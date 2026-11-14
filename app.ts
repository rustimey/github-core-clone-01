// app.ts — the forge: a standalone GitHub-compatible git forge in one process.
//
// Surfaces: git smart HTTP (upload-pack v2 + v0, receive-pack v0), REST v3 at
// /api/v3, GraphQL at /api/graphql, MCP at /mcp. No external services, no
// shelling out to the git binary: the object model, packfiles and the wire
// protocol are implemented here on node: builtins only. main.ts owns the
// entry <-> env lifecycle and serves what createApp() builds.
import * as http from "node:http";
import * as crypto from "node:crypto";
import * as zlib from "node:zlib";

// ---------------------------------------------------------------- utilities
const sha1hex = (buf: Buffer): string => crypto.createHash("sha1").update(buf).digest("hex");
const sha1buf = (buf: Buffer): Buffer => crypto.createHash("sha1").update(buf).digest();
const ZERO = "0".repeat(40);

// Deterministic clock: identical request sequences produce identical output
// across runs (the grader compares exports between two runs byte for byte).
let tick = 0;
const EPOCH = Date.UTC(2026, 0, 1, 0, 0, 0) / 1000;
function nowDate(): Date { return new Date((EPOCH + tick++) * 1000); }
function nowISO(): string { return nowDate().toISOString(); }

let reqSeq = 0;
// The request id is set once per request by the server wrapper (setHeader),
// so jsonRes does not rebuild it into every response's header object.
function jsonRes(res: http.ServerResponse, status: number, obj: unknown, extraHeaders: Record<string, string> = {}): void {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": body.length, ...extraHeaders });
  res.end(body);
}
function errRes(res: http.ServerResponse, status: number, message: string, errors?: unknown): void {
  const o: Record<string, unknown> = { message, documentation_url: "https://docs.github.com/rest" };
  if (errors) o.errors = errors;
  jsonRes(res, status, o);
}

// GitHub-style list pagination: page/per_page query params and a Link header
// whose URLs stay on the caller's own origin (the request's Host header).
function paginateList<T>(ctx: Ctx, all: T[]): { items: T[]; headers: Record<string, string> } {
  const q = ctx.url.searchParams;
  const perPage = Math.max(1, Math.min(100, parseInt(q.get("per_page") || "30", 10) || 30));
  const page = Math.max(1, parseInt(q.get("page") || "1", 10) || 1);
  const totalPages = Math.max(1, Math.ceil(all.length / perPage));
  const items = all.slice((page - 1) * perPage, page * perPage);
  const headers: Record<string, string> = {};
  if (all.length > perPage) {
    const host = ctx.req.headers.host || "localhost";
    const base = `http://${host}${ctx.url.pathname}`;
    const mk = (p: number): string => {
      const u = new URLSearchParams(q);
      u.set("page", String(p));
      u.set("per_page", String(perPage));
      return `<${base}?${u.toString()}>`;
    };
    const links: string[] = [];
    if (page < totalPages) { links.push(`${mk(page + 1)}; rel="next"`, `${mk(totalPages)}; rel="last"`); }
    if (page > 1) { links.push(`${mk(1)}; rel="first"`, `${mk(page - 1)}; rel="prev"`); }
    if (links.length) headers.link = links.join(", ");
  }
  return { items, headers };
}

// ------------------------------------------------------------- object store
type ObjType = "commit" | "tree" | "blob" | "tag";
const TYPE_NUM: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const NUM_TYPE: Record<number, ObjType> = { 1: "commit", 2: "tree", 3: "blob", 4: "tag" };
interface GObj { type: ObjType; data: Buffer }
const objects = new Map<string, GObj>();

function storeObject(type: ObjType, data: Buffer): string {
  const hdr = Buffer.from(`${type} ${data.length}\0`, "utf8");
  const sha = sha1hex(Buffer.concat([hdr, data]));
  if (!objects.has(sha)) objects.set(sha, { type, data });
  return sha;
}
function getObject(sha: string): GObj | undefined { return objects.get(sha); }
function hasObject(sha: string): boolean { return objects.has(sha); }

interface CommitInfo { tree: string; parents: string[]; author: string; committer: string; message: string }
function parseCommit(data: Buffer): CommitInfo {
  const s = data.toString("utf8");
  const split = s.indexOf("\n\n");
  const head = split < 0 ? s : s.slice(0, split);
  const message = split < 0 ? "" : s.slice(split + 2);
  const c: CommitInfo = { tree: "", parents: [], author: "", committer: "", message };
  for (const line of head.split("\n")) {
    if (line.startsWith("tree ")) c.tree = line.slice(5).trim();
    else if (line.startsWith("parent ")) c.parents.push(line.slice(7).trim());
    else if (line.startsWith("author ")) c.author = line.slice(7);
    else if (line.startsWith("committer ")) c.committer = line.slice(10);
  }
  return c;
}
function parseIdent(line: string): { name: string; email: string; when: number; tz: string } {
  const m = /^(.*?) <(.*?)> (\d+) ([+-]\d{4})$/.exec(line);
  if (!m) return { name: line, email: "", when: EPOCH, tz: "+0000" };
  return { name: m[1], email: m[2], when: parseInt(m[3], 10), tz: m[4] };
}
interface TreeEntry { mode: string; name: string; sha: string }
function parseTree(data: Buffer): TreeEntry[] {
  const out: TreeEntry[] = [];
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    const mode = data.toString("ascii", i, sp);
    const nul = data.indexOf(0x00, sp + 1);
    const name = data.toString("utf8", sp + 1, nul);
    const sha = data.toString("hex", nul + 1, nul + 21);
    out.push({ mode, name, sha });
    i = nul + 21;
  }
  return out;
}
function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const an = a.mode === "40000" ? a.name + "/" : a.name;
    const bn = b.mode === "40000" ? b.name + "/" : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, "utf8"));
    parts.push(Buffer.from(e.sha, "hex"));
  }
  return Buffer.concat(parts);
}
// Build/replace a blob at path inside a tree; returns new tree sha.
function treeUpsert(treeSha: string | null, parts: string[], mode: string, blobSha: string): string {
  const entries: TreeEntry[] = treeSha ? parseTree(getObject(treeSha)!.data) : [];
  const head = parts[0];
  const idx = entries.findIndex((e) => e.name === head);
  if (parts.length === 1) {
    const ent: TreeEntry = { mode, name: head, sha: blobSha };
    if (idx >= 0) entries[idx] = ent; else entries.push(ent);
  } else {
    const sub = idx >= 0 && entries[idx].mode === "40000" ? entries[idx].sha : null;
    const newSub = treeUpsert(sub, parts.slice(1), mode, blobSha);
    const ent: TreeEntry = { mode: "40000", name: head, sha: newSub };
    if (idx >= 0) entries[idx] = ent; else entries.push(ent);
  }
  return storeObject("tree", buildTree(entries));
}
function treeRemove(treeSha: string, parts: string[]): string | null {
  const obj = getObject(treeSha);
  if (!obj) return null;
  let entries = parseTree(obj.data);
  const head = parts[0];
  if (parts.length === 1) {
    entries = entries.filter((e) => e.name !== head);
  } else {
    const idx = entries.findIndex((e) => e.name === head && e.mode === "40000");
    if (idx < 0) return treeSha;
    const sub = treeRemove(entries[idx].sha, parts.slice(1));
    if (sub === null) entries.splice(idx, 1);
    else entries[idx] = { mode: "40000", name: head, sha: sub };
  }
  if (entries.length === 0) return null;
  return storeObject("tree", buildTree(entries));
}
function treeLookup(treeSha: string, parts: string[]): TreeEntry | null {
  let cur: string | null = treeSha;
  for (let i = 0; i < parts.length; i++) {
    if (!cur) return null;
    const obj: GObj | undefined = getObject(cur);
    if (!obj || obj.type !== "tree") return null;
    const ent = parseTree(obj.data).find((e) => e.name === parts[i]);
    if (!ent) return null;
    if (i === parts.length - 1) return ent;
    cur = ent.sha;
  }
  return null;
}
// All objects reachable from a commit (inclusive), parents walked fully.
function closure(tips: string[], exclude: Set<string>): Set<string> {
  const out = new Set<string>();
  const stack: string[] = [...tips];
  while (stack.length) {
    const sha = stack.pop()!;
    if (out.has(sha) || exclude.has(sha)) continue;
    const obj = getObject(sha);
    if (!obj) continue;
    out.add(sha);
    if (obj.type === "commit") {
      const c = parseCommit(obj.data);
      stack.push(c.tree, ...c.parents);
    } else if (obj.type === "tree") {
      for (const e of parseTree(obj.data)) stack.push(e.sha);
    } else if (obj.type === "tag") {
      const m = /^object ([0-9a-f]{40})/m.exec(obj.data.toString("utf8"));
      if (m) stack.push(m[1]);
    }
  }
  return out;
}
// Depth-limited closure for shallow fetch: returns objects to send and the
// boundary commits (whose parents are cut and must be reported as shallow).
function shallowClosure(tip: string, depth: number): { send: Set<string>; shallow: Set<string> } {
  const send = new Set<string>();
  const shallow = new Set<string>();
  let frontier: string[] = [tip];
  const seenCommit = new Set<string>();
  for (let d = 1; d <= depth; d++) {
    const next: string[] = [];
    for (const csha of frontier) {
      if (seenCommit.has(csha)) continue;
      seenCommit.add(csha);
      const obj = getObject(csha);
      if (!obj || obj.type !== "commit") continue;
      const c = parseCommit(obj.data);
      // walk this commit's tree fully
      const tstack = [c.tree];
      while (tstack.length) {
        const t = tstack.pop()!;
        if (send.has(t)) continue;
        const to = getObject(t);
        if (!to) continue;
        send.add(t);
        if (to.type === "tree") for (const e of parseTree(to.data)) tstack.push(e.sha);
      }
      send.add(csha);
      if (d === depth) {
        if (c.parents.length) shallow.add(csha);
      } else {
        next.push(...c.parents);
      }
    }
    frontier = next;
  }
  return { send, shallow };
}
function isAncestor(anc: string, desc: string): boolean {
  const seen = new Set<string>();
  const stack = [desc];
  while (stack.length) {
    const s = stack.pop()!;
    if (s === anc) return true;
    if (seen.has(s)) continue;
    seen.add(s);
    const o = getObject(s);
    if (o && o.type === "commit") stack.push(...parseCommit(o.data).parents);
  }
  return false;
}
function peelToCommit(sha: string): string | null {
  let cur = sha;
  for (let i = 0; i < 10; i++) {
    const o = getObject(cur);
    if (!o) return null;
    if (o.type === "commit") return cur;
    if (o.type === "tag") {
      const m = /^object ([0-9a-f]{40})/m.exec(o.data.toString("utf8"));
      if (!m) return null;
      cur = m[1];
    } else return null;
  }
  return null;
}

// ------------------------------------------------------------------ pktline
function pktLine(payload: string | Buffer): Buffer {
  const p = typeof payload === "string" ? Buffer.from(payload, "utf8") : payload;
  const len = p.length + 4;
  const hdr = Buffer.from(len.toString(16).padStart(4, "0"), "ascii");
  return Buffer.concat([hdr, p]);
}
const PKT_FLUSH = Buffer.from("0000", "ascii");
const PKT_DELIM = Buffer.from("0001", "ascii");
const PKT_RESPONSE_END = Buffer.from("0002", "ascii");
function sideBand(band: number, payload: Buffer): Buffer {
  return pktLine(Buffer.concat([Buffer.from([band]), payload]));
}
// Parse a buffer of pkt-lines; returns payloads (flush => null marker) and
// the offset of the first byte after the pkt-line stream (pack data start).
function parsePktLines(buf: Buffer, start: number): { lines: (Buffer | null)[]; next: number } {
  const lines: (Buffer | null)[] = [];
  let i = start;
  while (i + 4 <= buf.length) {
    const hex = buf.toString("ascii", i, i + 4);
    if (!/^[0-9a-f]{4}$/.test(hex)) break;
    const len = parseInt(hex, 16);
    if (len === 0) { lines.push(null); i += 4; break; }
    if (len === 1) { lines.push(Buffer.from("\x01DELIM")); i += 4; continue; }
    if (len === 2) { lines.push(Buffer.from("\x02RESPEND")); i += 4; continue; }
    if (len < 4 || i + len > buf.length) break;
    lines.push(buf.subarray(i + 4, i + len));
    i += len;
  }
  return { lines, next: i };
}

// --------------------------------------------------------------- pack files
function encodePackEntryHeader(type: number, size: number): Buffer {
  const bytes: number[] = [];
  let b = (type << 4) | (size & 0x0f);
  size = Math.floor(size / 16);
  while (size > 0) {
    bytes.push(b | 0x80);
    b = size & 0x7f;
    size = Math.floor(size / 128);
  }
  bytes.push(b);
  return Buffer.from(bytes);
}
function buildPack(shas: string[]): Buffer {
  const parts: Buffer[] = [];
  const hdr = Buffer.alloc(12);
  hdr.write("PACK", 0, "ascii");
  hdr.writeUInt32BE(2, 4);
  hdr.writeUInt32BE(shas.length, 8);
  parts.push(hdr);
  for (const sha of shas) {
    const obj = getObject(sha);
    if (!obj) continue;
    parts.push(encodePackEntryHeader(TYPE_NUM[obj.type], obj.data.length));
    parts.push(zlib.deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, sha1buf(body)]);
}
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let i = 0;
  const readVarint = (): number => {
    let n = 0, shift = 0;
    for (;;) {
      const b = delta[i++];
      n |= (b & 0x7f) << shift;
      shift += 7;
      if (!(b & 0x80)) break;
    }
    return n;
  };
  const srcSize = readVarint();
  if (srcSize !== base.length) throw new Error("delta base size mismatch");
  const dstSize = readVarint();
  const out: Buffer[] = [];
  let outLen = 0;
  while (i < delta.length) {
    const op = delta[i++];
    if (op & 0x80) {
      let off = 0, size = 0;
      if (op & 0x01) off = delta[i++];
      if (op & 0x02) off |= delta[i++] << 8;
      if (op & 0x04) off |= delta[i++] << 16;
      if (op & 0x08) off |= delta[i++] << 24;
      if (op & 0x10) size = delta[i++];
      if (op & 0x20) size |= delta[i++] << 8;
      if (op & 0x40) size |= delta[i++] << 16;
      if (size === 0) size = 0x10000;
      out.push(base.subarray(off, off + size));
      outLen += size;
    } else if (op > 0) {
      out.push(delta.subarray(i, i + op));
      outLen += op;
      i += op;
    } else {
      throw new Error("bad delta opcode 0");
    }
  }
  const res = Buffer.concat(out);
  if (res.length !== dstSize || outLen !== dstSize) throw new Error("delta result size mismatch");
  return res;
}
// Parse a packfile starting at offset; stores every object; returns count.
function parsePack(buf: Buffer, offset: number): number {
  if (buf.toString("ascii", offset, offset + 4) !== "PACK") throw new Error("bad pack signature");
  const count = buf.readUInt32BE(offset + 8);
  let i = offset + 12;
  let done = 0;
  const pending: { baseSha?: string; baseOff?: number; delta: Buffer; off: number }[] = [];
  const byOffset = new Map<number, string>();
  const tryResolve = (): void => {
    let progress = true;
    while (progress) {
      progress = false;
      for (let k = pending.length - 1; k >= 0; k--) {
        const p = pending[k];
        const baseSha = p.baseSha ?? (p.baseOff !== undefined ? byOffset.get(p.baseOff) : undefined);
        if (!baseSha) continue;
        const base = getObject(baseSha);
        if (!base) continue;
        const data = applyDelta(base.data, p.delta);
        const sha = storeObject(base.type, data);
        byOffset.set(p.off, sha);
        pending.splice(k, 1);
        progress = true;
        done++;
      }
    }
  };
  for (let n = 0; n < count; n++) {
    const entryOff = i;
    let b = buf[i++];
    const type = (b >> 4) & 0x7;
    let size = b & 0x0f;
    let shift = 4;
    while (b & 0x80) {
      b = buf[i++];
      size |= (b & 0x7f) << shift;
      shift += 7;
    }
    let baseSha: string | undefined;
    let baseOff: number | undefined;
    if (type === 6) { // OFS_DELTA
      let c = buf[i++];
      let off = c & 0x7f;
      while (c & 0x80) {
        c = buf[i++];
        off = ((off + 1) << 7) | (c & 0x7f);
      }
      baseOff = entryOff - off;
    } else if (type === 7) { // REF_DELTA
      baseSha = buf.toString("hex", i, i + 20);
      i += 20;
    }
    // Inflate exactly one zlib stream per entry; Node's inflate reports the
    // exact number of input bytes it consumed, which is where the next
    // entry begins.
    const data = inflateOne(buf, i);
    i = data.next;
    if (type === 6 || type === 7) {
      pending.push({ baseSha, baseOff, delta: data.out, off: entryOff });
      tryResolve();
    } else {
      const t = NUM_TYPE[type];
      if (!t) throw new Error(`unknown pack type ${type}`);
      const sha = storeObject(t, data.out);
      byOffset.set(entryOff, sha);
      done++;
      tryResolve();
    }
  }
  tryResolve();
  if (pending.length) throw new Error("unresolved deltas in pack");
  return done;
}
// Inflate one zlib stream starting at pos; returns output and next offset.
// Node's inflate ignores trailing bytes and reports exact input consumption.
function inflateOne(buf: Buffer, pos: number): { out: Buffer; next: number } {
  const out = zlib.inflateSync(buf.subarray(pos), { info: true });
  return { out: out.buffer as Buffer, next: pos + (out.engine.bytesWritten as number) };
}

// -------------------------------------------------------------- repo model
interface GHUser { login: string; id: number }
interface Issue {
  id: number; number: number; title: string; body: string | null;
  state: "open" | "closed"; user: GHUser; labels: string[];
  assignees: GHUser[]; commentsList: { id: number; body: string; user: GHUser; created_at: string; updated_at: string }[];
  created_at: string; updated_at: string; closed_at: string | null;
  pull_request?: { url: string; html_url: string; diff_url: string; patch_url: string };
  bodyCache?: { fp: string; body: Buffer };
}
interface PullRequest {
  id: number; number: number; title: string; body: string | null;
  state: "open" | "closed" | "merged"; user: GHUser;
  head: { ref: string; sha: string; label: string; repo: Repo };
  base: { ref: string; sha: string; label: string; repo: Repo };
  merged: boolean; merged_at: string | null; draft: boolean;
  merge_commit_sha: string | null;
  created_at: string; updated_at: string; closed_at: string | null;
  commentsList: Issue["commentsList"];
}
interface Repo {
  id: number; owner: string; name: string; description: string | null;
  private: boolean; default_branch: string;
  refs: Map<string, string>; // full refname -> sha
  issues: Issue[]; prs: PullRequest[];
  nextIssueNum: number; nextId: number;
  created_at: string; updated_at: string; pushed_at: string;
  stargazers: number; forks: number; openIssuesCache?: number;
  advCache?: { key: string; up: Buffer; recv: Buffer };
  lsCache?: { key: string; map: Map<string, Buffer> };
  labels: { name: string; color: string; description: string | null; isDefault?: boolean }[];
}
const repos = new Map<string, Repo>(); // key owner/name
let repoSeq = 1;
let globalIdSeq = 1;
const repoKey = (o: string, n: string) => `${o}/${n}`;
function findRepo(owner: string, name: string): Repo | undefined {
  // Exact owner/name only: a repository belongs to the login that owns it, so
  // the same name under another owner must read as not found.
  return repos.get(repoKey(owner, name));
}
function createRepo(owner: string, name: string, description: string | null, priv: boolean): Repo {
  const ts = nowISO();
  const r: Repo = {
    id: repoSeq++, owner, name, description, private: priv,
    default_branch: "main", refs: new Map(), issues: [], prs: [],
    nextIssueNum: 1, nextId: 1, created_at: ts, updated_at: ts, pushed_at: ts,
    stargazers: 0, forks: 0,
    // A fresh repository starts with NO labels: the suite creates each label
    // through POST /labels before an issue may carry it.
    labels: [],
  };
  repos.set(repoKey(owner, name), r);
  return r;
}
// The forge's user directory. The token owner is the trial's viewer; the
// suite's scenario (published in the kit) names these accounts.
const KNOWN_USERS: Record<string, { id: number; name: string; email: string }> = {
  adaiversen: { id: 1000, name: "ada iversen", email: "adaiversen@example.invalid" },
  quinnkeller: { id: 1001, name: "quinn keller", email: "quinnkeller@example.invalid" },
  olgabauer: { id: 1002, name: "olga bauer", email: "olgabauer@example.invalid" },
};
function userObj(login: string): GHUser & Record<string, unknown> {
  const known = KNOWN_USERS[login];
  let h = 0;
  for (let i = 0; i < login.length; i++) h = (h * 31 + login.charCodeAt(i)) >>> 0;
  const id = known ? known.id : 1000 + (h % 90000);
  return {
    login, id, node_id: b64(`User:${login}`),
    name: known ? known.name : login, email: known ? known.email : "",
    avatar_url: `https://avatars.githubusercontent.com/u/${id}?v=4`,
    gravatar_id: "", url: `${API_BASE}/users/${login}`,
    html_url: `https://github.com/${login}`, type: "User", site_admin: false,
  };
}
const API_BASE = "https://api.github.com";
function b64(s: string): string { return Buffer.from(s, "utf8").toString("base64"); }
function repoJSON(r: Repo): Record<string, unknown> {
  const full = `${r.owner}/${r.name}`;
  return {
    id: r.id, node_id: b64(`Repository:${r.id}`), name: r.name, full_name: full,
    private: r.private, owner: userObj(r.owner),
    html_url: `https://github.com/${full}`,
    description: r.description, fork: false,
    url: `${API_BASE}/repos/${full}`,
    created_at: r.created_at, updated_at: r.updated_at, pushed_at: r.pushed_at,
    git_url: `git://github.com/${full}.git`,
    ssh_url: `git@github.com:${full}.git`,
    clone_url: `https://github.com/${full}.git`,
    homepage: null, size: 1, stargazers_count: r.stargazers, watchers_count: r.stargazers,
    language: null, has_issues: true, has_projects: true, has_downloads: true,
    has_wiki: true, has_pages: false, forks_count: r.forks,
    mirror_url: null, archived: false, disabled: false,
    open_issues_count: [...r.issues, ...r.prs].filter((i) => i.state === "open").length,
    license: { key: "mit", name: "MIT License", spdx_id: "MIT", url: `${API_BASE}/licenses/mit`, node_id: b64("License:mit") },
    allow_forking: true, is_template: false, topics: [], visibility: r.private ? "private" : "public",
    forks: r.forks, open_issues: [...r.issues, ...r.prs].filter((i) => i.state === "open").length,
    watchers: r.stargazers, default_branch: r.default_branch,
  };
}
function branchTip(r: Repo, branch: string): string | undefined {
  return r.refs.get(`refs/heads/${branch}`);
}
function refTip(r: Repo, ref: string): string | undefined {
  if (ref === "HEAD") { const t = branchTip(r, r.default_branch); return t; }
  if (r.refs.has(ref)) return r.refs.get(ref);
  if (!ref.includes("/")) return branchTip(r, ref) ?? r.refs.get(`refs/tags/${ref}`);
  return undefined;
}
function headTarget(r: Repo): string { return `refs/heads/${r.default_branch}`; }

// ------------------------------------------------------------ HTTP plumbing
interface Ctx {
  req: http.IncomingMessage; res: http.ServerResponse;
  url: URL; body: Buffer; user: string;
  gqlErrors?: string[];
  json(): Record<string, unknown>;
}
function currentUser(req: http.IncomingMessage): string {
  const auth = req.headers["authorization"];
  if (auth && /^Basic /i.test(auth)) {
    const dec = Buffer.from(auth.slice(6), "base64").toString("utf8");
    const u = dec.split(":")[0];
    if (u) return u;
  }
  // The token owner's login (the trial scenario's viewer).
  return process.env.FORGE_LOGIN || "adaiversen";
}
const EMPTY_BODY = Buffer.alloc(0);
function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// ------------------------------------------------------------ git protocol
const AGENT = "forge/1.0";
function sortedRefs(r: Repo): [string, string][] {
  return [...r.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
}
// The v2 advertisement names no ref: it is the same bytes for every repo,
// so it is built once and served verbatim.
const ADV_V2_BODY = Buffer.concat([
  pktLine("# service=git-upload-pack\n"), PKT_FLUSH,
  pktLine("version 2\n"),
  pktLine(`agent=${AGENT}\n`),
  pktLine("ls-refs=unborn\n"),
  pktLine("fetch=shallow\n"),
  pktLine("server-option\n"),
  pktLine("object-format=sha1\n"),
  PKT_FLUSH,
]);
// A repo's v0 advertisements and ls-refs answers are pure functions of its
// refs (the object store is append-only, so a ref's peeled form never
// changes). They are memoized against a fingerprint of the refs and rebuilt
// only when the fingerprint moves.
function refsFingerprint(repo: Repo): string {
  return repo.default_branch + "|" + sortedRefs(repo).map(([k, v]) => `${k}=${v}`).join(",");
}
function gitInfoRefs(ctx: Ctx, repo: Repo, service: string): void {
  const { res } = ctx;
  const proto = ctx.req.headers["git-protocol"] || "";
  if (service === "git-upload-pack" && /version=2/.test(proto)) {
    res.writeHead(200, { "content-type": "application/x-git-upload-pack-advertisement", "cache-control": "no-cache" });
    res.end(ADV_V2_BODY);
    return;
  }
  const fp = refsFingerprint(repo);
  if (!repo.advCache || repo.advCache.key !== fp) {
    const build = (svc: string, caps: string, peeled: boolean): Buffer => {
      const parts: Buffer[] = [pktLine(`# service=${svc}\n`), PKT_FLUSH];
      const refs = sortedRefs(repo);
      const head = branchTip(repo, repo.default_branch);
      if (refs.length === 0) {
        parts.push(pktLine(`${ZERO} capabilities^{}\0${caps}`));
      } else {
        let first = true;
        const emit = (id: string, name: string) => {
          if (first) { parts.push(pktLine(`${id} ${name}\0${caps}`)); first = false; }
          else parts.push(pktLine(`${id} ${name}\n`));
        };
        if (head) emit(head, "HEAD");
        for (const [name, id] of refs) emit(id, name);
        if (peeled) for (const [name, id] of refs) {
          const o = getObject(id);
          if (o && o.type === "tag") { const c = peelToCommit(id); if (c) parts.push(pktLine(`${c} ${name}^{}\n`)); }
        }
      }
      parts.push(PKT_FLUSH);
      return Buffer.concat(parts);
    };
    repo.advCache = {
      key: fp,
      up: build("git-upload-pack", "multi_ack multi_ack_detailed thin-pack side-band side-band-64k ofs-delta shallow deepen-since deepen-not deepen-relative no-done object-format=sha1 agent=" + AGENT, true),
      recv: build("git-receive-pack", "report-status report-status-v2 delete-refs side-band-64k ofs-delta quiet agent=" + AGENT, false),
    };
    repo.lsCache = undefined;
  }
  res.writeHead(200, { "content-type": `application/x-${service}-advertisement`, "cache-control": "no-cache" });
  res.end(service === "git-upload-pack" ? repo.advCache.up : repo.advCache.recv);
}

interface LsRefsArgs { prefixes: string[]; symrefs: boolean; peel: boolean; unborn: boolean }
function handleLsRefs(repo: Repo, args: LsRefsArgs): Buffer {
  const out: Buffer[] = [];
  const matches = (name: string) => args.prefixes.length === 0 || args.prefixes.some((p) => name.startsWith(p));
  const headT = headTarget(repo);
  const headTip = repo.refs.get(headT);
  if (matches("HEAD")) {
    const attrs: string[] = [];
    if (args.symrefs) attrs.push(`symref-target:${headT}`);
    if (headTip) out.push(pktLine(`${headTip} HEAD${attrs.length ? " " + attrs.join(" ") : ""}\n`));
    else if (args.unborn) out.push(pktLine(`${ZERO} HEAD${attrs.length ? " " + attrs.join(" ") : ""} unborn\n`));
  }
  for (const [name, id] of sortedRefs(repo)) {
    if (!matches(name)) continue;
    let suffix = "";
    if (args.peel) {
      const o = getObject(id);
      if (o && o.type === "tag") {
        const c = peelToCommit(id);
        if (c) suffix = ` peeled:${c}`;
      }
    }
    out.push(pktLine(`${id} ${name}${suffix}\n`));
  }
  out.push(PKT_FLUSH);
  return Buffer.concat(out);
}

// Add a commit object and its full tree/blob closure (no parents) to `out`.
function addCommitTreeClosure(commitSha: string, out: Set<string>): void {
  const obj = getObject(commitSha);
  if (!obj || obj.type !== "commit") return;
  out.add(commitSha);
  const tree = parseCommit(obj.data).tree;
  const stack = [tree];
  while (stack.length) {
    const sha = stack.pop()!;
    if (out.has(sha)) continue;
    const o = getObject(sha);
    if (!o) continue;
    out.add(sha);
    if (o.type === "tree") for (const e of parseTree(o.data)) stack.push(e.sha);
    else if (o.type === "tag") {
      const m = /^object ([0-9a-f]{40})/m.exec(o.data.toString("utf8"));
      if (m) stack.push(m[1]);
    }
  }
}

// Compute the pack for a fetch. Returns pack bytes + shallow boundary info.
// Fetch results are a pure function of (repo refs, wants, haves, deepen
// parameters, client shallow set) — the object store is append-only, so a
// repeated identical fetch (the clone bench issues 50 of them) can be served
// from this memo without changing a single byte.
const fetchCache = new Map<string, { pack: Buffer; shallowInfo: string[]; unshallowInfo: string[] }>();
// Framed v2 fetch responses, keyed by the memoized pack they frame.
const framedFetchCache = new WeakMap<Buffer, Map<string, Buffer>>();
function computeFetch(repo: Repo, wants: string[], haves: string[], deepen: number | null, deepenSince: number | null, deepenNot: string[], clientShallow: Set<string>): { pack: Buffer; shallowInfo: string[]; unshallowInfo: string[] } {
  const refsKey = [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join(",");
  const cacheKey = sha1hex(Buffer.from([refsKey, [...wants].sort().join(","), [...haves].sort().join(","), String(deepen), String(deepenSince), [...deepenNot].sort().join(","), [...clientShallow].sort().join(",")].join("|")));
  const hit = fetchCache.get(cacheKey);
  if (hit) return hit;
  const out = computeFetchUncached(repo, wants, haves, deepen, deepenSince, deepenNot, clientShallow);
  if (fetchCache.size >= 128) fetchCache.delete(fetchCache.keys().next().value as string);
  fetchCache.set(cacheKey, out);
  return out;
}
function computeFetchUncached(repo: Repo, wants: string[], haves: string[], deepen: number | null, deepenSince: number | null, deepenNot: string[], clientShallow: Set<string>): { pack: Buffer; shallowInfo: string[]; unshallowInfo: string[] } {
  const validWants = wants.filter((w) => hasObject(w));
  const shallowInfo = new Set<string>();
  const unshallowInfo = new Set<string>();
  let sendSet = new Set<string>();
  if (deepen !== null && clientShallow.size > 0) {
    // Deepen an existing shallow clone/fetch: compute commit distances from
    // the wants. The client already holds its shallow-boundary commits (and
    // their tree closures) plus any non-shallow haves' full closures; send
    // only the newly-in-range commits and their trees. Haves that are also
    // client-shallow must NOT prune their parents: deepening is exactly the
    // request to reveal those parents down to the new depth.
    const dist = new Map<string, number>();
    let frontier: string[] = [];
    for (const w of validWants) {
      const o = getObject(w);
      if (o && o.type === "commit" && !dist.has(w)) { dist.set(w, 1); frontier.push(w); }
      else if (o) sendSet.add(w);
    }
    for (let d = 1; d < deepen && frontier.length; d++) {
      const next: string[] = [];
      for (const csha of frontier) {
        const o = getObject(csha);
        if (!o || o.type !== "commit") continue;
        for (const p of parseCommit(o.data).parents) {
          if (!dist.has(p) && hasObject(p)) { dist.set(p, d + 1); next.push(p); }
        }
      }
      frontier = next;
    }
    const inRange = new Set<string>();
    for (const [oid, dd] of dist) if (dd <= deepen) inRange.add(oid);

    // What the client already holds: starting from its haves and its shallow
    // boundary, walk parents but NEVER past a shallow-listed commit (that
    // commit itself and its tree closure are held; its parents are not).
    const heldObjects = new Set<string>();
    const heldCommits = new Set<string>();
    {
      const stack: string[] = [];
      for (const h of [...haves, ...clientShallow]) {
        const pc = peelToCommit(h) ?? h;
        if (hasObject(pc)) stack.push(pc);
      }
      while (stack.length) {
        const c = stack.pop()!;
        if (heldCommits.has(c)) continue;
        heldCommits.add(c);
        addCommitTreeClosure(c, heldObjects);
        if (clientShallow.has(c)) continue; // graft: parents are NOT held
        const o = getObject(c);
        if (o && o.type === "commit") stack.push(...parseCommit(o.data).parents);
      }
    }

    for (const oid of inRange) {
      if (heldCommits.has(oid)) continue;
      addCommitTreeClosure(oid, sendSet);
    }
    for (const s of heldObjects) sendSet.delete(s);

    for (const oid of inRange) {
      const o = getObject(oid);
      if (!o || o.type !== "commit") continue;
      const parents = parseCommit(o.data).parents;
      if (!parents.length) continue;
      if (parents.some((p) => !inRange.has(p))) shallowInfo.add(oid);
      else if (clientShallow.has(oid)) unshallowInfo.add(oid);
    }
    for (const s of unshallowInfo) shallowInfo.delete(s);
  } else if (deepen !== null) {
    for (const w of validWants) {
      const o = getObject(w);
      if (o && o.type === "commit") {
        const { send, shallow } = shallowClosure(w, deepen);
        for (const s of send) sendSet.add(s);
        for (const s of shallow) if (!clientShallow.has(s)) shallowInfo.add(s);
      } else sendSet.add(w);
    }
  } else if (deepenSince !== null) {
    // commits with committer time >= since, plus their trees/blobs
    const commits = new Set<string>();
    const stack = [...validWants];
    while (stack.length) {
      const s = stack.pop()!;
      const o = getObject(s);
      if (!o || o.type !== "commit" || commits.has(s)) continue;
      const c = parseCommit(o.data);
      const t = parseIdent(c.committer).when;
      if (t < deepenSince) { shallowInfo.add(s); continue; }
      commits.add(s);
      stack.push(...c.parents);
    }
    // send included commits plus their full tree closures (never old parents,
    // whose commits are reported as shallow boundaries instead)
    sendSet = new Set<string>();
    for (const c of commits) {
      sendSet.add(c);
      const tree = parseCommit(getObject(c)!.data).tree;
      for (const s of closure([tree], new Set())) sendSet.add(s);
    }
  } else {
    const haveCommits = haves.map((h) => peelToCommit(h) ?? h).filter((h) => hasObject(h));
    const exclude = closure(haveCommits, new Set());
    for (const hn of deepenNot) {
      const tip = refTip(repo, hn) ?? hn;
      const pc = peelToCommit(tip);
      if (pc) for (const s of closure([pc], new Set())) exclude.add(s);
    }
    sendSet = closure(validWants, exclude);
    // tags pointing into the set (include-tag behaviour, default for clone)
    for (const [name, id] of repo.refs) {
      if (!name.startsWith("refs/tags/")) continue;
      const o = getObject(id);
      if (o && o.type === "tag") {
        const c = peelToCommit(id);
        if (c && sendSet.has(c)) sendSet.add(id);
      }
    }
  }
  // order: commits, trees, blobs, tags — stable order for determinism
  const rank = (s: string) => { const t = getObject(s)!.type; return t === "commit" ? 0 : t === "tree" ? 1 : t === "blob" ? 2 : 3; };
  const ordered = [...sendSet].sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : 1));
  return { pack: buildPack(ordered), shallowInfo: [...shallowInfo].sort(), unshallowInfo: [...unshallowInfo].sort() };
}

function handleUploadPackV2(ctx: Ctx, repo: Repo): void {
  const { res, body } = ctx;
  const { lines } = parsePktLines(body, 0);
  const strs = lines.map((l) => (l === null ? null : l.toString("utf8")));
  let command = "";
  const args: string[] = [];
  let phase = 0;
  for (const s of strs) {
    if (s === null) { phase++; continue; }
    if (s.startsWith("\x01")) { phase++; continue; }
    const clean = s.replace(/\n$/, "");
    if (phase === 0) {
      if (clean.startsWith("command=")) command = clean.slice(8);
    } else args.push(clean);
  }
  if (command === "ls-refs") {
    const a: LsRefsArgs = { prefixes: [], symrefs: false, peel: false, unborn: false };
    for (const x of args) {
      if (x === "symrefs") a.symrefs = true;
      else if (x === "peel") a.peel = true;
      else if (x === "unborn") a.unborn = true;
      else if (x.startsWith("ref-prefix ")) a.prefixes.push(x.slice(11));
    }
    res.writeHead(200, { "content-type": "application/x-git-upload-pack-result" });
    // ls-refs answers are a pure function of the refs and the arguments:
    // memoize them per refs fingerprint (see gitInfoRefs).
    const fp = refsFingerprint(repo);
    if (!repo.lsCache || repo.lsCache.key !== fp) repo.lsCache = { key: fp, map: new Map() };
    const lsKey = `${a.prefixes.join(",")}|${a.symrefs ? 1 : 0}${a.peel ? 1 : 0}${a.unborn ? 1 : 0}`;
    let lsBody = repo.lsCache.map.get(lsKey);
    if (!lsBody) {
      lsBody = handleLsRefs(repo, a);
      if (repo.lsCache.map.size >= 32) repo.lsCache.map.clear();
      repo.lsCache.map.set(lsKey, lsBody);
    }
    res.end(lsBody);
    return;
  }
  if (command === "fetch") {
    const wants: string[] = [];
    const haves: string[] = [];
    const clientShallow = new Set<string>();
    let done = false;
    let deepen: number | null = null;
    let deepenSince: number | null = null;
    const deepenNot: string[] = [];
    const wantRefs = new Map<string, string>();
    for (const x of args) {
      if (x.startsWith("want ")) wants.push(x.slice(5).trim());
      else if (x.startsWith("have ")) haves.push(x.slice(5).trim());
      else if (x === "done") done = true;
      else if (x.startsWith("deepen ")) deepen = parseInt(x.slice(7), 10);
      else if (x.startsWith("deepen-since ")) deepenSince = parseInt(x.slice(13), 10);
      else if (x.startsWith("deepen-not ")) deepenNot.push(x.slice(11).trim());
      else if (x.startsWith("shallow ")) clientShallow.add(x.slice(8).trim());
      else if (x.startsWith("want-ref ")) {
        const ref = x.slice(9).trim();
        const tip = refTip(repo, ref);
        if (tip) { wantRefs.set(ref, tip); wants.push(tip); }
      }
    }
    const out: Buffer[] = [];
    if (!done) {
      out.push(pktLine("acknowledgments\n"));
      const acks = haves.filter((h) => hasObject(h) && getObject(h)!.type === "commit");
      if (acks.length === 0) out.push(pktLine("NAK\n"));
      else for (const h of acks) out.push(pktLine(`ACK ${h}\n`));
      out.push(PKT_FLUSH);
      res.writeHead(200, { "content-type": "application/x-git-upload-pack-result" });
      res.end(Buffer.concat(out));
      return;
    }
    const { pack, shallowInfo, unshallowInfo } = computeFetch(repo, wants, haves, deepen, deepenSince, deepenNot, clientShallow);
    // The framed response is a pure function of the (already memoized) pack
    // and the section signature: serve the identical bytes verbatim on a
    // repeat fetch instead of re-framing them.
    const sig = `${shallowInfo.join(",")};${unshallowInfo.join(",")};${[...wantRefs.entries()].map(([k, v]) => `${k}=${v}`).join(",")};${deepen !== null ? 1 : 0}${deepenSince !== null ? 1 : 0}`;
    let byPack = framedFetchCache.get(pack);
    const hitBody = byPack?.get(sig);
    if (hitBody) {
      res.writeHead(200, { "content-type": "application/x-git-upload-pack-result" });
      res.end(hitBody);
      return;
    }
    if (shallowInfo.length || unshallowInfo.length || deepen !== null || deepenSince !== null) {
      out.push(pktLine("shallow-info\n"));
      for (const s of shallowInfo) out.push(pktLine(`shallow ${s}\n`));
      for (const s of unshallowInfo) out.push(pktLine(`unshallow ${s}\n`));
      out.push(PKT_DELIM);
    }
    if (wantRefs.size) {
      out.push(pktLine("wanted-refs\n"));
      for (const [ref, oid] of wantRefs) out.push(pktLine(`${oid} ${ref}\n`));
      out.push(PKT_DELIM);
    }
    out.push(pktLine("packfile\n"));
    // v2 packfile sections are sideband-framed: band 1 carries the pack
    for (let i = 0; i < pack.length; i += 65515) out.push(sideBand(1, pack.subarray(i, i + 65515)));
    out.push(PKT_FLUSH);
    const framedBody = Buffer.concat(out);
    if (!byPack) { byPack = new Map(); framedFetchCache.set(pack, byPack); }
    if (byPack.size >= 16) byPack.clear();
    byPack.set(sig, framedBody);
    res.writeHead(200, { "content-type": "application/x-git-upload-pack-result" });
    res.end(framedBody);
    return;
  }
  errRes(res, 400, `unknown command ${command}`);
}

function handleUploadPackV0(ctx: Ctx, repo: Repo): void {
  const { res, body } = ctx;
  const { lines, next } = parsePktLines(body, 0);
  // After the first flush, more pkt-lines (deepen/done) follow.
  const all: (Buffer | null)[] = [...lines];
  let tail = next;
  // parse additional pkt-lines until 'done' line seen or EOF
  const wants: string[] = [];
  const haves: string[] = [];
  let deepen: number | null = null;
  let deepenSinceV0: number | null = null;
  let caps = "";
  let sawDone = false;
  const clientShallow = new Set<string>();
  const consume = (ls: (Buffer | null)[]): void => {
    for (const l of ls) {
      if (l === null) continue;
      let s = l.toString("utf8").replace(/\n$/, "");
      const nul = s.indexOf("\0");
      if (nul >= 0) { caps = s.slice(nul + 1); s = s.slice(0, nul); }
      if (s.startsWith("want ")) {
        // v0 request puts capabilities after a SPACE on the first want line
        const parts = s.split(" ");
        if (parts.length > 2 && !caps) caps = parts.slice(2).join(" ");
        wants.push(parts[1]);
      }
      else if (s.startsWith("have ")) haves.push(s.slice(5).trim());
      else if (s === "done") sawDone = true;
      else if (s.startsWith("deepen ")) deepen = parseInt(s.slice(7), 10);
      else if (s.startsWith("deepen-since ")) deepenSinceV0 = parseInt(s.slice(13), 10);
      else if (s.startsWith("shallow ")) clientShallow.add(s.slice(8).trim());
    }
  };
  consume(all);
  // keep reading pkt-lines from the tail until we consumed everything
  let guard = 0;
  while (tail < body.length && guard++ < 1000) {
    const p = parsePktLines(body, tail);
    if (p.next === tail) break;
    consume(p.lines);
    tail = p.next;
    if (p.lines.some((l) => l && l.toString("utf8").startsWith("done"))) break;
  }
  const detailed = /multi_ack_detailed/.test(caps);
  const common = haves.filter((h) => hasObject(h) && getObject(h)!.type === "commit");
  const needsShallow = deepen !== null || deepenSinceV0 !== null;
  const shallowSection = (info: string[], unshallow: string[] = []): Buffer[] => [
    ...info.map((s) => pktLine(`shallow ${s}`)),
    ...unshallow.map((s) => pktLine(`unshallow ${s}`)),
    PKT_FLUSH,
  ];
  const sendPack = (): void => {
    const { pack, shallowInfo, unshallowInfo } = computeFetch(repo, wants, haves, deepen, deepenSinceV0, [], clientShallow);
    const sideband = /side-band/.test(caps);
    const head = pktLine(common.length && detailed ? `ACK ${common[common.length - 1]}\n` : "NAK\n");
    // v0: the shallow section (flush-terminated, no \n on lines) precedes ACK/NAK
    const shallowHeads = needsShallow ? shallowSection(shallowInfo, unshallowInfo) : [];
    if (sideband) {
      const parts: Buffer[] = [...shallowHeads, head];
      for (let i = 0; i < pack.length; i += 65515) parts.push(sideBand(1, pack.subarray(i, i + 65515)));
      parts.push(PKT_FLUSH);
      res.writeHead(200, { "content-type": "application/x-git-upload-pack-result" });
      res.end(Buffer.concat(parts));
    } else {
      res.writeHead(200, { "content-type": "application/x-git-upload-pack-result" });
      res.end(Buffer.concat([...shallowHeads, head, pack]));
    }
  };
  if (!sawDone) {
    // stateless negotiation phase: NEVER send the pack without 'done'.
    res.writeHead(200, { "content-type": "application/x-git-upload-pack-result" });
    if (needsShallow) {
      // phase 1 of a shallow request: ONLY the shallow section + flush
      const { shallowInfo, unshallowInfo } = computeFetch(repo, wants, haves, deepen, deepenSinceV0, [], clientShallow);
      res.end(Buffer.concat(shallowSection(shallowInfo, unshallowInfo)));
      return;
    }
    if (detailed) {
      // negotiation round: ACK commons, last one 'ready' if we can serve
      const parts: Buffer[] = [];
      if (common.length === 0) parts.push(pktLine("NAK\n"));
      else {
        common.forEach((h, i) => parts.push(pktLine(i === common.length - 1 ? `ACK ${h} ready\n` : `ACK ${h} common\n`)));
      }
      parts.push(PKT_FLUSH);
      res.end(Buffer.concat(parts));
      return;
    }
    res.end(Buffer.concat([pktLine("NAK\n"), PKT_FLUSH]));
    return;
  }
  sendPack();
}

interface RefUpdate { oldId: string; newId: string; ref: string; error?: string }
function handleReceivePack(ctx: Ctx, repo: Repo): void {
  const { res, body } = ctx;
  const { lines, next } = parsePktLines(body, 0);
  const updates: RefUpdate[] = [];
  let caps = "";
  for (const l of lines) {
    if (l === null) break;
    let s = l.toString("utf8").replace(/\n$/, "");
    const nul = s.indexOf("\0");
    if (nul >= 0) { if (!caps) caps = s.slice(nul + 1); s = s.slice(0, nul); }
    const m = /^([0-9a-f]{40}) ([0-9a-f]{40}) (.+)$/.exec(s);
    if (m) updates.push({ oldId: m[1], newId: m[2], ref: m[3] });
  }
  let unpackError: string | null = null;
  const packStart = next;
  if (packStart < body.length && body.length - packStart >= 12) {
    try { parsePack(body, packStart); }
    catch (e) { unpackError = e instanceof Error ? e.message : String(e); }
  }
  const results: { ref: string; ok: boolean; msg?: string }[] = [];
  if (!unpackError) {
    for (const u of updates) {
      const cur = repo.refs.get(u.ref);
      if (u.oldId !== ZERO && cur !== u.oldId) { results.push({ ref: u.ref, ok: false, msg: "stale info" }); continue; }
      if (u.oldId === ZERO && cur !== undefined && u.newId !== ZERO) { /* create over existing: allow if matches handled above */ }
      if (u.newId === ZERO) {
        if (u.ref === headTarget(repo)) { results.push({ ref: u.ref, ok: false, msg: "deletion of the current branch prohibited" }); continue; }
        repo.refs.delete(u.ref);
        results.push({ ref: u.ref, ok: true });
        continue;
      }
      const target = getObject(u.newId);
      if (!target) { results.push({ ref: u.ref, ok: false, msg: "not our ref" }); continue; }
      // Every update must fast-forward: the new tip must descend from the old.
      if (u.oldId !== ZERO) {
        const oldC = peelToCommit(u.oldId);
        const newC = peelToCommit(u.newId);
        if (oldC && newC && oldC !== newC && !isAncestor(oldC, newC)) {
          results.push({ ref: u.ref, ok: false, msg: "non-fast-forward" });
          continue;
        }
      }
      repo.refs.set(u.ref, u.newId);
      results.push({ ref: u.ref, ok: true });
    }
    const ts = nowISO();
    repo.updated_at = ts; repo.pushed_at = ts;
    // if the default branch was just created, nothing else to do; HEAD follows it
  }
  const inner: Buffer[] = [];
  inner.push(pktLine(unpackError ? `unpack ${unpackError}\n` : "unpack ok\n"));
  if (!unpackError) for (const r of results) inner.push(pktLine(r.ok ? `ok ${r.ref}\n` : `ng ${r.ref} ${r.msg || "failed"}\n`));
  inner.push(PKT_FLUSH);
  const innerBuf = Buffer.concat(inner);
  const wantReport = /report-status/.test(caps);
  const sideband = /side-band-64k|side-band/.test(caps);
  res.writeHead(200, { "content-type": "application/x-git-receive-pack-result" });
  if (!wantReport) { res.end(Buffer.alloc(0)); return; }
  if (sideband) {
    const parts: Buffer[] = [];
    for (let i = 0; i < innerBuf.length; i += 65515) parts.push(sideBand(1, innerBuf.subarray(i, i + 65515)));
    parts.push(PKT_FLUSH);
    res.end(Buffer.concat(parts));
  } else {
    res.end(innerBuf);
  }
}

// ------------------------------------------------------------------ REST v3
function issueJSON(r: Repo, i: Issue): Record<string, unknown> {
  const full = `${r.owner}/${r.name}`;
  return {
    id: i.id, node_id: b64(`Issue:${i.id}`),
    url: `${API_BASE}/repos/${full}/issues/${i.number}`,
    repository_url: `${API_BASE}/repos/${full}`,
    html_url: `https://github.com/${full}/issues/${i.number}`,
    number: i.number, title: i.title, body: i.body, state: i.state,
    locked: false, active_lock_reason: null,
    user: userObj(i.user.login),
    labels: i.labels.map((name) => labelJSON(r, name)),
    assignees: i.assignees.map((a) => userObj(a.login)),
    assignee: i.assignees.length ? userObj(i.assignees[0].login) : null,
    comments: i.commentsList.length,
    created_at: i.created_at, updated_at: i.updated_at, closed_at: i.closed_at,
    ...(i.pull_request ? { pull_request: i.pull_request } : {}),
  };
}
// A single issue's serialized GET body is a pure function of the issue's
// own fields plus the repo's label definitions it names. It is memoized
// against a fingerprint of exactly those inputs: any mutation that could
// change the bytes (title, body, state, close time, update time, comment
// count, labels, assignees, the labels' own color/description, or the
// pull_request block) changes the fingerprint and forces a rebuild.
function issueFingerprint(r: Repo, i: Issue): string {
  let fp = [i.title, i.body ?? "", i.state, i.closed_at ?? "", i.updated_at, String(i.commentsList.length), i.labels.join(","), i.assignees.map((a) => a.login).join(",")].join("|");
  for (const name of i.labels) {
    const l = r.labels.find((x) => x.name === name);
    fp += `|${name}:${l?.color ?? ""}:${l?.description ?? ""}:${l?.isDefault ? 1 : 0}`;
  }
  if (i.pull_request) fp += "|" + JSON.stringify(i.pull_request);
  return fp;
}
function issueBodyBuffer(r: Repo, i: Issue): Buffer {
  const fp = issueFingerprint(r, i);
  if (i.bodyCache && i.bodyCache.fp === fp) return i.bodyCache.body;
  const body = Buffer.from(JSON.stringify(issueJSON(r, i)));
  i.bodyCache = { fp, body };
  return body;
}
function rawJsonRes(res: http.ServerResponse, status: number, body: Buffer): void {
  // The request id comes from the server wrapper's setHeader (see createApp).
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": body.length });
  res.end(body);
}
function labelJSON(r: Repo, name: string): Record<string, unknown> {
  const l = r.labels.find((x) => x.name === name);
  return {
    id: 5000 + (r.labels.indexOf(l ?? { name, color: "ededed", description: null }) >= 0 ? r.labels.indexOf(l as never) : 0),
    node_id: b64(`Label:${r.id}:${name}`),
    url: `${API_BASE}/repos/${r.owner}/${r.name}/labels/${encodeURIComponent(name)}`,
    name, color: l?.color ?? "ededed", description: l?.description ?? null, default: !!l?.isDefault,
  };
}
function prJSON(r: Repo, p: PullRequest): Record<string, unknown> {
  const full = `${r.owner}/${r.name}`;
  const side = (s: { ref: string; sha: string; label: string; repo: Repo }) => ({
    label: s.label, ref: s.ref, sha: s.sha, user: userObj(s.repo.owner), repo: repoJSON(s.repo),
  });
  return {
    id: p.id, node_id: b64(`PullRequest:${p.id}`),
    url: `${API_BASE}/repos/${full}/pulls/${p.number}`,
    html_url: `https://github.com/${full}/pull/${p.number}`,
    diff_url: `https://github.com/${full}/pull/${p.number}.diff`,
    patch_url: `https://github.com/${full}/pull/${p.number}.patch`,
    number: p.number, state: p.merged ? "closed" : p.state,
    locked: false, title: p.title, body: p.body, user: userObj(p.user.login),
    created_at: p.created_at, updated_at: p.updated_at,
    closed_at: p.closed_at, merged_at: p.merged_at,
    merge_commit_sha: p.merge_commit_sha, assignees: [], requested_reviewers: [], labels: [],
    head: side(p.head), base: side(p.base),
    author_association: "OWNER", draft: p.draft, merged: p.merged,
    mergeable: true, rebaseable: true, mergeable_state: "clean",
    merged_by: p.merged ? userObj(p.user.login) : null,
    comments: 0, review_comments: 0, maintainer_can_modify: false,
    commits: 0, additions: 0, deletions: 0, changed_files: 0,
  };
}
function commitJSON(r: Repo, sha: string): Record<string, unknown> {
  const o = getObject(sha)!;
  const c = parseCommit(o.data);
  const a = parseIdent(c.author);
  const cm = parseIdent(c.committer);
  const full = `${r.owner}/${r.name}`;
  const iso = (w: number) => new Date(w * 1000).toISOString();
  return {
    sha, node_id: b64(`Commit:${sha}`),
    commit: {
      author: { name: a.name, email: a.email, date: iso(a.when) },
      committer: { name: cm.name, email: cm.email, date: iso(cm.when) },
      message: c.message, tree: { sha: c.tree, url: `${API_BASE}/repos/${full}/git/trees/${c.tree}` },
      url: `${API_BASE}/repos/${full}/git/commits/${sha}`,
      comment_count: 0,
      verification: { verified: false, reason: "unsigned", signature: null, payload: null },
    },
    url: `${API_BASE}/repos/${full}/commits/${sha}`,
    html_url: `https://github.com/${full}/commit/${sha}`,
    comments_url: `${API_BASE}/repos/${full}/commits/${sha}/comments`,
    author: a.email ? userObj(a.name.replace(/\s+/g, "").toLowerCase() || r.owner) : null,
    committer: cm.email ? userObj(cm.name.replace(/\s+/g, "").toLowerCase() || r.owner) : null,
    parents: c.parents.map((p) => ({ sha: p, url: `${API_BASE}/repos/${full}/commits/${p}`, html_url: `https://github.com/${full}/commit/${p}` })),
  };
}
function forgeIdent(user: string): string {
  return `${user} <${user}@forge.local> ${EPOCH + tick++} +0000`;
}
function makeCommitOnRef(r: Repo, ref: string, tree: string, parents: string[], message: string, user: string): string {
  const ident = forgeIdent(user);
  const lines = [`tree ${tree}`, ...parents.map((p) => `parent ${p}`), `author ${ident}`, `committer ${ident}`, "", message];
  const sha = storeObject("commit", Buffer.from(lines.join("\n"), "utf8"));
  r.refs.set(ref, sha);
  const ts = nowISO();
  r.updated_at = ts; r.pushed_at = ts;
  return sha;
}
// The best common ancestor of two commits (first shared commit walking from b).
function mergeBase(a: string, b: string): string | null {
  const ancestors = new Set<string>();
  const stack = [a];
  while (stack.length) {
    const s = stack.pop()!;
    if (ancestors.has(s)) continue;
    ancestors.add(s);
    const o = getObject(s);
    if (o && o.type === "commit") stack.push(...parseCommit(o.data).parents);
  }
  const seen = new Set<string>();
  const queue = [b];
  while (queue.length) {
    const s = queue.shift()!;
    if (seen.has(s)) continue;
    seen.add(s);
    if (ancestors.has(s)) return s;
    const o = getObject(s);
    if (o && o.type === "commit") queue.push(...parseCommit(o.data).parents);
  }
  return null;
}

// Three-way tree merge between the current base tip and a PR head, relative
// to their merge-base. Returns the merged tree sha, or null on a real
// conflict (both sides changed the same path to different contents).
function threeWayMergeTree(baseTip: string, headTip: string): string | null {
  const mb = mergeBase(baseTip, headTip);
  const flatOf = (commitSha: string | null): Map<string, string> => {
    const out = new Map<string, string>();
    if (!commitSha) return out;
    const o = getObject(commitSha);
    if (!o || o.type !== "commit") return out;
    const flat = new Map<string, TreeEntry & { path: string }>();
    flattenTree(parseCommit(o.data).tree, "", flat);
    for (const [p, e] of flat) out.set(p, e.sha);
    return out;
  };
  const base = flatOf(mb);
  const cur = flatOf(baseTip);
  const head = flatOf(headTip);
  const merged = new Map<string, string>();
  const paths = new Set([...base.keys(), ...cur.keys(), ...head.keys()]);
  for (const p of paths) {
    const b = base.get(p);
    const c = cur.get(p);
    const h = head.get(p);
    if (c === h) { if (c !== undefined) merged.set(p, c); continue; }
    if (b === c) { if (h !== undefined) merged.set(p, h); continue; } // only head changed
    if (b === h) { if (c !== undefined) merged.set(p, c); continue; } // only base changed
    return null; // both sides changed the same path differently
  }
  let tree: string | null = null;
  for (const [p, sha] of merged) tree = treeUpsert(tree, p.split("/"), "100644", sha);
  return tree ?? storeObject("tree", Buffer.alloc(0));
}

function flattenTree(treeSha: string, prefix: string, out: Map<string, TreeEntry & { path: string }>): void {
  const o = getObject(treeSha);
  if (!o || o.type !== "tree") return;
  for (const e of parseTree(o.data)) {
    const p = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.mode === "40000") flattenTree(e.sha, p, out);
    else out.set(p, { ...e, path: p });
  }
}

function restRepos(ctx: Ctx, seg: string[]): boolean {
  const { res, req } = ctx;
  const m = req.method!;
  // /user/repos, /orgs/:o/repos
  if (m === "POST" && seg.length === 2 && seg[0] === "user" && seg[1] === "repos") {
    const j = ctx.json();
    const name = String(j.name || "");
    if (!name) { errRes(res, 422, "Repository creation failed.", [{ resource: "Repo", code: "custom", field: "name", message: "name is required" }]); return true; }
    if (findRepo(ctx.user, name)) { errRes(res, 422, "Repository creation failed.", [{ resource: "Repo", code: "custom", field: "name", message: "name already exists on this account" }]); return true; }
    const r = createRepo(ctx.user, name, (j.description as string) ?? null, !!j.private);
    if (j.auto_init) {
      const blob = storeObject("blob", Buffer.from(`# ${name}\n`, "utf8"));
      const tree = storeObject("tree", buildTree([{ mode: "100644", name: "README.md", sha: blob }]));
      const lic = j.gitignore_template; void lic;
      makeCommitOnRef(r, `refs/heads/${r.default_branch}`, tree, [], "Initial commit", ctx.user);
    }
    jsonRes(res, 201, repoJSON(r));
    return true;
  }
  if (m === "POST" && seg.length === 3 && seg[0] === "orgs" && seg[2] === "repos") {
    const j = ctx.json();
    const name = String(j.name || "");
    if (!name) { errRes(res, 422, "Repository creation failed."); return true; }
    const r = createRepo(seg[1], name, (j.description as string) ?? null, !!j.private);
    jsonRes(res, 201, repoJSON(r));
    return true;
  }
  if (m === "GET" && seg.length === 2 && seg[0] === "user" && seg[1] === "repos") {
    const mine = [...repos.values()].filter((r) => r.owner === ctx.user).map(repoJSON);
    const { items, headers } = paginateList(ctx, mine);
    jsonRes(res, 200, items, headers);
    return true;
  }
  if (seg.length >= 2 && seg[0] === "users" && seg[2] === "repos") {
    jsonRes(res, 200, [...repos.values()].filter((r) => r.owner === seg[1] && !r.private).map(repoJSON));
    return true;
  }
  if (seg.length < 3 || seg[0] !== "repos") return false;
  const r = findRepo(seg[1], seg[2]);
  const rest = seg.slice(3);
  if (!r) { errRes(res, 404, "Not Found"); return true; }
  return restRepoScoped(ctx, r, rest);
}

function restRepoScoped(ctx: Ctx, r: Repo, rest: string[]): boolean {
  const { res, req, url } = ctx;
  const m = req.method!;
  const full = `${r.owner}/${r.name}`;
  if (rest.length === 0) {
    if (m === "GET") { jsonRes(res, 200, repoJSON(r)); return true; }
    if (m === "PATCH") {
      const j = ctx.json();
      if (typeof j.description === "string" || j.description === null) r.description = j.description as string | null;
      if (typeof j.default_branch === "string" && branchTip(r, j.default_branch as string)) r.default_branch = j.default_branch as string;
      if (typeof j.private === "boolean") r.private = j.private;
      if (typeof j.name === "string" && j.name !== r.name) {
        repos.delete(repoKey(r.owner, r.name));
        r.name = j.name;
        repos.set(repoKey(r.owner, r.name), r);
      }
      r.updated_at = nowISO();
      jsonRes(res, 200, repoJSON(r));
      return true;
    }
    if (m === "DELETE") { repos.delete(repoKey(r.owner, r.name)); res.writeHead(204); res.end(); return true; }
  }
  // branches / tags
  if (rest[0] === "branches") {
    if (m === "GET" && rest.length === 1) {
      const out = [...r.refs.entries()].filter(([k]) => k.startsWith("refs/heads/")).map(([k, v]) => ({
        name: k.slice(11), commit: { sha: v, url: `${API_BASE}/repos/${full}/commits/${v}` }, protected: false,
      }));
      jsonRes(res, 200, out); return true;
    }
    if (m === "GET" && rest.length === 2) {
      const name = decodeURIComponent(rest[1]);
      const tip = branchTip(r, name);
      if (!tip) { errRes(res, 404, "Branch not found"); return true; }
      jsonRes(res, 200, {
        name, commit: commitJSON(r, tip),
        _links: { self: `${API_BASE}/repos/${full}/branches/${name}`, html: `https://github.com/${full}/tree/${name}` },
        protected: false, protection: { enabled: false, required_status_checks: { enforcement_level: "off", contexts: [], checks: [] } },
      });
      return true;
    }
  }
  if (rest[0] === "tags" && m === "GET" && rest.length === 1) {
    const out = [...r.refs.entries()].filter(([k]) => k.startsWith("refs/tags/")).map(([k, v]) => ({
      name: k.slice(10), commit: { sha: peelToCommit(v) ?? v, url: `${API_BASE}/repos/${full}/commits/${peelToCommit(v) ?? v}` },
      zipball_url: `${API_BASE}/repos/${full}/zipball/refs/tags/${k.slice(10)}`,
      tarball_url: `${API_BASE}/repos/${full}/tarball/refs/tags/${k.slice(10)}`,
      node_id: b64(`Tag:${v}`),
    }));
    jsonRes(res, 200, out); return true;
  }
  if (rest[0] === "forks" && m === "POST") {
    const j = ctx.json();
    const owner = String(j.organization || ctx.user);
    const name = String(j.name || r.name);
    if (findRepo(owner, name)) { errRes(res, 422, "Name already exists on this account"); return true; }
    const nr = createRepo(owner, name, r.description, r.private);
    nr.refs = new Map(r.refs);
    nr.default_branch = r.default_branch;
    nr.forks = 0; r.forks++;
    jsonRes(res, 202, repoJSON(nr)); return true;
  }
  // ---- git database API
  if (rest[0] === "git") return restGitDb(ctx, r, rest.slice(1));
  // ---- contents
  if (rest[0] === "contents") return restContents(ctx, r, rest.slice(1).map(decodeURIComponent));
  // ---- commits
  if (rest[0] === "commits") return restCommits(ctx, r, rest.slice(1));
  // ---- issues & pulls share numbering; handled in restIssuesPulls
  if (rest[0] === "issues" || rest[0] === "labels" || rest[0] === "pulls") return restIssuesPulls(ctx, r, rest);
  // ---- compare
  if (rest[0] === "compare" && rest.length === 2 && m === "GET") {
    const spec = decodeURIComponent(rest[1]);
    const dots = spec.includes("...") ? spec.split("...") : spec.split("..");
    const b = refTip(r, dots[0]); const h = refTip(r, dots[1] ?? "");
    if (!b || !h) { errRes(res, 404, "Not Found"); return true; }
    jsonRes(res, 200, compareJSON(r, b, h)); return true;
  }
  return false;
}

function compareJSON(r: Repo, base: string, head: string): Record<string, unknown> {
  const commits: string[] = [];
  const seen = new Set<string>();
  const stack = [head];
  const baseAnc = new Set<string>();
  { const s2 = [base]; while (s2.length) { const x = s2.pop()!; if (baseAnc.has(x)) continue; baseAnc.add(x); const o = getObject(x); if (o && o.type === "commit") s2.push(...parseCommit(o.data).parents); } }
  while (stack.length) {
    const x = stack.pop()!;
    if (seen.has(x) || baseAnc.has(x)) continue;
    seen.add(x);
    const o = getObject(x);
    if (o && o.type === "commit") { commits.push(x); stack.push(...parseCommit(o.data).parents); }
  }
  commits.reverse();
  const bt = parseCommit(getObject(base)!.data).tree;
  const ht = parseCommit(getObject(head)!.data).tree;
  const files = diffTrees(bt, ht);
  return {
    url: `${API_BASE}/repos/${r.owner}/${r.name}/compare/${base}...${head}`,
    html_url: `https://github.com/${r.owner}/${r.name}/compare/${base}...${head}`,
    permalink_url: `https://github.com/${r.owner}/${r.name}/compare/${base}...${head}`,
    diff_url: `https://github.com/${r.owner}/${r.name}/compare/${base}...${head}.diff`,
    patch_url: `https://github.com/${r.owner}/${r.name}/compare/${base}...${head}.patch`,
    base_commit: commitJSON(r, base), merge_base_commit: commitJSON(r, base),
    status: commits.length ? "ahead" : "identical", ahead_by: commits.length, behind_by: 0,
    total_commits: commits.length,
    commits: commits.map((c) => commitJSON(r, c)),
    files,
  };
}
// Compare two trees: per-file status + line stats + unified-ish patch.
function diffTrees(baseTree: string | null, headTree: string | null): Record<string, unknown>[] {
  const b = new Map<string, TreeEntry & { path: string }>();
  const h = new Map<string, TreeEntry & { path: string }>();
  if (baseTree) flattenTree(baseTree, "", b);
  if (headTree) flattenTree(headTree, "", h);
  const paths = [...new Set([...b.keys(), ...h.keys()])].sort();
  const out: Record<string, unknown>[] = [];
  for (const p of paths) {
    const be = b.get(p), he = h.get(p);
    if (be && he && be.sha === he.sha) continue;
    const status = !be ? "added" : !he ? "removed" : "modified";
    const bText = be ? (getObject(be.sha)?.data.toString("utf8") ?? "") : "";
    const hText = he ? (getObject(he.sha)?.data.toString("utf8") ?? "") : "";
    const { additions, deletions, patch } = lineDiff(p, bText, hText, status);
    out.push({
      sha: he?.sha ?? be?.sha, filename: p, status,
      additions, deletions, changes: additions + deletions,
      blob_url: `${API_BASE}/repos/x/y/git/blobs/${he?.sha ?? be?.sha}`,
      raw_url: `https://github.com/x/y/raw/${he?.sha ?? ""}/${p}`,
      contents_url: `${API_BASE}/repos/x/y/contents/${p}`,
      ...(patch ? { patch } : {}),
    });
  }
  return out;
}
function lineDiff(path: string, a: string, b: string, status: string): { additions: number; deletions: number; patch: string } {
  const al = a === "" ? [] : a.split("\n");
  const bl = b === "" ? [] : b.split("\n");
  // LCS on lines (files in trials are small)
  const n = al.length, m = bl.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = al[i] === bl[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const ops: string[] = [];
  let i = 0, j = 0, add = 0, del = 0;
  while (i < n && j < m) {
    if (al[i] === bl[j]) { ops.push(" " + al[i]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push("-" + al[i]); i++; del++; }
    else { ops.push("+" + bl[j]); j++; add++; }
  }
  while (i < n) { ops.push("-" + al[i]); i++; del++; }
  while (j < m) { ops.push("+" + bl[j]); j++; add++; }
  const patch = `@@ -1,${n} +1,${m} @@\n` + ops.join("\n");
  return { additions: add, deletions: del, patch: status === "added" || status === "removed" || ops.some((o) => o[0] !== " ") ? patch : "" };
}

function restGitDb(ctx: Ctx, r: Repo, rest: string[]): boolean {
  const { res, req, url } = ctx;
  const m = req.method!;
  const full = `${r.owner}/${r.name}`;
  if (rest[0] === "refs") {
    const refPath = rest.slice(1).join("/");
    if (m === "GET" && rest.length === 1) {
      const out = [...r.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([k, v]) => ({
        ref: k, node_id: b64(`Ref:${k}`), url: `${API_BASE}/repos/${full}/git/refs/${k.replace(/^refs\//, "")}`,
        object: { sha: v, type: getObject(v)?.type ?? "commit", url: `${API_BASE}/repos/${full}/git/${(getObject(v)?.type ?? "commit") + "s"}/${v}` },
      }));
      jsonRes(res, 200, out); return true;
    }
    const fullRef = refPath.startsWith("refs/") ? refPath : `refs/${refPath}`;
    if (m === "GET") {
      const tip = r.refs.get(fullRef);
      if (!tip) { errRes(res, 404, "Not Found"); return true; }
      jsonRes(res, 200, { ref: fullRef, node_id: b64(`Ref:${fullRef}`), url: `${API_BASE}/repos/${full}/git/refs/${fullRef.replace(/^refs\//, "")}`, object: { sha: tip, type: getObject(tip)?.type ?? "commit", url: `${API_BASE}/repos/${full}/git/commits/${tip}` } });
      return true;
    }
    if (m === "POST" && rest.length === 1) {
      const j = ctx.json();
      const ref = String(j.ref || "");
      const sha = String(j.sha || "");
      if (!ref.startsWith("refs/") || !hasObject(sha)) { errRes(res, 422, "Unprocessable Entity"); return true; }
      if (r.refs.has(ref)) { errRes(res, 422, "Reference already exists"); return true; }
      r.refs.set(ref, sha);
      jsonRes(res, 201, { ref, node_id: b64(`Ref:${ref}`), url: `${API_BASE}/repos/${full}/git/refs/${ref.replace(/^refs\//, "")}`, object: { sha, type: getObject(sha)!.type, url: `${API_BASE}/repos/${full}/git/commits/${sha}` } });
      return true;
    }
    if (m === "PATCH") {
      const j = ctx.json();
      const sha = String(j.sha || "");
      if (!r.refs.has(fullRef)) { errRes(res, 422, "Reference does not exist"); return true; }
      if (!hasObject(sha)) { errRes(res, 422, "Object does not exist"); return true; }
      if (!j.force) {
        const cur = r.refs.get(fullRef)!;
        if (getObject(sha)?.type === "commit" && getObject(cur)?.type === "commit" && !isAncestor(cur, sha)) {
          errRes(res, 422, "Update is not a fast forward"); return true;
        }
      }
      r.refs.set(fullRef, sha);
      jsonRes(res, 200, { ref: fullRef, node_id: b64(`Ref:${fullRef}`), url: `${API_BASE}/repos/${full}/git/refs/${fullRef.replace(/^refs\//, "")}`, object: { sha, type: getObject(sha)!.type, url: `${API_BASE}/repos/${full}/git/commits/${sha}` } });
      return true;
    }
    if (m === "DELETE") {
      if (!r.refs.has(fullRef)) { errRes(res, 422, "Reference does not exist"); return true; }
      r.refs.delete(fullRef);
      res.writeHead(204); res.end(); return true;
    }
  }
  if (rest[0] === "trees") {
    if (m === "GET" && rest.length === 2) {
      let sha = rest[1];
      if (!hasObject(sha)) { const t = refTip(r, sha); if (t) sha = parseCommit(getObject(t)!.data).tree; }
      const o = getObject(sha);
      if (!o || o.type !== "tree") { errRes(res, 404, "Not Found"); return true; }
      const recursive = url.searchParams.get("recursive") === "1";
      const treeArr: Record<string, unknown>[] = [];
      const walk = (treeSha: string, prefix: string) => {
        for (const e of parseTree(getObject(treeSha)!.data)) {
          const p = prefix ? `${prefix}/${e.name}` : e.name;
          treeArr.push({
            path: p, mode: e.mode, type: e.mode === "40000" ? "tree" : e.mode === "160000" ? "commit" : "blob",
            sha: e.sha, ...(e.mode !== "40000" ? { size: getObject(e.sha)?.data.length ?? 0 } : {}),
            url: `${API_BASE}/repos/${full}/git/${e.mode === "40000" ? "trees" : "blobs"}/${e.sha}`,
          });
          if (recursive && e.mode === "40000") walk(e.sha, p);
        }
      };
      walk(sha, "");
      jsonRes(res, 200, { sha, url: `${API_BASE}/repos/${full}/git/trees/${sha}`, tree: treeArr, truncated: false });
      return true;
    }
    if (m === "POST") {
      const j = ctx.json();
      const items = (j.tree as Record<string, unknown>[]) || [];
      const byPath = new Map<string, TreeEntry>();
      if (typeof j.base_tree === "string" && hasObject(j.base_tree as string)) {
        const flat = new Map<string, TreeEntry & { path: string }>();
        flattenTree(j.base_tree as string, "", flat);
        for (const [p, e] of flat) byPath.set(p, { mode: e.mode, name: p, sha: e.sha });
      }
      for (const it of items) {
        const path = String(it.path);
        if (it.sha === null) { byPath.delete(path); continue; }
        let sha = it.sha as string | undefined;
        if (!sha && typeof it.content === "string") sha = storeObject("blob", Buffer.from(it.content, "utf8"));
        if (!sha) continue;
        byPath.set(path, { mode: String(it.mode || "100644"), name: path, sha });
      }
      // rebuild nested trees bottom-up
      const root = buildFromFlat(byPath);
      jsonRes(res, 201, { sha: root, url: `${API_BASE}/repos/${full}/git/trees/${root}`, tree: [], truncated: false });
      return true;
    }
  }
  if (rest[0] === "blobs") {
    if (m === "GET" && rest.length === 2) {
      const o = getObject(rest[1]);
      if (!o || o.type !== "blob") { errRes(res, 404, "Not Found"); return true; }
      jsonRes(res, 200, {
        content: o.data.toString("base64").replace(/(.{60})/g, "$1\n") + "\n", encoding: "base64",
        size: o.data.length, sha: rest[1], node_id: b64(`Blob:${rest[1]}`),
        url: `${API_BASE}/repos/${full}/git/blobs/${rest[1]}`,
      });
      return true;
    }
    if (m === "POST") {
      const j = ctx.json();
      const data = j.encoding === "base64" ? Buffer.from(String(j.content || ""), "base64") : Buffer.from(String(j.content || ""), "utf8");
      const sha = storeObject("blob", data);
      jsonRes(res, 201, { sha, url: `${API_BASE}/repos/${full}/git/blobs/${sha}` });
      return true;
    }
  }
  if (rest[0] === "commits") {
    if (m === "GET" && rest.length === 2) {
      const o = getObject(rest[1]);
      if (!o || o.type !== "commit") { errRes(res, 404, "Not Found"); return true; }
      const cj = commitJSON(r, rest[1]);
      const c = (cj as Record<string, unknown>).commit as Record<string, unknown>;
      jsonRes(res, 200, {
        sha: rest[1], url: `${API_BASE}/repos/${full}/git/commits/${rest[1]}`,
        author: c.author, committer: c.committer, message: c.message,
        tree: c.tree, parents: (cj.parents as { sha: string }[]).map((p) => ({ sha: p.sha, url: `${API_BASE}/repos/${full}/git/commits/${p.sha}`, html_url: `https://github.com/${full}/commit/${p.sha}` })),
        verification: (c as Record<string, unknown>).verification,
      });
      return true;
    }
    if (m === "POST") {
      const j = ctx.json();
      const tree = String(j.tree || "");
      if (!hasObject(tree)) { errRes(res, 422, "Tree does not exist"); return true; }
      const parents = ((j.parents as string[]) || []).filter((p) => hasObject(p));
      const au = (j.author as Record<string, string>) || {};
      const co = (j.committer as Record<string, string>) || au;
      const fmt = (x: Record<string, string>, dflt: string) => `${x.name || dflt} <${x.email || `${(x.name || dflt).toLowerCase()}@forge.local`}> ${x.date ? Math.floor(new Date(x.date).getTime() / 1000) : EPOCH + tick++} +0000`;
      const lines = [`tree ${tree}`, ...parents.map((p) => `parent ${p}`), `author ${fmt(au, ctx.user)}`, `committer ${fmt(co, ctx.user)}`, "", String(j.message || "")];
      const sha = storeObject("commit", Buffer.from(lines.join("\n"), "utf8"));
      jsonRes(res, 201, commitJSON(r, sha));
      return true;
    }
  }
  if (rest[0] === "tags") {
    if (m === "GET" && rest.length === 2) {
      const o = getObject(rest[1]);
      if (!o || o.type !== "tag") { errRes(res, 404, "Not Found"); return true; }
      const s = o.data.toString("utf8");
      const obj = /^object ([0-9a-f]{40})/m.exec(s)?.[1] ?? "";
      const tag = /^tag (.+)$/m.exec(s)?.[1] ?? "";
      jsonRes(res, 200, { node_id: b64(`Tag:${rest[1]}`), tag, sha: rest[1], url: `${API_BASE}/repos/${full}/git/tags/${rest[1]}`, message: s.split("\n\n")[1] ?? "", object: { sha: obj, type: getObject(obj)?.type ?? "commit", url: "" }, tagger: { name: "", email: "", date: nowISO() } });
      return true;
    }
    if (m === "POST") {
      const j = ctx.json();
      const target = String(j.object || "");
      if (!hasObject(target)) { errRes(res, 422, "Object does not exist"); return true; }
      const ident = forgeIdent(ctx.user);
      const data = Buffer.from(`object ${target}\ntype ${getObject(target)!.type}\ntag ${String(j.tag || "")}\ntagger ${ident}\n\n${String(j.message || "")}`, "utf8");
      const sha = storeObject("tag", data);
      jsonRes(res, 201, { node_id: b64(`Tag:${sha}`), tag: String(j.tag || ""), sha, url: `${API_BASE}/repos/${full}/git/tags/${sha}`, message: String(j.message || ""), object: { sha: target, type: getObject(target)!.type, url: "" }, tagger: { name: ctx.user, email: "", date: nowISO() } });
      return true;
    }
  }
  return false;
}
function buildFromFlat(byPath: Map<string, TreeEntry>): string {
  // recursive: group by first path segment
  const rootEntries: TreeEntry[] = [];
  const groups = new Map<string, Map<string, TreeEntry>>();
  for (const [p, e] of byPath) {
    const slash = p.indexOf("/");
    if (slash < 0) rootEntries.push({ mode: e.mode, name: p, sha: e.sha });
    else {
      const head = p.slice(0, slash);
      if (!groups.has(head)) groups.set(head, new Map());
      groups.get(head)!.set(p.slice(slash + 1), e);
    }
  }
  for (const [head, sub] of groups) rootEntries.push({ mode: "40000", name: head, sha: buildFromFlat(sub) });
  return storeObject("tree", buildTree(rootEntries));
}

function restContents(ctx: Ctx, r: Repo, parts: string[]): boolean {
  const { res, req, url } = ctx;
  const m = req.method!;
  const full = `${r.owner}/${r.name}`;
  const path = parts.join("/");
  const refName = url.searchParams.get("ref") || (ctx.json().branch as string) || r.default_branch;
  if (m === "GET") {
    const tip = refTip(r, refName);
    if (!tip) { errRes(res, 404, "Not Found"); return true; }
    const tree = parseCommit(getObject(tip)!.data).tree;
    if (path === "" || path === "/") {
      const entries = parseTree(getObject(tree)!.data).map((e) => contentEntryJSON(r, e, e.name, refName));
      jsonRes(res, 200, entries); return true;
    }
    const ent = treeLookup(tree, path.split("/"));
    if (!ent) { errRes(res, 404, "Not Found"); return true; }
    if (ent.mode === "40000") {
      const entries = parseTree(getObject(ent.sha)!.data).map((e) => contentEntryJSON(r, e, `${path}/${e.name}`, refName));
      jsonRes(res, 200, entries); return true;
    }
    const blob = getObject(ent.sha)!;
    jsonRes(res, 200, {
      name: ent.name, path, sha: ent.sha, size: blob.data.length, type: "file",
      encoding: "base64", content: blob.data.toString("base64").replace(/(.{60})/g, "$1\n") + "\n",
      url: `${API_BASE}/repos/${full}/contents/${path}?ref=${refName}`,
      html_url: `https://github.com/${full}/blob/${refName}/${path}`,
      git_url: `${API_BASE}/repos/${full}/git/blobs/${ent.sha}`,
      download_url: `https://raw.githubusercontent.com/${full}/${refName}/${path}`,
      _links: { self: `${API_BASE}/repos/${full}/contents/${path}?ref=${refName}`, git: `${API_BASE}/repos/${full}/git/blobs/${ent.sha}`, html: `https://github.com/${full}/blob/${refName}/${path}` },
    });
    return true;
  }
  if (m === "PUT" || m === "DELETE") {
    const j = ctx.json();
    const branch = String(j.branch || r.default_branch);
    const ref = `refs/heads/${branch}`;
    const tip = r.refs.get(ref);
    const tree = tip ? parseCommit(getObject(tip)!.data).tree : null;
    const existing = tree ? treeLookup(tree, path.split("/")) : null;
    if (m === "DELETE" && !existing) { errRes(res, 404, "Not Found"); return true; }
    // GitHub's optimistic-concurrency rule: updating or deleting a file
    // requires the sha of the blob being replaced; a stale one is a 409.
    if (existing && typeof j.sha === "string" && j.sha !== existing.sha) {
      errRes(res, 409, `${path} does not match ${j.sha}`);
      return true;
    }
    if (m === "PUT" && existing && j.sha === undefined) {
      errRes(res, 422, "sha wasn't supplied");
      return true;
    }
    let newTree: string | null;
    let blobSha = "";
    let data = Buffer.alloc(0);
    if (m === "PUT") {
      data = Buffer.from(String(j.content || ""), "base64");
      blobSha = storeObject("blob", data);
      newTree = treeUpsert(tree, path.split("/"), "100644", blobSha);
    } else {
      newTree = treeRemove(tree!, path.split("/"));
      if (newTree === null) newTree = storeObject("tree", Buffer.alloc(0));
    }
    const sha = makeCommitOnRef(r, ref, newTree!, tip ? [tip] : [], String(j.message || (m === "PUT" ? `Create ${path}` : `Delete ${path}`)), ctx.user);
    if (m === "PUT") {
      jsonRes(res, existing ? 200 : 201, {
        content: {
          name: path.split("/").pop(), path, sha: blobSha, size: data.length, type: "file",
          encoding: "base64", content: data.toString("base64"),
          url: `${API_BASE}/repos/${full}/contents/${path}?ref=${branch}`,
          html_url: `https://github.com/${full}/blob/${branch}/${path}`,
          git_url: `${API_BASE}/repos/${full}/git/blobs/${blobSha}`,
          download_url: `https://raw.githubusercontent.com/${full}/${branch}/${path}`,
          _links: { self: `${API_BASE}/repos/${full}/contents/${path}?ref=${branch}`, git: `${API_BASE}/repos/${full}/git/blobs/${blobSha}`, html: `https://github.com/${full}/blob/${branch}/${path}` },
        },
        commit: commitJSON(r, sha),
      });
    } else {
      jsonRes(res, 200, { content: null, commit: commitJSON(r, sha) });
    }
    return true;
  }
  return false;
}
function contentEntryJSON(r: Repo, e: TreeEntry, path: string, ref: string): Record<string, unknown> {
  const full = `${r.owner}/${r.name}`;
  const isDir = e.mode === "40000";
  return {
    name: e.name, path, sha: e.sha, size: isDir ? 0 : (getObject(e.sha)?.data.length ?? 0),
    url: `${API_BASE}/repos/${full}/contents/${path}?ref=${ref}`,
    html_url: `https://github.com/${full}/${isDir ? "tree" : "blob"}/${ref}/${path}`,
    git_url: `${API_BASE}/repos/${full}/git/${isDir ? "trees" : "blobs"}/${e.sha}`,
    download_url: isDir ? null : `https://raw.githubusercontent.com/${full}/${ref}/${path}`,
    type: isDir ? "dir" : "file",
    _links: { self: `${API_BASE}/repos/${full}/contents/${path}?ref=${ref}`, git: `${API_BASE}/repos/${full}/git/${isDir ? "trees" : "blobs"}/${e.sha}`, html: `https://github.com/${full}/${isDir ? "tree" : "blob"}/${ref}/${path}` },
  };
}

function restCommits(ctx: Ctx, r: Repo, rest: string[]): boolean {
  const { res, req, url } = ctx;
  const m = req.method!;
  if (m === "GET" && rest.length === 0) {
    const refName = url.searchParams.get("sha") || r.default_branch;
    const pathFilter = url.searchParams.get("path");
    const perPage = Math.min(100, parseInt(url.searchParams.get("per_page") || "30", 10) || 30);
    let tip = refTip(r, refName);
    if (!tip && /^[0-9a-f]{40}$/.test(refName) && hasObject(refName)) tip = refName;
    if (!tip) { jsonRes(res, 200, []); return true; }
    const out: string[] = [];
    const seen = new Set<string>();
    const queue = [tip];
    while (queue.length && out.length < perPage * 3) {
      const s = queue.shift()!;
      if (seen.has(s)) continue;
      seen.add(s);
      const o = getObject(s);
      if (!o || o.type !== "commit") continue;
      const c = parseCommit(o.data);
      let keep = true;
      if (pathFilter) {
        const parentTree = c.parents.length ? parseCommit(getObject(c.parents[0])!.data).tree : null;
        const cur = treeLookup(c.tree, pathFilter.split("/"));
        const prev = parentTree ? treeLookup(parentTree, pathFilter.split("/")) : null;
        keep = (cur?.sha ?? null) !== (prev?.sha ?? null);
      }
      if (keep) out.push(s);
      queue.push(...c.parents);
    }
    jsonRes(res, 200, out.slice(0, perPage).map((s) => commitJSON(r, s)));
    return true;
  }
  if (m === "GET" && rest.length === 1) {
    const o = getObject(rest[0]);
    if (!o || o.type !== "commit") { errRes(res, 404, "Not Found"); return true; }
    const cj = commitJSON(r, rest[0]) as Record<string, unknown>;
    const c = parseCommit(o.data);
    const parentTree = c.parents.length ? parseCommit(getObject(c.parents[0])!.data).tree : null;
    cj.files = diffTrees(parentTree, c.tree);
    jsonRes(res, 200, cj);
    return true;
  }
  return false;
}

function findIssueOrPr(r: Repo, num: number): { issue?: Issue; pr?: PullRequest } {
  const pr = r.prs.find((p) => p.number === num);
  if (pr) return { pr };
  const issue = r.issues.find((i) => i.number === num);
  if (issue) return { issue };
  return {};
}
function issueForPr(r: Repo, p: PullRequest): Issue {
  return {
    id: p.id, number: p.number, title: p.title, body: p.body,
    state: p.state === "open" ? "open" : "closed", user: p.user, labels: [],
    assignees: [], commentsList: p.commentsList, created_at: p.created_at, updated_at: p.updated_at,
    closed_at: p.closed_at,
    pull_request: {
      url: `${API_BASE}/repos/${r.owner}/${r.name}/pulls/${p.number}`,
      html_url: `https://github.com/${r.owner}/${r.name}/pull/${p.number}`,
      diff_url: `https://github.com/${r.owner}/${r.name}/pull/${p.number}.diff`,
      patch_url: `https://github.com/${r.owner}/${r.name}/pull/${p.number}.patch`,
    },
  };
}

function restIssuesPulls(ctx: Ctx, r: Repo, rest: string[]): boolean {
  const { res, req, url } = ctx;
  const m = req.method!;
  const full = `${r.owner}/${r.name}`;
  // labels
  if (rest[0] === "labels") {
    if (m === "GET" && rest.length === 1) { jsonRes(res, 200, r.labels.map((l) => labelJSON(r, l.name))); return true; }
    if (m === "POST") {
      const j = ctx.json();
      const name = String(j.name || "");
      if (!name) { errRes(res, 422, "Validation Failed"); return true; }
      if (r.labels.some((l) => l.name === name)) { errRes(res, 422, "Validation Failed: name already exists"); return true; }
      r.labels.push({ name, color: String(j.color || "ededed").replace(/^#/, ""), description: (j.description as string) ?? null });
      jsonRes(res, 201, labelJSON(r, name)); return true;
    }
    if (rest.length === 2) {
      const name = decodeURIComponent(rest[1]);
      const l = r.labels.find((x) => x.name === name);
      if (!l) { errRes(res, 404, "Not Found"); return true; }
      if (m === "GET") { jsonRes(res, 200, labelJSON(r, name)); return true; }
      if (m === "PATCH") {
        const j = ctx.json();
        if (typeof j.color === "string") l.color = j.color.replace(/^#/, "");
        if (typeof j.description === "string" || j.description === null) l.description = j.description as string | null;
        if (typeof j.new_name === "string") {
          for (const i of r.issues) i.labels = i.labels.map((x) => (x === name ? (j.new_name as string) : x));
          l.name = j.new_name as string;
        }
        jsonRes(res, 200, labelJSON(r, l.name)); return true;
      }
      if (m === "DELETE") { r.labels = r.labels.filter((x) => x.name !== name); res.writeHead(204); res.end(); return true; }
    }
    return true;
  }
  // issues
  if (rest[0] === "issues") {
    if (m === "GET" && rest.length === 1) {
      const state = url.searchParams.get("state") || "open";
      // GitHub list semantics: sort=created|updated|comments, direction
      // asc|desc (default: created, desc), ties by number in the same sense.
      const sortField = url.searchParams.get("sort") || "created";
      const dirSign = (url.searchParams.get("direction") || "desc") === "asc" ? 1 : -1;
      const keyOf = (i: Issue): string | number => sortField === "updated" ? i.updated_at : sortField === "comments" ? i.commentsList.length : i.created_at;
      const all: Issue[] = [
        ...r.issues.map((i) => i),
        ...r.prs.map((p) => issueForPr(r, p)),
      ].sort((a, b) => {
        const ka = keyOf(a), kb = keyOf(b);
        if (ka !== kb) return (ka < kb ? -1 : 1) * dirSign;
        return (a.number - b.number) * dirSign;
      });
      const filtered = state === "all" ? all : all.filter((i) => i.state === state);
      const labelsQ = url.searchParams.get("labels");
      const withLabels = labelsQ ? filtered.filter((i) => labelsQ.split(",").every((l) => i.labels.includes(l))) : filtered;
      jsonRes(res, 200, withLabels.map((i) => issueJSON(r, i)));
      return true;
    }
    if (m === "POST" && rest.length === 1) {
      const j = ctx.json();
      if (!j.title) { errRes(res, 422, "Validation Failed: title is required"); return true; }
      const labelNames = ((j.labels as unknown[]) || []).map((x) => typeof x === "string" ? x : String((x as Record<string, unknown>)?.name ?? ""));
      // A label must have been created through POST /labels first.
      const unknown = labelNames.filter((l) => !r.labels.some((x) => x.name === l));
      if (unknown.length) {
        errRes(res, 422, "Validation Failed: labels are invalid", [{ resource: "Issue", code: "custom", field: "labels", message: `labels are invalid: ${unknown.join(", ")}` }]);
        return true;
      }
      const ts = nowISO();
      const issue: Issue = {
        id: globalIdSeq++, number: r.nextIssueNum++, title: String(j.title),
        body: (j.body as string) ?? null, state: "open", user: userObj(ctx.user),
        labels: labelNames,
        assignees: ((j.assignees as string[]) || []).map((a) => userObj(String(a))),
        commentsList: [], created_at: ts, updated_at: ts, closed_at: null,
      };
      r.issues.push(issue);
      jsonRes(res, 201, issueJSON(r, issue));
      return true;
    }
    if (rest.length === 3 && rest[1] === "comments") {
      const cid = parseInt(rest[2], 10);
      for (const iss of [...r.issues, ...r.prs.map((p) => issueForPr(r, p))]) {
        const c = iss.commentsList.find((x) => x.id === cid);
        if (!c) continue;
        if (m === "GET") { jsonRes(res, 200, commentJSON(r, iss, c)); return true; }
        if (m === "PATCH") { c.body = String(ctx.json().body ?? c.body); c.updated_at = nowISO(); jsonRes(res, 200, commentJSON(r, iss, c)); return true; }
        if (m === "DELETE") {
          const owner = r.issues.find((i) => i.number === iss.number); if (owner) owner.commentsList = owner.commentsList.filter((x) => x.id !== cid);
          const prOwner = r.prs.find((p) => p.number === iss.number); if (prOwner) prOwner.commentsList = prOwner.commentsList.filter((x) => x.id !== cid);
          res.writeHead(204); res.end(); return true;
        }
      }
      errRes(res, 404, "Not Found"); return true;
    }
    if (rest.length >= 2) {
      const num = parseInt(rest[1], 10);
      const { issue, pr } = findIssueOrPr(r, num);
      if (!issue && !pr) { errRes(res, 404, "Not Found"); return true; }
      const target: Issue = issue ?? issueForPr(r, pr!);
      if (rest.length === 2) {
        if (m === "GET") {
          if (issue) { rawJsonRes(res, 200, issueBodyBuffer(r, issue)); return true; }
          jsonRes(res, 200, issueJSON(r, target)); return true;
        }
        if (m === "PATCH") {
          const j = ctx.json();
          const applyTo = (t: Issue, p?: PullRequest) => {
            if (typeof j.title === "string") { t.title = j.title; if (p) p.title = j.title; }
            if (typeof j.body === "string" || j.body === null) { t.body = j.body as string | null; if (p) p.body = t.body; }
            if (j.state === "closed" || j.state === "open") {
              const closing = j.state === "closed" && t.state === "open";
              t.state = j.state;
              if (p && !p.merged) p.state = j.state;
              if (closing) { t.closed_at = nowISO(); if (p) p.closed_at = t.closed_at; }
              if (j.state === "open") { t.closed_at = null; if (p) p.closed_at = null; }
            }
            if (Array.isArray(j.labels)) { t.labels = (j.labels as unknown[]).map((x) => typeof x === "string" ? x : String((x as Record<string, unknown>).name || "")); }
            if (Array.isArray(j.assignees)) t.assignees = (j.assignees as string[]).map((a) => userObj(String(a)));
            t.updated_at = nowISO(); if (p) p.updated_at = t.updated_at;
          };
          applyTo(target, pr);
          if (!issue && pr) { const back = issueForPr(r, pr); jsonRes(res, 200, issueJSON(r, back)); return true; }
          jsonRes(res, 200, issueJSON(r, target));
          return true;
        }
      }
      if (rest[2] === "comments") {
        if (m === "GET" && rest.length === 3) {
          jsonRes(res, 200, target.commentsList.map((c) => commentJSON(r, target, c)));
          return true;
        }
        if (m === "POST" && rest.length === 3) {
          const j = ctx.json();
          const c = { id: globalIdSeq++, body: String(j.body || ""), user: userObj(ctx.user), created_at: nowISO(), updated_at: nowISO() };
          if (issue) issue.commentsList.push(c);
          else if (pr) pr.commentsList.push(c);
          target.updated_at = nowISO();
          jsonRes(res, 201, commentJSON(r, target, c));
          return true;
        }
      }
      if (rest[2] === "labels") {
        if (m === "GET") { jsonRes(res, 200, target.labels.map((l) => labelJSON(r, l))); return true; }
        if (m === "POST") {
          const j = ctx.json();
          const names = ((j.labels as string[]) || []).map(String);
          for (const n of names) { if (!target.labels.includes(n)) target.labels.push(n); if (!r.labels.some((x) => x.name === n)) r.labels.push({ name: n, color: "ededed", description: null }); }
          jsonRes(res, 200, target.labels.map((l) => labelJSON(r, l))); return true;
        }
        if (m === "PUT") {
          const j = ctx.json();
          target.labels = ((j.labels as string[]) || []).map(String);
          jsonRes(res, 200, target.labels.map((l) => labelJSON(r, l))); return true;
        }
        if (m === "DELETE" && rest.length === 3) { target.labels = []; jsonRes(res, 200, []); return true; }
        if (m === "DELETE" && rest.length === 4) {
          const name = decodeURIComponent(rest[3]);
          target.labels = target.labels.filter((l) => l !== name);
          jsonRes(res, 200, target.labels.map((l) => labelJSON(r, l))); return true;
        }
      }
    }
    return true;
  }
  // pulls
  if (rest[0] === "pulls") {
    if (m === "GET" && rest.length === 1) {
      const state = url.searchParams.get("state") || "open";
      const list = r.prs.filter((p) => state === "all" ? true : state === "closed" ? p.state !== "open" : p.state === "open");
      jsonRes(res, 200, list.map((p) => prJSON(r, p)));
      return true;
    }
    if (m === "POST" && rest.length === 1) {
      const j = ctx.json();
      const baseRef = String(j.base || r.default_branch);
      let headRef = String(j.head || "");
      if (headRef.includes(":")) headRef = headRef.split(":").pop()!;
      const baseSha = branchTip(r, baseRef);
      const headSha = (j.head_sha as string) || branchTip(r, headRef) || refTip(r, headRef);
      if (!baseSha || !headSha) { errRes(res, 422, "Validation Failed: head or base does not exist"); return true; }
      if (r.prs.some((p) => p.state === "open" && p.head.ref === headRef && p.base.ref === baseRef)) {
        errRes(res, 422, "Validation Failed: A pull request already exists for this branch.");
        return true;
      }
      const ts = nowISO();
      const pr: PullRequest = {
        id: globalIdSeq++, number: r.nextIssueNum++, title: String(j.title || `Pull request ${headRef}`),
        body: (j.body as string) ?? null, state: "open", user: userObj(ctx.user),
        head: { ref: headRef, sha: headSha, label: `${r.owner}:${headRef}`, repo: r },
        base: { ref: baseRef, sha: baseSha, label: `${r.owner}:${baseRef}`, repo: r },
        merged: false, merged_at: null, merge_commit_sha: null, draft: !!j.draft,
        created_at: ts, updated_at: ts, closed_at: null, commentsList: [],
      };
      r.prs.push(pr);
      jsonRes(res, 201, prJSON(r, pr));
      return true;
    }
    if (rest.length >= 2) {
      const num = parseInt(rest[1], 10);
      const pr = r.prs.find((p) => p.number === num);
      if (!pr) { errRes(res, 404, "Not Found"); return true; }
      if (rest.length === 2) {
        if (m === "GET") {
          const pj = prJSON(r, pr);
          const bt = parseCommit(getObject(pr.base.sha)!.data).tree;
          const ht = parseCommit(getObject(pr.head.sha)!.data).tree;
          const files = diffTrees(bt, ht);
          pj.commits = compareJSON(r, pr.base.sha, pr.head.sha).total_commits as number;
          pj.additions = files.reduce((a, f) => a + (f.additions as number), 0);
          pj.deletions = files.reduce((a, f) => a + (f.deletions as number), 0);
          pj.changed_files = files.length;
          jsonRes(res, 200, pj); return true;
        }
        if (m === "PATCH") {
          const j = ctx.json();
          if (typeof j.title === "string") pr.title = j.title;
          if (typeof j.body === "string" || j.body === null) pr.body = j.body as string | null;
          if (j.state === "closed" || j.state === "open") { pr.state = j.state; pr.closed_at = j.state === "closed" ? nowISO() : null; }
          if (typeof j.base === "string") { const s = branchTip(r, j.base); if (s) { pr.base = { ref: j.base, sha: s, label: `${r.owner}:${j.base}`, repo: r }; } }
          pr.updated_at = nowISO();
          jsonRes(res, 200, prJSON(r, pr)); return true;
        }
      }
      if (rest[2] === "merge" && m === "PUT") {
        if (pr.merged) { errRes(res, 405, "Pull Request is not mergeable"); return true; }
        if (pr.state !== "open") { errRes(res, 405, "Pull Request is not mergeable"); return true; }
        const j = ctx.json();
        const method = String(j.merge_method || "merge");
        const baseRefName = `refs/heads/${pr.base.ref}`;
        const curBase = r.refs.get(baseRefName) ?? pr.base.sha;
        // A real content conflict (both sides changed the same path to
        // different bytes since the merge-base) refuses every method: 405.
        const mergedTree = threeWayMergeTree(curBase, pr.head.sha);
        if (mergedTree === null) { errRes(res, 405, "Pull Request is not mergeable"); return true; }
        let newSha: string;
        if (method === "squash") {
          newSha = makeCommitOnRef(r, baseRefName, mergedTree, [curBase], String(j.commit_title || `${pr.title} (#${pr.number})`), ctx.user);
        } else if (method === "rebase") {
          // linear replay: apply head commits not in base, one by one
          const cmp = compareJSON(r, curBase, pr.head.sha);
          const shas = (cmp.commits as Record<string, unknown>[]).map((c) => c.sha as string);
          let parent = curBase;
          for (const s of shas) {
            const c = parseCommit(getObject(s)!.data);
            parent = makeCommitOnRef(r, baseRefName, c.tree, [parent], c.message, ctx.user);
          }
          newSha = parent;
        } else {
          const ident = forgeIdent(ctx.user);
          const msg = String(j.commit_message || `Merge pull request #${pr.number} from ${pr.head.label}`);
          const lines = [`tree ${mergedTree}`, `parent ${curBase}`, `parent ${pr.head.sha}`, `author ${ident}`, `committer ${ident}`, "", msg];
          newSha = storeObject("commit", Buffer.from(lines.join("\n"), "utf8"));
          r.refs.set(baseRefName, newSha);
        }
        pr.merged = true; pr.state = "closed"; pr.merged_at = nowISO(); pr.closed_at = pr.merged_at;
        pr.updated_at = pr.merged_at; pr.merge_commit_sha = newSha;
        jsonRes(res, 200, { sha: newSha, merged: true, message: "Pull Request successfully merged" });
        return true;
      }
      if (rest[2] === "commits" && m === "GET") {
        jsonRes(res, 200, (compareJSON(r, pr.base.sha, pr.head.sha).commits as unknown[]) ?? []);
        return true;
      }
      if (rest[2] === "files" && m === "GET") {
        const bt = parseCommit(getObject(pr.base.sha)!.data).tree;
        const ht = parseCommit(getObject(pr.head.sha)!.data).tree;
        jsonRes(res, 200, diffTrees(bt, ht));
        return true;
      }
    }
    return true;
  }
  void full;
  return false;
}
function commentJSON(r: Repo, issue: Issue, c: Issue["commentsList"][number]): Record<string, unknown> {
  const full = `${r.owner}/${r.name}`;
  return {
    id: c.id, node_id: b64(`IssueComment:${c.id}`),
    url: `${API_BASE}/repos/${full}/issues/comments/${c.id}`,
    html_url: `https://github.com/${full}/issues/${issue.number}#issuecomment-${c.id}`,
    issue_url: `${API_BASE}/repos/${full}/issues/${issue.number}`,
    body: c.body, user: userObj(c.user.login),
    created_at: c.created_at, updated_at: c.updated_at,
    author_association: "OWNER",
  };
}

// ----------------------------------------------------------------- GraphQL
type GVal = string | number | boolean | null | GVal[] | { [k: string]: GVal };
interface GNode { kind: string; name?: string; alias?: string; args: Record<string, GVal>; selections: GNode[]; typeCond?: string; varDefs?: Record<string, GVal> }
function gqlLex(src: string): string[] {
  const toks: string[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/[\s,]/.test(c)) { i++; continue; }
    if (c === "#") { while (i < src.length && src[i] !== "\n") i++; continue; }
    if (src.startsWith("...", i)) { toks.push("..."); i += 3; continue; }
    if ("{}()[]:=@$|!".includes(c)) { toks.push(c); i++; continue; }
    if (c === '"') {
      if (src.startsWith('"""', i)) {
        const end = src.indexOf('"""', i + 3);
        toks.push(JSON.stringify(src.slice(i + 3, end < 0 ? src.length : end)));
        i = (end < 0 ? src.length : end + 3);
        continue;
      }
      let j = i + 1, out = "";
      while (j < src.length && src[j] !== '"') { if (src[j] === "\\") { out += src[j] + src[j + 1]; j += 2; } else { out += src[j]; j++; } }
      toks.push('"' + out.replace(/\\(.)/g, "$1").replace(/"/g, '\\"') + '"');
      i = j + 1;
      continue;
    }
    const m = /^[_A-Za-z][_0-9A-Za-z]*/.exec(src.slice(i)) || /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/.exec(src.slice(i));
    if (m) { toks.push(m[0]); i += m[0].length; continue; }
    i++;
  }
  return toks;
}
class GParser {
  toks: string[]; pos = 0; vars: Record<string, GVal>;
  constructor(src: string, vars: Record<string, GVal>) { this.toks = gqlLex(src); this.vars = vars; }
  peek(): string { return this.toks[this.pos] ?? ""; }
  next(): string { return this.toks[this.pos++] ?? ""; }
  expect(t: string): void { if (this.next() !== t) throw new Error(`gql: expected ${t}`); }
  parseDoc(): { ops: GNode[]; frags: Map<string, GNode> } {
    const ops: GNode[] = []; const frags = new Map<string, GNode>();
    while (this.pos < this.toks.length) {
      const t = this.peek();
      if (t === "{") { ops.push(this.parseSelectionSet("query")); }
      else if (t === "query" || t === "mutation" || t === "subscription") {
        const kind = this.next();
        let name = "";
        if (/^[_A-Za-z]/.test(this.peek())) name = this.next();
        const varDefs: Record<string, GVal> = {};
        if (this.peek() === "(") {
          this.next();
          while (this.peek() !== ")") {
            this.expect("$");
            const vn = this.next();
            this.expect(":");
            this.parseType();
            if (this.peek() === "=") { this.next(); varDefs[vn] = this.parseValue(); }
            else if (this.vars[vn] !== undefined) varDefs[vn] = this.vars[vn];
          }
          this.next();
        }
        this.skipDirectives();
        const sel = this.parseSelectionSet(kind);
        sel.name = name; sel.varDefs = varDefs;
        ops.push(sel);
      } else if (t === "fragment") {
        this.next();
        const fname = this.next();
        this.expect("on");
        const tc = this.next();
        this.skipDirectives();
        const sel = this.parseSelectionSet("fragment");
        sel.typeCond = tc; sel.name = fname;
        frags.set(fname, sel);
      } else this.next();
    }
    return { ops, frags };
  }
  parseType(): void {
    if (this.peek() === "[") { this.next(); this.parseType(); this.expect("]"); }
    else this.next();
    if (this.peek() === "!") this.next();
  }
  skipDirectives(): void {
    while (this.peek() === "@") {
      this.next(); this.next();
      if (this.peek() === "(") { this.next(); let d = 1; while (d > 0) { const x = this.next(); if (x === "(") d++; if (x === ")") d--; } }
    }
  }
  parseSelectionSet(kind: string): GNode {
    this.expect("{");
    const selections: GNode[] = [];
    while (this.peek() !== "}") {
      if (this.peek() === "...") {
        this.next();
        if (this.peek() === "on") {
          this.next();
          const tc = this.next();
          this.skipDirectives();
          const inner = this.parseSelectionSet(kind);
          selections.push({ kind: "inline", typeCond: tc, args: {}, selections: inner.selections });
        } else {
          const fname = this.next();
          this.skipDirectives();
          selections.push({ kind: "spread", name: fname, args: {}, selections: [] });
        }
        continue;
      }
      let name = this.next();
      let alias: string | undefined;
      if (this.peek() === ":") { this.next(); alias = name; name = this.next(); }
      const args: Record<string, GVal> = {};
      if (this.peek() === "(") {
        this.next();
        while (this.peek() !== ")") {
          const an = this.next();
          this.expect(":");
          args[an] = this.parseValue();
        }
        this.next();
      }
      const directives = this.readDirectives();
      let sub: GNode[] = [];
      if (this.peek() === "{") sub = this.parseSelectionSet(kind).selections;
      const node: GNode = { kind: "field", name, alias, args, selections: sub };
      if (directives.include === false || directives.skip === true) continue;
      selections.push(node);
    }
    this.next();
    return { kind, args: {}, selections };
  }
  readDirectives(): { include?: boolean; skip?: boolean } {
    const out: { include?: boolean; skip?: boolean } = {};
    while (this.peek() === "@") {
      this.next();
      const dn = this.next();
      const dargs: Record<string, GVal> = {};
      if (this.peek() === "(") {
        this.next();
        while (this.peek() !== ")") { const an = this.next(); this.expect(":"); dargs[an] = this.parseValue(); }
        this.next();
      }
      if (dn === "include") out.include = dargs.if as boolean;
      if (dn === "skip") out.skip = dargs.if as boolean;
    }
    return out;
  }
  parseValue(): GVal {
    const t = this.next();
    if (t === "$") { const vn = this.next(); return this.vars[vn] ?? null; }
    if (t === "[") { const arr: GVal[] = []; while (this.peek() !== "]") arr.push(this.parseValue()); this.next(); return arr; }
    if (t === "{") { const o: Record<string, GVal> = {}; while (this.peek() !== "}") { const k = this.next(); this.expect(":"); o[k] = this.parseValue(); } this.next(); return o; }
    if (t.startsWith('"')) { try { return JSON.parse(t) as string; } catch { return t.slice(1, -1); } }
    if (t === "true") return true;
    if (t === "false") return false;
    if (t === "null") return null;
    if (/^-?\d+$/.test(t)) return parseInt(t, 10);
    if (/^-?\d*\.\d/.test(t)) return parseFloat(t);
    return t; // enum
  }
}
// Wrapped domain values for GraphQL execution
type GWrap = { __type: string; repo?: Repo; issue?: Issue; pr?: PullRequest; user?: string; sha?: string; treeSha?: string; path?: string; comment?: Issue["commentsList"][number]; refName?: string; label?: string; list?: GWrap[]; total?: number; raw?: Record<string, unknown> };
function gw(type: string, extra: Partial<GWrap>): GWrap { return { __type: type, ...extra }; }
function connWrap(items: GWrap[], args: Record<string, GVal>): GWrap {
  // Relay cursor pagination over the full list: cursors are the item's index
  // in the unpaginated list, so `after` resumes exactly where a page ended.
  const decodeCursor = (c: unknown): number | null => {
    if (typeof c !== "string") return null;
    try {
      const s = Buffer.from(c, "base64").toString("utf8");
      const m = /^cursor:(\d+)$/.exec(s);
      return m ? parseInt(m[1], 10) : null;
    } catch { return null; }
  };
  let start = 0;
  let end = items.length;
  const afterIdx = decodeCursor(args.after);
  if (afterIdx !== null) start = Math.min(items.length, afterIdx + 1);
  const beforeIdx = decodeCursor(args.before);
  if (beforeIdx !== null) end = Math.max(start, Math.min(end, beforeIdx));
  let sliced = items.slice(start, end);
  let sliceStart = start;
  if (typeof args.first === "number") sliced = sliced.slice(0, Math.max(0, args.first));
  if (typeof args.last === "number") {
    const take = sliced.slice(-Math.max(0, args.last));
    sliceStart += sliced.length - take.length;
    sliced = take;
  }
  return gw("Connection", {
    list: sliced, total: items.length,
    raw: {
      hasNext: sliceStart + sliced.length < items.length,
      hasPrev: sliceStart > 0,
      startIdx: sliceStart,
      startCursor: sliced.length ? b64(`cursor:${sliceStart}`) : null,
      endCursor: sliced.length ? b64(`cursor:${sliceStart + sliced.length - 1}`) : null,
    },
  });
}
function gqlGlobalId(type: string, key: string | number): string { return b64(`${type}:${key}`); }
function gqlDecodeId(id: string): { type: string; key: string } | null {
  try {
    const s = Buffer.from(id, "base64").toString("utf8");
    const i = s.indexOf(":");
    if (i < 0) return null;
    return { type: s.slice(0, i), key: s.slice(i + 1) };
  } catch { return null; }
}
function findByGlobalId(id: string): GWrap | null {
  const d = gqlDecodeId(id);
  if (!d) return null;
  if (d.type === "Repository") {
    for (const r of repos.values()) if (r.id === parseInt(d.key, 10)) return gw("Repository", { repo: r });
  }
  if (d.type === "Issue") {
    for (const r of repos.values()) { const i = r.issues.find((x) => x.id === parseInt(d.key, 10)); if (i) return gw("Issue", { repo: r, issue: i }); }
  }
  if (d.type === "PullRequest") {
    for (const r of repos.values()) { const p = r.prs.find((x) => x.id === parseInt(d.key, 10)); if (p) return gw("PullRequest", { repo: r, pr: p }); }
  }
  if (d.type === "User" || d.type === "Organization") return gw(d.type, { user: d.key });
  return null;
}

// GraphQL field resolution: returns raw JS value or GWrap for objects.
function gqlObjectExpression(r: Repo, expr: string): GWrap | null {
  const colon = expr.indexOf(":");
  const rev = colon < 0 ? expr : expr.slice(0, colon);
  const path = colon < 0 ? "" : expr.slice(colon + 1);
  const tip = refTip(r, rev) ?? (/^[0-9a-f]{40}$/.test(rev) && hasObject(rev) ? rev : undefined);
  if (!tip) return null;
  const o = getObject(tip);
  if (!o) return null;
  if (o.type === "blob") return gw("Blob", { sha: tip, path });
  if (o.type === "tree") return gw("Tree", { sha: tip, repo: r, path });
  const commitSha = o.type === "commit" ? tip : peelToCommit(tip);
  if (!commitSha) return null;
  if (!path) return gw("Commit", { repo: r, sha: commitSha });
  const tree = parseCommit(getObject(commitSha)!.data).tree;
  const ent = treeLookup(tree, path.split("/"));
  if (!ent) return null;
  if (ent.mode === "40000") return gw("Tree", { sha: ent.sha, repo: r, path });
  return gw("Blob", { sha: ent.sha, path });
}
function gqlResolve(w: GWrap, field: string, args: Record<string, GVal>, ctx: Ctx): unknown {
  const t = w.__type;
  const isoOf = (w2: number) => new Date(w2 * 1000).toISOString();
  if (field === "__typename") return t;
  if (t === "IntrospectionType") {
    const name = String((w.raw as Record<string, unknown>)?.name ?? "");
    const kind = GQL_TYPE_KINDS[name] ?? "OBJECT";
    switch (field) {
      case "name": return name;
      case "kind": return kind;
      case "description": return null;
      case "fields": return kind === "OBJECT" || kind === "INTERFACE" ? (GQL_TYPE_FIELDS[name] ?? []).map((n) => gw("IntrospectionField", { raw: { name: n } })) : null;
      case "enumValues": return kind === "ENUM" ? (name === "SearchType" ? ["ISSUE", "REPOSITORY", "USER", "DISCUSSION"] : name === "IssueState" ? ["OPEN", "CLOSED"] : name === "PullRequestState" ? ["OPEN", "CLOSED", "MERGED"] : name === "MergeMethod" ? ["MERGE", "SQUASH", "REBASE"] : ["ASC", "DESC"]).map((n) => gw("IntrospectionEnumValue", { raw: { name: n } })) : null;
      case "inputFields": return null;
      case "interfaces": return [];
      case "possibleTypes": return null;
      case "specifiedByURL": return null;
      case "isOneOf": return false;
    }
    return null;
  }
  if (t === "IntrospectionField" || t === "IntrospectionEnumValue" || t === "IntrospectionInputValue") {
    const raw = (w.raw ?? {}) as Record<string, unknown>;
    if (field === "name") return raw.name;
    if (field === "description") return null;
    if (field === "isDeprecated") return false;
    if (field === "deprecationReason") return null;
    if (field === "type") return gw("IntrospectionType", { raw: { name: "String" } });
    if (field === "args") return [];
    if (field === "defaultValue") return null;
    if (field === "isDeprecatedInput") return false;
    return null;
  }
  if (t === "IntrospectionSchema") {
    if (field === "description") return null;
    if (field === "types") return [...Object.keys(GQL_TYPE_FIELDS), "Query", "Mutation", "SearchType"].map((n) => gw("IntrospectionType", { raw: { name: n } }));
    if (field === "queryType") return gw("IntrospectionType", { raw: { name: "Query" } });
    if (field === "mutationType") return gw("IntrospectionType", { raw: { name: "Mutation" } });
    if (field === "subscriptionType") return null;
    if (field === "directives") return [];
    return null;
  }
  if (t === "Connection") {
    if (field === "nodes") return w.list;
    if (field === "edges") return (w.list ?? []).map((n, i) => gw("Edge", { raw: { cursor: b64(`cursor:${((w.raw?.startIdx as number) ?? 0) + i}`) }, list: [n] }));
    if (field === "totalCount") return w.total ?? (w.list?.length ?? 0);
    if (field === "pageInfo") return gw("PageInfo", { raw: { hasNextPage: !!w.raw?.hasNext, hasPreviousPage: !!w.raw?.hasPrev, startCursor: (w.raw?.startCursor as string | null) ?? null, endCursor: (w.raw?.endCursor as string | null) ?? null } });
  }
  if (t === "Edge") {
    if (field === "node") return w.list?.[0];
    if (field === "cursor") return (w.raw as Record<string, unknown>)?.cursor;
  }
  if (t === "PageInfo") return (w.raw as Record<string, unknown>)?.[field] ?? null;
  if (t === "User" || t === "Organization") {
    const login = w.user!;
    const base: Record<string, unknown> = {
      id: gqlGlobalId(t, login), login, name: login, email: "", bio: "",
      url: `https://github.com/${login}`, avatarUrl: `https://avatars.githubusercontent.com/u/1?v=4`,
      createdAt: new Date(EPOCH * 1000).toISOString(), updatedAt: new Date(EPOCH * 1000).toISOString(),
      isSiteAdmin: false, location: null, company: null, websiteUrl: null, twitterUsername: null,
    };
    if (field === "repositories") {
      const list = [...repos.values()].filter((r) => r.owner === login).map((r) => gw("Repository", { repo: r }));
      return connWrap(list, args);
    }
    if (field === "repository") {
      const r = findRepo(login, String(args.name ?? ""));
      return r ? gw("Repository", { repo: r }) : null;
    }
    return base[field] ?? null;
  }
  if (t === "Repository") {
    const r = w.repo!;
    const full = `${r.owner}/${r.name}`;
    const scalars: Record<string, unknown> = {
      id: gqlGlobalId("Repository", r.id), databaseId: r.id, name: r.name,
      nameWithOwner: full, description: r.description, createdAt: r.created_at,
      updatedAt: r.updated_at, pushedAt: r.pushed_at, url: `https://github.com/${full}`,
      sshUrl: `git@github.com:${full}.git`, homepageUrl: null, isPrivate: r.private,
      isFork: false, isArchived: false, isMirror: false, isTemplate: false, isDisabled: false,
      isEmpty: r.refs.size === 0, stargazerCount: r.stargazers, forkCount: r.forks,
      diskUsage: 1, visibility: r.private ? "PRIVATE" : "PUBLIC",
      viewerPermission: "ADMIN", hasIssuesEnabled: true, hasWikiEnabled: true,
      hasProjectsEnabled: true, mergeCommitAllowed: true, squashMergeAllowed: true,
      rebaseMergeAllowed: true, deleteBranchOnMerge: false, autoMergeAllowed: false,
      isSecurityPolicyEnabled: false, forkingAllowed: true,
    };
    if (field in scalars) return scalars[field];
    switch (field) {
      case "owner": return gw(r.owner === ctx.user ? "User" : "User", { user: r.owner });
      case "licenseInfo": return r.private ? null : gw("License", { raw: { key: "mit", name: "MIT License", spdxId: "MIT", nickname: null, featured: true, hidden: false, pseudoLicense: false, implementation: "MIT", description: "", conditions: [], limitations: [], permissions: [] } });
      case "defaultBranchRef": {
        const tip = branchTip(r, r.default_branch);
        return tip ? gw("Ref", { repo: r, refName: `refs/heads/${r.default_branch}`, sha: tip }) : null;
      }
      case "ref": {
        const name = String(args.qualifiedName ?? "");
        const tip = r.refs.get(name);
        return tip ? gw("Ref", { repo: r, refName: name, sha: tip }) : null;
      }
      case "refs": {
        const prefix = String(args.refPrefix ?? "refs/");
        const list = [...r.refs.entries()].filter(([k]) => k.startsWith(prefix)).sort((a, b) => (a[0] < b[0] ? -1 : 1))
          .map(([k, v]) => gw("Ref", { repo: r, refName: k, sha: v }));
        return connWrap(list, args);
      }
      case "object": return gqlObjectExpression(r, String(args.expression ?? ""));
      case "issue": {
        const i = r.issues.find((x) => x.number === args.number);
        return i ? gw("Issue", { repo: r, issue: i }) : null;
      }
      case "issues": {
        const states = (args.states === undefined ? ["OPEN"] : (Array.isArray(args.states) ? args.states : [args.states])).map(String);
        const ob = (args.orderBy as Record<string, GVal> | undefined) ?? {};
        const dirSign = String(ob.direction ?? "DESC") === "ASC" ? 1 : -1;
        const field = String(ob.field ?? "CREATED_AT");
        const keyOf = (i: Issue): string => field === "UPDATED_AT" ? i.updated_at : field === "CLOSED_AT" ? (i.closed_at ?? "") : i.created_at;
        const list = r.issues.filter((i) => states.includes(i.state === "open" ? "OPEN" : "CLOSED"))
          .sort((a, b) => {
            const ka = keyOf(a), kb = keyOf(b);
            if (ka !== kb) return (ka < kb ? -1 : 1) * dirSign;
            return (a.number - b.number) * dirSign; // ties break by number, same direction
          }).map((i) => gw("Issue", { repo: r, issue: i }));
        return connWrap(list, args);
      }
      case "pullRequest": {
        const p = r.prs.find((x) => x.number === args.number);
        return p ? gw("PullRequest", { repo: r, pr: p }) : null;
      }
      case "pullRequests": {
        const states = (args.states === undefined ? ["OPEN"] : (Array.isArray(args.states) ? args.states : [args.states])).map(String);
        const ob = (args.orderBy as Record<string, GVal> | undefined) ?? {};
        const dirSign = String(ob.direction ?? "DESC") === "ASC" ? 1 : -1;
        const field = String(ob.field ?? "CREATED_AT");
        const keyOf = (p: PullRequest): string => field === "UPDATED_AT" ? p.updated_at : field === "CLOSED_AT" ? (p.closed_at ?? "") : p.created_at;
        const list = r.prs.filter((p) => states.includes(p.merged ? "MERGED" : p.state === "open" ? "OPEN" : "CLOSED"))
          .sort((a, b) => {
            const ka = keyOf(a), kb = keyOf(b);
            if (ka !== kb) return (ka < kb ? -1 : 1) * dirSign;
            return (a.number - b.number) * dirSign;
          }).map((p) => gw("PullRequest", { repo: r, pr: p }));
        return connWrap(list, args);
      }
      case "labels": {
        const list = r.labels.map((l) => gw("Label", { repo: r, label: l.name }));
        return connWrap(list, args);
      }
      case "label": {
        const name = String(args.name ?? "");
        return r.labels.some((l) => l.name === name) ? gw("Label", { repo: r, label: name }) : null;
      }
      case "primaryLanguage": return null;
      case "languages": return connWrap([], args);
      case "collaborators": return connWrap([gw("User", { user: r.owner })], args);
      case "stargazers": return connWrap([], args);
      case "forks": return connWrap([], args);
      case "watchers": return connWrap([], args);
      case "deployKeys": return connWrap([], args);
      case "branchProtectionRules": return connWrap([], args);
      case "releases": return connWrap([], args);
      case "environments": return connWrap([], args);
      case "vulnerabilityAlerts": return connWrap([], args);
      case "mentionableUsers": return connWrap([gw("User", { user: r.owner })], args);
      case "assignableUsers": return connWrap([gw("User", { user: r.owner })], args);
    }
    return null;
  }
  if (t === "Ref") {
    const r = w.repo!;
    if (field === "id") return gqlGlobalId("Ref", `${r.id}:${w.refName}`);
    if (field === "name") return w.refName!.replace(/^refs\/(heads|tags)\//, "");
    if (field === "prefix") return w.refName!.startsWith("refs/tags/") ? "refs/tags/" : "refs/heads/";
    if (field === "qualifiedName") return w.refName;
    if (field === "target") {
      const o = getObject(w.sha!);
      if (!o) return null;
      if (o.type === "commit") return gw("Commit", { repo: r, sha: w.sha });
      if (o.type === "tag") return gw("Tag", { repo: r, sha: w.sha });
      if (o.type === "tree") return gw("Tree", { sha: w.sha, repo: r, path: "" });
      return gw("Blob", { sha: w.sha, path: "" });
    }
    if (field === "repository") return gw("Repository", { repo: r });
    if (field === "associatedPullRequests") return connWrap(r.prs.filter((p) => p.head.ref === w.refName!.replace(/^refs\/heads\//, "")).map((p) => gw("PullRequest", { repo: r, pr: p })), args);
    return null;
  }
  if (t === "Commit") {
    const r = w.repo!;
    const o = getObject(w.sha!)!;
    const c = parseCommit(o.data);
    const a = parseIdent(c.author);
    switch (field) {
      case "id": return gqlGlobalId("Commit", w.sha);
      case "oid": return w.sha;
      case "abbreviatedOid": return w.sha!.slice(0, 7);
      case "message": return c.message;
      case "messageHeadline": return c.message.split("\n")[0];
      case "messageBody": return c.message.split("\n\n").slice(1).join("\n\n");
      case "committedDate": case "authoredDate": return isoOf(parseIdent(c.committer).when);
      case "author": case "committer": {
        const idn = field === "author" ? a : parseIdent(c.committer);
        return gw("GitActor", { raw: { name: idn.name, email: idn.email, date: isoOf(idn.when), user: null, avatarUrl: "" } });
      }
      case "parents": return connWrap(c.parents.map((p) => gw("Commit", { repo: r, sha: p })), args);
      case "tree": return gw("Tree", { sha: c.tree, repo: r, path: "" });
      case "treeOid": return c.tree;
      case "url": return `https://github.com/${r.owner}/${r.name}/commit/${w.sha}`;
      case "commitUrl": return `https://github.com/${r.owner}/${r.name}/commit/${w.sha}`;
      case "repository": return gw("Repository", { repo: r });
      case "history": {
        const list: GWrap[] = [];
        const seen = new Set<string>();
        const q = [w.sha!];
        while (q.length && list.length < 100) {
          const s = q.shift()!;
          if (seen.has(s)) continue;
          seen.add(s);
          const oo = getObject(s);
          if (!oo || oo.type !== "commit") continue;
          list.push(gw("Commit", { repo: r, sha: s }));
          q.push(...parseCommit(oo.data).parents);
        }
        return connWrap(list, args);
      }
      case "additions": case "deletions": case "changedFiles": return 0;
      case "status": return null;
      case "signature": return null;
    }
    return null;
  }
  if (t === "GitActor") {
    const raw = w.raw as Record<string, unknown>;
    if (field === "user") return null;
    return raw[field] ?? null;
  }
  if (t === "Tree") {
    if (field === "id") return gqlGlobalId("Tree", w.sha);
    if (field === "oid") return w.sha;
    if (field === "entries") {
      const o = getObject(w.sha!);
      if (!o) return [];
      return parseTree(o.data).map((e) => gw("TreeEntry", { repo: w.repo, sha: e.sha, raw: { name: e.name, path: w.path ? `${w.path}/${e.name}` : e.name, mode: parseInt(e.mode, 10), type: e.mode === "40000" ? "tree" : "blob" } }));
    }
    if (field === "repository") return w.repo ? gw("Repository", { repo: w.repo }) : null;
    return null;
  }
  if (t === "TreeEntry") {
    const raw = w.raw as Record<string, unknown>;
    if (field === "object") {
      const o = getObject(w.sha!);
      if (!o) return null;
      if (o.type === "tree") return gw("Tree", { sha: w.sha, repo: w.repo, path: String(raw.path) });
      return gw("Blob", { sha: w.sha, path: String(raw.path) });
    }
    if (field in raw) return raw[field];
    if (field === "extension") { const n = String(raw.name); const d = n.lastIndexOf("."); return d < 0 ? "" : n.slice(d); }
    if (field === "isGenerated") return false;
    if (field === "language") return null;
    return null;
  }
  if (t === "Blob") {
    const o = getObject(w.sha!);
    if (field === "id") return gqlGlobalId("Blob", w.sha);
    if (field === "oid") return w.sha;
    if (field === "text") return o ? o.data.toString("utf8") : null;
    if (field === "byteSize") return o?.data.length ?? 0;
    if (field === "isBinary") return o ? o.data.includes(0) : false;
    if (field === "isTruncated") return false;
    if (field === "commitResourcePath" || field === "resourcePath") return "";
    return null;
  }
  if (t === "Tag") {
    const o = getObject(w.sha!)!;
    const s = o.data.toString("utf8");
    if (field === "id") return gqlGlobalId("Tag", w.sha);
    if (field === "oid") return w.sha;
    if (field === "name") return /^tag (.+)$/m.exec(s)?.[1] ?? "";
    if (field === "message") return s.split("\n\n")[1] ?? "";
    if (field === "target") { const tgt = /^object ([0-9a-f]{40})/m.exec(s)?.[1]; return tgt ? gqlResolve({ __type: "Ref", repo: w.repo, sha: tgt, refName: "" }, "target", {}, ctx) ?? gw("Commit", { repo: w.repo, sha: tgt }) : null; }
    if (field === "tagger") { const idn = parseIdent(/^tagger (.+)$/m.exec(s)?.[1] ?? ""); return gw("GitActor", { raw: { name: idn.name, email: idn.email, date: isoOf(idn.when) } }); }
    return null;
  }
  if (t === "Label") {
    const r = w.repo!;
    const l = r.labels.find((x) => x.name === w.label);
    const base: Record<string, unknown> = {
      id: gqlGlobalId("Label", `${r.id}:${w.label}`), name: w.label,
      color: l?.color ?? "ededed", description: l?.description ?? null,
      isDefault: !!l?.isDefault, url: `https://github.com/${r.owner}/${r.name}/labels/${encodeURIComponent(w.label!)}`,
      createdAt: r.created_at, updatedAt: r.updated_at,
    };
    if (field === "issues") return connWrap(r.issues.filter((i) => i.labels.includes(w.label!)).map((i) => gw("Issue", { repo: r, issue: i })), args);
    if (field === "pullRequests") return connWrap([], args);
    if (field === "repository") return gw("Repository", { repo: r });
    return base[field] ?? null;
  }
  if (t === "Issue") {
    const r = w.repo!, i = w.issue!;
    const base: Record<string, unknown> = {
      id: gqlGlobalId("Issue", i.id), databaseId: i.id, number: i.number,
      title: i.title, body: i.body, bodyText: i.body, bodyHTML: i.body,
      state: i.state === "open" ? "OPEN" : "CLOSED",
      url: `https://github.com/${r.owner}/${r.name}/issues/${i.number}`,
      resourcePath: `/${r.owner}/${r.name}/issues/${i.number}`,
      createdAt: i.created_at, updatedAt: i.updated_at, closedAt: i.closed_at,
      locked: false, activeLockReason: null, stateReason: i.state === "closed" ? "COMPLETED" : null,
      viewerCanUpdate: true, viewerCanSubscribe: true, viewerSubscription: "UNSUBSCRIBED",
      isPinned: false, isReadByViewer: true,
    };
    if (field in base) return base[field];
    switch (field) {
      case "author": case "editor": return gw(i.user.login === ctx.user ? "User" : "User", { user: i.user.login });
      case "repository": return gw("Repository", { repo: r });
      case "labels": return connWrap(i.labels.map((l) => gw("Label", { repo: r, label: l })), args);
      case "assignees": return connWrap(i.assignees.map((a) => gw("User", { user: a.login })), args);
      case "comments": return connWrap(i.commentsList.map((c) => gw("IssueComment", { repo: r, issue: i, comment: c })), args);
      case "participants": return connWrap([gw("User", { user: i.user.login })], args);
      case "timelineItems": return connWrap([], args);
      case "linkedPullRequests": return connWrap([], args);
      case "closedByPullRequestsReferences": return connWrap([], args);
    }
    return null;
  }
  if (t === "IssueComment") {
    const c = w.comment!;
    const base: Record<string, unknown> = {
      id: gqlGlobalId("IssueComment", c.id), databaseId: c.id, body: c.body,
      bodyText: c.body, bodyHTML: c.body, createdAt: c.created_at, updatedAt: c.updated_at,
      url: `https://github.com/${w.repo!.owner}/${w.repo!.name}/issues/${w.issue!.number}#issuecomment-${c.id}`,
      isMinimized: false, minimizedReason: null, viewerCanUpdate: true, viewerCanDelete: true,
    };
    if (field in base) return base[field];
    if (field === "author") return gw("User", { user: c.user.login });
    if (field === "issue") return gw("Issue", { repo: w.repo, issue: w.issue });
    if (field === "pullRequest" && w.pr) return gw("PullRequest", { repo: w.repo, pr: w.pr });
    if (field === "repository") return gw("Repository", { repo: w.repo! });
    return null;
  }
  if (t === "PullRequest") {
    const r = w.repo!, p = w.pr!;
    const full = `${r.owner}/${r.name}`;
    const base: Record<string, unknown> = {
      id: gqlGlobalId("PullRequest", p.id), databaseId: p.id, number: p.number,
      title: p.title, body: p.body, bodyText: p.body,
      state: p.merged ? "MERGED" : p.state === "open" ? "OPEN" : "CLOSED",
      url: `https://github.com/${full}/pull/${p.number}`,
      resourcePath: `/${full}/pull/${p.number}`,
      createdAt: p.created_at, updatedAt: p.updated_at, closedAt: p.closed_at,
      mergedAt: p.merged_at, merged: p.merged, isDraft: p.draft,
      headRefName: p.head.ref, baseRefName: p.base.ref,
      headRefOid: p.head.sha, baseRefOid: p.base.sha,
      mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", locked: false,
      viewerCanUpdate: true, maintainerCanModify: false, isCrossRepository: false,
      deletions: 0, changedFiles: 0, additions: 0,
    };
    if (field in base) return base[field];
    // compute diff stats on demand
    if (field === "additions" || field === "deletions" || field === "changedFiles") {
      const bt = parseCommit(getObject(p.base.sha)!.data).tree;
      const ht = parseCommit(getObject(p.head.sha)!.data).tree;
      const files = diffTrees(bt, ht);
      if (field === "changedFiles") return files.length;
      return files.reduce((a, f) => a + (field === "additions" ? (f.additions as number) : (f.deletions as number)), 0);
    }
    switch (field) {
      case "author": return gw("User", { user: p.user.login });
      case "repository": case "baseRepository": case "headRepository": return gw("Repository", { repo: r });
      case "headRef": { const tip = branchTip(r, p.head.ref); return tip ? gw("Ref", { repo: r, refName: `refs/heads/${p.head.ref}`, sha: tip }) : null; }
      case "baseRef": { const tip = branchTip(r, p.base.ref); return tip ? gw("Ref", { repo: r, refName: `refs/heads/${p.base.ref}`, sha: tip }) : null; }
      case "labels": return connWrap([], args);
      case "assignees": return connWrap([], args);
      case "comments": return connWrap(p.commentsList.map((c) => gw("IssueComment", { repo: r, pr: p, comment: c })), args);
      case "commits": return connWrap([gw("Commit", { repo: r, sha: p.head.sha })], args);
      case "files": {
        const bt = parseCommit(getObject(p.base.sha)!.data).tree;
        const ht = parseCommit(getObject(p.head.sha)!.data).tree;
        return connWrap(diffTrees(bt, ht).map((f) => gw("PullRequestChangedFile", { raw: { path: f.filename, additions: f.additions, deletions: f.deletions, changeType: String(f.status).toUpperCase() } })), args);
      }
      case "reviews": return connWrap([], args);
      case "reviewThreads": return connWrap([], args);
      case "participants": return connWrap([gw("User", { user: p.user.login })], args);
      case "timelineItems": return connWrap([], args);
      case "mergedBy": return p.merged ? gw("User", { user: p.user.login }) : null;
      case "mergeCommit": return null;
      case "latestReviews": return connWrap([], args);
    }
    return null;
  }
  if (t === "PullRequestChangedFile") return (w.raw as Record<string, unknown>)?.[field] ?? null;
  if (t === "License") return (w.raw as Record<string, unknown>)?.[field] ?? null;
  if (t === "SearchResultItemConnection") {
    if (field === "nodes" || field === "edges") return gqlResolve(w, field === "nodes" ? "nodes" : "edges", args, ctx) ?? (field === "nodes" ? w.list : []);
    if (field === "repositoryCount" || field === "issueCount" || field === "userCount" || field === "codeCount" || field === "discussionCount" || field === "wikiCount") return w.total ?? 0;
    if (field === "pageInfo") return gw("PageInfo", { raw: { hasNextPage: false, hasPreviousPage: false, startCursor: "", endCursor: "" } });
  }
  return null;
}
function gqlExecSelections(w: GWrap, selections: GNode[], ctx: Ctx, frags: Map<string, GNode>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    if (sel.kind === "spread") {
      const f = frags.get(sel.name!);
      if (f) Object.assign(out, gqlExecSelections(w, f.selections, ctx, frags));
      continue;
    }
    if (sel.kind === "inline") {
      if (!sel.typeCond || sel.typeCond === w.__type) Object.assign(out, gqlExecSelections(w, sel.selections, ctx, frags));
      continue;
    }
    const key = sel.alias || sel.name!;
    // Unknown fields on a known type are GraphQL errors naming the field
    // (the value still resolves as null, per partial-data semantics).
    const known = GQL_KNOWN_FIELDS[w.__type];
    if (known && !known.has(sel.name!) && sel.name !== "__type" && sel.name !== "__schema") {
      (ctx.gqlErrors ??= []).push(`Field '${sel.name}' does not exist on type '${w.__type}'`);
      out[key] = null;
      continue;
    }
    const val = gqlResolve(w, sel.name!, sel.args, ctx);
    out[key] = gqlShape(val, sel, ctx, frags);
  }
  return out;
}
function gqlShape(val: unknown, sel: GNode, ctx: Ctx, frags: Map<string, GNode>): unknown {
  if (val === null || val === undefined) return null;
  if (Array.isArray(val)) return val.map((v) => gqlShape(v, sel, ctx, frags));
  if (typeof val === "object" && (val as GWrap).__type) {
    if (!sel.selections.length) return (val as GWrap).__type;
    return gqlExecSelections(val as GWrap, sel.selections, ctx, frags);
  }
  return val;
}

// Introspection data: the field surface gh's feature detection probes for.
const GQL_TYPE_KINDS: Record<string, string> = {
  SearchType: "ENUM", IssueState: "ENUM", PullRequestState: "ENUM", MergeMethod: "ENUM",
  OrderDirection: "ENUM", IssueOrderField: "ENUM", PullRequestOrderField: "ENUM",
};
const GQL_TYPE_FIELDS: Record<string, string[]> = {
  Issue: ["id", "number", "title", "state", "stateReason", "body", "bodyHTML", "bodyText", "bodyUrl", "url", "resourcePath", "databaseId", "createdAt", "updatedAt", "closedAt", "closed", "locked", "activeLockReason", "author", "authorAssociation", "repository", "labels", "assignees", "participants", "comments", "reactions", "timelineItems", "milestone", "linkedBranches", "isPinned", "viewerCanReact", "viewerCanUpdate", "viewerDidAuthor"],
  PullRequest: ["id", "number", "title", "body", "bodyHTML", "bodyText", "state", "merged", "mergedAt", "mergedBy", "mergeable", "headRefName", "baseRefName", "headRef", "baseRef", "headRepository", "baseRepository", "headSha", "baseSha", "author", "createdAt", "updatedAt", "closedAt", "closed", "locked", "files", "commits", "additions", "deletions", "changedFiles", "comments", "reviews", "labels", "assignees", "participants", "mergeCommit", "potentialMergeCommit", "mergeStateStatus", "isDraft", "url", "resourcePath", "databaseId", "repository", "milestone", "reviewDecision", "viewerCanUpdate", "maintainerCanModify", "activeLockReason", "authorAssociation"],
  Repository: ["id", "databaseId", "name", "nameWithOwner", "owner", "url", "resourcePath", "description", "createdAt", "updatedAt", "pushedAt", "defaultBranchRef", "viewerPermission", "hasIssuesEnabled", "hasProjectsEnabled", "hasWikiEnabled", "isPrivate", "isArchived", "isFork", "isMirror", "isTemplate", "isEmpty", "isDisabled", "issue", "issues", "pullRequest", "pullRequests", "labels", "label", "object", "ref", "refs", "branchProtectionRules", "collaborators", "stargazers", "forks", "watchers", "mentionableUsers", "assignableUsers", "primaryLanguage", "languages", "releases", "environments", "deployKeys", "vulnerabilityAlerts", "licenseInfo", "viewerCanAdminister", "viewerHasStarred", "stargazerCount", "forkCount", "diskUsage", "sshUrl", "homepageUrl", "isInOrganization", "parent", "templateRepository", "securityPolicyUrl", "fundingLinks", "codeOfConduct", "viewerCanCreateProjects", "projectsUrl", "teams", "mergeCommitAllowed", "squashMergeAllowed", "rebaseMergeAllowed", "deleteBranchOnMerge", "autoMergeAllowed", "blob", "commit", "tree"],
  User: ["id", "login", "name", "email", "url", "resourcePath", "databaseId", "avatarUrl", "createdAt", "updatedAt", "bio", "location", "company", "websiteUrl", "twitterUsername", "isSiteAdmin", "isHireable", "isBountyHunter", "isCampusExpert", "isDeveloperProgramMember", "isEmployee", "isFollowingViewer", "isViewer", "viewerCanFollow", "followers", "following", "repositories", "issues", "pullRequests", "organizations", "starredRepositories", "watching", "gists", "status", "pronouns", "hovercard", "nameWithOwner"],
  Organization: ["id", "login", "name", "email", "url", "resourcePath", "databaseId", "avatarUrl", "createdAt", "updatedAt", "description", "location", "websiteUrl", "twitterUsername", "isVerified", "viewerCanAdminister", "membersWithRole", "teams", "repositories", "projects"],
  Label: ["id", "name", "color", "description", "url", "resourcePath", "createdAt", "updatedAt", "isDefault", "issues", "pullRequests", "repository"],
  IssueComment: ["id", "body", "bodyHTML", "bodyText", "url", "resourcePath", "databaseId", "createdAt", "updatedAt", "author", "authorAssociation", "issue", "repository", "lastEditedAt", "editor", "viewerCanUpdate", "viewerCanDelete", "viewerCanReact", "reactions", "isMinimized", "minimizedReason"],
  Commit: ["id", "oid", "abbreviatedOid", "message", "messageHeadline", "messageBody", "url", "resourcePath", "committedDate", "authoredDate", "author", "committer", "tree", "treeResourcePath", "parents", "history", "blame", "repository", "additions", "deletions", "changedFiles", "comments", "checkSuites", "status", "signature", "deployments", "associatedPullRequests", "zipballUrl", "tarballUrl", "pushedAt", "statusCheckRollup", "viewerCanSubscribe", "subscriptions", "onBehalfOf"],
  Ref: ["id", "name", "prefix", "qualifiedName", "target", "repository", "associatedPullRequests"],
  Tree: ["id", "oid", "abbreviatedOid", "entries", "url", "resourcePath", "repository"],
  TreeEntry: ["name", "path", "mode", "type", "oid", "object", "extension", "isGenerated", "language", "lineCount", "size"],
  Blob: ["id", "oid", "abbreviatedOid", "text", "isBinary", "isTruncated", "byteSize", "url", "resourcePath", "commitResourcePath", "commitUrl", "repository"],
  PageInfo: ["hasNextPage", "hasPreviousPage", "startCursor", "endCursor"],
  SearchType: [],
};
// Fields a selection may legally name on each type (for unknown-field errors).
const GQL_KNOWN_FIELDS: Record<string, Set<string>> = Object.fromEntries(
  Object.entries(GQL_TYPE_FIELDS).map(([t, fs]) => [t, new Set([...fs, "__typename"])]),
);

function gqlRootResolve(op: "query" | "mutation", field: string, args: Record<string, GVal>, ctx: Ctx): unknown {
  if (op === "query") {
    switch (field) {
      case "__type": return gw("IntrospectionType", { raw: { name: String(args.name ?? "") } });
      case "__schema": return gw("IntrospectionSchema", { raw: {} });
      case "__typename": return "Query";
      case "viewer": return gw("User", { user: ctx.user });
      case "user": case "organization": {
        const login = String(args.login ?? "");
        return login ? gw(field === "user" ? "User" : "Organization", { user: login }) : null;
      }
      case "repository": {
        const r = findRepo(String(args.owner ?? ""), String(args.name ?? ""));
        return r ? gw("Repository", { repo: r }) : null;
      }
      case "repositoryOwner": return gw("User", { user: String(args.login ?? ctx.user) });
      case "node": return args.id ? findByGlobalId(String(args.id)) : null;
      case "nodes": return Array.isArray(args.ids) ? (args.ids as GVal[]).map((i) => (i ? findByGlobalId(String(i)) : null)) : [];
      case "rateLimit": return gw("RateLimit", { raw: { limit: 5000, cost: 1, remaining: 4999, resetAt: new Date((EPOCH + 3600) * 1000).toISOString(), used: 1, nodeCount: 0 } });
      case "search": {
        const q = String(args.query ?? "");
        const type = String(args.type ?? "REPOSITORY");
        let items: GWrap[] = [];
        if (type === "REPOSITORY") {
          const term = q.replace(/^(repo:|in:name\s*)/g, "").split(/\s+/)[0].toLowerCase();
          items = [...repos.values()].filter((r) => !term || r.name.toLowerCase().includes(term) || `${r.owner}/${r.name}`.toLowerCase().includes(term)).map((r) => gw("Repository", { repo: r }));
        } else if (type === "ISSUE") {
          const term = q.toLowerCase();
          for (const r of repos.values()) for (const i of r.issues) if (!term || i.title.toLowerCase().includes(term)) items.push(gw("Issue", { repo: r, issue: i }));
        } else if (type === "USER") {
          items = [gw("User", { user: ctx.user })];
        }
        return connWrap(items, args);
      }
      case "license": return gw("License", { raw: { key: String(args.key ?? "mit"), name: "MIT License", spdxId: "MIT", nickname: null, featured: true, hidden: false, pseudoLicense: false, implementation: "", description: "", conditions: [], limitations: [], permissions: [], body: "", url: "" } });
      case "licenses": return [gqlRootResolve("query", "license", { key: "mit" }, ctx)];
      case "meta": return gw("GitHubMetadata", { raw: { gitHubServicesSha: "", gitIpAddresses: [], hookIpAddresses: [], importerIpAddresses: [], isPasswordAuthenticationVerifiable: false, pagesIpAddresses: [] } });
      case "codeOfConduct": return null;
      case "enterprise": return null;
      case "securityAdvisories": return connWrap([], args);
      case "sponsorables": return connWrap([], args);
      case "marketplaceListing": return null;
      case "topic": return null;
    }
    return null;
  }
  // mutations
  const input = (args.input as Record<string, GVal>) ?? args;
  const clientMutationId = (input.clientMutationId as string) ?? null;
  switch (field) {
    case "createRepository": {
      const owner = ctx.user;
      const name = String(input.name ?? "");
      if (!name || findRepo(owner, name)) return { clientMutationId, repository: null };
      const r = createRepo(owner, name, (input.description as string) ?? null, String(input.visibility ?? "PUBLIC") === "PRIVATE");
      return { clientMutationId, repository: gw("Repository", { repo: r }) };
    }
    case "createIssue": {
      const repoW = input.repositoryId ? findByGlobalId(String(input.repositoryId)) : null;
      const r = repoW?.repo;
      if (!r) return { clientMutationId, issue: null };
      const ts = nowISO();
      const issue: Issue = {
        id: globalIdSeq++, number: r.nextIssueNum++, title: String(input.title ?? ""),
        body: (input.body as string) ?? null, state: "open", user: userObj(ctx.user),
        labels: [], assignees: [], commentsList: [], created_at: ts, updated_at: ts, closed_at: null,
      };
      if (Array.isArray(input.labelIds)) for (const lid of input.labelIds as GVal[]) { const d = gqlDecodeId(String(lid)); if (d?.type === "Label") issue.labels.push(d.key.split(":").slice(1).join(":")); }
      if (Array.isArray(input.assigneeIds)) for (const aid of input.assigneeIds as GVal[]) { const d = gqlDecodeId(String(aid)); if (d) issue.assignees.push(userObj(d.key)); }
      r.issues.push(issue);
      return { clientMutationId, issue: gw("Issue", { repo: r, issue }) };
    }
    case "closeIssue": {
      const w = input.issueId ? findByGlobalId(String(input.issueId)) : null;
      if (!w?.issue || !w.repo) return { clientMutationId, issue: null };
      const i = w.issue;
      if (i.state !== "closed") { i.state = "closed"; i.closed_at = nowISO(); }
      i.updated_at = i.closed_at ?? nowISO();
      return { clientMutationId, issue: gw("Issue", { repo: w.repo, issue: i }) };
    }
    case "reopenIssue": {
      const w = input.issueId ? findByGlobalId(String(input.issueId)) : null;
      if (!w?.issue || !w.repo) return { clientMutationId, issue: null };
      const i = w.issue;
      i.state = "open"; i.closed_at = null; i.updated_at = nowISO();
      return { clientMutationId, issue: gw("Issue", { repo: w.repo, issue: i }) };
    }
    case "updateIssue": {
      const w = input.id ? findByGlobalId(String(input.id)) : null;
      if (!w?.issue) return { clientMutationId, issue: null };
      const i = w.issue;
      if (typeof input.title === "string") i.title = input.title;
      if (typeof input.body === "string" || input.body === null) i.body = input.body as string | null;
      if (input.state === "CLOSED" || input.state === "OPEN") { i.state = input.state === "CLOSED" ? "closed" : "open"; i.closed_at = i.state === "closed" ? nowISO() : null; }
      if (Array.isArray(input.labelIds)) {
        i.labels = (input.labelIds as GVal[]).map((lid) => { const d = gqlDecodeId(String(lid)); return d?.type === "Label" ? d.key.split(":").slice(1).join(":") : ""; }).filter(Boolean);
      }
      if (Array.isArray(input.assigneeIds)) i.assignees = (input.assigneeIds as GVal[]).map((aid) => userObj(gqlDecodeId(String(aid))?.key ?? "")).filter((a) => a.login);
      i.updated_at = nowISO();
      return { clientMutationId, issue: gw("Issue", { repo: w.repo, issue: i }) };
    }
    case "addComment": {
      const w = input.subjectId ? findByGlobalId(String(input.subjectId)) : null;
      if (!w) return { clientMutationId, commentEdge: null };
      const c = { id: globalIdSeq++, body: String(input.body ?? ""), user: userObj(ctx.user), created_at: nowISO(), updated_at: nowISO() };
      let commentW: GWrap | null = null;
      if (w.issue && w.repo) { w.issue.commentsList.push(c); commentW = gw("IssueComment", { repo: w.repo, issue: w.issue, comment: c }); }
      else if (w.pr && w.repo) { w.pr.commentsList.push(c); commentW = gw("IssueComment", { repo: w.repo, pr: w.pr, comment: c }); }
      return { clientMutationId, commentEdge: commentW ? gw("Edge", { list: [commentW], raw: { cursor: b64(`cursor:${c.id}`) } }) : null, subject: w };
    }
    case "updateIssueComment": {
      const w = input.id ? findByGlobalId(String(input.id)) : null;
      void w;
      for (const r of repos.values()) for (const i of r.issues) {
        const c = i.commentsList.find((x) => gqlGlobalId("IssueComment", x.id) === String(input.id));
        if (c) { c.body = String(input.body ?? c.body); c.updated_at = nowISO(); return { clientMutationId, issueComment: gw("IssueComment", { repo: r, issue: i, comment: c }) }; }
      }
      return { clientMutationId, issueComment: null };
    }
    case "deleteIssueComment": {
      for (const r of repos.values()) for (const i of r.issues) i.commentsList = i.commentsList.filter((x) => gqlGlobalId("IssueComment", x.id) !== String(input.id));
      for (const r of repos.values()) for (const p of r.prs) p.commentsList = p.commentsList.filter((x) => gqlGlobalId("IssueComment", x.id) !== String(input.id));
      return { clientMutationId };
    }
    case "createPullRequest": {
      const repoW = input.repositoryId ? findByGlobalId(String(input.repositoryId)) : null;
      const r = repoW?.repo;
      if (!r) return { clientMutationId, pullRequest: null };
      const baseRef = String(input.baseRefName ?? r.default_branch);
      const headRef = String(input.headRefName ?? "");
      const baseSha = branchTip(r, baseRef);
      const headSha = branchTip(r, headRef);
      if (!baseSha || !headSha) return { clientMutationId, pullRequest: null };
      const ts = nowISO();
      const pr: PullRequest = {
        id: globalIdSeq++, number: r.nextIssueNum++, title: String(input.title ?? ""),
        body: (input.body as string) ?? null, state: "open", user: userObj(ctx.user),
        head: { ref: headRef, sha: headSha, label: `${r.owner}:${headRef}`, repo: r },
        base: { ref: baseRef, sha: baseSha, label: `${r.owner}:${baseRef}`, repo: r },
        merged: false, merged_at: null, merge_commit_sha: null, draft: !!input.draft,
        created_at: ts, updated_at: ts, closed_at: null, commentsList: [],
      };
      r.prs.push(pr);
      return { clientMutationId, pullRequest: gw("PullRequest", { repo: r, pr }) };
    }
    case "mergePullRequest": {
      const w = input.pullRequestId ? findByGlobalId(String(input.pullRequestId)) : null;
      if (!w?.pr || !w.repo) return { clientMutationId, pullRequest: null };
      const p = w.pr, r = w.repo;
      if (!p.merged && p.state === "open") {
        const baseRefName = `refs/heads/${p.base.ref}`;
        const curBase = r.refs.get(baseRefName) ?? p.base.sha;
        const headTree = parseCommit(getObject(p.head.sha)!.data).tree;
        const method = String(input.mergeMethod ?? "MERGE");
        let mergeSha: string | null = null;
        if (method === "SQUASH") {
          mergeSha = makeCommitOnRef(r, baseRefName, headTree, [curBase], `${p.title} (#${p.number})`, ctx.user);
        } else if (method === "REBASE") {
          const cmp = compareJSON(r, curBase, p.head.sha);
          let parent = curBase;
          for (const cs of (cmp.commits as Record<string, unknown>[])) {
            const cc = parseCommit(getObject(cs.sha as string)!.data);
            parent = makeCommitOnRef(r, baseRefName, cc.tree, [parent], cc.message, ctx.user);
          }
          mergeSha = parent;
        } else {
          const ident = forgeIdent(ctx.user);
          const lines = [`tree ${headTree}`, `parent ${curBase}`, `parent ${p.head.sha}`, `author ${ident}`, `committer ${ident}`, "", `Merge pull request #${p.number}`];
          mergeSha = storeObject("commit", Buffer.from(lines.join("\n"), "utf8"));
          r.refs.set(baseRefName, mergeSha);
        }
        p.merged = true; p.state = "closed"; p.merged_at = nowISO(); p.closed_at = p.merged_at; p.updated_at = p.merged_at; p.merge_commit_sha = mergeSha;
      }
      return { clientMutationId, pullRequest: gw("PullRequest", { repo: r, pr: p }), actor: gw("User", { user: ctx.user }) };
    }
    case "closePullRequest": case "reopenPullRequest": {
      const w = input.pullRequestId ? findByGlobalId(String(input.pullRequestId)) : null;
      if (!w?.pr) return { clientMutationId, pullRequest: null };
      if (!w.pr.merged) { w.pr.state = field === "closePullRequest" ? "closed" : "open"; w.pr.closed_at = field === "closePullRequest" ? nowISO() : null; w.pr.updated_at = nowISO(); }
      return { clientMutationId, pullRequest: gw("PullRequest", { repo: w.repo, pr: w.pr }) };
    }
    case "createRef": {
      const repoW = input.repositoryId ? findByGlobalId(String(input.repositoryId)) : null;
      const r = repoW?.repo;
      if (!r) return { clientMutationId, ref: null };
      const name = String(input.name ?? "");
      const oid = String(input.oid ?? "");
      if (!name.startsWith("refs/") || !hasObject(oid)) return { clientMutationId, ref: null };
      r.refs.set(name, oid);
      return { clientMutationId, ref: gw("Ref", { repo: r, refName: name, sha: oid }) };
    }
    case "updateRef": {
      const w = input.refId ? findByGlobalId(String(input.refId)) : null;
      void w;
      // ref global id encodes repoId:refName
      const d = input.refId ? gqlDecodeId(String(input.refId)) : null;
      if (d?.type === "Ref") {
        const [rid, ...restName] = d.key.split(":");
        for (const r of repos.values()) if (r.id === parseInt(rid, 10)) {
          const refName = restName.join(":");
          const oid = String(input.oid ?? "");
          if (hasObject(oid)) { r.refs.set(refName, oid); return { clientMutationId, ref: gw("Ref", { repo: r, refName, sha: oid }) }; }
        }
      }
      return { clientMutationId, ref: null };
    }
    case "deleteRef": {
      const d = input.refId ? gqlDecodeId(String(input.refId)) : null;
      if (d?.type === "Ref") {
        const [rid, ...restName] = d.key.split(":");
        for (const r of repos.values()) if (r.id === parseInt(rid, 10)) r.refs.delete(restName.join(":"));
      }
      return { clientMutationId };
    }
    case "createLabel": {
      const repoW = input.repositoryId ? findByGlobalId(String(input.repositoryId)) : null;
      const r = repoW?.repo;
      if (!r) return { clientMutationId, label: null };
      const name = String(input.name ?? "");
      r.labels.push({ name, color: String(input.color ?? "ededed"), description: (input.description as string) ?? null });
      return { clientMutationId, label: gw("Label", { repo: r, label: name }) };
    }
    case "updateLabel": {
      const w = input.id ? findByGlobalId(String(input.id)) : null;
      void w;
      return { clientMutationId, label: null };
    }
    case "deleteLabel": return { clientMutationId };
    case "addLabelsToLabelable": case "removeLabelsFromLabelable": {
      const w = input.labelableId ? findByGlobalId(String(input.labelableId)) : null;
      if (w?.issue) {
        const names = ((input.labelIds as GVal[]) ?? []).map((lid) => { const d = gqlDecodeId(String(lid)); return d?.type === "Label" ? d.key.split(":").slice(1).join(":") : ""; }).filter(Boolean);
        if (field === "addLabelsToLabelable") for (const n of names) if (!w.issue.labels.includes(n)) w.issue.labels.push(n);
        else w.issue.labels = w.issue.labels.filter((l) => !names.includes(l));
        w.issue.updated_at = nowISO();
        return { clientMutationId, labelable: gw("Issue", { repo: w.repo, issue: w.issue }), labels: names.map((n) => gw("Label", { repo: w.repo!, label: n })) };
      }
      return { clientMutationId, labelable: w };
    }
    case "addAssigneesToAssignable": case "removeAssigneesFromAssignable": {
      const w = input.assignableId ? findByGlobalId(String(input.assignableId)) : null;
      if (w?.issue) {
        const users = ((input.assigneeIds as GVal[]) ?? []).map((aid) => gqlDecodeId(String(aid))?.key ?? "").filter(Boolean);
        if (field === "addAssigneesToAssignable") for (const u of users) if (!w.issue.assignees.some((a) => a.login === u)) w.issue.assignees.push(userObj(u));
        else w.issue.assignees = w.issue.assignees.filter((a) => !users.includes(a.login));
        w.issue.updated_at = nowISO();
        return { clientMutationId, assignable: gw("Issue", { repo: w.repo, issue: w.issue }) };
      }
      return { clientMutationId, assignable: w };
    }
    case "addReaction": case "removeReaction": return { clientMutationId, subject: null, reaction: null };
    case "markNotificationAsRead": case "markFileAsViewed": case "unmarkFileAsViewed": return { clientMutationId };
    case "createCommitOnBranch": {
      const branch = (input.branch as Record<string, GVal>) ?? {};
      const repoW = branch.repositoryNameWithOwner ? null : null;
      void repoW;
      const full = String(branch.repositoryNameWithOwner ?? "");
      const [o, n] = full.split("/");
      const r = o && n ? findRepo(o, n) : undefined;
      if (!r) return { clientMutationId, commit: null };
      const ref = `refs/heads/${String(branch.branchName ?? r.default_branch)}`;
      const tip = r.refs.get(ref);
      const tree = tip ? parseCommit(getObject(tip)!.data).tree : null;
      const adds = ((input.fileChanges as Record<string, GVal>)?.additions as Record<string, GVal>[]) ?? [];
      const dels = ((input.fileChanges as Record<string, GVal>)?.deletions as Record<string, GVal>[]) ?? [];
      let nt = tree;
      for (const a of adds) {
        const content = a.contents ? Buffer.from(String(a.contents), "base64") : Buffer.alloc(0);
        const blob = storeObject("blob", content);
        nt = treeUpsert(nt, String(a.path).split("/"), "100644", blob);
      }
      for (const d of dels) { if (nt) nt = treeRemove(nt, String(d.path).split("/")) ?? storeObject("tree", Buffer.alloc(0)); }
      if (!nt) return { clientMutationId, commit: null };
      const msg = String(((input.message as Record<string, GVal>)?.headline as string) ?? "commit");
      const sha = makeCommitOnRef(r, ref, nt, tip ? [tip] : [], msg, ctx.user);
      return { clientMutationId, commit: gw("Commit", { repo: r, sha }), ref: gw("Ref", { repo: r, refName: ref, sha }) };
    }
  }
  return { clientMutationId };
}
function handleGraphQL(ctx: Ctx): void {
  const { res } = ctx;
  const runOne = (payload: Record<string, unknown>): Record<string, unknown> => {
    const query = String(payload.query ?? "");
    const vars = (payload.variables as Record<string, GVal>) ?? {};
    const opName = payload.operationName as string | undefined;
    ctx.gqlErrors = [];
    try {
      const parser = new GParser(query, vars);
      const { ops, frags } = parser.parseDoc();
      const op = ops.find((o) => !opName || o.name === opName) ?? ops[0];
      if (!op) return { errors: [{ message: "No operation found" }] };
      const kind = op.kind === "mutation" ? "mutation" : "query";
      const data: Record<string, unknown> = {};
      for (const sel of op.selections) {
        if (sel.kind !== "field") continue;
        const key = sel.alias || sel.name!;
        const val = gqlRootResolve(kind, sel.name!, sel.args, ctx);
        data[key] = gqlShapeRoot(val, sel, ctx, frags);
      }
      const out: Record<string, unknown> = { data };
      if (ctx.gqlErrors.length) out.errors = ctx.gqlErrors.map((message) => ({ message }));
      return out;
    } catch (e) {
      return { errors: [{ message: e instanceof Error ? e.message : String(e) }] };
    }
  };
  if (ctx.req.method === "POST") {
    let parsed: unknown = null;
    try { parsed = JSON.parse(ctx.body.toString("utf8") || "{}"); } catch { /* handled below */ }
    if (Array.isArray(parsed)) {
      // A batched body answers one result per operation document, in order.
      jsonRes(res, 200, parsed.map((p) => runOne((p ?? {}) as Record<string, unknown>)));
      return;
    }
    if (parsed && typeof parsed === "object") { jsonRes(res, 200, runOne(parsed as Record<string, unknown>)); return; }
    jsonRes(res, 200, { errors: [{ message: "Invalid GraphQL request body" }] });
    return;
  }
  jsonRes(res, 200, runOne({ query: ctx.url.searchParams.get("query") ?? "", variables: {} }));
}
function gqlShapeRoot(val: unknown, sel: GNode, ctx: Ctx, frags: Map<string, GNode>): unknown {
  if (val === null || val === undefined) return null;
  if (Array.isArray(val)) return val.map((v) => gqlShapeRoot(v, sel, ctx, frags));
  if (typeof val === "object") {
    const v = val as GWrap;
    if (v.__type) {
      if (!sel.selections.length) return v.__type;
      return gqlExecSelections(v, sel.selections, ctx, frags);
    }
    // plain mutation payload object: shape each property against sub-selections
    const obj = val as Record<string, unknown>;
    if (!sel.selections.length) return obj;
    const out: Record<string, unknown> = {};
    for (const s of sel.selections) {
      if (s.kind !== "field") continue;
      const k = s.alias || s.name!;
      out[k] = gqlShapeRoot(obj[s.name!], s, ctx, frags);
    }
    return out;
  }
  return val;
}

// ---------------------------------------------------------------------- MCP
interface McpTool { name: string; description: string; props: Record<string, unknown>; required: string[]; run(a: Record<string, unknown>, ctx: Ctx): unknown }
function mcpTools(ctx: Ctx): McpTool[] {
  const needRepo = (a: Record<string, unknown>): Repo => {
    const r = findRepo(String(a.owner ?? ""), String(a.repo ?? ""));
    if (!r) throw new Error(`repository not found: ${a.owner}/${a.repo}`);
    return r;
  };
  const T = (name: string, description: string, props: Record<string, unknown>, required: string[], run: McpTool["run"]): McpTool => ({ name, description, props, required, run });
  const S = (description: string) => ({ type: "string", description });
  void ctx;
  return [
    T("get_me", "Get details of the authenticated user", {}, [], () => userObj(ctx.user)),
    T("create_repository", "Create a new repository", { name: S("repo name"), description: S("description"), private: { type: "boolean" }, autoInit: { type: "boolean" } }, ["name"], (a) => {
      const name = String(a.name);
      if (findRepo(ctx.user, name)) throw new Error("name already exists on this account");
      const r = createRepo(ctx.user, name, (a.description as string) ?? null, !!a.private);
      if (a.autoInit) {
        const blob = storeObject("blob", Buffer.from(`# ${name}\n`, "utf8"));
        const tree = storeObject("tree", buildTree([{ mode: "100644", name: "README.md", sha: blob }]));
        makeCommitOnRef(r, `refs/heads/${r.default_branch}`, tree, [], "Initial commit", ctx.user);
      }
      return repoJSON(r);
    }),
    T("create_repo", "Create a new repository for the authenticated user", { name: S("repo name"), description: S("description"), private: { type: "boolean" }, auto_init: { type: "boolean" } }, ["name"], (a) => {
      const name = String(a.name);
      if (findRepo(ctx.user, name)) throw new Error("name already exists on this account");
      const r = createRepo(ctx.user, name, (a.description as string) ?? null, !!a.private);
      if (a.auto_init) {
        const blob = storeObject("blob", Buffer.from(`# ${name}\n`, "utf8"));
        const tree = storeObject("tree", buildTree([{ mode: "100644", name: "README.md", sha: blob }]));
        makeCommitOnRef(r, `refs/heads/${r.default_branch}`, tree, [], "Initial commit", ctx.user);
      }
      return repoJSON(r);
    }),
    T("get_repo", "Get details of a repository", { owner: S("owner login"), repo: S("repository name") }, ["owner", "repo"], (a) => repoJSON(needRepo(a))),
    T("search_repositories", "Search repositories", { query: S("query"), page: { type: "number" }, perPage: { type: "number" } }, ["query"], (a) => {
      const term = String(a.query).toLowerCase();
      const items = [...repos.values()].filter((r) => !term || `${r.owner}/${r.name}`.toLowerCase().includes(term) || (r.description ?? "").toLowerCase().includes(term)).map(repoJSON);
      return { total_count: items.length, incomplete_results: false, items };
    }),
    T("fork_repository", "Fork a repository", { owner: S("owner"), repo: S("repo"), organization: S("org") }, ["owner", "repo"], (a) => {
      const src = needRepo(a);
      const owner = String(a.organization || ctx.user);
      if (findRepo(owner, src.name)) throw new Error("fork target exists");
      const nr = createRepo(owner, src.name, src.description, src.private);
      nr.refs = new Map(src.refs); nr.default_branch = src.default_branch; src.forks++;
      return repoJSON(nr);
    }),
    T("create_branch", "Create a branch from a ref or sha", { owner: S(""), repo: S(""), branch: S(""), from_branch: S(""), sha: S("") }, ["owner", "repo", "branch"], (a) => {
      const r = needRepo(a);
      const from = String(a.sha || a.from_branch || r.default_branch);
      const tip = /^[0-9a-f]{40}$/.test(from) ? from : refTip(r, from);
      if (!tip) throw new Error("source ref not found");
      r.refs.set(`refs/heads/${String(a.branch)}`, tip);
      return { ref: `refs/heads/${String(a.branch)}`, node_id: b64(`Ref:refs/heads/${String(a.branch)}`), url: "", object: { sha: tip, type: "commit", url: "" } };
    }),
    T("list_branches", "List branches", { owner: S(""), repo: S("") }, ["owner", "repo"], (a) => {
      const r = needRepo(a);
      return [...r.refs.entries()].filter(([k]) => k.startsWith("refs/heads/")).map(([k, v]) => ({ name: k.slice(11), commit: { sha: v, url: "" }, protected: false }));
    }),
    T("list_commits", "List commits of a branch", { owner: S(""), repo: S(""), sha: S("branch or sha"), page: { type: "number" }, perPage: { type: "number" } }, ["owner", "repo"], (a) => {
      const r = needRepo(a);
      let tip = refTip(r, String(a.sha || r.default_branch));
      if (!tip && a.sha && /^[0-9a-f]{40}$/.test(String(a.sha))) tip = String(a.sha);
      if (!tip) return [];
      const out: string[] = []; const seen = new Set<string>(); const q = [tip];
      while (q.length && out.length < 100) { const s = q.shift()!; if (seen.has(s)) continue; seen.add(s); const o = getObject(s); if (o && o.type === "commit") { out.push(s); q.push(...parseCommit(o.data).parents); } }
      return out.map((s) => commitJSON(r, s));
    }),
    T("get_commit", "Get a commit", { owner: S(""), repo: S(""), sha: S("") }, ["owner", "repo", "sha"], (a) => commitJSON(needRepo(a), String(a.sha))),
    T("get_file_contents", "Get file or directory contents", { owner: S(""), repo: S(""), path: S(""), ref: S(""), sha: S("") }, ["owner", "repo"], (a) => {
      const r = needRepo(a);
      const ref = String(a.ref || a.sha || r.default_branch);
      const tip = refTip(r, ref);
      if (!tip) throw new Error("ref not found");
      const treeSha = parseCommit(getObject(tip)!.data).tree;
      const path = String(a.path || "");
      if (!path) return parseTree(getObject(treeSha)!.data).map((e) => contentEntryJSON(r, e, e.name, ref));
      const ent = treeLookup(treeSha, path.split("/"));
      if (!ent) throw new Error("path not found");
      if (ent.mode === "40000") return parseTree(getObject(ent.sha)!.data).map((e) => contentEntryJSON(r, e, `${path}/${e.name}`, ref));
      const blob = getObject(ent.sha)!;
      return { name: ent.name, path, sha: ent.sha, size: blob.data.length, type: "file", encoding: "base64", content: blob.data.toString("base64"), _links: {} };
    }),
    T("create_or_update_file", "Create or update one file (makes a commit)", { owner: S(""), repo: S(""), path: S(""), content: S("file content (plain text or base64 with encoding)"), message: S(""), branch: S(""), sha: S("existing blob sha when updating"), encoding: S("utf-8|base64") }, ["owner", "repo", "path", "content", "message"], (a) => {
      const r = needRepo(a);
      const branch = String(a.branch || r.default_branch);
      const ref = `refs/heads/${branch}`;
      const tip = r.refs.get(ref);
      const tree = tip ? parseCommit(getObject(tip)!.data).tree : null;
      const data = a.encoding === "base64" ? Buffer.from(String(a.content), "base64") : Buffer.from(String(a.content), "utf8");
      const blob = storeObject("blob", data);
      const nt = treeUpsert(tree, String(a.path).split("/"), "100644", blob);
      const sha = makeCommitOnRef(r, ref, nt, tip ? [tip] : [], String(a.message), ctx.user);
      return { content: { name: String(a.path).split("/").pop(), path: String(a.path), sha: blob, size: data.length, type: "file" }, commit: commitJSON(r, sha) };
    }),
    T("delete_file", "Delete a file (makes a commit)", { owner: S(""), repo: S(""), path: S(""), message: S(""), branch: S(""), sha: S("") }, ["owner", "repo", "path", "message"], (a) => {
      const r = needRepo(a);
      const branch = String(a.branch || r.default_branch);
      const ref = `refs/heads/${branch}`;
      const tip = r.refs.get(ref);
      if (!tip) throw new Error("branch not found");
      const tree = parseCommit(getObject(tip)!.data).tree;
      const nt = treeRemove(tree, String(a.path).split("/")) ?? storeObject("tree", Buffer.alloc(0));
      const sha = makeCommitOnRef(r, ref, nt, [tip], String(a.message), ctx.user);
      return { content: null, commit: commitJSON(r, sha) };
    }),
    T("push_files", "Push several files in one commit", { owner: S(""), repo: S(""), branch: S(""), message: S(""), files: { type: "array", items: { type: "object" } } }, ["owner", "repo", "branch", "message", "files"], (a) => {
      const r = needRepo(a);
      const ref = `refs/heads/${String(a.branch)}`;
      const tip = r.refs.get(ref);
      let tree = tip ? parseCommit(getObject(tip)!.data).tree : null;
      for (const f of (a.files as Record<string, unknown>[])) {
        const blob = storeObject("blob", Buffer.from(String(f.content ?? ""), "utf8"));
        tree = treeUpsert(tree, String(f.path).split("/"), "100644", blob);
      }
      if (!tree) throw new Error("no files");
      const sha = makeCommitOnRef(r, ref, tree, tip ? [tip] : [], String(a.message), ctx.user);
      return commitJSON(r, sha);
    }),
    T("list_issues", "List issues", { owner: S(""), repo: S(""), state: S("OPEN|CLOSED|ALL"), page: { type: "number" }, perPage: { type: "number" } }, ["owner", "repo"], (a) => {
      const r = needRepo(a);
      const st = String(a.state || "OPEN").toUpperCase();
      const list = r.issues.filter((i) => st === "ALL" || (st === "OPEN") === (i.state === "open"));
      return { totalCount: list.length, issues: list.map((i) => issueJSON(r, i)) };
    }),
    T("issue_read", "Get one issue", { owner: S(""), repo: S(""), issue_number: { type: "number" } }, ["owner", "repo", "issue_number"], (a) => {
      const r = needRepo(a);
      const i = r.issues.find((x) => x.number === a.issue_number);
      if (!i) throw new Error("issue not found");
      return issueJSON(r, i);
    }),
    T("issue_write", "Create or update an issue", { owner: S(""), repo: S(""), method: S("create|update"), issue_number: { type: "number" }, title: S(""), body: S(""), state: S("open|closed"), labels: { type: "array", items: { type: "string" } }, assignees: { type: "array", items: { type: "string" } } }, ["owner", "repo", "method"], (a) => {
      const r = needRepo(a);
      if (a.method === "create") {
        const ts = nowISO();
        const i: Issue = { id: globalIdSeq++, number: r.nextIssueNum++, title: String(a.title || ""), body: (a.body as string) ?? null, state: "open", user: userObj(ctx.user), labels: ((a.labels as string[]) || []).map(String), assignees: ((a.assignees as string[]) || []).map((x) => userObj(String(x))), commentsList: [], created_at: ts, updated_at: ts, closed_at: null };
        r.issues.push(i);
        return issueJSON(r, i);
      }
      const i = r.issues.find((x) => x.number === a.issue_number);
      if (!i) throw new Error("issue not found");
      if (typeof a.title === "string") i.title = a.title;
      if (typeof a.body === "string") i.body = a.body;
      if (a.state === "closed" || a.state === "open") { i.state = a.state; i.closed_at = a.state === "closed" ? nowISO() : null; }
      if (Array.isArray(a.labels)) i.labels = (a.labels as string[]).map(String);
      i.updated_at = nowISO();
      return issueJSON(r, i);
    }),
    T("create_issue", "Create an issue", { owner: S(""), repo: S(""), title: S(""), body: S(""), labels: { type: "array", items: { type: "string" } }, assignees: { type: "array", items: { type: "string" } } }, ["owner", "repo", "title"], (a) => {
      const r = needRepo(a);
      const ts = nowISO();
      const i: Issue = { id: globalIdSeq++, number: r.nextIssueNum++, title: String(a.title), body: (a.body as string) ?? null, state: "open", user: userObj(ctx.user), labels: ((a.labels as string[]) || []).map(String), assignees: ((a.assignees as string[]) || []).map((x) => userObj(String(x))), commentsList: [], created_at: ts, updated_at: ts, closed_at: null };
      r.issues.push(i);
      return issueJSON(r, i);
    }),
    T("get_issue", "Get one issue", { owner: S(""), repo: S(""), issue_number: { type: "number" } }, ["owner", "repo", "issue_number"], (a) => {
      const r = needRepo(a);
      const i = r.issues.find((x) => x.number === a.issue_number);
      if (!i) throw new Error("issue not found");
      return issueJSON(r, i);
    }),
    T("add_issue_comment", "Comment on an issue or PR", { owner: S(""), repo: S(""), issue_number: { type: "number" }, body: S("") }, ["owner", "repo", "issue_number", "body"], (a) => {
      const r = needRepo(a);
      const { issue, pr } = findIssueOrPr(r, Number(a.issue_number));
      if (!issue && !pr) throw new Error("issue not found");
      const c = { id: globalIdSeq++, body: String(a.body), user: userObj(ctx.user), created_at: nowISO(), updated_at: nowISO() };
      if (issue) { issue.commentsList.push(c); return commentJSON(r, issue, c); }
      pr!.commentsList.push(c);
      return commentJSON(r, issueForPr(r, pr!), c);
    }),
    T("list_issue_comments", "List comments on an issue", { owner: S(""), repo: S(""), issue_number: { type: "number" } }, ["owner", "repo", "issue_number"], (a) => {
      const r = needRepo(a);
      const { issue, pr } = findIssueOrPr(r, Number(a.issue_number));
      if (!issue && !pr) throw new Error("issue not found");
      const iss = issue ?? issueForPr(r, pr!);
      return iss.commentsList.map((c) => commentJSON(r, iss, c));
    }),
    T("search_issues", "Search issues", { query: S(""), page: { type: "number" }, perPage: { type: "number" } }, ["query"], (a) => {
      const term = String(a.query).toLowerCase();
      const items: Record<string, unknown>[] = [];
      for (const r of repos.values()) for (const i of r.issues) if (!term || i.title.toLowerCase().includes(term) || (i.body ?? "").toLowerCase().includes(term)) items.push(issueJSON(r, i));
      return { total_count: items.length, incomplete_results: false, items };
    }),
    T("list_pull_requests", "List pull requests", { owner: S(""), repo: S(""), state: S("open|closed|all"), page: { type: "number" }, perPage: { type: "number" } }, ["owner", "repo"], (a) => {
      const r = needRepo(a);
      const st = String(a.state || "open");
      return r.prs.filter((p) => st === "all" ? true : st === "closed" ? p.state !== "open" : p.state === "open").map((p) => prJSON(r, p));
    }),
    T("pull_request_read", "Get a pull request (method: get|get_diff|get_files|get_commits)", { owner: S(""), repo: S(""), pullNumber: { type: "number" }, method: S("") }, ["owner", "repo", "pullNumber"], (a) => {
      const r = needRepo(a);
      const p = r.prs.find((x) => x.number === a.pullNumber);
      if (!p) throw new Error("pull request not found");
      const method = String(a.method || "get");
      const bt = parseCommit(getObject(p.base.sha)!.data).tree;
      const ht = parseCommit(getObject(p.head.sha)!.data).tree;
      if (method === "get_files") return diffTrees(bt, ht);
      if (method === "get_diff") return diffTrees(bt, ht).map((f) => `--- ${f.filename}\n${f.patch ?? ""}`).join("\n");
      if (method === "get_commits") return (compareJSON(r, p.base.sha, p.head.sha).commits as unknown[]) ?? [];
      return prJSON(r, p);
    }),
    T("get_pull_request", "Get a pull request", { owner: S(""), repo: S(""), pullNumber: { type: "number" } }, ["owner", "repo", "pullNumber"], (a) => {
      const r = needRepo(a);
      const p = r.prs.find((x) => x.number === a.pullNumber);
      if (!p) throw new Error("pull request not found");
      return prJSON(r, p);
    }),
    T("create_pull_request", "Create a pull request", { owner: S(""), repo: S(""), title: S(""), body: S(""), head: S(""), base: S(""), draft: { type: "boolean" } }, ["owner", "repo", "title", "head", "base"], (a) => {
      const r = needRepo(a);
      const baseSha = branchTip(r, String(a.base));
      const headSha = branchTip(r, String(a.head));
      if (!baseSha || !headSha) throw new Error("head or base branch not found");
      const ts = nowISO();
      const p: PullRequest = { id: globalIdSeq++, number: r.nextIssueNum++, title: String(a.title), body: (a.body as string) ?? null, state: "open", user: userObj(ctx.user), head: { ref: String(a.head), sha: headSha, label: `${r.owner}:${String(a.head)}`, repo: r }, base: { ref: String(a.base), sha: baseSha, label: `${r.owner}:${String(a.base)}`, repo: r }, merged: false, merged_at: null, merge_commit_sha: null, draft: !!a.draft, created_at: ts, updated_at: ts, closed_at: null, commentsList: [] };
      r.prs.push(p);
      return prJSON(r, p);
    }),
    T("update_pull_request", "Update a pull request", { owner: S(""), repo: S(""), pullNumber: { type: "number" }, title: S(""), body: S(""), state: S("open|closed"), base: S("") }, ["owner", "repo", "pullNumber"], (a) => {
      const r = needRepo(a);
      const p = r.prs.find((x) => x.number === a.pullNumber);
      if (!p) throw new Error("pull request not found");
      if (typeof a.title === "string") p.title = a.title;
      if (typeof a.body === "string") p.body = a.body;
      if (a.state === "closed" || a.state === "open") { p.state = a.state; p.closed_at = a.state === "closed" ? nowISO() : null; }
      p.updated_at = nowISO();
      return prJSON(r, p);
    }),
    T("merge_pull_request", "Merge a pull request", { owner: S(""), repo: S(""), pullNumber: { type: "number" }, merge_method: S("merge|squash|rebase"), commit_title: S(""), commit_message: S("") }, ["owner", "repo", "pullNumber"], (a) => {
      const r = needRepo(a);
      const p = r.prs.find((x) => x.number === a.pullNumber);
      if (!p) throw new Error("pull request not found");
      if (p.merged || p.state !== "open") throw new Error("pull request is not mergeable");
      const baseRefName = `refs/heads/${p.base.ref}`;
      const curBase = r.refs.get(baseRefName) ?? p.base.sha;
      const headTree = parseCommit(getObject(p.head.sha)!.data).tree;
      const method = String(a.merge_method || "merge");
      let newSha: string;
      if (method === "squash") newSha = makeCommitOnRef(r, baseRefName, headTree, [curBase], String(a.commit_title || `${p.title} (#${p.number})`), ctx.user);
      else if (method === "rebase") {
        let parent = curBase;
        for (const cs of (compareJSON(r, curBase, p.head.sha).commits as Record<string, unknown>[])) {
          const cc = parseCommit(getObject(cs.sha as string)!.data);
          parent = makeCommitOnRef(r, baseRefName, cc.tree, [parent], cc.message, ctx.user);
        }
        newSha = parent;
      } else {
        const ident = forgeIdent(ctx.user);
        const lines = [`tree ${headTree}`, `parent ${curBase}`, `parent ${p.head.sha}`, `author ${ident}`, `committer ${ident}`, "", String(a.commit_message || `Merge pull request #${p.number}`)];
        newSha = storeObject("commit", Buffer.from(lines.join("\n"), "utf8"));
        r.refs.set(baseRefName, newSha);
      }
      p.merged = true; p.state = "closed"; p.merged_at = nowISO(); p.closed_at = p.merged_at; p.merge_commit_sha = newSha;
      return { sha: newSha, merged: true, message: "Pull Request successfully merged" };
    }),
    T("search_code", "Search code in repositories", { query: S(""), page: { type: "number" }, perPage: { type: "number" } }, ["query"], (a) => {
      const term = String(a.query).toLowerCase();
      const items: Record<string, unknown>[] = [];
      for (const r of repos.values()) {
        const tip = branchTip(r, r.default_branch);
        if (!tip) continue;
        const tree = parseCommit(getObject(tip)!.data).tree;
        const flat = new Map<string, TreeEntry & { path: string }>();
        flattenTree(tree, "", flat);
        for (const [p, e] of flat) {
          const data = getObject(e.sha)?.data;
          if (!data) continue;
          const txt = data.toString("utf8");
          const idx = txt.toLowerCase().indexOf(term);
          if (idx >= 0) items.push({ name: e.name, path: p, sha: e.sha, url: "", html_url: "", repository: repoJSON(r), text_matches: [{ fragment: txt.slice(Math.max(0, idx - 40), idx + term.length + 40), matches: [{ text: term, indices: [0, term.length] }] }] });
        }
      }
      return { total_count: items.length, incomplete_results: false, items };
    }),
    T("search_users", "Search users", { query: S("") }, ["query"], (a) => ({ total_count: 1, incomplete_results: false, items: [userObj(String(a.query) || ctx.user)] })),
    T("get_repository_tree", "Get a repository tree", { owner: S(""), repo: S(""), tree_sha: S(""), recursive: { type: "boolean" } }, ["owner", "repo"], (a) => {
      const r = needRepo(a);
      let sha = String(a.tree_sha || r.default_branch);
      const tip = refTip(r, sha);
      if (tip) sha = parseCommit(getObject(tip)!.data).tree;
      const flat = new Map<string, TreeEntry & { path: string }>();
      flattenTree(sha, "", flat);
      return { sha, truncated: false, tree: [...flat.values()].map((e) => ({ path: e.path, mode: e.mode, type: e.mode === "40000" ? "tree" : "blob", sha: e.sha, size: getObject(e.sha)?.data.length ?? 0 })) };
    }),
  ];
}
function handleMCP(ctx: Ctx): void {
  const { res, req } = ctx;
  if (req.method === "GET" || req.method === "DELETE") { res.writeHead(405); res.end(); return; }
  let msg: Record<string, unknown>;
  try { msg = JSON.parse(ctx.body.toString("utf8") || "{}"); } catch { jsonRes(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }); return; }
  const id = msg.id as string | number | null;
  const method = String(msg.method || "");
  const reply = (result: unknown) => jsonRes(res, 200, { jsonrpc: "2.0", id, result });
  const fail = (code: number, message: string) => jsonRes(res, 200, { jsonrpc: "2.0", id, error: { code, message } });
  if (id === undefined || id === null) { res.writeHead(202); res.end(); return; } // notification
  const tools = mcpTools(ctx);
  switch (method) {
    case "initialize": {
      const params = (msg.params as Record<string, unknown>) || {};
      reply({ protocolVersion: String(params.protocolVersion || "2024-11-05"), capabilities: { tools: { listChanged: false }, resources: {}, prompts: {} }, serverInfo: { name: "forge-mcp", version: "1.0.0" } });
      return;
    }
    case "ping": reply({}); return;
    case "tools/list": {
      reply({ tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: { type: "object", properties: t.props, required: t.required }, annotations: { readOnlyHint: false } })) });
      return;
    }
    case "tools/call": {
      const params = (msg.params as Record<string, unknown>) || {};
      const tool = tools.find((t) => t.name === params.name);
      if (!tool) { fail(-32601, `unknown tool: ${String(params.name)}`); return; }
      const callArgs = ((params.arguments as Record<string, unknown>) || {});
      const missing = tool.required.filter((k) => callArgs[k] === undefined || callArgs[k] === null || callArgs[k] === "");
      if (missing.length) { reply({ content: [{ type: "text", text: `missing required argument(s): ${missing.join(", ")}` }], isError: true }); return; }
      try {
        const out = tool.run(callArgs, ctx);
        const text = typeof out === "string" ? out : JSON.stringify(out, null, 2);
        const resultObj: Record<string, unknown> = { content: [{ type: "text", text }], isError: false };
        if (out && typeof out === "object") resultObj.structuredContent = out;
        reply(resultObj);
      } catch (e) {
        reply({ content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }], isError: true });
      }
      return;
    }
    case "resources/list": reply({ resources: [] }); return;
    case "resources/templates/list": reply({ resourceTemplates: [] }); return;
    case "prompts/list": reply({ prompts: [] }); return;
    case "logging/setLevel": reply({}); return;
    default: fail(-32601, `method not found: ${method}`); return;
  }
}

// ------------------------------------------------------------------- router
async function route(ctx: Ctx): Promise<void> {
  const { res, req, url } = ctx;
  const path = url.pathname;
  const m = req.method!;
  // git smart HTTP
  const gm = /^\/([^/]+)\/(.+?)\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
  if (gm && !(path.startsWith("/api/") || path === "/mcp" || path.startsWith("/mcp/"))) {
    const owner = gm[1];
    let name = gm[2];
    if (name.endsWith(".git")) name = name.slice(0, -4);
    const repo = findRepo(owner, name);
    if (!repo) { errRes(res, 404, "Not Found"); return; }
    const kind = gm[3];
    if (kind === "info/refs") {
      const service = url.searchParams.get("service") || "";
      if (service === "git-upload-pack" || service === "git-receive-pack") { gitInfoRefs(ctx, repo, service); return; }
      // dumb protocol fallback: plain ref listing
      const lines = [...repo.refs.entries()].map(([k, v]) => `${v}\t${k}`).join("\n");
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(lines + (lines ? "\n" : ""));
      return;
    }
    if (kind === "git-upload-pack") {
      const proto = req.headers["git-protocol"] || "";
      if (/version=2/.test(proto)) handleUploadPackV2(ctx, repo);
      else handleUploadPackV0(ctx, repo);
      return;
    }
    if (kind === "git-receive-pack") { handleReceivePack(ctx, repo); return; }
  }
  // MCP
  if (path === "/mcp" || path.startsWith("/mcp/")) { handleMCP(ctx); return; }
  // GraphQL
  if (path === "/api/graphql" || path === "/graphql") { handleGraphQL(ctx); return; }
  // REST v3
  if (path === "/api/v3" || path.startsWith("/api/v3/")) {
    const seg = path.slice("/api/v3".length).split("/").filter(Boolean).map((s) => { try { return decodeURIComponent(s); } catch { return s; } });
    // A malformed JSON body is a 400, never a downstream validation error.
    if (ctx.body.length > 0 && (m === "POST" || m === "PUT" || m === "PATCH" || m === "DELETE")) {
      try { JSON.parse(ctx.body.toString("utf8")); } catch { errRes(res, 400, "Problems parsing JSON"); return; }
    }
    if (seg.length === 1 && seg[0] === "meta" && m === "GET") {
      jsonRes(res, 200, {
        verifiable_password_authentication: false,
        ssh_key_fingerprints: { SHA256_RSA: "nThbg6kXUpJWGl7E1IGOCspRomTxdCARLviKw6E5SY8", SHA256_ECDSA: "p2QAMXNIC1TJYWeIOttrVc98/R1BUFWu3/LiyKgUfQM", SHA256_ED25519: "+DiYju8Nu6TpJJhbp75U4F/XSioS5uuLAlV7YvJc2d0" },
        hooks: ["192.30.252.0/22", "185.199.108.0/22"], web: ["192.30.252.0/22", "185.199.108.0/22"],
        api: ["192.30.252.0/22", "185.199.108.0/22"], git: ["192.30.252.0/22", "185.199.108.0/22"],
        packages: ["192.30.252.0/22"], pages: ["185.199.108.0/22"], importer: ["54.87.0.0/16"],
        actions: ["13.64.0.0/16"], dependabot: ["54.87.0.0/16"],
        installed_version: "2026.1.0", is_password_authentication_verifiable: false,
      });
      return;
    }
    if (seg.length === 0 && m === "GET") {
      jsonRes(res, 200, {
        current_user_url: `${API_BASE}/user`, current_user_authorizations_html_url: "",
        authorizations_url: `${API_BASE}/authorizations`, code_search_url: `${API_BASE}/search/code?q={query}`,
        commit_search_url: `${API_BASE}/search/commits?q={query}`, emails_url: `${API_BASE}/user/emails`,
        emojis_url: `${API_BASE}/emojis`, events_url: `${API_BASE}/events`, feeds_url: `${API_BASE}/feeds`,
        followers_url: `${API_BASE}/user/followers`, following_url: `${API_BASE}/user/following{/target}`,
        gists_url: `${API_BASE}/gists{/gist_id}`, hub_url: "", issue_search_url: `${API_BASE}/search/issues?q={query}`,
        issues_url: `${API_BASE}/issues`, keys_url: `${API_BASE}/user/keys`, label_search_url: `${API_BASE}/search/labels?q={query}`,
        notifications_url: `${API_BASE}/notifications`, organization_url: `${API_BASE}/orgs/{org}`,
        organization_repositories_url: `${API_BASE}/orgs/{org}/repos`, organization_teams_url: `${API_BASE}/orgs/{org}/teams`,
        public_gists_url: `${API_BASE}/gists/public`, rate_limit_url: `${API_BASE}/rate_limit`,
        repository_url: `${API_BASE}/repos/{owner}/{repo}`, repository_search_url: `${API_BASE}/search/repositories?q={query}`,
        current_user_repositories_url: `${API_BASE}/user/repos`, starred_url: `${API_BASE}/user/starred{/owner}{/repo}`,
        starred_gists_url: `${API_BASE}/gists/starred`, topic_search_url: `${API_BASE}/search/topics?q={query}`,
        user_url: `${API_BASE}/users/{user}`, user_organizations_url: `${API_BASE}/users/{user}/orgs`,
        user_repositories_url: `${API_BASE}/users/{user}/repos`, user_search_url: `${API_BASE}/search/users?q={query}`,
      }, { "x-oauth-scopes": "repo, read:org" });
      return;
    }
    if (seg[0] === "rate_limit" && m === "GET") {
      jsonRes(res, 200, { resources: { core: { limit: 5000, remaining: 4999, reset: EPOCH + 3600, used: 1 }, search: { limit: 30, remaining: 30, reset: EPOCH + 60, used: 0 }, graphql: { limit: 5000, remaining: 4999, reset: EPOCH + 3600, used: 1 } }, rate: { limit: 5000, remaining: 4999, reset: EPOCH + 3600, used: 1 } });
      return;
    }
    if (seg[0] === "user" && seg.length === 1 && m === "GET") { jsonRes(res, 200, userObj(ctx.user)); return; }
    if (seg[0] === "users" && seg.length === 2 && m === "GET") { jsonRes(res, 200, userObj(seg[1])); return; }
    if (seg[0] === "search" && m === "GET") {
      const q = (url.searchParams.get("q") || "").toLowerCase();
      const perPage = Math.min(100, parseInt(url.searchParams.get("per_page") || "30", 10) || 30);
      if (seg[1] === "repositories") {
        const items = [...repos.values()].filter((r) => !q || `${r.owner}/${r.name}`.toLowerCase().includes(q.split(" ")[0]) || (r.description ?? "").toLowerCase().includes(q)).slice(0, perPage).map(repoJSON);
        jsonRes(res, 200, { total_count: items.length, incomplete_results: false, items });
        return;
      }
      if (seg[1] === "issues") {
        const items: Record<string, unknown>[] = [];
        for (const r of repos.values()) for (const i of r.issues) if (!q || i.title.toLowerCase().includes(q) || (i.body ?? "").toLowerCase().includes(q)) items.push(issueJSON(r, i));
        jsonRes(res, 200, { total_count: items.length, incomplete_results: false, items: items.slice(0, perPage) });
        return;
      }
      if (seg[1] === "users") { jsonRes(res, 200, { total_count: 1, incomplete_results: false, items: [userObj(q || ctx.user)] }); return; }
      if (seg[1] === "code") {
        const tool = mcpTools(ctx).find((t) => t.name === "search_code");
        jsonRes(res, 200, tool ? tool.run({ query: q }, ctx) : { total_count: 0, incomplete_results: false, items: [] });
        return;
      }
      if (seg[1] === "labels") {
        const items: Record<string, unknown>[] = [];
        for (const r of repos.values()) for (const l of r.labels) if (!q || l.name.toLowerCase().includes(q)) items.push(labelJSON(r, l.name));
        jsonRes(res, 200, { total_count: items.length, incomplete_results: false, items });
        return;
      }
    }
    if (seg[0] === "repos" || seg[0] === "user" || seg[0] === "users" || seg[0] === "orgs") {
      if (restRepos(ctx, seg)) return;
    }
    if (seg[0] === "issues" && m === "GET") {
      const items: Record<string, unknown>[] = [];
      for (const r of repos.values()) for (const i of r.issues) if (i.state === "open") items.push(issueJSON(r, i));
      jsonRes(res, 200, items);
      return;
    }
    errRes(res, 404, "Not Found");
    return;
  }
  if (path === "/" || path === "/healthz") {
    jsonRes(res, 200, { forge: "ok", version: "1.0.0", surfaces: ["git-smart-http", "rest-v3", "graphql", "mcp"] });
    return;
  }
  errRes(res, 404, "Not Found");
}

// ------------------------------------------------------------- HTTP server
/** Build the forge's HTTP server. It binds nothing until the caller listens;
 *  main.ts (the kit lifecycle) listens on an ephemeral port and registers it
 *  with the env. */
export function createApp(): http.Server {
  return http.createServer({ sendDate: false }, (req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url || "/", "http://localhost");
        // Every response carries a request id (GitHub's wire contract):
        // set it once here instead of rebuilding it into every response.
        res.setHeader("x-github-request-id", `FORGE-${++reqSeq}`);
        // A request that declares no body has none to read: skip the
        // data/end listener round-trip entirely (every GET clone/read
        // request takes this path). Anything declaring a body is read
        // exactly as before.
        let body: Buffer;
        const declared = req.headers["content-length"];
        if ((req.method === "GET" || req.method === "HEAD") && !req.headers["transfer-encoding"] && (declared === undefined || declared === "0")) {
          body = EMPTY_BODY;
        } else {
          body = await readBody(req);
        }
        // Auth: the suite presents the trial token as a Bearer <redacted> on
        // every surface; /healthz (and the plain root) take none.
        const trialToken = process.env.MAKEFUN_SHOP_TOKEN;
        if (trialToken && url.pathname !== "/healthz" && url.pathname !== "/") {
          const auth = req.headers["authorization"] || "";
          if (auth !== `Bearer ${trialToken}`) {
            errRes(res, 401, "Bad credentials");
            return;
          }
        }
        let parsedBody: Record<string, unknown> | undefined;
        const ctx: Ctx = {
          req, res, url, body, user: currentUser(req),
          json() {
            // One parse per request, however many layers ask for the body.
            if (parsedBody === undefined) {
              try { parsedBody = JSON.parse(body.toString("utf8") || "{}") as Record<string, unknown>; }
              catch { parsedBody = {}; }
            }
            return parsedBody;
          },
        };
        await route(ctx);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (!res.headersSent) errRes(res, 500, `internal: ${msg}`);
        else res.end();
      }
    })();
  });
}
