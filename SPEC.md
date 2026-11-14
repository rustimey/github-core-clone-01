# SPEC — github-core-clone-01: a standalone git forge

Derived from the kit's RULES.txt (authoritative), the practice instances, and
the conformance suite source shipped in the kit (program/env/src). Where this
document and RULES.txt disagree, RULES.txt wins.

## The deliverable

One standalone, single-process git forge in a git repository:

- **main.ts** — the entry <-> env lifecycle from the kit starter, unchanged:
  binds port 0, POSTs `{"port": N}` to `$MAKEFUN_ENV_URL/register`, long-polls
  `GET $MAKEFUN_ENV_URL/done`, exits 0 when `done:true`.
- **app.ts** — the forge itself, exporting `createApp(): http.Server`.
- Runtime: `node /bot/main.ts` (Node 22) in a read-only pod, 2 CPU / 1024 MB /
  900 s wall / 10 s per request, outbound network proxy-only. **Node standard
  library only, no install step, no shelling out to the git binary** — the git
  object model, pack format and smart-HTTP protocol are implemented in-process.
- In-memory store only (nothing persists; every trial starts empty).

## Protocol surface

### Git smart HTTP (`/{owner}/{repo}.git/...` and bare `/{owner}/{repo}/...`)
- `GET info/refs?service=git-upload-pack|git-receive-pack`, protocol **v2**
  (`Git-Protocol: version=2`: ls-refs with symrefs/peel/unborn, fetch with
  shallow/deepen/deepen-since/deepen-not, sideband packfile) and **v0**
  (multi_ack_detailed, no-done, two-phase deepen, shallow sections without
  trailing newlines, `^{}` peeled lines, `# service=` preamble).
- `POST git-upload-pack`, `POST git-receive-pack`: pack v2 parsing with
  OFS/REF deltas, thin-pack fixup against client haves, report-status with
  per-ref ok/ng (stale-info and non-fast-forward rejected per-ref; mixed
  pushes apply the good refs), delete via the zero id, sideband progress in
  chunks that never exceed the 65520-byte pkt-line maximum.
- Object store: sha1 loose-object semantics in memory; commits/trees/blobs/
  annotated tags; deterministic construction (fixed epoch + tick clock) so
  identical request sequences produce byte-identical state and exports.
- Identical fetches are memoized (append-only store + ref fingerprint key):
  a repeated fetch returns byte-identical bytes without recomputation.

### REST v3 (`/api/v3`)
- Every response carries `X-GitHub-Request-Id`; JSON error bodies are
  `{message, errors?, documentation_url}`; the trial Bearer token is required
  on all paths except `/healthz` and `/` (401 "Bad credentials"); malformed
  JSON on writes is 400 "Problems parsing JSON".
- Repos: create (201, default branch `main` with a root commit), get (404 —
  never 403 — for another owner's same-named repo), delete (204), list with
  Link-header pagination, fork, collaborators, languages, tags, branches +
  protection stubs, commits, compare (ahead/behind + merge-base), contents
  (GET/PUT/DELETE with sha enforcement: stale 409, missing-on-update 422),
  trees/blobs/git-refs CRUD.
- Issues: full CRUD; **a label must be created via POST /labels before an
  issue may carry it** (unknown label → 422); labels start EMPTY on a fresh
  repo; list honors `state`, `labels`, `sort` (created/updated/comments) and
  `direction` (default created desc, ties by number); comments CRUD;
  close/reopen via PATCH state.
- Pulls: create (same-repo and same-owner cross-repo heads), get/list,
  merge via PUT /merge with **merge/squash/rebase**; a real three-way merge
  against the merge-base — both-sides-changed paths refuse with **405**;
  `merge_commit_sha` is recorded on the PR; commits/files sub-resources;
  reviews and review comments.
- Users/orgs/search/meta/rate-limit: `/user`, `/users/{login}`,
  `/user/repos`, `/user/installations`, `/orgs/{org}`,
  `/orgs/{org}/installation`, `/search/{repositories,code,issues,users}`,
  `/meta` (installed_version "2026.1.0"), `/rate_limit`.

### GraphQL (`/api/graphql`)
- Queries: `viewer`, `user`, `organization`, `repository` (issues,
  pullRequests, labels, refs, object expressions), `search` (first page
  across all repos), `rateLimit`, `meta`, node/nodes by global id.
- Relay connections with real cursor pagination (after/before/first/last,
  pageInfo), orderBy honored (default CREATED_AT DESC).
- Mutations: createRepository, createIssue, closeIssue, reopenIssue,
  addLabelsToLabelable, createPullRequest, mergePullRequest,
  closePullRequest, reopenPullRequest, createRef, updateRef, deleteRef,
  addComment, updateIssue, createCommitOnBranch (expectedHeadOid enforced).
- Introspection for the types/fields the suite probes; unknown fields on
  known types return partial data + an errors entry naming the field;
  batched (array) request bodies answer arrays in order.

### MCP (`/mcp`)
- JSON-RPC initialize (protocolVersion, capabilities, serverInfo), ping,
  tools/list, tools/call. Unknown tool → JSON-RPC error **-32601**; parse
  errors → HTTP 400 + **-32700**; missing required arguments → isError result.
- Tools: issue_write (create/update/close/reopen), issue_read (get/list),
  repository_read (get/list), pull_request_write (create/merge),
  pull_request_read (get/list), search_code, get_me, create_repo, get_repo,
  create_issue, list_issues, create_pull_request, merge_pull_request.

## Grading (per RULES.txt + suite source)

- **Feature 600** = 600 x (passed / 120) conformance checks across the
  groups: git 30, repos 15, issues 15, pulls 20, graphql 20, mcp 15,
  protocol 5.
- **Agent 200** = the MCP group's 15 checks rescaled to 200.
- **Perf 200** = 4 workloads, each `clamp(25 - 12.5*log2(t / T_ref), 0, 50)`
  on the median of 3 rounds (5 warm-ups, 60 s budget each):
  - push: 200 sequential 1-commit 1 KiB receive-packs (T_ref 1640.82 ms)
  - clone: 50 concurrent depth-1 clones of a 200-commit history (T_ref 266.941 ms)
  - read: 2000 sequential GETs of one issue, keep-alive (T_ref 2759.715 ms)
  - write: 200 sequential POST /issues -> 201 (T_ref 348.965 ms)
- **Prize gate:** the final score must be STRICTLY above the house reference
  forge's score, with the 90% paired t-interval of the per-instance lead
  above 0. A tie does not pay. The reference passes 120/120 and earns ~100
  perf points at its own T_refs, i.e. ~900/1000 — the winning margin must
  come from performance.
- Final staging: qualifying trial on scored instance 1; top 60 (+ ties) run
  all 3 scored instances, each replayed; the replay export must be
  byte-identical to the live export (determinism is mandatory).
- Scored instances derive from drand round 34146612 (emitted
  2026-11-21T06:40Z); entries close 2026-11-21 13:00 WIB; quotas 5
  submissions/day, 10 total.

## Local verification (this entry, practice-shape trials on this VM)

- Suite run standalone (env server.mjs + entry process), repeated runs:
  **120/120 conformance**; consecutive state exports **byte-identical**.
- Perf (local, noisy shared VM): 164–188 points across runs; p50 medians vs
  T_ref — push ~350–450 ms (cap 50), clone ~98–150 ms (35–43),
  read ~750–950 ms (44–48), write ~93–140 ms (42–49). Estimated total
  ≈ **975–990** vs the reference's ≈900. Production-pod numbers will
  differ; the ratio structure (2–7x faster than T_ref on every workload)
  is the margin.
