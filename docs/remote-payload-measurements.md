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
| Slim `RemoteStateV2` core (protocol 2, one profile)                                | **9.9 KiB**    | **99.2%** vs post-dedup desktop payload · **99.5%** vs 2.4.10 |

The Phase 1 dedup alone cuts ~38% (the projects aliases the plan flagged as
"byte-identical duplicate"). The slim core then removes the rest of the weight —
full git logs, provider PR threads/issue comments, and Docker lists are fetched
on demand — leaving a ~10 KiB core for the always-on navigation + badges (the
core shrank further once the provider PR reducer switched from a denylist to an
exact badge allowlist and settings dropped the tunnel/Telegram management
blocks). This is telemetry, **not** a correctness gate: no socket is closed for
a large frame (see `terminalBackpressureDecision` / `socketStallDecision`).

## HTTP bootstrap compression (Phase 4)

The `/api/state` bootstrap core (9.9 KiB) compresses to:

| Encoding | Size                 | Compress time | Ratio |
| -------- | -------------------- | ------------- | ----- |
| Brotli   | **1.1 KiB** (1136 B) | ~9.4 ms       | 88.8% |
| gzip     | **1.5 KiB** (1497 B) | ~0.37 ms      | 85.2% |

(Compress **sizes** are deterministic; the **times** are indicative and vary per
run/machine — Brotli trades markedly more CPU for a modestly smaller body.)

Brotli is preferred (better ratio) and is chosen when the client's
`Accept-Encoding` advertises it; gzip is the fallback (`pickEncoding` in
`remote-server.ts`). Compression only kicks in above `JSON_COMPRESS_MIN_BYTES`
(1 KiB) so tiny results (`{ ok: true }`) are never framed/CPU-taxed. ETag/`304`
revalidation (client `If-None-Match`) lets a re-fetch of an unchanged bootstrap
or detail skip the body entirely.

## WS `permessage-deflate` evaluation (Phase 4 — "evaluate only after measuring")

The plan requires measuring CPU **and** memory before deciding, not inferring
them. `npm run measure:remote` compresses the two representative post-bootstrap
frames with raw DEFLATE at the parameters `ws` uses for permessage-deflate
(`windowBits: 15`, `memLevel: 8`, RFC 7692) and measures per-frame CPU (median of
2000 runs) and the actual per-socket compression-context memory (RSS delta over
200 contexts with context takeover, the default):

| Ongoing WS frame                     | Raw     | Deflated | Saving   | CPU / frame (median) |
| ------------------------------------ | ------- | -------- | -------- | -------------------- |
| `resource:invalidate` (steady state) | 97 B    | 86 B     | **11 B** | ~0.007 ms            |
| coalesced core delta (largest)       | 9.9 KiB | 1.5 KiB  | ~85%     | ~0.033 ms            |

| Cost                                      | Measured                                   |
| ----------------------------------------- | ------------------------------------------ |
| Per-socket compression context (takeover) | **~65 KiB / socket** (RSS delta)           |
| → deflate state alone at scale            | ~1.5 k sockets ≈ **~100 MB** of zlib state |

**Recommendation: keep WS `permessage-deflate` OFF.** The steady-state
invalidation is below the deflate window's useful floor — it saves ~11 bytes per
frame. The core delta compresses well (~85%), but it is a **latest-wins-coalesced,
infrequent** frame, and its saving is dwarfed by a **~65 KiB compression context
retained per connected socket** (context takeover) plus per-frame CPU. HTTP
compression already covers the one large transfer (the bootstrap core over
`/api/state`); the ongoing WS traffic is tiny invalidations plus coalesced core
deltas, for which per-message deflate is net-negative on both CPU and memory. The
small core/invalidation protocol deliberately does not depend on it (plan
§Phase 4). Revisit only if profiling a real deployment shows the WS delta stream
— not the bootstrap — dominating bandwidth, which the coalescing + summary/detail
split is designed to prevent. (Compressed **sizes** are deterministic; CPU/RSS
numbers are indicative and vary per run/machine.)

## Live end-to-end validation (plan §Verification 9)

Automated coverage exercises the full remote path headlessly — HTTP bootstrap →
slim core, WS state deltas, targeted mutation acks, detail endpoints + profile
authorization (including cross-profile rejection and the unbound → default
profile scoping), the interest → invalidate → fetch pipeline, capability
negotiation, the bootstrap→WS revision handoff and the `state:sync` first-connect
window, single-path reconnect resync, reconnect resubscription, the viewer-bound
per-PR review mutations, and the v1/v2 compatibility split
(`electron/backend/remote-server.test.ts`, `electron/backend/remote-core.test.ts`,
`src/stores/remote-details.test.ts`, `src/composables/useResourceInterest.test.ts`,
`src/transport.test.ts`, `src/stores/app.test.ts`).

### Bootstrap & reconnect are single-path (plan §11 / success-criterion "transferred once")

State is transferred over exactly one channel per event, never both HTTP and WS:

- **First connect** — the HTTP `GET /api/state` bootstrap delivers the core; the
  first WS URL is frozen before a revision exists so it carries no `?rev=` and the
  server holds bootstrap-once (no redundant initial frame). The client then hands
  its bootstrap revision off via a one-shot `state:sync`, which the server answers
  with a catch-up only if state moved in the `[bootstrap, WS-open]` window.
- **Reconnect** — the fresh socket's URL carries `?rev=lastCoreRevision`, and that
  is the **only** resync channel. The server sends exactly one catch-up core when —
  and only when — its `coreRevision` differs from the advertised rev. The client no
  longer also issues `GET /api/state` on reconnect, so a stale reconnect can never
  transfer the core twice (the earlier dual path). A no-change reconnect transfers
  zero state bytes.
- **Server restart** — `coreRevision` is a per-process monotonic counter, so after a
  restart it resets below the value a reconnecting client still holds. The catch-up
  gate is `rev !== coreRevision` (not `rev < coreRevision`) precisely so a
  client-ahead rev still resyncs with one fresh core instead of being stranded on
  state from the dead process.

Coverage: `src/transport.test.ts` ("reconnect resync is single-path: WS `?rev=`
catch-up, never a duplicate `/api/state` fetch") proves the client issues no
reconnect HTTP fetch and carries the rev on the socket; `remote-server.test.ts`
proves, over real TCP, that a stale reconnect gets exactly one catch-up frame, a
current rev gets none, and a rev ahead of the server (post-restart) still gets
exactly one ("server-restart recovery").

`src/composables/useResourceInterest.test.ts` mounts the **real**
`WorkspaceGridStage.vue` (its `WorkspaceCell` stubbed to a pane that declares a
git interest) and asserts the WS interest set actually pushed to the transport as
the layout changes: a wide grid mounts every cell (all interested); a narrow /
mobile layout mounts ONLY the focused cell, so hidden cells' interests are
released; moving the focused cell moves the interest; and wide→narrow→wide
restores the full set. This exercises the production `renderedCells` logic — the
narrow layout unmounts hidden cells rather than hiding them with `v-show`, so a
phone no longer keeps fetching detail for panes it cannot see.

### E2E (real Chromium) — `npm run test:e2e`

The Playwright UI E2E suite runs the whole remote client against Chromium,
connecting through `test/mock-server.ts`, which now serves the **real slim-core
contract** (it composes the v2 core and the `{resource,revision,data}` detail
resources via the same `remote-core.ts` builders the production server uses, and
pushes `resource:invalidate` on interest). So the review / inbox / git / docker
panes fetch their detail on demand exactly as they do in production. Result:
**120 passed, 5 skipped, 0 failed**. The 5 skips are the Task-dashboard specs
that require the Monaco editor (unavailable in the bare headless env — skipped,
not failed).

### Live browser pass — phone / tablet / wide (plan §Verification 9)

A scripted real-browser pass (Chromium via `agent-browser`) was run against the
running app (`test/mock-server.ts` serving the `multi-workspace` fixture over the
slim-core protocol, proxying to the Vite dev server) at three viewport classes:

| viewport        | result                                                                                                                                                                                |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Wide 1440×900   | full desktop layout renders from the slim core; switching workspace (Frontend → Backend) adopts the new slim core (tab strip updates); no JS errors; clean WS connect (no 1013 loop). |
| Phone 390×844   | mobile layout (MobileInputBar “Show keyboard”, “▤ Tabs” picker); workspace tap switches; no JS errors.                                                                                |
| Tablet 820×1180 | sidebar + workspace layout renders from the slim core; no JS errors.                                                                                                                  |

At every viewport `GET /api/state` returned the slim `RemoteStateV2` core
(`stateProtocol: 2`, `gitSummaries` present, `git.workspaces`/
`reviewBridge.agentPrompts` absent) and the `/api/git/workspace-detail` endpoint
returned `{resource,revision,data}` on demand — confirming the contract end to end
in a real browser, not just headless unit mounts.

### Production server coverage (not just the mock)

The multi-viewport pass and E2E above drive the real client through
`test/mock-server.ts`. The **production** server (`electron/backend/remote-server.ts`)
is separately exercised end to end by `remote-server.test.ts`, which boots the
real `startRemoteServer` over real TCP sockets and asserts, against a realistic
runtime, the behaviors that actually differ over a tunnel:

- slim-core composition + per-client profile scoping on every outbound path
  (`/api/state`, WS `state:updated`, activation, mutation acks);
- the master-token strip on both top-level AND nested (`{ ok, payload }`)
  responses — so a v1 nested mutation cannot leak it;
- viewer-bound cross-profile refusal for every PR mutation (mark-seen, comment,
  vote, thread-status, review, rerun-check, review-bridge sync) and git/grid/
  attention routes;
- detail endpoints returning `{resource,revision,data}` with 403 on cross-profile
  ids, and the `agent-prompts` resource whose revision bumps on reset;
- latest-wins state coalescing, time-based stall detection and the total
  time-to-drain telemetry;
- Brotli/gzip + ETag/304, and the tunnel-only `Secure` session cookie keyed off
  `x-forwarded-proto: https` (`buildSessionCookieAttrs` tests).

A Cloudflare tunnel is a transparent HTTPS reverse proxy: the app-observable
differences from localhost are exactly HTTPS (the `Secure` cookie above),
compression negotiation (`measure:remote`), and latency — all covered above.

### Live smoke over a REAL Cloudflare tunnel — EXECUTED (2026-07-16)

The phone/tablet/wide-browser pass was re-run **through a live Cloudflare quick
tunnel** (`cloudflared tunnel --url …` → `https://<name>.trycloudflare.com`, TLS

- QUIC to the Cloudflare edge, region `prg01`), not just localhost. The browser
  loaded the app from the tunnel URL and connected `wss://<tunnel>/ws`, so every
  observation below crossed the real HTTPS reverse proxy the production incident
  did. The mock served the **real** slim-core contract (the same
  `electron/backend/remote-core.ts` builders production uses) over synthetic
  fixture data (no real credentials/workspaces exposed on the public URL); the
  tunnel was torn down at the end. Chromium drove three device profiles — phone
  (iPhone 13 emulation: mobile viewport, DPR, touch, mobile UA), tablet (iPad
  emulation), and wide desktop (1440×900) — against the tunnel URL.

| viewport            | over the tunnel — observed                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Phone** iPhone 13 | slim core delivered (`stateProtocol: 2`, `gitSummaries` present (2), `git.workspaces` absent, `azureDevops.inbox` absent, ~8.9 KiB, **`Content-Encoding: gzip`** over the tunnel); mobile chrome (MobileInputBar); terminal I/O reached the server (18 `terminal:input` frames received); reconnect after offline→online was clean; **no `1013` loop** (WS stable, no reconnecting banner); 0 JS errors. |
| **Tablet** iPad     | same slim core; workspace switch adopted the new core; `GET /api/git/workspace-detail` returned `{resource,revision,data}` (200) on demand over the tunnel; clean reconnect; no `1013`; 0 JS errors.                                                                                                                                                                                                     |
| **Wide** 1440×900   | full desktop **2×2 workspace grid** with several non-terminal panes mounted at once (task-dashboard cells + terminal cells), each rendering from the slim core; the `master clean` git badge rendered from the **summary** (not a full snapshot); workspace switch adopted the new core; detail-on-demand 200; clean reconnect; no `1013`; 0 JS errors; core ~9.9 KiB.                                   |

Telemetry captured as observations (no hard target): the `/api/state` bootstrap
core was **8.9–9.9 KiB** and **gzip-compressed over the tunnel**; the core
carried summaries only (no full `git.workspaces`, no `azureDevops.inbox`); the WS
stayed connected with no size-induced `1013` close and recovered cleanly across
an offline→online cycle. Reproduce by starting the Vite dev server + the
mock-server (`tsx test/mock-server.ts workspace-grid --port 3999`, with
`VITE_DEV_PORT` pointing at Vite), running `cloudflared tunnel --url
http://127.0.0.1:3999`, and opening the printed `trycloudflare.com` URL in a
browser (or driving it with Playwright device emulation).

#### Residual not covered by the above (optional human confirmation)

The automated pass above exercises the real slim-core contract over a real
Cloudflare tunnel with real HTTPS/WSS, real edge latency, real compression
negotiation, and emulated mobile viewport/touch. Two things it does **not**
cover, neither of which exercises any additional application code path:

1. **Literal physical hardware** — a real phone/tablet's touch digitizer and
   real cellular radio (vs. Chromium's device emulation over Wi-Fi). Pinch-zoom
   font sizing in particular is a real-gesture affordance worth a human glance.
2. **A named (account) Cloudflare tunnel** started from `.\dev.ps1` against the
   full Electron backend (vs. a quick tunnel to the mock). The full backend's
   HTTP/WS plumbing, backpressure, response adapter and secret-strip are proven
   over real TCP in `remote-server.test.ts`; the tunnel hop itself is proven
   above.

These remain a nice-to-have final sign-off for a release owner, not a gate on
this work: the slim-core remote contract is verified end-to-end over a real
Cloudflare tunnel at phone, tablet, and wide-browser viewports.
