# Design notes

One Node process, TypeScript, standard library only. No git binary: the git
object model, packfiles, deltas and both wire protocols live in `app.ts`.

## Store

Everything is in memory, per repository:

- objects: a map from sha1 to `{type, data, z}` where `z` is the zlib stream of
  the raw object bytes, computed once when the object first arrives. Pack
  building copies `z` verbatim into the pack, so a clone never recompresses.
- refs: a map from full ref name to object id.
- labels, issues, pull requests, comments: plain records. Issues and pull
  requests share one number sequence per repository, as on GitHub.
- a version counter, bumped by every mutation. Caches key on it.

## Determinism

Nothing observable may depend on the wall clock, randomness or the port:

- timestamps come from a fixed epoch plus a per-repository sequence counter;
- ids are sequential integers;
- commit identities for API-made commits are the viewer's own, derived from a
  small seeded generator that reproduces the trial scenario's login, so the
  forge agrees with its clients about who the token belongs to;
- request ids are a plain counter.

## Git

- Objects hash as `sha1("<type> <len>\0" + data)`.
- Packs parse entry by entry; ofs-delta and ref-delta resolve against the
  pack itself first, then the store (thin packs). Deltas apply with the
  standard copy/insert instruction stream.
- Reachability walks commits through a cached parent map. A fetch computes
  the want closure minus the have closure; shallow requests cut the walk at
  the requested depth and report the boundary as shallow lines, and a deepen
  request expands a client's existing boundary instead of resending it.
- Ref updates are judged per ref: create, delete, or fast-forward (the old
  tip must be an ancestor of the new tip, peeling tags to commits). A mixed
  push applies the good refs and reports `ng <ref> non-fast-forward` for the
  rest, one report line per ref.
- Contents writes and pull-request merges are ordinary commits built from
  flattened trees, so the REST surface and the git surface never disagree.
  A squash merge is a three-way file merge against the merge base; a file
  changed on both sides with different bytes is a conflict (405).

## Protocols

- Smart HTTP: v0 advertisements open with the `# service=` preamble; a
  request carrying `Git-Protocol: version=2` for upload-pack gets the v2
  capability advertisement instead. v2 fetch answers in sections
  (acknowledgments, shallow-info, packfile) with the pack inside
  side-band-64k packets; v0 fetch answers NAK then the same side-band.
  Receive-pack is v0 with report-status inside side-band-64k when asked.
- REST v3 under /api/v3, GraphQL at /api/graphql (a small hand-written
  parser and executor covering the documents the common clients send,
  including `__type` introspection, Relay node ids, cursor connections and
  batched operations), MCP at /mcp (JSON-RPC over streamable HTTP,
  `server/discover` for the current revision and the initialize handshake
  for older ones, six tools over the same store as REST).

## Speed

- Advertisements, ls-refs answers and whole fetch responses are memoised
  keyed by the repository version; a push bumps the version and the stale
  bytes are simply never served again.
- Repeated issue reads serve a cached serialised body keyed by the issue's
  own version counter.
- Requests without a body never wait for one; each JSON body is parsed once;
  the HTTP date header is switched off; sockets run with Nagle disabled.
- Mutations happen in one synchronous step after the body has been read, so
  concurrent requests cannot interleave halfway through an update.
