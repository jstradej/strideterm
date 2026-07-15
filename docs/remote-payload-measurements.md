# Remote payload measurements

Recorded evidence for the remote slim-core work (`plan-remote-payload-slim.md`).
Reproduce with:

```
npm run measure:remote
```

The tool (`scripts/measure-remote-payload.mts`) builds a representative payload
modelled on the July 2026 prod incident — **59 workspaces** with heavy git
snapshots (log / compareWithBase / roots / remotes), **26 Azure PRs** carrying
review threads + issue comments, and full **Docker** lists (186 images / 7
containers / 36 volumes) — then measures the reduction and the compression
trade-offs. Sizes are deterministic (fixed synthetic data), so re-running
reproduces them.

## Payload size reduction (plan §Verification 6 — "record the payload reduction")

| Stage                                                                              | Size           | Reduction                                                     |
| ---------------------------------------------------------------------------------- | -------------- | ------------------------------------------------------------- |
| Pre-dedup full payload (2.4.10, with `git.projects` + `appState.projects` aliases) | **2109.3 KiB** | —                                                             |
| Post-dedup desktop payload (Phase 1 removed the byte-identical aliases)            | **1300.8 KiB** | **38.3%** vs pre-dedup                                        |
| Slim `RemoteStateV2` core (protocol 2, one profile)                                | **10.6 KiB**   | **99.2%** vs post-dedup desktop payload · **99.5%** vs 2.4.10 |

The Phase 1 dedup alone cuts ~38% (the projects aliases the plan flagged as
"byte-identical duplicate"). The slim core then removes the rest of the weight —
full git logs, provider PR threads/issue comments, and Docker lists are fetched
on demand — leaving a ~10 KiB core for the always-on navigation + badges. This
is telemetry, **not** a correctness gate: no socket is closed for a large frame
(see `terminalBackpressureDecision` / `socketStallDecision`).

## HTTP bootstrap compression (Phase 4)

The `/api/state` bootstrap core (10.6 KiB) compresses to:

| Encoding | Size                 | Compress time | Ratio |
| -------- | -------------------- | ------------- | ----- |
| Brotli   | **1.2 KiB** (1222 B) | ~16.5 ms      | 88.8% |
| gzip     | **1.6 KiB** (1600 B) | ~0.35 ms      | 85.3% |

Brotli is preferred (better ratio) and is chosen when the client's
`Accept-Encoding` advertises it; gzip is the fallback (`pickEncoding` in
`remote-server.ts`). Compression only kicks in above `JSON_COMPRESS_MIN_BYTES`
(1 KiB) so tiny results (`{ ok: true }`) are never framed/CPU-taxed. ETag/`304`
revalidation (client `If-None-Match`) lets a re-fetch of an unchanged bootstrap
or detail skip the body entirely.

## WS `permessage-deflate` evaluation (Phase 4 — "evaluate only after measuring")

After bootstrap the WebSocket carries only **tiny** frames: a steady-state
`resource:invalidate` is **97 B**, and state deltas are latest-wins coalesced
slim cores. permessage-deflate would compress a ~100 B frame to roughly the same
size — it sits below the deflate window's useful floor — while adding per-frame
CPU and a compression context (memory) **per socket**.

**Recommendation: keep WS `permessage-deflate` OFF.** HTTP compression already
covers the single large transfer (the bootstrap core over `/api/state`); the
ongoing WS traffic is small invalidations plus coalesced core deltas, for which
per-message deflate is net-negative (CPU/memory for no meaningful byte saving).
The small core/invalidation protocol deliberately does not depend on it
(plan §Phase 4). Revisit only if profiling a real deployment shows the WS delta
stream — not the bootstrap — dominating bandwidth, which the coalescing +
summary/detail split is designed to prevent.

## Live end-to-end validation (plan §Verification 9)

Automated coverage exercises the full remote path headlessly — HTTP bootstrap →
slim core, WS state deltas, detail endpoints + profile authorization, the
interest → invalidate → fetch pipeline, capability negotiation, the
bootstrap→WS revision handoff, reconnect resubscription, and the v1/v2
compatibility split (`electron/backend/remote-server.test.ts`,
`src/stores/remote-details.test.ts`, `src/composables/useResourceInterest.test.ts`,
`src/transport.test.ts`, `src/stores/app.test.ts`).

The remaining item that genuinely cannot run in CI is a human-in-the-loop pass
over the tunnel on a **physical phone / tablet / wide desktop browser** via
`.\dev.ps1` (touch gestures, real viewport reflow, real cellular/tunnel
latency). That is a manual sign-off step for the release owner; everything it
would verify functionally is covered by the automated suites above.
