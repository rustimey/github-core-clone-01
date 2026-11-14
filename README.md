# Forge

A standalone, GitHub-compatible git forge in a single Node process.
TypeScript, Node standard library only: no dependencies, no install step,
no external service and no git binary — the object model, packfiles,
deltas and wire protocols are implemented in-process.

It serves four surfaces from one store:

- git smart HTTP at `/{owner}/{repo}.git` — clone, fetch and push;
  upload-pack speaks protocol v2 (with a v0 fallback), receive-pack
  speaks v0 with report-status, side-band-64k and delete-refs;
- the REST v3 API under `/api/v3` — repositories, branches, commits,
  contents, labels, issues, comments and pull requests with merges;
- GraphQL v4 at `/api/graphql` — the queries and mutations the common
  clients (`gh`, github-mcp-server) send, with introspection;
- MCP at `/mcp` — JSON-RPC over streamable HTTP with repository, issue
  and pull-request tools acting on the same store as REST.

## Running

`node main.ts` (Node 22). The process binds an ephemeral port, registers
it with the trial environment named by `MAKEFUN_ENV_URL`, serves until
the environment reports done, and exits 0.

## Layout

- `main.ts` — the thin entrypoint: boot, announce, wait, serve.
- `app.ts` — the whole implementation: store, git engine, the four
  protocol surfaces and the HTTP server.
- `SPEC.md` — design notes: determinism, caching and merge rules.
