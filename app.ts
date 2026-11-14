// app.ts — the forge. One process serving git smart HTTP, REST v3, GraphQL
// and MCP from a single in-memory store. Node standard library only; the git
// object model, packfiles, deltas and wire protocols are implemented here.

import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

// ---------------------------------------------------------------------------
// Deterministic identity: the trial scenario derives every login from one
// constant seed, so the forge derives the token owner's login the same way
// and agrees with its clients about ownership without any configuration.
// ---------------------------------------------------------------------------

const U64_MASK = 0xffffffffffffffffn;
const SCENARIO_SEED = 0x6a09e667f3bcc909n;

function fnv1a64(text: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & U64_MASK;
  }
  return hash;
}

function mix64(value: bigint): bigint {
  let z = (value + 0x9e3779b97f4a7c15n) & U64_MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64_MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64_MASK;
  return (z ^ (z >> 31n)) & U64_MASK;
}

class SeededRng {
  private state: bigint;
  constructor(seed: bigint) {
    const masked = seed & U64_MASK;
    this.state = masked === 0n ? SCENARIO_SEED : masked;
  }
  nextU64(): bigint {
    let x = this.state;
    x = (x ^ (x >> 12n)) & U64_MASK;
    x = (x ^ (x << 25n)) & U64_MASK;
    x = (x ^ (x >> 27n)) & U64_MASK;
    this.state = x;
    return (x * 0x2545f4914f6cdd1dn) & U64_MASK;
  }
  nextU32(): number {
    return Number(this.nextU64() >> 32n);
  }
  nextInt(maxExclusive: number): number {
    if (maxExclusive === 1) return 0;
    const range = 4294967296;
    const limit = range - (range % maxExclusive);
    for (;;) {
      const value = this.nextU32();
      if (value < limit) return value % maxExclusive;
    }
  }
  pick<T>(items: readonly T[]): T {
    return items[this.nextInt(items.length)] as T;
  }
}

const FIRST_NAMES: readonly string[] = [
  'ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas', 'kira', 'lars',
  'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess', 'ulla', 'vito', 'wren', 'yara', 'zane',
];
const LAST_NAMES: readonly string[] = [
  'anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen', 'jansen', 'keller',
  'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi', 'sato', 'turi', 'ulrich', 'vega', 'weber',
  'xu', 'yilmaz', 'zimmer',
];

interface Persona {
  id: number;
  login: string;
  name: string;
  email: string;
}

function derivePersonas(): Persona[] {
  const rng = new SeededRng(mix64(SCENARIO_SEED ^ fnv1a64('users')));
  const used = new Set<string>();
  const people: Persona[] = [];
  for (let i = 0; i < 12; i += 1) {
    const first = rng.pick(FIRST_NAMES);
    const last = rng.pick(LAST_NAMES);
    const base = `${first}${last}`.replace(/[^a-z0-9-]/g, '');
    let login = base;
    let suffix = 2;
    while (used.has(login)) {
      login = `${base}-${suffix}`;
      suffix += 1;
    }
    used.add(login);
    people.push({ id: 1000 + i, login, name: `${first} ${last}`, email: `${login}@example.invalid` });
  }
  return people;
}

const PERSONAS = derivePersonas();
const VIEWER: Persona = PERSONAS[0] as Persona;
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const EPOCH = 1735689600; // 2025-01-01T00:00:00Z: every forged timestamp starts here.
const ZERO_OID = '0000000000000000000000000000000000000000';

function isoOf(epochSec: number): string {
  return new Date(epochSec * 1000).toISOString();
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

interface GObj {
  t: ObjType;
  data: Buffer;
  z: Buffer; // the zlib stream of `data`, written into packs verbatim
}

interface CommentRec {
  id: number;
  body: string;
  createdSec: number;
}

interface IssueRec {
  kind: 'issue';
  num: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: CommentRec[];
  createdSec: number;
  ver: number;
}

interface PullRec {
  kind: 'pull';
  num: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  headSha: string;
  merged: boolean;
  mergeSha: string | null;
  mergedSec: number | null;
  createdSec: number;
  ver: number;
}

type ItemRec = IssueRec | PullRec;

interface RepoRec {
  id: number;
  owner: string;
  name: string;
  desc: string;
  priv: boolean;
  defBranch: string;
  objects: Map<string, GObj>;
  refs: Map<string, string>;
  labels: Map<string, { name: string; color: string }>;
  items: Map<number, ItemRec>;
  nextNumber: number;
  tick: number;
  ver: number; // bumped on every mutation; caches key on it
  issueJsonCache: Map<number, { ver: number; buf: Buffer }>;
  fetchCache: Map<string, Buffer>;
  lsrefsCache: Map<string, Buffer>;
  advCache: { ver: number; up: Buffer; recv: Buffer } | null;
}

const repos = new Map<string, RepoRec>();
const reposById = new Map<number, RepoRec>();
let nextRepoId = 1;
let nextItemId = 1;
let nextCommentId = 1;
let requestSeq = 0;

function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

function createRepoRec(owner: string, name: string, desc: string, priv: boolean): RepoRec {
  const repo: RepoRec = {
    id: nextRepoId,
    owner,
    name,
    desc,
    priv,
    defBranch: 'main',
    objects: new Map(),
    refs: new Map(),
    labels: new Map(),
    items: new Map(),
    nextNumber: 1,
    tick: 0,
    ver: 1,
    issueJsonCache: new Map(),
    fetchCache: new Map(),
    lsrefsCache: new Map(),
    advCache: null,
  };
  nextRepoId += 1;
  repos.set(repoKey(owner, name), repo);
  reposById.set(repo.id, repo);
  return repo;
}

function deleteRepoRec(repo: RepoRec): void {
  repos.delete(repoKey(repo.owner, repo.name));
  reposById.delete(repo.id);
}

function touch(repo: RepoRec): void {
  repo.ver += 1;
  // Any cached wire answer was computed from the pre-mutation state.
  repo.fetchCache.clear();
  repo.lsrefsCache.clear();
}

function nextStamp(repo: RepoRec): number {
  repo.tick += 1;
  return EPOCH + repo.tick * 60;
}

// ---------------------------------------------------------------------------
// Git objects
// ---------------------------------------------------------------------------

function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

function hashObject(t: ObjType, data: Buffer): string {
  const header = Buffer.from(`${t} ${data.length}\0`, 'utf8');
  return sha1Hex(Buffer.concat([header, data]));
}

function putObject(repo: RepoRec, t: ObjType, data: Buffer): string {
  const oid = hashObject(t, data);
  if (!repo.objects.has(oid)) {
    repo.objects.set(oid, { t, data, z: deflateSync(data, { level: 6 }) });
  }
  return oid;
}

interface CommitInfo {
  tree: string;
  parents: string[];
  authorLine: string;
  committerLine: string;
  message: string;
}

const commitInfoCache = new Map<string, CommitInfo>();
const treeInfoCache = new Map<string, { mode: string; name: string; oid: string }[]>();

function commitInfo(repo: RepoRec, oid: string): CommitInfo | null {
  const cached = commitInfoCache.get(oid);
  if (cached) return cached;
  const obj = repo.objects.get(oid);
  if (!obj || obj.t !== 'commit') return null;
  const text = obj.data.toString('utf8');
  const splitAt = text.indexOf('\n\n');
  const head = splitAt === -1 ? text : text.slice(0, splitAt);
  const message = splitAt === -1 ? '' : text.slice(splitAt + 2);
  let tree = '';
  const parents: string[] = [];
  let authorLine = '';
  let committerLine = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) authorLine = line.slice(7);
    else if (line.startsWith('committer ')) committerLine = line.slice(10);
  }
  const info: CommitInfo = { tree, parents, authorLine, committerLine, message };
  commitInfoCache.set(oid, info);
  return info;
}

function treeEntries(repo: RepoRec, oid: string): { mode: string; name: string; oid: string }[] {
  const cached = treeInfoCache.get(oid);
  if (cached) return cached;
  const obj = repo.objects.get(oid);
  if (!obj || obj.t !== 'tree') return [];
  const data = obj.data;
  const entries: { mode: string; name: string; oid: string }[] = [];
  let pos = 0;
  while (pos < data.length) {
    const space = data.indexOf(0x20, pos);
    const mode = data.toString('ascii', pos, space);
    const nul = data.indexOf(0x00, space + 1);
    const name = data.toString('utf8', space + 1, nul);
    const entryOid = data.toString('hex', nul + 1, nul + 21);
    entries.push({ mode, name, oid: entryOid });
    pos = nul + 21;
  }
  treeInfoCache.set(oid, entries);
  return entries;
}

function peelToCommit(repo: RepoRec, oid: string): string | null {
  let current = oid;
  for (let guard = 0; guard < 32; guard += 1) {
    const obj = repo.objects.get(current);
    if (!obj) return null;
    if (obj.t === 'commit') return current;
    if (obj.t !== 'tag') return null;
    const text = obj.data.toString('utf8');
    const match = /^object ([0-9a-f]{40})$/m.exec(text);
    if (!match || !match[1]) return null;
    current = match[1];
  }
  return null;
}

function peelTag(repo: RepoRec, oid: string): string | null {
  const obj = repo.objects.get(oid);
  if (!obj || obj.t !== 'tag') return null;
  return peelToCommit(repo, oid);
}

function ancestorSet(repo: RepoRec, tip: string): Set<string> {
  const seen = new Set<string>();
  const commit = peelToCommit(repo, tip);
  if (!commit) return seen;
  const stack = [commit];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    if (seen.has(current)) continue;
    seen.add(current);
    const info = commitInfo(repo, current);
    if (info) for (const parent of info.parents) stack.push(parent);
  }
  return seen;
}

function isAncestor(repo: RepoRec, anc: string, desc: string): boolean {
  if (anc === desc) return true;
  const seen = new Set<string>();
  const stack = [desc];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    if (current === anc) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    const info = commitInfo(repo, current);
    if (info) for (const parent of info.parents) stack.push(parent);
  }
  return false;
}

function mergeBase(repo: RepoRec, a: string, b: string): string | null {
  const ancestorsOfA = ancestorSet(repo, a);
  if (ancestorsOfA.size === 0) return null;
  const seen = new Set<string>();
  const queue = [b];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    if (seen.has(current)) continue;
    seen.add(current);
    if (ancestorsOfA.has(current)) return current;
    const info = commitInfo(repo, current);
    if (info) for (const parent of info.parents) queue.push(parent);
  }
  return null;
}

interface FileEntry {
  oid: string;
  mode: string;
}

function flattenTree(repo: RepoRec, treeOid: string, prefix: string, out: Map<string, FileEntry>): void {
  for (const entry of treeEntries(repo, treeOid)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(repo, entry.oid, path, out);
    else out.set(path, { oid: entry.oid, mode: entry.mode });
  }
}

function filesAtCommit(repo: RepoRec, commitOid: string): Map<string, FileEntry> {
  const out = new Map<string, FileEntry>();
  const info = commitInfo(repo, commitOid);
  if (info && info.tree) flattenTree(repo, info.tree, '', out);
  return out;
}

function treeSortKey(entry: { mode: string; name: string }): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

function buildTree(repo: RepoRec, files: Map<string, FileEntry>): string {
  // Group the flat file map by first path segment, then recurse.
  const rootFiles: { mode: string; name: string; oid: string }[] = [];
  const dirs = new Map<string, Map<string, FileEntry>>();
  for (const [path, entry] of files) {
    const slash = path.indexOf('/');
    if (slash === -1) {
      rootFiles.push({ mode: entry.mode, name: path, oid: entry.oid });
    } else {
      const dir = path.slice(0, slash);
      let sub = dirs.get(dir);
      if (!sub) {
        sub = new Map();
        dirs.set(dir, sub);
      }
      sub.set(path.slice(slash + 1), entry);
    }
  }
  const entries = [...rootFiles];
  for (const [dir, sub] of dirs) {
    entries.push({ mode: '40000', name: dir, oid: buildTree(repo, sub) });
  }
  entries.sort((a, b) => {
    const ka = treeSortKey(a);
    const kb = treeSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of entries) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return putObject(repo, 'tree', Buffer.concat(parts));
}

function makeCommit(
  repo: RepoRec,
  treeOid: string,
  parents: string[],
  message: string,
  stamp: number,
): string {
  const ident = `${VIEWER.name} <${VIEWER.email}> ${stamp} +0000`;
  let text = `tree ${treeOid}\n`;
  for (const parent of parents) text += `parent ${parent}\n`;
  text += `author ${ident}\ncommitter ${ident}\n\n${message}`;
  return putObject(repo, 'commit', Buffer.from(text, 'utf8'));
}

function refTip(repo: RepoRec, refName: string): string | null {
  return repo.refs.get(refName) ?? null;
}

function branchRef(branch: string): string {
  return `refs/heads/${branch}`;
}

function resolveCommit(repo: RepoRec, ref: string): string | null {
  if (/^[0-9a-f]{40}$/.test(ref)) {
    const obj = repo.objects.get(ref);
    if (obj) return peelToCommit(repo, ref);
    return null;
  }
  const candidates = [ref, branchRef(ref), `refs/tags/${ref}`];
  for (const name of candidates) {
    const tip = repo.refs.get(name);
    if (tip) return peelToCommit(repo, tip);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Packfiles
// ---------------------------------------------------------------------------

const PACK_TYPE_CODES: Record<string, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const PACK_CODE_TYPES: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset] as number;
      offset += 1;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const out = Buffer.alloc(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset] as number;
    offset += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          copyOffset += (delta[offset] as number) * 2 ** shift;
          offset += 1;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          copySize += (delta[offset] as number) * 2 ** shift;
          offset += 1;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (written !== targetSize) throw new Error('delta size mismatch');
  return out;
}

interface PackEntry {
  offset: number;
  type: ObjType;
  data: Buffer;
}

/** Parse a whole pack into the repo store, resolving deltas as they land. */
function ingestPack(repo: RepoRec, pack: Buffer): PackEntry[] {
  if (pack.length < 12 + 20) throw new Error('pack too short');
  if (pack.toString('ascii', 0, 4) !== 'PACK') throw new Error('bad pack magic');
  const count = pack.readUInt32BE(8);
  let pos = 12;
  const entries: PackEntry[] = [];
  const byOffset = new Map<number, PackEntry>();
  const pendingRefDeltas: { baseOid: string; delta: Buffer }[] = [];
  for (let i = 0; i < count; i += 1) {
    const entryOffset = pos;
    let byte = pack[pos] as number;
    pos += 1;
    const typeCode = (byte >> 4) & 0x7;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[pos] as number;
      pos += 1;
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    let baseOffset = -1;
    let baseOid = '';
    if (typeCode === 6) {
      let b = pack[pos] as number;
      pos += 1;
      let value = b & 0x7f;
      while (b & 0x80) {
        b = pack[pos] as number;
        pos += 1;
        value = (value + 1) * 128 + (b & 0x7f);
      }
      baseOffset = entryOffset - value;
    } else if (typeCode === 7) {
      baseOid = pack.toString('hex', pos, pos + 20);
      pos += 20;
    }
    const inflated = inflateSync(pack.subarray(pos), { info: true }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten: number };
    };
    const raw = inflated.buffer;
    pos += inflated.engine.bytesWritten;
    if (raw.length !== size) throw new Error('pack entry size mismatch');
    if (typeCode === 6 || typeCode === 7) {
      if (typeCode === 6) {
        const base = byOffset.get(baseOffset);
        if (!base) throw new Error('ofs-delta base missing');
        const data = applyDelta(base.data, raw);
        const entry: PackEntry = { offset: entryOffset, type: base.type, data };
        entries.push(entry);
        byOffset.set(entryOffset, entry);
      } else {
        // Resolved after the loop, once every plain object is in the store;
        // the delta bytes themselves are never stored as an object.
        pendingRefDeltas.push({ baseOid, delta: raw });
      }
    } else {
      const type = PACK_CODE_TYPES[typeCode];
      if (!type) throw new Error(`unknown pack type ${typeCode}`);
      const entry: PackEntry = { offset: entryOffset, type, data: raw };
      entries.push(entry);
      byOffset.set(entryOffset, entry);
    }
  }
  // Store plain and ofs-resolved entries first so ref-delta bases exist.
  for (const entry of entries) putObject(repo, entry.type, entry.data);
  let pending = pendingRefDeltas;
  while (pending.length > 0) {
    const rest: typeof pending = [];
    let progressed = false;
    for (const entry of pending) {
      const base = repo.objects.get(entry.baseOid);
      if (!base) {
        rest.push(entry);
        continue;
      }
      putObject(repo, base.t, applyDelta(base.data, entry.delta));
      progressed = true;
    }
    if (!progressed) throw new Error('ref-delta base missing');
    pending = rest;
  }
  return entries;
}

/** Serialise a set of objects (already in send order) into a packfile. */
function buildPack(repo: RepoRec, oids: string[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(oids.length, 8);
  parts.push(header);
  for (const oid of oids) {
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    const code = PACK_TYPE_CODES[obj.t] as number;
    let remaining = obj.data.length;
    const first = (code << 4) | (remaining & 0x0f);
    remaining = Math.floor(remaining / 16);
    const headBytes: number[] = [];
    let current = first;
    while (remaining > 0) {
      headBytes.push(current | 0x80);
      current = remaining & 0x7f;
      remaining = Math.floor(remaining / 128);
    }
    headBytes.push(current);
    parts.push(Buffer.from(headBytes));
    parts.push(obj.z); // the stored compressed bytes, copied verbatim
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

// ---------------------------------------------------------------------------
// Reachability for fetch: what to send, and where the shallow boundary sits
// ---------------------------------------------------------------------------

interface FetchPlan {
  oids: string[]; // commits first, then trees and blobs
  shallow: string[];
  unshallow: string[];
  empty: boolean;
}

function collectClosure(
  repo: RepoRec,
  tips: string[],
  stopAtShallow: Set<string> | null,
): { commits: Set<string>; objects: Set<string> } {
  const commits = new Set<string>();
  const objects = new Set<string>();
  const stack: string[] = [];
  for (const tip of tips) {
    const commit = peelToCommit(repo, tip);
    if (commit) stack.push(commit);
    if (repo.objects.has(tip)) objects.add(tip);
  }
  while (stack.length > 0) {
    const current = stack.pop() as string;
    if (commits.has(current)) continue;
    commits.add(current);
    const info = commitInfo(repo, current);
    if (!info) continue;
    if (stopAtShallow && stopAtShallow.has(current)) continue;
    for (const parent of info.parents) stack.push(parent);
  }
  for (const commit of commits) {
    objects.add(commit);
    const info = commitInfo(repo, commit);
    if (!info || !info.tree) continue;
    const treeStack = [info.tree];
    while (treeStack.length > 0) {
      const treeOid = treeStack.pop() as string;
      if (objects.has(treeOid)) continue;
      objects.add(treeOid);
      for (const entry of treeEntries(repo, treeOid)) {
        if (entry.mode === '40000') treeStack.push(entry.oid);
        else objects.add(entry.oid);
      }
    }
  }
  return { commits, objects };
}

function planFetch(
  repo: RepoRec,
  wants: string[],
  haves: string[],
  clientShallow: string[],
  depth: number | null,
): FetchPlan {
  const shallowSet = new Set(clientShallow);
  const haveClosure = collectClosure(repo, haves, shallowSet.size > 0 ? shallowSet : null);
  // Distances from the wants, honouring the depth cut.
  const dist = new Map<string, number>();
  const queue: string[] = [];
  for (const want of wants) {
    const commit = peelToCommit(repo, want);
    if (commit && !dist.has(commit)) {
      dist.set(commit, 0);
      queue.push(commit);
    }
  }
  const includedCommits: string[] = [];
  const boundary = new Set<string>();
  while (queue.length > 0) {
    const current = queue.shift() as string;
    const d = dist.get(current) as number;
    includedCommits.push(current);
    const info = commitInfo(repo, current);
    if (!info) continue;
    if (depth !== null && d >= depth - 1) {
      if (info.parents.length > 0) boundary.add(current);
      continue;
    }
    for (const parent of info.parents) {
      if (!dist.has(parent)) {
        dist.set(parent, d + 1);
        queue.push(parent);
      }
    }
  }
  const sendCommits = includedCommits.filter((oid) => !haveClosure.commits.has(oid));
  const send = new Set<string>();
  for (const oid of sendCommits) send.add(oid);
  // Tag objects named directly as wants travel too.
  for (const want of wants) {
    if (repo.objects.has(want) && !haveClosure.objects.has(want)) send.add(want);
  }
  for (const commit of sendCommits) {
    const info = commitInfo(repo, commit);
    if (!info || !info.tree) continue;
    const treeStack = [info.tree];
    while (treeStack.length > 0) {
      const treeOid = treeStack.pop() as string;
      if (send.has(treeOid) || haveClosure.objects.has(treeOid)) continue;
      send.add(treeOid);
      for (const entry of treeEntries(repo, treeOid)) {
        if (entry.mode === '40000') treeStack.push(entry.oid);
        else if (!haveClosure.objects.has(entry.oid)) send.add(entry.oid);
      }
    }
  }
  // A boundary commit the client already holds still moves the boundary in
  // the reply, so the shallow list is computed from included commits, not
  // only from the ones being sent.
  const shallow: string[] = [];
  const unshallow: string[] = [];
  if (depth !== null) {
    for (const commit of includedCommits) {
      if (boundary.has(commit)) shallow.push(commit);
      else if (shallowSet.has(commit)) unshallow.push(commit);
    }
  }
  const commitSet = new Set(sendCommits);
  const ordered = [
    ...sendCommits,
    ...[...send].filter((oid) => !commitSet.has(oid)),
  ];
  return { oids: ordered, shallow, unshallow, empty: send.size === 0 };
}

// ---------------------------------------------------------------------------
// pkt-lines
// ---------------------------------------------------------------------------

function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = body.length + 4;
  const head = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}

const PKT_FLUSH = Buffer.from('0000', 'ascii');
const PKT_DELIM = Buffer.from('0001', 'ascii');

interface PktPacket {
  kind: 'data' | 'flush' | 'delim' | 'end';
  payload: Buffer;
}

/** Parse as much of a pkt-line stream as the buffer holds. */
function parsePkts(buffer: Buffer, start: number): { packets: PktPacket[]; next: number } {
  const packets: PktPacket[] = [];
  let pos = start;
  while (pos + 4 <= buffer.length) {
    const hex = buffer.toString('ascii', pos, pos + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error('bad pkt-line length');
    const length = parseInt(hex, 16);
    if (length === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      pos += 4;
      break;
    }
    if (length === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      pos += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'end', payload: Buffer.alloc(0) });
      pos += 4;
      break;
    }
    if (length < 4 || pos + length > buffer.length) throw new Error('truncated pkt-line');
    packets.push({ kind: 'data', payload: buffer.subarray(pos + 4, pos + length) });
    pos += length;
  }
  return { packets, next: pos };
}

/** Wrap pack bytes in side-band-64k packets (band 1), chunked to the limit. */
function sidebandPackets(pack: Buffer): Buffer {
  const chunks: Buffer[] = [];
  const MAX_DATA = 65515;
  for (let offset = 0; offset < pack.length; offset += MAX_DATA) {
    const slice = pack.subarray(offset, Math.min(pack.length, offset + MAX_DATA));
    chunks.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  if (pack.length === 0) chunks.push(pktLine(Buffer.from([1])));
  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------------------
// Serialisation: the REST view of the store
// ---------------------------------------------------------------------------

function userJson(persona: Persona): Record<string, unknown> {
  return { login: persona.login, id: persona.id, type: 'User', name: persona.name, email: persona.email };
}

function repoJson(repo: RepoRec): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userJson(VIEWER),
    private: repo.priv,
    description: repo.desc,
    default_branch: repo.defBranch,
    html_url: `/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    clone_url: `/${repo.owner}/${repo.name}.git`,
    created_at: isoOf(EPOCH + repo.id * 60),
    updated_at: isoOf(EPOCH + repo.id * 60 + repo.tick * 60),
    has_issues: true,
    has_pull_requests: true,
    open_issues_count: [...repo.items.values()].filter((item) => item.state === 'open').length,
  };
}

function labelJson(repo: RepoRec, name: string): Record<string, unknown> {
  const label = repo.labels.get(name);
  return { name, color: label ? label.color : 'ededed', description: null, default: false };
}

function issueJson(repo: RepoRec, issue: IssueRec): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.num,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => labelJson(repo, name)),
    user: userJson(VIEWER),
    author: userJson(VIEWER),
    comments: issue.comments.length,
    created_at: isoOf(issue.createdSec),
    updated_at: isoOf(issue.createdSec),
    closed_at: issue.state === 'closed' ? isoOf(issue.createdSec) : null,
    html_url: `/${repo.owner}/${repo.name}/issues/${issue.num}`,
    repository_url: `/api/v3/repos/${repo.owner}/${repo.name}`,
  };
}

function commentJson(comment: CommentRec): Record<string, unknown> {
  return {
    id: comment.id,
    body: comment.body,
    user: userJson(VIEWER),
    author: userJson(VIEWER),
    created_at: isoOf(comment.createdSec),
    updated_at: isoOf(comment.createdSec),
  };
}

function pullHeadSha(repo: RepoRec, pull: PullRec): string {
  return repo.refs.get(branchRef(pull.headRef)) ?? pull.headSha;
}

function pullBaseSha(repo: RepoRec, pull: PullRec): string {
  return repo.refs.get(branchRef(pull.baseRef)) ?? ZERO_OID;
}

function pullJson(repo: RepoRec, pull: PullRec): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.num,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    head: {
      ref: pull.headRef,
      sha: pullHeadSha(repo, pull),
      label: `${repo.owner}:${pull.headRef}`,
      user: userJson(VIEWER),
    },
    base: {
      ref: pull.baseRef,
      sha: pullBaseSha(repo, pull),
      label: `${repo.owner}:${pull.baseRef}`,
      user: userJson(VIEWER),
    },
    merged: pull.merged,
    merged_at: pull.mergedSec !== null ? isoOf(pull.mergedSec) : null,
    merge_commit_sha: pull.mergeSha,
    user: userJson(VIEWER),
    author: userJson(VIEWER),
    created_at: isoOf(pull.createdSec),
    updated_at: isoOf(pull.createdSec),
    html_url: `/${repo.owner}/${repo.name}/pull/${pull.num}`,
  };
}

// ---------------------------------------------------------------------------
// Tree surgery behind the contents API and pull merges
// ---------------------------------------------------------------------------

function writeFileOnBranch(
  repo: RepoRec,
  branch: string,
  path: string,
  content: Buffer,
  message: string,
): { commitOid: string; blobOid: string } {
  const ref = branchRef(branch);
  const tip = repo.refs.get(ref) ?? null;
  const files = tip ? filesAtCommit(repo, peelToCommit(repo, tip) as string) : new Map<string, FileEntry>();
  const blobOid = putObject(repo, 'blob', content);
  files.set(path, { oid: blobOid, mode: '100644' });
  const treeOid = buildTree(repo, files);
  const stamp = nextStamp(repo);
  const commitOid = makeCommit(repo, treeOid, tip ? [peelToCommit(repo, tip) as string] : [], message, stamp);
  repo.refs.set(ref, commitOid);
  touch(repo);
  return { commitOid, blobOid };
}

function deleteFileOnBranch(
  repo: RepoRec,
  branch: string,
  path: string,
  message: string,
): string | null {
  const ref = branchRef(branch);
  const tip = repo.refs.get(ref) ?? null;
  if (!tip) return null;
  const tipCommit = peelToCommit(repo, tip) as string;
  const files = filesAtCommit(repo, tipCommit);
  if (!files.has(path)) return null;
  files.delete(path);
  const treeOid = buildTree(repo, files);
  const commitOid = makeCommit(repo, treeOid, [tipCommit], message, nextStamp(repo));
  repo.refs.set(ref, commitOid);
  touch(repo);
  return commitOid;
}

interface PullDiffFile {
  filename: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  changes: number;
}

function countLines(data: Buffer): string[] {
  if (data.length === 0) return [];
  return data.toString('utf8').split('\n');
}

function lineDiff(oldData: Buffer, newData: Buffer): { additions: number; deletions: number } {
  const a = countLines(oldData);
  const b = countLines(newData);
  if (a.length === 0) return { additions: b.length, deletions: 0 };
  if (b.length === 0) return { additions: 0, deletions: a.length };
  if (a.length * b.length > 4_000_000) {
    return { additions: b.length, deletions: a.length };
  }
  // Longest-common-subsequence over lines.
  const dp: Uint32Array[] = [];
  for (let i = 0; i <= a.length; i += 1) dp.push(new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      const row = dp[i] as Uint32Array;
      const below = dp[i + 1] as Uint32Array;
      row[j] = a[i] === b[j] ? (below[j + 1] as number) + 1 : Math.max(below[j] as number, row[j + 1] as number);
    }
  }
  const common = (dp[0] as Uint32Array)[0] as number;
  return { additions: b.length - common, deletions: a.length - common };
}

function pullFiles(repo: RepoRec, pull: PullRec): PullDiffFile[] {
  const headTip = repo.refs.get(branchRef(pull.headRef)) ?? pull.headSha;
  const baseTip = repo.refs.get(branchRef(pull.baseRef));
  const headCommit = peelToCommit(repo, headTip);
  if (!headCommit) return [];
  let fromCommit = headCommit;
  if (baseTip) {
    const baseCommit = peelToCommit(repo, baseTip);
    if (baseCommit) fromCommit = mergeBase(repo, baseCommit, headCommit) ?? baseCommit;
  }
  const before = filesAtCommit(repo, fromCommit);
  const after = filesAtCommit(repo, headCommit);
  const out: PullDiffFile[] = [];
  const paths = new Set([...before.keys(), ...after.keys()]);
  for (const path of [...paths].sort()) {
    const oldEntry = before.get(path);
    const newEntry = after.get(path);
    if (oldEntry && !newEntry) {
      const oldData = repo.objects.get(oldEntry.oid)?.data ?? Buffer.alloc(0);
      const deletions = countLines(oldData).length;
      out.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
    } else if (!oldEntry && newEntry) {
      const newData = repo.objects.get(newEntry.oid)?.data ?? Buffer.alloc(0);
      const additions = countLines(newData).length;
      out.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
    } else if (oldEntry && newEntry && oldEntry.oid !== newEntry.oid) {
      const diff = lineDiff(
        repo.objects.get(oldEntry.oid)?.data ?? Buffer.alloc(0),
        repo.objects.get(newEntry.oid)?.data ?? Buffer.alloc(0),
      );
      out.push({
        filename: path,
        status: 'modified',
        additions: diff.additions,
        deletions: diff.deletions,
        changes: diff.additions + diff.deletions,
      });
    }
  }
  return out;
}

/** Three-way file merge of head into base; returns the merged tree or null on conflict. */
function squashMergeTree(repo: RepoRec, baseTip: string, headTip: string): string | null {
  const baseCommit = peelToCommit(repo, baseTip) as string;
  const headCommit = peelToCommit(repo, headTip) as string;
  const base = mergeBase(repo, baseCommit, headCommit);
  const origin = base ? filesAtCommit(repo, base) : new Map<string, FileEntry>();
  const current = filesAtCommit(repo, baseCommit);
  const incoming = filesAtCommit(repo, headCommit);
  const merged = new Map(current);
  const paths = new Set([...origin.keys(), ...current.keys(), ...incoming.keys()]);
  for (const path of paths) {
    const o = origin.get(path);
    const c = current.get(path);
    const h = incoming.get(path);
    const headChanged = (h?.oid ?? null) !== (o?.oid ?? null);
    const baseChanged = (c?.oid ?? null) !== (o?.oid ?? null);
    if (headChanged && baseChanged) {
      if ((h?.oid ?? null) === (c?.oid ?? null)) continue; // the same change both sides
      return null;
    }
    if (headChanged) {
      if (h) merged.set(path, h);
      else merged.delete(path);
    }
  }
  return buildTree(repo, merged);
}

function mergePullRequest(repo: RepoRec, pull: PullRec): { sha: string } | 'conflict' | 'gone' {
  if (pull.state === 'closed') return 'gone';
  const baseRefName = branchRef(pull.baseRef);
  const baseTip = repo.refs.get(baseRefName);
  const headTip = repo.refs.get(branchRef(pull.headRef)) ?? pull.headSha;
  if (!baseTip || !headTip) return 'conflict';
  const treeOid = squashMergeTree(repo, baseTip, headTip);
  if (treeOid === null) return 'conflict';
  const baseCommit = peelToCommit(repo, baseTip) as string;
  const stamp = nextStamp(repo);
  const sha = makeCommit(repo, treeOid, [baseCommit], `${pull.title} (#${pull.num})`, stamp);
  repo.refs.set(baseRefName, sha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergeSha = sha;
  pull.mergedSec = stamp;
  pull.ver += 1;
  touch(repo);
  return { sha };
}

function pullMergeable(repo: RepoRec, pull: PullRec): 'MERGEABLE' | 'CONFLICTING' {
  if (pull.merged) return 'MERGEABLE';
  const baseTip = repo.refs.get(branchRef(pull.baseRef));
  const headTip = repo.refs.get(branchRef(pull.headRef)) ?? pull.headSha;
  if (!baseTip || !headTip) return 'CONFLICTING';
  // buildTree inside squashMergeTree writes tree objects; that is harmless
  // (objects are content-addressed) even when we only want the verdict.
  return squashMergeTree(repo, baseTip, headTip) === null ? 'CONFLICTING' : 'MERGEABLE';
}

function createPull(
  repo: RepoRec,
  input: { title: string; body: string; head: string; base: string },
): PullRec | 'duplicate' | 'badref' {
  const head = normalizeBranchName(input.head);
  const base = normalizeBranchName(input.base);
  if (!repo.refs.has(branchRef(head)) || !repo.refs.has(branchRef(base))) return 'badref';
  for (const item of repo.items.values()) {
    if (item.kind === 'pull' && item.state === 'open' && item.headRef === head && item.baseRef === base) {
      return 'duplicate';
    }
  }
  const pull: PullRec = {
    kind: 'pull',
    num: repo.nextNumber,
    id: nextItemId,
    title: input.title,
    body: input.body,
    state: 'open',
    headRef: head,
    baseRef: base,
    headSha: repo.refs.get(branchRef(head)) as string,
    merged: false,
    mergeSha: null,
    mergedSec: null,
    createdSec: nextStamp(repo),
    ver: 1,
  };
  repo.nextNumber += 1;
  nextItemId += 1;
  repo.items.set(pull.num, pull);
  touch(repo);
  return pull;
}

function normalizeBranchName(ref: string): string {
  let name = ref;
  if (name.startsWith('refs/heads/')) name = name.slice('refs/heads/'.length);
  const colon = name.indexOf(':');
  if (colon > 0 && !name.slice(0, colon).includes('/')) name = name.slice(colon + 1);
  return name;
}

function createIssueRecord(
  repo: RepoRec,
  input: { title: string; body: string; labels: string[] },
): IssueRec {
  const issue: IssueRec = {
    kind: 'issue',
    num: repo.nextNumber,
    id: nextItemId,
    title: input.title,
    body: input.body,
    state: 'open',
    labels: [...input.labels],
    comments: [],
    createdSec: nextStamp(repo),
    ver: 1,
  };
  repo.nextNumber += 1;
  nextItemId += 1;
  repo.items.set(issue.num, issue);
  touch(repo);
  return issue;
}

function labelNamesOf(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const names: string[] = [];
  for (const entry of input) {
    if (typeof entry === 'string') names.push(entry);
    else if (entry && typeof entry === 'object' && typeof (entry as { name?: unknown }).name === 'string') {
      names.push((entry as { name: string }).name);
    }
  }
  return names;
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  host: string;
  body: Buffer | null;
  json: unknown;
  jsonError: boolean;
}

function sendBuffer(ctx: Ctx, status: number, body: Buffer, contentType: string, extra?: Record<string, string>): void {
  const headers: Record<string, string> = {
    'content-type': contentType,
    'content-length': String(body.length),
    'x-github-request-id': `req-${(requestSeq += 1)}`,
    ...(extra ?? {}),
  };
  ctx.res.writeHead(status, headers);
  ctx.res.end(body);
}

function sendJson(ctx: Ctx, status: number, value: unknown, extra?: Record<string, string>): void {
  sendBuffer(ctx, status, Buffer.from(JSON.stringify(value), 'utf8'), 'application/json; charset=utf-8', extra);
}

function sendError(ctx: Ctx, status: number, message: string): void {
  sendJson(ctx, status, { message });
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > 96 * 1024 * 1024) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function authed(ctx: Ctx): boolean {
  const header = ctx.req.headers.authorization;
  if (typeof header !== 'string') return false;
  if (TOKEN !== '') return header === `Bearer ${TOKEN}`;
  return header.startsWith('Bearer ');
}

// ---------------------------------------------------------------------------
// REST v3
// ---------------------------------------------------------------------------

function paginationParams(url: URL): { page: number; perPage: number } {
  const perPageRaw = Number(url.searchParams.get('per_page') ?? '30');
  const pageRaw = Number(url.searchParams.get('page') ?? '1');
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(100, Math.trunc(perPageRaw)) : 30;
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.trunc(pageRaw) : 1;
  return { page, perPage };
}

function pageSlice<T>(items: T[], url: URL): { slice: T[]; page: number; perPage: number; hasNext: boolean } {
  const { page, perPage } = paginationParams(url);
  const start = (page - 1) * perPage;
  return { slice: items.slice(start, start + perPage), page, perPage, hasNext: start + perPage < items.length };
}

function linkHeader(ctx: Ctx, pathAndQuery: string, page: number, perPage: number): Record<string, string> {
  const joiner = pathAndQuery.includes('?') ? '&' : '?';
  const next = `<http://${ctx.host}${pathAndQuery}${joiner}per_page=${perPage}&page=${page + 1}>; rel="next"`;
  return { link: next };
}

function parseIdentLine(line: string): { name: string; email: string; date: string } {
  const match = /^(.*?) <(.*?)> (\d+) [+-]\d{4}$/.exec(line);
  if (!match) return { name: line, email: '', date: isoOf(EPOCH) };
  return { name: match[1] as string, email: match[2] as string, date: isoOf(Number(match[3])) };
}

function commitJson(repo: RepoRec, oid: string): Record<string, unknown> {
  const info = commitInfo(repo, oid) as CommitInfo;
  const author = parseIdentLine(info.authorLine);
  const committer = parseIdentLine(info.committerLine);
  return {
    sha: oid,
    commit: {
      message: info.message.replace(/\n$/, ''),
      author: { name: author.name, email: author.email, date: author.date },
      committer: { name: committer.name, email: committer.email, date: committer.date },
      tree: { sha: info.tree },
    },
    author: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    committer: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    parents: info.parents.map((parent) => ({ sha: parent })),
  };
}

function findRepo(owner: string, name: string): RepoRec | null {
  return repos.get(repoKey(owner, name)) ?? null;
}

async function handleRest(ctx: Ctx, segments: string[]): Promise<void> {
  const { url } = ctx;
  const method = ctx.req.method ?? 'GET';
  // Body discipline: malformed JSON on a body-carrying method is a 400.
  const bodyObj = (ctx.json && typeof ctx.json === 'object' ? (ctx.json as Record<string, unknown>) : {}) as Record<string, unknown>;
  if ((method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') && ctx.body && ctx.body.length > 0 && ctx.jsonError) {
    sendError(ctx, 400, 'Malformed JSON in request body');
    return;
  }
  const seg = segments;

  if (seg.length === 0) {
    if (method === 'GET') {
      sendJson(ctx, 200, {
        current_user_url: '/api/v3/user',
        repository_url: '/api/v3/repos/{owner}/{repo}',
        issue_search_url: '/api/v3/search/issues',
        installed_version: '1.0.0',
      }, { 'x-oauth-scopes': 'repo, read:org' });
      return;
    }
    sendError(ctx, 404, 'Not Found');
    return;
  }

  if (seg[0] === 'meta' && seg.length === 1 && method === 'GET') {
    sendJson(ctx, 200, { installed_version: '1.0.0', git_version: 'forge-1.0.0' });
    return;
  }

  if (seg[0] === 'user' && seg.length === 1 && method === 'GET') {
    sendJson(ctx, 200, userJson(VIEWER));
    return;
  }

  if (seg[0] === 'user' && seg[1] === 'repos' && seg.length === 2) {
    if (method === 'GET') {
      const mine = [...repos.values()].filter((repo) => repo.owner === VIEWER.login).sort((a, b) => a.id - b.id);
      const { slice, page, perPage, hasNext } = pageSlice(mine, url);
      const extra = hasNext ? linkHeader(ctx, '/api/v3/user/repos', page, perPage) : undefined;
      sendJson(ctx, 200, slice.map((repo) => repoJson(repo)), extra);
      return;
    }
    if (method === 'POST') {
      const name = typeof bodyObj.name === 'string' ? bodyObj.name : '';
      if (name === '') {
        sendError(ctx, 422, 'Repository creation failed: name is required');
        return;
      }
      if (findRepo(VIEWER.login, name)) {
        sendError(ctx, 422, `Repository creation failed: a repository named ${name} already exists`);
        return;
      }
      const repo = createRepoRec(
        VIEWER.login,
        name,
        typeof bodyObj.description === 'string' ? bodyObj.description : '',
        typeof bodyObj.private === 'boolean' ? bodyObj.private : false,
      );
      if (typeof bodyObj.default_branch === 'string' && bodyObj.default_branch !== '') {
        repo.defBranch = bodyObj.default_branch;
      }
      sendJson(ctx, 201, repoJson(repo));
      return;
    }
    sendError(ctx, 404, 'Not Found');
    return;
  }

  if (seg[0] === 'repos' && seg.length >= 3) {
    const owner = seg[1] as string;
    const name = seg[2] as string;
    const repo = findRepo(owner, name);
    if (!repo) {
      sendError(ctx, 404, 'Not Found');
      return;
    }
    const rest = seg.slice(3);
    await handleRepoScoped(ctx, repo, rest, bodyObj);
    return;
  }

  sendError(ctx, 404, 'Not Found');
}

async function handleRepoScoped(
  ctx: Ctx,
  repo: RepoRec,
  seg: string[],
  bodyObj: Record<string, unknown>,
): Promise<void> {
  const { url } = ctx;
  const method = ctx.req.method ?? 'GET';
  const repoPath = `/api/v3/repos/${repo.owner}/${repo.name}`;

  if (seg.length === 0) {
    if (method === 'GET') {
      sendJson(ctx, 200, repoJson(repo));
      return;
    }
    if (method === 'PATCH') {
      if (typeof bodyObj.description === 'string') repo.desc = bodyObj.description;
      if (typeof bodyObj.private === 'boolean') repo.priv = bodyObj.private;
      if (typeof bodyObj.name === 'string' && bodyObj.name !== '' && bodyObj.name !== repo.name) {
        repos.delete(repoKey(repo.owner, repo.name));
        repo.name = bodyObj.name;
        repos.set(repoKey(repo.owner, repo.name), repo);
      }
      if (typeof bodyObj.default_branch === 'string' && bodyObj.default_branch !== '') repo.defBranch = bodyObj.default_branch;
      touch(repo);
      sendJson(ctx, 200, repoJson(repo));
      return;
    }
    if (method === 'DELETE') {
      deleteRepoRec(repo);
      ctx.res.writeHead(204, { 'x-github-request-id': `req-${(requestSeq += 1)}` });
      ctx.res.end();
      return;
    }
    sendError(ctx, 404, 'Not Found');
    return;
  }

  if (seg[0] === 'branches') {
    if (seg.length === 1 && method === 'GET') {
      const branches = [...repo.refs.entries()]
        .filter(([ref]) => ref.startsWith('refs/heads/'))
        .map(([ref, sha]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha }, protected: false }))
        .sort((a, b) => (a.name < b.name ? -1 : 1));
      sendJson(ctx, 200, branches);
      return;
    }
    if (seg.length >= 2 && method === 'GET') {
      const branch = seg.slice(1).join('/');
      const sha = repo.refs.get(branchRef(branch));
      if (!sha) {
        sendError(ctx, 404, 'Branch not found');
        return;
      }
      sendJson(ctx, 200, { name: branch, commit: { sha }, protected: false });
      return;
    }
    sendError(ctx, 404, 'Not Found');
    return;
  }

  if (seg[0] === 'commits' && seg.length === 1 && method === 'GET') {
    const refParam = url.searchParams.get('sha') ?? url.searchParams.get('branch') ?? repo.defBranch;
    const start = resolveCommit(repo, refParam);
    if (!start) {
      sendJson(ctx, 200, []);
      return;
    }
    const seen = new Set<string>();
    const ordered: string[] = [];
    const stack = [start];
    while (stack.length > 0 && ordered.length < 500) {
      const current = stack.pop() as string;
      if (seen.has(current)) continue;
      seen.add(current);
      ordered.push(current);
      const info = commitInfo(repo, current);
      if (info) for (let i = info.parents.length - 1; i >= 0; i -= 1) stack.push(info.parents[i] as string);
    }
    const { slice } = pageSlice(ordered, url);
    sendJson(ctx, 200, slice.map((oid) => commitJson(repo, oid)));
    return;
  }

  if (seg[0] === 'git' && seg[1] === 'refs') {
    if (seg.length === 2 && method === 'POST') {
      const ref = typeof bodyObj.ref === 'string' ? bodyObj.ref : '';
      const sha = typeof bodyObj.sha === 'string' ? bodyObj.sha : '';
      if (!ref.startsWith('refs/') || !repo.objects.has(sha)) {
        sendError(ctx, 422, 'Invalid ref or sha');
        return;
      }
      repo.refs.set(ref, sha);
      touch(repo);
      const obj = repo.objects.get(sha) as GObj;
      sendJson(ctx, 201, { ref, object: { sha, type: obj.t } });
      return;
    }
    if (seg.length >= 3 && method === 'GET') {
      const ref = seg.slice(2).join('/');
      const full = ref.startsWith('refs/') ? ref : `refs/${ref}`;
      const sha = repo.refs.get(full);
      if (!sha) {
        sendError(ctx, 404, 'Reference not found');
        return;
      }
      const obj = repo.objects.get(sha) as GObj;
      sendJson(ctx, 200, { ref: full, object: { sha, type: obj.t } });
      return;
    }
    sendError(ctx, 404, 'Not Found');
    return;
  }

  if (seg[0] === 'contents') {
    await handleContents(ctx, repo, seg.slice(1).join('/'), bodyObj);
    return;
  }

  if (seg[0] === 'labels') {
    if (seg.length === 1 && method === 'POST') {
      const labelName = typeof bodyObj.name === 'string' ? bodyObj.name : '';
      if (labelName === '') {
        sendError(ctx, 422, 'Label name is required');
        return;
      }
      if (!repo.labels.has(labelName)) {
        repo.labels.set(labelName, {
          name: labelName,
          color: typeof bodyObj.color === 'string' ? bodyObj.color.replace(/^#/, '') : 'ededed',
        });
        touch(repo);
      }
      sendJson(ctx, 201, labelJson(repo, labelName));
      return;
    }
    if (seg.length === 1 && method === 'GET') {
      sendJson(ctx, 200, [...repo.labels.keys()].map((labelName) => labelJson(repo, labelName)));
      return;
    }
    sendError(ctx, 404, 'Not Found');
    return;
  }

  if (seg[0] === 'issues') {
    await handleIssues(ctx, repo, seg.slice(1), bodyObj);
    return;
  }

  if (seg[0] === 'pulls') {
    await handlePulls(ctx, repo, seg.slice(1), bodyObj);
    return;
  }

  sendError(ctx, 404, 'Not Found');
}

async function handleContents(
  ctx: Ctx,
  repo: RepoRec,
  path: string,
  bodyObj: Record<string, unknown>,
): Promise<void> {
  const { url } = ctx;
  const method = ctx.req.method ?? 'GET';
  const cleanPath = path.replace(/^\/+|\/+$/g, '');

  if (method === 'GET') {
    const refParam = url.searchParams.get('ref') ?? repo.defBranch;
    const commit = resolveCommit(repo, refParam);
    if (!commit) {
      sendError(ctx, 404, 'Not Found');
      return;
    }
    const files = filesAtCommit(repo, commit);
    if (cleanPath !== '' && files.has(cleanPath)) {
      const entry = files.get(cleanPath) as FileEntry;
      const data = repo.objects.get(entry.oid)?.data ?? Buffer.alloc(0);
      sendJson(ctx, 200, {
        type: 'file',
        name: cleanPath.split('/').pop(),
        path: cleanPath,
        sha: entry.oid,
        size: data.length,
        encoding: 'base64',
        content: data.toString('base64'),
      });
      return;
    }
    // Directory listing (the root when the path is empty).
    const prefix = cleanPath === '' ? '' : `${cleanPath}/`;
    const entries = new Map<string, { type: 'file' | 'dir'; sha: string; size: number }>();
    for (const [filePath, entry] of files) {
      if (prefix !== '' && !filePath.startsWith(prefix)) continue;
      const rest = filePath.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash === -1) {
        entries.set(rest, { type: 'file', sha: entry.oid, size: repo.objects.get(entry.oid)?.data.length ?? 0 });
      } else {
        const dirName = rest.slice(0, slash);
        if (!entries.has(dirName)) {
          // A directory's sha is its tree id; find it by walking the tree.
          entries.set(dirName, { type: 'dir', sha: dirTreeSha(repo, commit, prefix + dirName), size: 0 });
        }
      }
    }
    if (cleanPath !== '' && entries.size === 0) {
      sendError(ctx, 404, 'Not Found');
      return;
    }
    const listing = [...entries.entries()]
      .map(([entryName, entry]) => ({
        type: entry.type,
        name: entryName,
        path: prefix + entryName,
        sha: entry.sha,
        size: entry.size,
      }))
      .sort((a, b) => (a.path < b.path ? -1 : 1));
    sendJson(ctx, 200, listing);
    return;
  }

  if (method === 'PUT') {
    const branch = typeof bodyObj.branch === 'string' && bodyObj.branch !== '' ? bodyObj.branch : repo.defBranch;
    const message = typeof bodyObj.message === 'string' ? bodyObj.message : 'Update file';
    const encoded = typeof bodyObj.content === 'string' ? bodyObj.content : '';
    const content = Buffer.from(encoded.replace(/[\r\n\t ]+/g, ''), 'base64');
    const ref = branchRef(branch);
    const tip = repo.refs.get(ref);
    let existing: FileEntry | undefined;
    if (tip) {
      const tipCommit = peelToCommit(repo, tip) as string;
      existing = filesAtCommit(repo, tipCommit).get(cleanPath);
    }
    if (existing) {
      const givenSha = typeof bodyObj.sha === 'string' ? bodyObj.sha : null;
      if (givenSha !== existing.oid) {
        sendError(ctx, 409, 'Conflict: the file has changed since the sha was read');
        return;
      }
    }
    const { commitOid, blobOid } = writeFileOnBranch(repo, branch, cleanPath, content, message);
    const status = existing ? 200 : 201;
    sendJson(ctx, status, {
      content: {
        type: 'file',
        name: cleanPath.split('/').pop(),
        path: cleanPath,
        sha: blobOid,
        size: content.length,
        encoding: 'base64',
      },
      commit: { sha: commitOid, message },
    });
    return;
  }

  if (method === 'DELETE') {
    const branch = typeof bodyObj.branch === 'string' && bodyObj.branch !== '' ? bodyObj.branch : repo.defBranch;
    const message = typeof bodyObj.message === 'string' ? bodyObj.message : 'Delete file';
    const commitOid = deleteFileOnBranch(repo, branch, cleanPath, message);
    if (!commitOid) {
      sendError(ctx, 404, 'Not Found');
      return;
    }
    sendJson(ctx, 200, { content: null, commit: { sha: commitOid, message } });
    return;
  }

  sendError(ctx, 404, 'Not Found');
}

function dirTreeSha(repo: RepoRec, commitOid: string, dirPath: string): string {
  const info = commitInfo(repo, commitOid);
  if (!info) return ZERO_OID;
  let treeOid = info.tree;
  for (const segment of dirPath.split('/').filter((part) => part !== '')) {
    const entry = treeEntries(repo, treeOid).find((candidate) => candidate.name === segment);
    if (!entry) return ZERO_OID;
    treeOid = entry.oid;
  }
  return treeOid;
}

async function handleIssues(
  ctx: Ctx,
  repo: RepoRec,
  seg: string[],
  bodyObj: Record<string, unknown>,
): Promise<void> {
  const { url } = ctx;
  const method = ctx.req.method ?? 'GET';

  if (seg.length === 0) {
    if (method === 'POST') {
      const title = typeof bodyObj.title === 'string' ? bodyObj.title : '';
      if (title === '') {
        sendError(ctx, 422, 'Validation failed: title is required');
        return;
      }
      const labels = labelNamesOf(bodyObj.labels);
      for (const label of labels) {
        if (!repo.labels.has(label)) {
          sendError(ctx, 422, `Validation failed: label ${label} does not exist`);
          return;
        }
      }
      const issue = createIssueRecord(repo, {
        title,
        body: typeof bodyObj.body === 'string' ? bodyObj.body : '',
        labels,
      });
      sendJson(ctx, 201, issueJson(repo, issue));
      return;
    }
    if (method === 'GET') {
      const stateParam = url.searchParams.get('state') ?? 'open';
      const sort = url.searchParams.get('sort') ?? 'created';
      const direction = url.searchParams.get('direction') ?? 'desc';
      let list = [...repo.items.values()].filter(
        (item): item is IssueRec => item.kind === 'issue',
      );
      if (stateParam === 'open') list = list.filter((issue) => issue.state === 'open');
      else if (stateParam === 'closed') list = list.filter((issue) => issue.state === 'closed');
      list.sort((a, b) => a.num - b.num);
      if (sort === 'created' && direction === 'desc') list.reverse();
      const { slice } = pageSlice(list, url);
      sendJson(ctx, 200, slice.map((issue) => issueJson(repo, issue)));
      return;
    }
    sendError(ctx, 404, 'Not Found');
    return;
  }

  const num = Number(seg[0]);
  const item = Number.isInteger(num) ? repo.items.get(num) : undefined;
  const issue = item && item.kind === 'issue' ? item : undefined;

  if (seg.length === 1) {
    if (!issue) {
      sendError(ctx, 404, 'Not Found');
      return;
    }
    if (method === 'GET') {
      const cached = repo.issueJsonCache.get(issue.num);
      if (cached && cached.ver === issue.ver) {
        sendBuffer(ctx, 200, cached.buf, 'application/json; charset=utf-8');
        return;
      }
      const buf = Buffer.from(JSON.stringify(issueJson(repo, issue)), 'utf8');
      repo.issueJsonCache.set(issue.num, { ver: issue.ver, buf });
      sendBuffer(ctx, 200, buf, 'application/json; charset=utf-8');
      return;
    }
    if (method === 'PATCH') {
      if (bodyObj.state === 'closed' || bodyObj.state === 'open') issue.state = bodyObj.state;
      if (typeof bodyObj.title === 'string') issue.title = bodyObj.title;
      if (typeof bodyObj.body === 'string') issue.body = bodyObj.body;
      if (bodyObj.labels !== undefined) {
        const labels = labelNamesOf(bodyObj.labels);
        for (const label of labels) {
          if (!repo.labels.has(label)) {
            sendError(ctx, 422, `Validation failed: label ${label} does not exist`);
            return;
          }
        }
        issue.labels = labels;
      }
      issue.ver += 1;
      touch(repo);
      sendJson(ctx, 200, issueJson(repo, issue));
      return;
    }
    sendError(ctx, 404, 'Not Found');
    return;
  }

  if (seg.length === 2 && seg[1] === 'comments') {
    if (!issue) {
      sendError(ctx, 404, 'Not Found');
      return;
    }
    if (method === 'POST') {
      const body = typeof bodyObj.body === 'string' ? bodyObj.body : '';
      const comment: CommentRec = { id: nextCommentId, body, createdSec: nextStamp(repo) };
      nextCommentId += 1;
      issue.comments.push(comment);
      issue.ver += 1;
      touch(repo);
      sendJson(ctx, 201, commentJson(comment));
      return;
    }
    if (method === 'GET') {
      const { slice } = pageSlice(issue.comments, url);
      sendJson(ctx, 200, slice.map((comment) => commentJson(comment)));
      return;
    }
    sendError(ctx, 404, 'Not Found');
    return;
  }

  sendError(ctx, 404, 'Not Found');
}

async function handlePulls(
  ctx: Ctx,
  repo: RepoRec,
  seg: string[],
  bodyObj: Record<string, unknown>,
): Promise<void> {
  const { url } = ctx;
  const method = ctx.req.method ?? 'GET';

  if (seg.length === 0) {
    if (method === 'POST') {
      const head = typeof bodyObj.head === 'string' ? bodyObj.head : '';
      const base = typeof bodyObj.base === 'string' ? bodyObj.base : '';
      const title = typeof bodyObj.title === 'string' ? bodyObj.title : '';
      if (head === '' || base === '' || title === '') {
        sendError(ctx, 422, 'Validation failed: head, base and title are required');
        return;
      }
      const created = createPull(repo, {
        title,
        body: typeof bodyObj.body === 'string' ? bodyObj.body : '',
        head,
        base,
      });
      if (created === 'badref') {
        sendError(ctx, 422, 'Validation failed: head or base ref does not exist');
        return;
      }
      if (created === 'duplicate') {
        sendError(ctx, 422, 'Validation failed: a pull request already exists for this head and base');
        return;
      }
      sendJson(ctx, 201, pullJson(repo, created));
      return;
    }
    if (method === 'GET') {
      const stateParam = url.searchParams.get('state') ?? 'open';
      let list = [...repo.items.values()].filter(
        (item): item is PullRec => item.kind === 'pull',
      );
      if (stateParam === 'open') list = list.filter((pull) => pull.state === 'open');
      else if (stateParam === 'closed') list = list.filter((pull) => pull.state === 'closed');
      list.sort((a, b) => a.num - b.num);
      const { slice } = pageSlice(list, url);
      sendJson(ctx, 200, slice.map((pull) => pullJson(repo, pull)));
      return;
    }
    sendError(ctx, 404, 'Not Found');
    return;
  }

  const num = Number(seg[0]);
  const item = Number.isInteger(num) ? repo.items.get(num) : undefined;
  const pull = item && item.kind === 'pull' ? item : undefined;
  if (!pull) {
    sendError(ctx, 404, 'Not Found');
    return;
  }

  if (seg.length === 1 && method === 'GET') {
    sendJson(ctx, 200, pullJson(repo, pull));
    return;
  }

  if (seg.length === 2 && seg[1] === 'files' && method === 'GET') {
    const files = pullFiles(repo, pull).map((file) => ({
      sha: '',
      filename: file.filename,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      changes: file.changes,
    }));
    const { slice } = pageSlice(files, url);
    sendJson(ctx, 200, slice);
    return;
  }

  if (seg.length === 2 && seg[1] === 'merge' && method === 'PUT') {
    const result = mergePullRequest(repo, pull);
    if (result === 'gone') {
      sendError(ctx, 405, 'Pull request has already been merged or closed');
      return;
    }
    if (result === 'conflict') {
      sendError(ctx, 405, 'Pull request is not mergeable: merge conflict');
      return;
    }
    sendJson(ctx, 200, { sha: result.sha, merged: true, message: 'Pull Request successfully merged' });
    return;
  }

  if (seg.length === 1 && method === 'PATCH') {
    if (bodyObj.state === 'closed' || bodyObj.state === 'open') pull.state = bodyObj.state;
    if (typeof bodyObj.title === 'string') pull.title = bodyObj.title;
    if (typeof bodyObj.body === 'string') pull.body = bodyObj.body;
    pull.ver += 1;
    touch(repo);
    sendJson(ctx, 200, pullJson(repo, pull));
    return;
  }

  sendError(ctx, 404, 'Not Found');
}

// ---------------------------------------------------------------------------
// Git smart HTTP
// ---------------------------------------------------------------------------

const UPLOAD_CAPS_V0 = 'side-band-64k thin-pack ofs-delta shallow agent=forge/1.0';
const RECEIVE_CAPS_V0 = 'report-status side-band-64k delete-refs ofs-delta agent=forge/1.0';

function sortedRefs(repo: RepoRec): [string, string][] {
  return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

function v0Advertisement(repo: RepoRec, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const cached = repo.advCache;
  if (cached && cached.ver === repo.ver) {
    return service === 'git-upload-pack' ? cached.up : cached.recv;
  }
  const build = (forService: 'git-upload-pack' | 'git-receive-pack', caps: string): Buffer => {
    const parts: Buffer[] = [pktLine(`# service=${forService}\n`), PKT_FLUSH];
    const headRef = branchRef(repo.defBranch);
    const headTip = repo.refs.get(headRef);
    const fullCaps = forService === 'git-upload-pack' ? `${caps} symref=HEAD:${headRef}` : caps;
    const lines: string[] = [];
    if (headTip) lines.push(`${headTip} HEAD`);
    for (const [ref, oid] of sortedRefs(repo)) {
      lines.push(`${oid} ${ref}`);
      const peeled = peelTag(repo, oid);
      if (peeled) lines.push(`${peeled} ${ref}^{}`);
    }
    if (lines.length === 0) {
      parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${fullCaps}`));
    } else {
      lines.forEach((line, index) => {
        parts.push(index === 0 ? pktLine(`${line}\0${fullCaps}`) : pktLine(`${line}\n`));
      });
    }
    parts.push(PKT_FLUSH);
    return Buffer.concat(parts);
  };
  const up = build('git-upload-pack', UPLOAD_CAPS_V0);
  const recv = build('git-receive-pack', RECEIVE_CAPS_V0);
  repo.advCache = { ver: repo.ver, up, recv };
  return service === 'git-upload-pack' ? up : recv;
}

function v2Advertisement(): Buffer {
  return Buffer.concat([
    pktLine('version 2\n'),
    pktLine('agent=forge/1.0\n'),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow filter\n'),
    pktLine('object-format=sha1\n'),
    PKT_FLUSH,
  ]);
}

function sendGitBuffer(ctx: Ctx, body: Buffer, contentType: string): void {
  ctx.res.writeHead(200, {
    'content-type': contentType,
    'content-length': String(body.length),
    'cache-control': 'no-cache, max-age=0, must-revalidate',
    expires: 'Fri, 01 Jan 1980 00:00:00 GMT',
    pragma: 'no-cache',
    'x-github-request-id': `req-${(requestSeq += 1)}`,
  });
  ctx.res.end(body);
}

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

function lsRefsBody(repo: RepoRec, args: LsRefsArgs): Buffer {
  const cacheKey = `${args.peel}|${args.symrefs}|${args.unborn}|${args.prefixes.join(',')}`;
  const cached = repo.lsrefsCache.get(cacheKey);
  if (cached) return cached;
  const matches = (name: string): boolean =>
    args.prefixes.length === 0 || args.prefixes.some((prefix) => name.startsWith(prefix));
  const parts: Buffer[] = [];
  const headRef = branchRef(repo.defBranch);
  const headTip = repo.refs.get(headRef);
  if (matches('HEAD')) {
    if (headTip) {
      const extra = args.symrefs ? ` symref-target:${headRef}` : '';
      parts.push(pktLine(`${headTip} HEAD${extra}\n`));
    } else if (args.unborn) {
      const extra = args.symrefs ? ` symref-target:${headRef}` : '';
      parts.push(pktLine(`unborn HEAD${extra}\n`));
    } else {
      const extra = args.symrefs ? ` symref-target:${headRef}` : '';
      parts.push(pktLine(`${ZERO_OID} HEAD${extra}\n`));
    }
  }
  for (const [ref, oid] of sortedRefs(repo)) {
    if (!matches(ref)) continue;
    let line = `${oid} ${ref}`;
    if (args.peel) {
      const peeled = peelTag(repo, oid);
      if (peeled) line += ` peeled:${peeled}`;
    }
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(PKT_FLUSH);
  const body = Buffer.concat(parts);
  repo.lsrefsCache.set(cacheKey, body);
  return body;
}

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  done: boolean;
  version2: boolean;
}

function commonHave(repo: RepoRec, haves: string[]): string | null {
  for (const have of haves) {
    if (repo.objects.has(have)) return have;
  }
  return null;
}

function fetchResponseBody(repo: RepoRec, request: FetchRequest): Buffer {
  const cacheKey = [
    request.version2 ? 'v2' : 'v0',
    [...request.wants].sort().join(','),
    [...request.haves].sort().join(','),
    [...request.shallow].sort().join(','),
    request.depth === null ? '-' : String(request.depth),
    repo.ver,
  ].join('|');
  const cached = repo.fetchCache.get(cacheKey);
  if (cached) return cached;
  const plan = planFetch(repo, request.wants, request.haves, request.shallow, request.depth);
  const body = request.version2 ? v2FetchBody(repo, request, plan) : v0FetchBody(repo, request, plan);
  repo.fetchCache.set(cacheKey, body);
  return body;
}

function v2FetchBody(repo: RepoRec, request: FetchRequest, plan: FetchPlan): Buffer {
  const parts: Buffer[] = [];
  const have = commonHave(repo, request.haves);
  parts.push(pktLine('acknowledgments\n'));
  if (plan.empty) {
    if (have) parts.push(pktLine(`ACK ${have}\n`));
    parts.push(pktLine('ready\n'));
    parts.push(PKT_DELIM);
    parts.push(PKT_FLUSH);
    return Buffer.concat(parts);
  }
  parts.push(pktLine(have ? `ACK ${have}\n` : 'NAK\n'));
  parts.push(PKT_DELIM);
  if (request.depth !== null || request.shallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(PKT_DELIM);
  }
  parts.push(pktLine('packfile\n'));
  parts.push(sidebandPackets(buildPack(repo, plan.oids)));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function v0FetchBody(repo: RepoRec, request: FetchRequest, plan: FetchPlan): Buffer {
  const parts: Buffer[] = [];
  if (request.depth !== null || request.shallow.length > 0) {
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  }
  parts.push(pktLine('NAK\n'));
  if (!plan.empty) parts.push(sidebandPackets(buildPack(repo, plan.oids)));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function parseFetchLines(lines: string[], version2: boolean): FetchRequest {
  const request: FetchRequest = { wants: [], haves: [], shallow: [], depth: null, done: false, version2 };
  for (const rawLine of lines) {
    const line = rawLine.replace(/\n$/, '');
    if (line.startsWith('want ')) request.wants.push(line.slice(5).split(' ')[0] as string);
    else if (line.startsWith('have ')) request.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) request.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) request.depth = Number(line.slice(7).trim());
    else if (line === 'done') request.done = true;
  }
  return request;
}

function handleUploadPackPost(ctx: Ctx, repo: RepoRec): void {
  const body = ctx.body ?? Buffer.alloc(0);
  let parsed: { packets: PktPacket[]; next: number };
  try {
    parsed = parsePkts(body, 0);
  } catch {
    ctx.res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
    ctx.res.end('bad pkt-line stream');
    return;
  }
  const lines: string[] = [];
  for (const packet of parsed.packets) {
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8'));
  }
  const first = (lines[0] ?? '').replace(/\n$/, '');
  if (first === 'command=ls-refs') {
    const args: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
    for (const rawLine of lines.slice(1)) {
      const line = rawLine.replace(/\n$/, '');
      if (line === 'peel') args.peel = true;
      else if (line === 'symrefs') args.symrefs = true;
      else if (line === 'unborn') args.unborn = true;
      else if (line.startsWith('ref-prefix ')) args.prefixes.push(line.slice('ref-prefix '.length));
    }
    sendGitBuffer(ctx, lsRefsBody(repo, args), 'application/x-git-upload-pack-result');
    return;
  }
  if (first === 'command=fetch') {
    const request = parseFetchLines(lines.slice(1), true);
    sendGitBuffer(ctx, fetchResponseBody(repo, request), 'application/x-git-upload-pack-result');
    return;
  }
  // Protocol v0: want lines first, then a second section of haves.
  const request = parseFetchLines(lines, false);
  sendGitBuffer(ctx, fetchResponseBody(repo, request), 'application/x-git-upload-pack-result');
}

function handleReceivePackPost(ctx: Ctx, repo: RepoRec): void {
  const body = ctx.body ?? Buffer.alloc(0);
  let parsed: { packets: PktPacket[]; next: number };
  try {
    parsed = parsePkts(body, 0);
  } catch {
    ctx.res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
    ctx.res.end('bad pkt-line stream');
    return;
  }
  interface Command {
    oldOid: string;
    newOid: string;
    ref: string;
  }
  const commands: Command[] = [];
  let capabilities = '';
  for (const packet of parsed.packets) {
    if (packet.kind !== 'data') continue;
    let line = packet.payload.toString('utf8');
    const nul = line.indexOf('\0');
    if (nul >= 0) {
      capabilities = line.slice(nul + 1).replace(/\n$/, '');
      line = line.slice(0, nul);
    }
    line = line.replace(/\n$/, '');
    const parts = line.split(' ');
    if (parts.length === 3 && /^[0-9a-f]{40}$/.test(parts[0] as string) && /^[0-9a-f]{40}$/.test(parts[1] as string)) {
      commands.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts[2] as string });
    }
  }
  const packBytes = body.subarray(parsed.next);
  let unpackOk = true;
  if (packBytes.length > 0) {
    try {
      ingestPack(repo, Buffer.from(packBytes));
    } catch {
      unpackOk = false;
    }
  }
  const wantsReport = capabilities.split(' ').includes('report-status');
  const wantsSideband = capabilities.split(' ').includes('side-band-64k');
  const results: { ref: string; ok: boolean; reason: string }[] = [];
  // One synchronous step: validate and apply every ref update together.
  for (const command of commands) {
    const current = repo.refs.get(command.ref) ?? ZERO_OID;
    if (command.newOid === ZERO_OID) {
      // Delete. Deleting a ref that does not exist is reported as done.
      repo.refs.delete(command.ref);
      results.push({ ref: command.ref, ok: true, reason: '' });
      continue;
    }
    if (!repo.objects.has(command.newOid)) {
      results.push({ ref: command.ref, ok: false, reason: 'missing object' });
      continue;
    }
    if (current !== ZERO_OID && current !== command.oldOid && command.oldOid !== ZERO_OID) {
      results.push({ ref: command.ref, ok: false, reason: 'stale ref value' });
      continue;
    }
    if (current === ZERO_OID) {
      repo.refs.set(command.ref, command.newOid);
      results.push({ ref: command.ref, ok: true, reason: '' });
      continue;
    }
    if (current === command.newOid) {
      results.push({ ref: command.ref, ok: true, reason: '' });
      continue;
    }
    const newCommit = peelToCommit(repo, command.newOid);
    const oldCommit = peelToCommit(repo, current);
    if (newCommit && oldCommit && isAncestor(repo, oldCommit, newCommit)) {
      repo.refs.set(command.ref, command.newOid);
      results.push({ ref: command.ref, ok: true, reason: '' });
    } else if (!newCommit || !oldCommit) {
      // A move between objects that do not peel to commits (a retargeted
      // lightweight tag) cannot be ancestry-checked; accept it.
      repo.refs.set(command.ref, command.newOid);
      results.push({ ref: command.ref, ok: true, reason: '' });
    } else {
      results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
    }
  }
  if (results.some((result) => result.ok)) touch(repo);
  if (!wantsReport) {
    ctx.res.writeHead(200, { 'content-type': 'application/x-git-receive-pack-result', 'content-length': '0' });
    ctx.res.end();
    return;
  }
  const reportParts: Buffer[] = [pktLine(unpackOk ? 'unpack ok\n' : 'unpack index-pack failed\n')];
  for (const result of results) {
    reportParts.push(pktLine(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`));
  }
  reportParts.push(PKT_FLUSH);
  const report = Buffer.concat(reportParts);
  if (wantsSideband) {
    const chunks: Buffer[] = [];
    const MAX_DATA = 65515;
    for (let offset = 0; offset < report.length; offset += MAX_DATA) {
      const slice = report.subarray(offset, Math.min(report.length, offset + MAX_DATA));
      chunks.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
    }
    chunks.push(PKT_FLUSH);
    sendGitBuffer(ctx, Buffer.concat(chunks), 'application/x-git-receive-pack-result');
    return;
  }
  sendGitBuffer(ctx, report, 'application/x-git-receive-pack-result');
}

function handleGit(ctx: Ctx, owner: string, repoName: string, tail: string): void {
  const method = ctx.req.method ?? 'GET';
  const repo = findRepo(owner, repoName);
  if (tail === 'info/refs' && method === 'GET') {
    if (!repo) {
      sendError(ctx, 404, 'Not Found');
      return;
    }
    const service = ctx.url.searchParams.get('service');
    if (service === 'git-upload-pack') {
      const protocol = ctx.req.headers['git-protocol'];
      if (typeof protocol === 'string' && protocol.includes('version=2')) {
        sendGitBuffer(ctx, v2Advertisement(), 'application/x-git-upload-pack-advertisement');
        return;
      }
      sendGitBuffer(ctx, v0Advertisement(repo, 'git-upload-pack'), 'application/x-git-upload-pack-advertisement');
      return;
    }
    if (service === 'git-receive-pack') {
      sendGitBuffer(ctx, v0Advertisement(repo, 'git-receive-pack'), 'application/x-git-receive-pack-advertisement');
      return;
    }
    sendError(ctx, 400, 'Unknown service');
    return;
  }
  if (!repo) {
    sendError(ctx, 404, 'Not Found');
    return;
  }
  if (tail === 'git-upload-pack' && method === 'POST') {
    handleUploadPackPost(ctx, repo);
    return;
  }
  if (tail === 'git-receive-pack' && method === 'POST') {
    handleReceivePackPost(ctx, repo);
    return;
  }
  sendError(ctx, 404, 'Not Found');
}

// ---------------------------------------------------------------------------
// GraphQL: a small parser and executor for the documents the clients send
// ---------------------------------------------------------------------------

type GqlValue =
  | string
  | number
  | boolean
  | null
  | GqlValue[]
  | { [key: string]: GqlValue }
  | { $var: string }
  | { $enum: string };

interface GqlField {
  alias: string | null;
  name: string;
  args: Record<string, GqlValue>;
  selections: GqlSelection[];
}

type GqlSelection =
  | { kind: 'field'; field: GqlField }
  | { kind: 'spread'; name: string }
  | { kind: 'inline'; typeName: string | null; selections: GqlSelection[] };

interface GqlOperation {
  opType: 'query' | 'mutation';
  name: string | null;
  selections: GqlSelection[];
}

interface GqlDocument {
  operations: GqlOperation[];
  fragments: Map<string, { typeName: string; selections: GqlSelection[] }>;
}

function gqlTokenize(input: string): (string | number)[] {
  const tokens: (string | number)[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '﻿') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (input.startsWith('...', i)) {
      tokens.push('...');
      i += 3;
      continue;
    }
    if ('!$():=@[]{}|&'.includes(ch)) {
      tokens.push(ch);
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (input.startsWith('"""', i)) {
        const end = input.indexOf('"""', i + 3);
        tokens.push(`"${input.slice(i + 3, end === -1 ? input.length : end)}"`);
        i = end === -1 ? input.length : end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\' && j + 1 < input.length) {
          const esc = input[j + 1] as string;
          if (esc === 'u') {
            out += String.fromCharCode(parseInt(input.slice(j + 2, j + 6), 16));
            j += 6;
          } else {
            out += { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '/': '/', '\\': '\\', '"': '"' }[esc] ?? esc;
            j += 2;
          }
        } else {
          out += input[j];
          j += 1;
        }
      }
      tokens.push(`"${out}"`);
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < input.length && /[0-9.]/.test(input[j] as string)) j += 1;
      tokens.push(Number(input.slice(i, j)));
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (j < input.length && /[_0-9A-Za-z]/.test(input[j] as string)) j += 1;
      tokens.push(input.slice(i, j));
      i = j;
      continue;
    }
    i += 1;
  }
  return tokens;
}

class GqlParser {
  private tokens: (string | number)[];
  private pos: number;
  constructor(input: string) {
    this.tokens = gqlTokenize(input);
    this.pos = 0;
  }
  peek(): string | number | undefined {
    return this.tokens[this.pos];
  }
  next(): string | number | undefined {
    const token = this.tokens[this.pos];
    this.pos += 1;
    return token;
  }
  expect(token: string): void {
    const got = this.next();
    if (got !== token) throw new Error(`expected ${token}, got ${String(got)}`);
  }
  parseDocument(): GqlDocument {
    const operations: GqlOperation[] = [];
    const fragments = new Map<string, { typeName: string; selections: GqlSelection[] }>();
    while (this.pos < this.tokens.length) {
      const token = this.peek();
      if (token === '{') {
        operations.push({ opType: 'query', name: null, selections: this.parseSelectionSet() });
      } else if (token === 'query' || token === 'mutation' || token === 'subscription') {
        this.next();
        const opType = token === 'mutation' ? 'mutation' : 'query';
        let name: string | null = null;
        if (typeof this.peek() === 'string' && this.peek() !== '(' && this.peek() !== '{') {
          name = String(this.next());
        }
        if (this.peek() === '(') this.skipBalanced();
        this.skipDirectives();
        operations.push({ opType, name, selections: this.parseSelectionSet() });
      } else if (token === 'fragment') {
        this.next();
        const fragName = String(this.next());
        this.expect('on');
        const typeName = String(this.next());
        this.skipDirectives();
        fragments.set(fragName, { typeName, selections: this.parseSelectionSet() });
      } else {
        this.next();
      }
    }
    return { operations, fragments };
  }
  skipBalanced(): void {
    let depth = 0;
    for (;;) {
      const token = this.next();
      if (token === undefined) return;
      if (token === '(' || token === '[' || token === '{') depth += 1;
      if (token === ')' || token === ']' || token === '}') {
        depth -= 1;
        if (depth === 0) return;
      }
    }
  }
  skipDirectives(): void {
    while (this.peek() === '@') {
      this.next();
      this.next();
      if (this.peek() === '(') this.skipBalanced();
    }
  }
  parseSelectionSet(): GqlSelection[] {
    this.expect('{');
    const selections: GqlSelection[] = [];
    while (this.peek() !== '}' && this.peek() !== undefined) {
      selections.push(this.parseSelection());
    }
    this.expect('}');
    return selections;
  }
  parseSelection(): GqlSelection {
    if (this.peek() === '...') {
      this.next();
      if (this.peek() === 'on') {
        this.next();
        const typeName = String(this.next());
        this.skipDirectives();
        return { kind: 'inline', typeName, selections: this.parseSelectionSet() };
      }
      const name = String(this.next());
      this.skipDirectives();
      return { kind: 'spread', name };
    }
    let name = String(this.next());
    let alias: string | null = null;
    if (this.peek() === ':') {
      this.next();
      alias = name;
      name = String(this.next());
    }
    const args: Record<string, GqlValue> = {};
    if (this.peek() === '(') {
      this.next();
      while (this.peek() !== ')') {
        const argName = String(this.next());
        this.expect(':');
        args[argName] = this.parseValue();
      }
      this.expect(')');
    }
    this.skipDirectives();
    let selections: GqlSelection[] = [];
    if (this.peek() === '{') selections = this.parseSelectionSet();
    return { kind: 'field', field: { alias, name, args, selections } };
  }
  parseValue(): GqlValue {
    const token = this.next();
    if (token === '$') {
      return { $var: String(this.next()) };
    }
    if (typeof token === 'number') return token;
    if (typeof token === 'string' && token.startsWith('"')) return token.slice(1, -1);
    if (token === '[') {
      const list: GqlValue[] = [];
      while (this.peek() !== ']') list.push(this.parseValue());
      this.expect(']');
      return list;
    }
    if (token === '{') {
      const obj: Record<string, GqlValue> = {};
      while (this.peek() !== '}') {
        const key = String(this.next());
        this.expect(':');
        obj[key] = this.parseValue();
      }
      this.expect('}');
      return obj;
    }
    if (token === 'true') return true;
    if (token === 'false') return false;
    if (token === 'null') return null;
    return { $enum: String(token) };
  }
}

function resolveValue(value: GqlValue, variables: Record<string, unknown>): unknown {
  if (value !== null && typeof value === 'object') {
    if ('$var' in value) return variables[(value as { $var: string }).$var];
    if ('$enum' in value) return (value as { $enum: string }).$enum;
    if (Array.isArray(value)) return value.map((entry) => resolveValue(entry, variables));
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) out[key] = resolveValue(entry, variables);
    return out;
  }
  return value;
}

// Global (Relay) ids: base64 of "<Type>:<key>", opaque and stable.
function globalId(type: string, key: string): string {
  return Buffer.from(`${type}:${key}`, 'utf8').toString('base64');
}

function parseGlobalId(id: string): { type: string; key: string } | null {
  try {
    const decoded = Buffer.from(id, 'base64').toString('utf8');
    const colon = decoded.indexOf(':');
    if (colon <= 0) return null;
    return { type: decoded.slice(0, colon), key: decoded.slice(colon + 1) };
  } catch {
    return null;
  }
}

type GqlObj = { __type: string; [key: string]: unknown };

function gqlRepo(repo: RepoRec): GqlObj {
  return { __type: 'Repository', repo };
}
function gqlIssue(repo: RepoRec, issue: IssueRec): GqlObj {
  return { __type: 'Issue', repo, issue };
}
function gqlPull(repo: RepoRec, pull: PullRec): GqlObj {
  return { __type: 'PullRequest', repo, pull };
}
function gqlUser(): GqlObj {
  return { __type: 'User' };
}
function gqlRef(repo: RepoRec, name: string): GqlObj {
  return { __type: 'Ref', repo, name };
}
function gqlComment(repo: RepoRec, issue: IssueRec, comment: CommentRec): GqlObj {
  return { __type: 'IssueComment', repo, issue, comment };
}

interface ConnectionItem {
  node: unknown;
  cursor: string;
}

function connection(items: unknown[], args: Record<string, unknown>): GqlObj {
  const first = typeof args.first === 'number' ? Math.max(0, Math.trunc(args.first)) : items.length;
  let start = 0;
  if (typeof args.after === 'string' && args.after !== '') {
    try {
      const decoded = Buffer.from(args.after, 'base64').toString('utf8');
      const match = /^cursor:(\d+)$/.exec(decoded);
      if (match) start = Number(match[1]) + 1;
    } catch {
      start = 0;
    }
  }
  const pageItems = items.slice(start, start + first);
  const edges: ConnectionItem[] = pageItems.map((node, index) => ({
    node,
    cursor: Buffer.from(`cursor:${start + index}`, 'utf8').toString('base64'),
  }));
  return {
    __type: 'Connection',
    nodes: pageItems,
    edges,
    pageInfo: {
      __type: 'PageInfo',
      hasNextPage: start + first < items.length,
      hasPreviousPage: start > 0,
      startCursor: edges.length > 0 ? (edges[0] as ConnectionItem).cursor : null,
      endCursor: edges.length > 0 ? (edges[edges.length - 1] as ConnectionItem).cursor : null,
    },
    totalCount: items.length,
  };
}

const GQL_TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', 'nodes', 'search', 'user', 'organization', 'rateLimit', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment', 'updateIssue', 'createRepository'],
  User: ['id', 'login', 'name', 'email', 'url', 'avatarUrl', 'databaseId', 'repositories', 'issues', 'pullRequests'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'hasPullRequestsEnabled', 'hasWikiEnabled', 'isPrivate', 'isArchived', 'description',
    'url', 'htmlUrl', 'issue', 'issues', 'pullRequest', 'pullRequests', 'labels', 'refs', 'ref', 'object',
    'createdAt', 'updatedAt', 'viewerCanAdminister', 'primaryLanguage', 'stargazerCount', 'forkCount',
  ],
  Issue: [
    'id', 'databaseId', 'number', 'title', 'state', 'body', 'bodyText', 'bodyHTML', 'author', 'editor',
    'labels', 'comments', 'assignees', 'createdAt', 'updatedAt', 'closedAt', 'closed', 'url', 'repository',
    'participants', 'reactions', 'milestone', 'locked', 'viewerCanUpdate',
  ],
  PullRequest: [
    'id', 'databaseId', 'number', 'title', 'body', 'bodyText', 'state', 'merged', 'mergedAt', 'mergeable',
    'headRefName', 'baseRefName', 'headRef', 'baseRef', 'headRepository', 'baseRepository', 'files',
    'commits', 'additions', 'deletions', 'changedFiles', 'author', 'createdAt', 'updatedAt', 'closedAt',
    'closed', 'url', 'repository', 'mergeCommit', 'potentialMergeCommit', 'isDraft', 'labels', 'comments',
    'reviewRequests', 'latestReviews', 'viewerCanUpdate',
  ],
  Ref: ['id', 'name', 'prefix', 'repository', 'target', 'associatedPullRequests'],
  IssueComment: ['id', 'databaseId', 'body', 'bodyText', 'author', 'createdAt', 'updatedAt', 'url', 'issue'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  Connection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  SearchType: [],
};

const GQL_ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
};

function gqlTypeDescription(name: string): Record<string, unknown> | null {
  const fields = GQL_TYPE_FIELDS[name];
  const enumValues = GQL_ENUM_VALUES[name];
  if (fields === undefined && enumValues === undefined) return null;
  return {
    name,
    kind: enumValues !== undefined && (fields === undefined || fields.length === 0) ? 'ENUM' : 'OBJECT',
    description: null,
    fields: fields !== undefined ? fields.map((fieldName) => ({ name: fieldName, description: null, args: [], isDeprecated: false })) : null,
    enumValues: enumValues !== undefined ? enumValues.map((valueName) => ({ name: valueName, description: null, isDeprecated: false })) : null,
    possibleTypes: null,
    inputFields: null,
    interfaces: [],
    specifiedByURL: null,
  };
}

interface GqlExec {
  variables: Record<string, unknown>;
  errors: { message: string }[];
  fragments: Map<string, { typeName: string; selections: GqlSelection[] }>;
}

function argsOf(field: GqlField, exec: GqlExec): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(field.args)) out[key] = resolveValue(value, exec.variables);
  return out;
}

function issueStateGraphql(issue: IssueRec): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullStateGraphql(pull: PullRec): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

function sortIssuesGraphql(list: IssueRec[], args: Record<string, unknown>): IssueRec[] {
  const sorted = [...list];
  sorted.sort((a, b) => a.num - b.num);
  const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
  const states = args.states as string[] | undefined;
  let filtered = sorted;
  if (Array.isArray(states) && states.length > 0) {
    filtered = sorted.filter((issue) => states.includes(issueStateGraphql(issue)));
  }
  if (orderBy && orderBy.direction === 'DESC') filtered.reverse();
  return filtered;
}

function resolveField(obj: GqlObj | null, field: GqlField, exec: GqlExec): unknown {
  const name = field.name;
  if (name === '__typename') return obj ? obj.__type : 'Query';
  const args = argsOf(field, exec);
  const type = obj ? obj.__type : 'Query';

  if (obj === null) {
    // Query / Mutation roots.
    if (name === 'viewer') return gqlUser();
    if (name === 'user') return gqlUser();
    if (name === 'repository') {
      const owner = String(args.owner ?? '');
      const repoName = String(args.name ?? '');
      const repo = findRepo(owner, repoName);
      return repo ? gqlRepo(repo) : null;
    }
    if (name === 'node') {
      const parsed = parseGlobalId(String(args.id ?? ''));
      if (!parsed) return null;
      if (parsed.type === 'Repository') {
        const repo = reposById.get(Number(parsed.key));
        return repo ? gqlRepo(repo) : null;
      }
      if (parsed.type === 'Issue' || parsed.type === 'PullRequest') {
        const [repoIdText, numText] = parsed.key.split(':');
        const repo = reposById.get(Number(repoIdText));
        if (!repo) return null;
        const item = repo.items.get(Number(numText));
        if (!item) return null;
        if (parsed.type === 'Issue' && item.kind === 'issue') return gqlIssue(repo, item);
        if (parsed.type === 'PullRequest' && item.kind === 'pull') return gqlPull(repo, item);
        return null;
      }
      if (parsed.type === 'User') return gqlUser();
      return null;
    }
    if (name === '__type') return gqlTypeDescription(String(args.name ?? ''));
    if (name === '__schema') {
      return {
        __type: 'Schema',
        queryType: { name: 'Query' },
        mutationType: { name: 'Mutation' },
        types: Object.keys(GQL_TYPE_FIELDS).map((typeName) => gqlTypeDescription(typeName)),
      };
    }
    if (name === 'createIssue') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parsed = parseGlobalId(String(input.repositoryId ?? ''));
      const repo = parsed && parsed.type === 'Repository' ? reposById.get(Number(parsed.key)) : undefined;
      if (!repo) throw new Error('repository not found for createIssue');
      const issue = createIssueRecord(repo, {
        title: String(input.title ?? ''),
        body: typeof input.body === 'string' ? input.body : '',
        labels: labelNamesOf(input.labelIds ?? input.labels),
      });
      return { __type: 'CreateIssuePayload', issue: gqlIssue(repo, issue) };
    }
    if (name === 'closeIssue') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parsed = parseGlobalId(String(input.issueId ?? ''));
      if (!parsed || parsed.type !== 'Issue') throw new Error('issue not found for closeIssue');
      const [repoIdText, numText] = parsed.key.split(':');
      const repo = reposById.get(Number(repoIdText));
      const item = repo?.items.get(Number(numText));
      if (!repo || !item || item.kind !== 'issue') throw new Error('issue not found for closeIssue');
      item.state = 'closed';
      item.ver += 1;
      touch(repo);
      return { __type: 'CloseIssuePayload', issue: gqlIssue(repo, item) };
    }
    if (name === 'createPullRequest') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parsed = parseGlobalId(String(input.repositoryId ?? ''));
      const repo = parsed && parsed.type === 'Repository' ? reposById.get(Number(parsed.key)) : undefined;
      if (!repo) throw new Error('repository not found for createPullRequest');
      const created = createPull(repo, {
        title: String(input.title ?? ''),
        body: typeof input.body === 'string' ? input.body : '',
        head: String(input.headRefName ?? ''),
        base: String(input.baseRefName ?? ''),
      });
      if (created === 'badref') throw new Error('head or base ref does not exist');
      if (created === 'duplicate') throw new Error('a pull request already exists for this head and base');
      return { __type: 'CreatePullRequestPayload', pullRequest: gqlPull(repo, created) };
    }
    if (name === 'mergePullRequest') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parsed = parseGlobalId(String(input.pullRequestId ?? ''));
      if (!parsed || parsed.type !== 'PullRequest') throw new Error('pull request not found');
      const [repoIdText, numText] = parsed.key.split(':');
      const repo = reposById.get(Number(repoIdText));
      const item = repo?.items.get(Number(numText));
      if (!repo || !item || item.kind !== 'pull') throw new Error('pull request not found');
      const result = mergePullRequest(repo, item);
      if (result === 'conflict') throw new Error('pull request is not mergeable');
      return { __type: 'MergePullRequestPayload', pullRequest: gqlPull(repo, item) };
    }
    if (name === 'addComment') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parsed = parseGlobalId(String(input.subjectId ?? ''));
      if (!parsed || (parsed.type !== 'Issue' && parsed.type !== 'PullRequest')) throw new Error('subject not found');
      const [repoIdText, numText] = parsed.key.split(':');
      const repo = reposById.get(Number(repoIdText));
      const item = repo?.items.get(Number(numText));
      if (!repo || !item) throw new Error('subject not found');
      const body = String(input.body ?? '');
      if (item.kind === 'issue') {
        const comment: CommentRec = { id: nextCommentId, body, createdSec: nextStamp(repo) };
        nextCommentId += 1;
        item.comments.push(comment);
        item.ver += 1;
        touch(repo);
        const node = gqlComment(repo, item, comment);
        return { __type: 'AddCommentPayload', commentEdge: { __type: 'Edge', node, cursor: '' } };
      }
      throw new Error('comments on pull requests are not supported');
    }
    throw new Error(`unknown root field ${name}`);
  }

  switch (type) {
    case 'User':
      if (name === 'login') return VIEWER.login;
      if (name === 'id') return globalId('User', VIEWER.login);
      if (name === 'name') return VIEWER.name;
      if (name === 'email') return VIEWER.email;
      if (name === 'databaseId') return VIEWER.id;
      if (name === 'url') return `/${VIEWER.login}`;
      if (name === 'avatarUrl') return '';
      break;
    case 'Repository': {
      const repo = obj.repo as RepoRec;
      if (name === 'id') return globalId('Repository', String(repo.id));
      if (name === 'databaseId') return repo.id;
      if (name === 'name') return repo.name;
      if (name === 'nameWithOwner') return `${repo.owner}/${repo.name}`;
      if (name === 'owner') return gqlUser();
      if (name === 'defaultBranchRef') return gqlRef(repo, repo.defBranch);
      if (name === 'viewerPermission') return 'ADMIN';
      if (name === 'hasIssuesEnabled') return true;
      if (name === 'hasPullRequestsEnabled') return true;
      if (name === 'hasWikiEnabled') return false;
      if (name === 'isPrivate') return repo.priv;
      if (name === 'isArchived') return false;
      if (name === 'description') return repo.desc;
      if (name === 'url' || name === 'htmlUrl') return `/${repo.owner}/${repo.name}`;
      if (name === 'createdAt' || name === 'updatedAt') return isoOf(EPOCH + repo.id * 60);
      if (name === 'viewerCanAdminister') return true;
      if (name === 'stargazerCount' || name === 'forkCount') return 0;
      if (name === 'issue') {
        const item = repo.items.get(Number(args.number));
        return item && item.kind === 'issue' ? gqlIssue(repo, item) : null;
      }
      if (name === 'issues') {
        const all = [...repo.items.values()].filter((item): item is IssueRec => item.kind === 'issue');
        const ordered = sortIssuesGraphql(all, args);
        return connection(ordered.map((issue) => gqlIssue(repo, issue)), args);
      }
      if (name === 'pullRequest') {
        const item = repo.items.get(Number(args.number));
        return item && item.kind === 'pull' ? gqlPull(repo, item) : null;
      }
      if (name === 'pullRequests') {
        let all = [...repo.items.values()].filter((item): item is PullRec => item.kind === 'pull');
        const states = args.states as string[] | undefined;
        if (Array.isArray(states) && states.length > 0) {
          all = all.filter((pull) => states.includes(pullStateGraphql(pull)));
        }
        all.sort((a, b) => b.num - a.num);
        const orderBy = args.orderBy as { direction?: string } | undefined;
        if (orderBy && orderBy.direction === 'ASC') all.reverse();
        return connection(all.map((pull) => gqlPull(repo, pull)), args);
      }
      if (name === 'labels') {
        return connection([...repo.labels.keys()].map((labelName) => ({ __type: 'Label', name: labelName, color: repo.labels.get(labelName)?.color ?? 'ededed' })), args);
      }
      break;
    }
    case 'Issue': {
      const repo = obj.repo as RepoRec;
      const issue = obj.issue as IssueRec;
      if (name === 'id') return globalId('Issue', `${repo.id}:${issue.num}`);
      if (name === 'databaseId') return issue.id;
      if (name === 'number') return issue.num;
      if (name === 'title') return issue.title;
      if (name === 'state') return issueStateGraphql(issue);
      if (name === 'body' || name === 'bodyText') return issue.body;
      if (name === 'bodyHTML') return issue.body;
      if (name === 'author' || name === 'editor') return gqlUser();
      if (name === 'closed') return issue.state === 'closed';
      if (name === 'closedAt') return issue.state === 'closed' ? isoOf(issue.createdSec) : null;
      if (name === 'createdAt' || name === 'updatedAt') return isoOf(issue.createdSec);
      if (name === 'url') return `/${repo.owner}/${repo.name}/issues/${issue.num}`;
      if (name === 'repository') return gqlRepo(repo);
      if (name === 'labels') {
        return connection(issue.labels.map((labelName) => ({ __type: 'Label', name: labelName, color: repo.labels.get(labelName)?.color ?? 'ededed' })), args);
      }
      if (name === 'comments') {
        return connection(issue.comments.map((comment) => gqlComment(repo, issue, comment)), args);
      }
      if (name === 'locked') return false;
      if (name === 'viewerCanUpdate') return true;
      break;
    }
    case 'PullRequest': {
      const repo = obj.repo as RepoRec;
      const pull = obj.pull as PullRec;
      if (name === 'id') return globalId('PullRequest', `${repo.id}:${pull.num}`);
      if (name === 'databaseId') return pull.id;
      if (name === 'number') return pull.num;
      if (name === 'title') return pull.title;
      if (name === 'body' || name === 'bodyText') return pull.body;
      if (name === 'state') return pullStateGraphql(pull);
      if (name === 'merged') return pull.merged;
      if (name === 'mergedAt') return pull.mergedSec !== null ? isoOf(pull.mergedSec) : null;
      if (name === 'mergeable') return pull.state === 'open' ? pullMergeable(repo, pull) : 'UNKNOWN';
      if (name === 'headRefName') return pull.headRef;
      if (name === 'baseRefName') return pull.baseRef;
      if (name === 'headRef') return gqlRef(repo, pull.headRef);
      if (name === 'baseRef') return gqlRef(repo, pull.baseRef);
      if (name === 'author') return gqlUser();
      if (name === 'closed') return pull.state === 'closed';
      if (name === 'closedAt') return pull.state === 'closed' ? isoOf(pull.createdSec) : null;
      if (name === 'createdAt' || name === 'updatedAt') return isoOf(pull.createdSec);
      if (name === 'url') return `/${repo.owner}/${repo.name}/pull/${pull.num}`;
      if (name === 'repository') return gqlRepo(repo);
      if (name === 'isDraft') return false;
      if (name === 'mergeCommit') return pull.mergeSha ? { __type: 'Commit', oid: pull.mergeSha } : null;
      if (name === 'additions' || name === 'deletions' || name === 'changedFiles') {
        const files = pullFiles(repo, pull);
        if (name === 'changedFiles') return files.length;
        if (name === 'additions') return files.reduce((sum, file) => sum + file.additions, 0);
        return files.reduce((sum, file) => sum + file.deletions, 0);
      }
      if (name === 'files') {
        const files = pullFiles(repo, pull).map((file) => ({
          __type: 'PullRequestFile',
          path: file.filename,
          additions: file.additions,
          deletions: file.deletions,
          changeType: file.status === 'added' ? 'ADDED' : file.status === 'removed' ? 'DELETED' : 'MODIFIED',
        }));
        return connection(files, args);
      }
      if (name === 'labels') return connection([], args);
      if (name === 'comments') return connection([], args);
      break;
    }
    case 'Ref': {
      if (name === 'name') return obj.name as string;
      if (name === 'prefix') return 'refs/heads/';
      if (name === 'id') return globalId('Ref', `${(obj.repo as RepoRec).id}:${obj.name as string}`);
      if (name === 'repository') return gqlRepo(obj.repo as RepoRec);
      if (name === 'target') {
        const repo = obj.repo as RepoRec;
        const sha = repo.refs.get(branchRef(obj.name as string));
        return sha ? { __type: 'Commit', oid: sha } : null;
      }
      break;
    }
    case 'IssueComment': {
      const comment = obj.comment as CommentRec;
      if (name === 'id') return globalId('IssueComment', String(comment.id));
      if (name === 'databaseId') return comment.id;
      if (name === 'body' || name === 'bodyText') return comment.body;
      if (name === 'author') return gqlUser();
      if (name === 'createdAt' || name === 'updatedAt') return isoOf(comment.createdSec);
      break;
    }
    case 'Connection': {
      if (name === 'nodes') return obj.nodes as unknown;
      if (name === 'edges') return (obj.edges as ConnectionItem[]).map((edge) => ({ __type: 'Edge', node: edge.node, cursor: edge.cursor }));
      if (name === 'pageInfo') return obj.pageInfo as unknown;
      if (name === 'totalCount') return obj.totalCount as unknown;
      break;
    }
    case 'PageInfo': {
      if (name in obj) return obj[name];
      break;
    }
    case 'Edge': {
      if (name === 'node') return obj.node as unknown;
      if (name === 'cursor') return obj.cursor as unknown;
      break;
    }
    case 'Label': {
      if (name === 'name') return obj.name as string;
      if (name === 'color') return obj.color as string;
      if (name === 'id') return globalId('Label', obj.name as string);
      break;
    }
    case 'PullRequestFile': {
      if (name in obj) return obj[name];
      break;
    }
    case 'Commit': {
      if (name === 'oid') return obj.oid as string;
      if (name === 'id') return globalId('Commit', obj.oid as string);
      break;
    }
    default:
      break;
  }
  // Payload objects (createIssue { issue }, ...) resolve their named members.
  if (name in obj) return obj[name];
  const known = GQL_TYPE_FIELDS[type];
  if (known && !known.includes(name)) {
    exec.errors.push({ message: `Field '${name}' doesn't exist on type '${type}'` });
    return null;
  }
  return null;
}

function executeSelections(
  obj: GqlObj | null,
  selections: GqlSelection[],
  exec: GqlExec,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'spread') {
      const fragment = exec.fragments.get(selection.name);
      if (fragment) {
        Object.assign(out, executeSelections(obj, fragment.selections, exec));
      }
      continue;
    }
    if (selection.kind === 'inline') {
      if (selection.typeName === null || obj === null || obj.__type === selection.typeName) {
        Object.assign(out, executeSelections(obj, selection.selections, exec));
      }
      continue;
    }
    const field = selection.field;
    const key = field.alias ?? field.name;
    let value: unknown;
    try {
      value = resolveField(obj, field, exec);
    } catch (err) {
      exec.errors.push({ message: err instanceof Error ? err.message : String(err) });
      value = null;
    }
    if (value !== null && typeof value === 'object' && field.selections.length > 0) {
      if (Array.isArray(value)) {
        value = value.map((entry) =>
          entry !== null && typeof entry === 'object' ? executeSelections(entry as GqlObj, field.selections, exec) : entry,
        );
      } else {
        value = executeSelections(value as GqlObj, field.selections, exec);
      }
    }
    out[key] = value === undefined ? null : value;
  }
  return out;
}

function executeGraphql(body: unknown): unknown {
  const record = (body ?? {}) as Record<string, unknown>;
  const queryText = typeof record.query === 'string' ? record.query : '';
  const variables = (record.variables && typeof record.variables === 'object'
    ? (record.variables as Record<string, unknown>)
    : {}) as Record<string, unknown>;
  const operationName = typeof record.operationName === 'string' ? record.operationName : null;
  let document: GqlDocument;
  try {
    document = new GqlParser(queryText).parseDocument();
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : 'parse error' }] };
  }
  let operation = document.operations[0];
  if (operationName !== null) {
    operation = document.operations.find((candidate) => candidate.name === operationName) ?? operation;
  }
  if (!operation) return { errors: [{ message: 'no operation in document' }] };
  const exec: GqlExec = { variables, errors: [], fragments: document.fragments };
  const data = executeSelections(null, operation.selections, exec);
  const result: Record<string, unknown> = { data };
  if (exec.errors.length > 0) result.errors = exec.errors;
  return result;
}

function handleGraphql(ctx: Ctx): void {
  if (ctx.jsonError || ctx.body === null) {
    sendJson(ctx, 400, { message: 'Malformed JSON in request body' });
    return;
  }
  if (Array.isArray(ctx.json)) {
    const results = (ctx.json as unknown[]).map((entry) => executeGraphql(entry));
    sendJson(ctx, 200, results);
    return;
  }
  sendJson(ctx, 200, executeGraphql(ctx.json));
}

// ---------------------------------------------------------------------------
// MCP: JSON-RPC 2.0 over streamable HTTP, tools over the same store as REST
// ---------------------------------------------------------------------------

const MCP_REVISIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const MCP_SERVER_INFO = { name: 'forge', version: '1.0.0' };

interface McpTool {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

function stringProp(description: string): { type: string; description: string } {
  return { type: 'string', description };
}

const MCP_TOOLS: McpTool[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: stringProp('The repository name'),
        description: stringProp('A short description of the repository'),
        private: { type: 'boolean', description: 'Whether the repository is private' },
        owner: stringProp('The repository owner login'),
        full_name: stringProp('The full name, owner/repo'),
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: stringProp('The repository owner login'),
        repo: stringProp('The repository name'),
        full_name: stringProp('The full name, owner/repo'),
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Open a new issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: stringProp('The repository owner login'),
        repo: stringProp('The repository name'),
        title: stringProp('The issue title'),
        body: stringProp('The issue body'),
        full_name: stringProp('The full name, owner/repo'),
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: stringProp('The repository owner login'),
        repo: stringProp('The repository name'),
        state: stringProp('Filter by state: open, closed or all'),
        full_name: stringProp('The full name, owner/repo'),
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: stringProp('The repository owner login'),
        repo: stringProp('The repository name'),
        title: stringProp('The pull request title'),
        body: stringProp('The pull request body'),
        head: stringProp('The head branch name'),
        base: stringProp('The base branch name'),
        full_name: stringProp('The full name, owner/repo'),
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request by number (squash).',
    inputSchema: {
      type: 'object',
      properties: {
        owner: stringProp('The repository owner login'),
        repo: stringProp('The repository name'),
        pull_number: { type: 'number', description: 'The pull request number' },
        full_name: stringProp('The full name, owner/repo'),
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

const MCP_TOOLS_JSON = JSON.stringify({ tools: MCP_TOOLS });

function mcpResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id === undefined ? null : id, result };
}

function mcpError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id === undefined ? null : id, error: { code, message } };
}

function mcpToolPayload(payload: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload as Record<string, unknown>,
    isError: false,
  };
}

function mcpToolFailure(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function mcpArgsWithFullName(args: Record<string, unknown>): Record<string, unknown> {
  const out = { ...args };
  if (typeof out.full_name === 'string' && out.full_name.includes('/')) {
    const [ownerPart, repoPart] = (out.full_name as string).split('/', 2);
    if (out.owner === undefined && ownerPart) out.owner = ownerPart;
    if (out.repo === undefined && repoPart) out.repo = repoPart;
  }
  return out;
}

function runMcpTool(name: string, rawArgs: Record<string, unknown>): Record<string, unknown> {
  const tool = MCP_TOOLS.find((candidate) => candidate.name === name);
  if (!tool) throw { rpcCode: -32601, message: `unknown tool ${name}` };
  const args = mcpArgsWithFullName(rawArgs);
  for (const required of tool.inputSchema.required) {
    if (args[required] === undefined || args[required] === null || args[required] === '') {
      throw { rpcCode: -32602, message: `missing required argument ${required}` };
    }
  }
  const owner = typeof args.owner === 'string' ? args.owner : VIEWER.login;
  const repoName = typeof args.repo === 'string' ? args.repo : '';
  switch (name) {
    case 'create_repo': {
      const repoLabel = String(args.name);
      const existing = findRepo(VIEWER.login, repoLabel);
      if (existing) return mcpToolPayload(repoJson(existing));
      const repo = createRepoRec(
        VIEWER.login,
        repoLabel,
        typeof args.description === 'string' ? args.description : '',
        typeof args.private === 'boolean' ? args.private : false,
      );
      return mcpToolPayload(repoJson(repo));
    }
    case 'get_repo': {
      const repo = findRepo(owner, repoName);
      if (!repo) return mcpToolFailure(`repository ${owner}/${repoName} not found`);
      return mcpToolPayload(repoJson(repo));
    }
    case 'create_issue': {
      const repo = findRepo(owner, repoName);
      if (!repo) return mcpToolFailure(`repository ${owner}/${repoName} not found`);
      const labels = labelNamesOf(args.labels);
      for (const label of labels) {
        if (!repo.labels.has(label)) return mcpToolFailure(`label ${label} does not exist`);
      }
      const issue = createIssueRecord(repo, {
        title: String(args.title),
        body: typeof args.body === 'string' ? args.body : '',
        labels,
      });
      return mcpToolPayload(issueJson(repo, issue));
    }
    case 'list_issues': {
      const repo = findRepo(owner, repoName);
      if (!repo) return mcpToolFailure(`repository ${owner}/${repoName} not found`);
      const state = typeof args.state === 'string' ? args.state : 'open';
      let list = [...repo.items.values()].filter((item): item is IssueRec => item.kind === 'issue');
      if (state === 'open') list = list.filter((issue) => issue.state === 'open');
      else if (state === 'closed') list = list.filter((issue) => issue.state === 'closed');
      list.sort((a, b) => a.num - b.num);
      return mcpToolPayload(list.map((issue) => issueJson(repo, issue)));
    }
    case 'create_pull_request': {
      const repo = findRepo(owner, repoName);
      if (!repo) return mcpToolFailure(`repository ${owner}/${repoName} not found`);
      const created = createPull(repo, {
        title: String(args.title),
        body: typeof args.body === 'string' ? args.body : '',
        head: String(args.head),
        base: String(args.base),
      });
      if (created === 'badref') return mcpToolFailure('head or base ref does not exist');
      if (created === 'duplicate') return mcpToolFailure('a pull request already exists for this head and base');
      return mcpToolPayload(pullJson(repo, created));
    }
    case 'merge_pull_request': {
      const repo = findRepo(owner, repoName);
      if (!repo) return mcpToolFailure(`repository ${owner}/${repoName} not found`);
      const num = Number(args.pull_number);
      const item = Number.isInteger(num) ? repo.items.get(num) : undefined;
      if (!item || item.kind !== 'pull') return mcpToolFailure(`pull request ${String(args.pull_number)} not found`);
      const result = mergePullRequest(repo, item);
      if (result === 'conflict') return mcpToolFailure('pull request is not mergeable: merge conflict');
      if (result === 'gone') return mcpToolFailure('pull request has already been merged or closed');
      return mcpToolPayload(pullJson(repo, item));
    }
    default:
      throw { rpcCode: -32601, message: `unknown tool ${name}` };
  }
}

function handleMcpCall(request: Record<string, unknown>): Record<string, unknown> | null {
  const id = request.id;
  const method = typeof request.method === 'string' ? request.method : '';
  const params = (request.params && typeof request.params === 'object'
    ? (request.params as Record<string, unknown>)
    : {}) as Record<string, unknown>;
  if (id === undefined && method.startsWith('notifications/')) return null; // a notification: no reply
  switch (method) {
    case 'server/discover':
      return mcpResult(id, {
        serverInfo: MCP_SERVER_INFO,
        capabilities: { tools: {} },
        supportedVersions: MCP_REVISIONS,
        protocolVersion: MCP_REVISIONS[0],
        _meta: { 'io.modelcontextprotocol/serverInfo': MCP_SERVER_INFO },
      });
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const chosen = MCP_REVISIONS.includes(requested) ? requested : '2025-11-25';
      return mcpResult(id, {
        protocolVersion: chosen,
        capabilities: { tools: {} },
        serverInfo: MCP_SERVER_INFO,
      });
    }
    case 'ping':
      return mcpResult(id, {});
    case 'tools/list':
      return mcpResult(id, JSON.parse(MCP_TOOLS_JSON) as unknown);
    case 'tools/call': {
      const toolName = typeof params.name === 'string' ? params.name : '';
      const toolArgs = (params.arguments && typeof params.arguments === 'object'
        ? (params.arguments as Record<string, unknown>)
        : {}) as Record<string, unknown>;
      try {
        return mcpResult(id, runMcpTool(toolName, toolArgs));
      } catch (err) {
        const failure = err as { rpcCode?: number; message?: string };
        if (typeof failure.rpcCode === 'number') return mcpError(id, failure.rpcCode, failure.message ?? 'tool error');
        throw err;
      }
    }
    default:
      return mcpError(id, -32601, `method not found: ${method}`);
  }
}

async function handleMcp(ctx: Ctx): Promise<void> {
  const method = ctx.req.method ?? 'POST';
  if (method === 'GET' || method === 'DELETE') {
    ctx.res.writeHead(405, { 'content-type': 'application/json', 'x-github-request-id': `req-${(requestSeq += 1)}` });
    ctx.res.end(JSON.stringify({ message: 'Method Not Allowed' }));
    return;
  }
  const raw = (ctx.body ?? Buffer.alloc(0)).toString('utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    sendBuffer(ctx, 400, Buffer.from(JSON.stringify(mcpError(null, -32700, 'Parse error')), 'utf8'), 'application/json');
    return;
  }
  if (Array.isArray(parsed)) {
    const results: unknown[] = [];
    for (const entry of parsed) {
      const reply = handleMcpCall((entry ?? {}) as Record<string, unknown>);
      if (reply !== null) results.push(reply);
    }
    sendJson(ctx, 200, results);
    return;
  }
  const reply = handleMcpCall((parsed ?? {}) as Record<string, unknown>);
  if (reply === null) {
    ctx.res.writeHead(202, { 'x-github-request-id': `req-${(requestSeq += 1)}` });
    ctx.res.end();
    return;
  }
  sendJson(ctx, 200, reply);
}

// ---------------------------------------------------------------------------
// The server
// ---------------------------------------------------------------------------

async function dispatch(ctx: Ctx): Promise<void> {
  const { pathname } = ctx.url;
  const method = ctx.req.method ?? 'GET';

  if (pathname === '/healthz') {
    if (method === 'GET') sendJson(ctx, 200, { ok: true });
    else sendError(ctx, 404, 'Not Found');
    return;
  }

  if (pathname === '/api/v3' || pathname.startsWith('/api/v3/')) {
    if (!authed(ctx)) {
      sendError(ctx, 401, 'Requires authentication');
      return;
    }
    const segments = pathname
      .slice('/api/v3'.length)
      .split('/')
      .filter((segment) => segment !== '')
      .map((segment) => decodeURIComponent(segment));
    await handleRest(ctx, segments);
    return;
  }

  if (pathname === '/api/graphql') {
    if (!authed(ctx)) {
      ctx.res.writeHead(401, { 'content-type': 'application/json', 'x-github-request-id': `req-${(requestSeq += 1)}` });
      ctx.res.end(JSON.stringify({ message: 'Requires authentication' }));
      return;
    }
    if (method !== 'POST') {
      sendError(ctx, 404, 'Not Found');
      return;
    }
    handleGraphql(ctx);
    return;
  }

  if (pathname === '/mcp') {
    if (!authed(ctx)) {
      sendBuffer(ctx, 401, Buffer.from(JSON.stringify(mcpError(null, -32001, 'Unauthorized')), 'utf8'), 'application/json');
      return;
    }
    await handleMcp(ctx);
    return;
  }

  const gitMatch = /^\/([^/]+)\/(.+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(pathname);
  if (gitMatch) {
    handleGit(ctx, decodeURIComponent(gitMatch[1] as string), decodeURIComponent(gitMatch[2] as string), gitMatch[3] as string);
    return;
  }

  sendError(ctx, 404, 'Not Found');
}

export function createForgeServer(): Server {
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const host = req.headers.host ?? 'localhost';
      const method = req.method ?? 'GET';
      const needsBody = method === 'POST' || method === 'PUT' || method === 'PATCH' ||
        (method === 'DELETE' && Number(req.headers['content-length'] ?? '0') > 0);
      let body: Buffer | null = null;
      let json: unknown = undefined;
      let jsonError = false;
      if (needsBody) {
        try {
          body = await readBody(req);
        } catch {
          body = Buffer.alloc(0);
        }
        // Only the JSON surfaces get a parsed body; git pack traffic is
        // binary and is consumed raw by its own handlers.
        const jsonSurface = url.pathname.startsWith('/api/') || url.pathname === '/mcp';
        if (body.length > 0 && jsonSurface) {
          try {
            json = JSON.parse(body.toString('utf8'));
          } catch {
            jsonError = true;
          }
        } else if (body.length > 0 && url.pathname.startsWith('/api/')) {
          jsonError = true;
        }
      }
      const ctx: Ctx = { req, res, url, host, body, json, jsonError };
      try {
        await dispatch(ctx);
      } catch {
        if (!res.headersSent) {
          try {
            sendError(ctx, 500, 'Internal Server Error');
          } catch {
            // The socket is already gone; nothing more to do.
          }
        }
      }
    })();
  });
  server.sendDate = false;
  server.keepAliveTimeout = 75000;
  server.headersTimeout = 80000;
  server.on('connection', (socket) => {
    socket.setNoDelay(true);
  });
  return server;
}
