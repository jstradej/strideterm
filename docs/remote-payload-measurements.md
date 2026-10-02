# Remote payload measurements

The decisions behind the remote (web / phone) state protocol, with the numbers they rest on.
Reproduce the numbers with:

```
npm run measure:remote
```

`scripts/measure-remote-payload.mts` builds a fixed synthetic payload modelled on a heavy real
installation — 59 workspaces with full git snapshots, 26 Azure PRs with review threads and issue
comments, full Docker lists — so the **sizes** are deterministic. CPU and memory numbers are
indicative and vary per machine.

## A slim core, detail on demand

| Stage                                                                 | Size           | Reduction                    |
| --------------------------------------------------------------------- | -------------- | ---------------------------- |
| Full desktop payload before dedup (2.4.10, with the projects aliases) | **2109.3 KiB** | —                            |
| Desktop payload after removing the byte-identical aliases             | **1300.8 KiB** | 38.3%                        |
| Slim `RemoteStateV2` core (protocol 2, one profile)                   | **9.9 KiB**    | 99.2% vs the deduped payload |

A remote client always holds only the core: navigation, badges and summaries for the profile it is
bound to. Full git logs, PR threads and comments, and Docker lists are separate resources fetched
when a visible pane asks for them, and the server pushes `resource:invalidate` instead of the data
when one changes. A narrow (phone) layout mounts only the focused cell, so hidden panes hold no
interest and fetch nothing.

Payload size is telemetry, not a correctness gate: no socket is closed because a frame is large.

## HTTP compression

The `/api/state` bootstrap core (9.9 KiB) compresses to:

| Encoding | Size             | Compress time | Ratio |
| -------- | ---------------- | ------------- | ----- |
| Brotli   | 1.1 KiB (1136 B) | ~9.4 ms       | 88.8% |
| gzip     | 1.5 KiB (1497 B) | ~0.37 ms      | 85.2% |

Brotli is used when the client's `Accept-Encoding` offers it, gzip otherwise. Bodies under 1 KiB
are sent uncompressed. ETag / `304` lets a re-fetch of an unchanged bootstrap or detail resource
skip the body.

## WebSocket `permessage-deflate` stays off

| Ongoing WS frame                     | Raw     | Deflated | CPU / frame (median) |
| ------------------------------------ | ------- | -------- | -------------------- |
| `resource:invalidate` (steady state) | 97 B    | 86 B     | ~0.007 ms            |
| coalesced core delta (largest)       | 9.9 KiB | 1.5 KiB  | ~0.033 ms            |

A compression context with context takeover (the `ws` default) costs about **65 KiB per socket**
(RSS delta). The steady-state traffic is tiny invalidations that deflate saves ~11 bytes on, and
the core delta is infrequent and coalesced latest-wins. The one large transfer, the bootstrap, is
already compressed over HTTP. Revisit only if a real deployment shows the WS delta stream, not the
bootstrap, dominating bandwidth.

## State is transferred over one path per event

- **First connect:** `GET /api/state` delivers the core. The first WebSocket URL carries no `?rev=`,
  so the server sends no redundant initial frame; the client hands its bootstrap revision over in a
  one-shot `state:sync`, answered with a catch-up only if state moved between bootstrap and
  WebSocket open.
- **Reconnect:** the new socket's URL carries `?rev=<last core revision>`, and that is the only
  resync channel — there is no second `/api/state` fetch. The server sends exactly one catch-up core
  when its revision differs, none otherwise.
- **Server restart:** `coreRevision` is a per-process counter and starts again from zero, so the
  catch-up condition is `rev !== coreRevision`, not `rev < coreRevision`. A client that is "ahead"
  of a restarted server still gets one fresh core.

`npm run smoke:remote-tunnel` runs the real backend headless behind a live Cloudflare quick tunnel
and drives the web client through it (needs `cloudflared` on `PATH` and a `dist/` built with
`VITE_BUILD_WATCH=1 npx vite build`).
