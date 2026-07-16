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

### Live smoke over a REAL Cloudflare tunnel against the REAL backend — EXECUTED (2026-07-16)

The plan's live matrix (§Verification 9) was executed against the **real
application backend**, not the mock server. `scripts/remote-tunnel-smoke.mts`
(run: `npm run smoke:remote-tunnel`) boots the actual `createRuntime()` +
`startRemoteServer()` **headless** — the exact code the Electron shell runs, only
the GUI window is absent (the backend runtime/remote-server import no `electron`
module; verified) — then drives it over a live `cloudflared` quick tunnel
(`https://<name>.trycloudflare.com`, real TLS/QUIC to the Cloudflare edge). The
tunnel is torn down at the end.

**Seeded data:** a **real git repo** (real `GitManager` snapshot, dirty working
tree), **real Docker** via the `STRIDETERM_DOCKER_MOCK_FILE` code path (real
`DockerManager`, no daemon on this host), a **real PTY** terminal (real Windows
shell), and the real `reviewBridgeStore`. Azure/GitHub/review-bridge **data** is
synthetic — this environment has no real provider accounts — but flows through
the real managers, the real `remote-core.ts` reducers, the real detail endpoints
and the real revision/invalidation path. (Loading a real provider account's PRs
on physical hardware is the one remaining human step; see below.)

**Result: 33/33 checks pass** over the tunnel. Two layers, both over the tunnel URL:

**Protocol layer** (Node `fetch`/`ws` → the real server over the edge):

- `/?token=` bootstraps a session cookie; the client activates its profile
  (`/api/remote-client/profile/activate` → 200).
- `GET /api/state` → slim core: `stateProtocol: 2`, `Content-Encoding: gzip`,
  ~8.8 KiB, `gitSummaries` present (the seeded repo shows `dirty:true,
dirtyCount:1`), **`git.workspaces` absent**, provider **`inbox` absent**.
- Every detail resource returns `{resource,revision,data}` 200 over the tunnel:
  `git:<ws>` (heavy snapshot with `roots`/`log`), `docker` (full 3-container
  list), `azure-inbox`, `azure-pr`, `github-inbox`, `github-pr`, `review-bridge`,
  `agent-prompts`. The azure-pr `revision` folds checks + reviewer votes
  (`…ck1:succeeded,ck2:pending|rv1:5|…`), proving the round-8 freshness fix over
  the wire.
- **Profile authorization holds over the tunnel:** a cross-profile PR detail is
  rejected `403`.
- **Terminal I/O + replay:** `terminal:subscribe` returns a `terminal:replay`
  carrying earlier **real PTY output** (the `STRIDETERM_SMOKE_MARKER` echo);
  `terminal:input` sent over the tunnel WS reaches the PTY (server-side observed).
- `resource:interest` primes `resource:invalidate`; **no size-induced `1013`
  close**; reconnect carrying `?rev=` re-establishes and re-primes invalidations
  without a `1013` loop.

**Device layer** (Playwright Chromium at three profiles, rendering the **real web
client** served from `dist/` over the tunnel):

| viewport            | over the tunnel — observed                                                                                                                                                                                                                                        |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Phone** iPhone 13 | real mobile web client mounts + renders the slim core; the terminal pane shows the real shell with the `STRIDETERM_SMOKE_MARKER` and `TUNNEL_WS_INPUT` echoes; no `1013` reconnect loop; 0 JS errors. Screenshot: `docs/remote-smoke-artifacts/tunnel-phone.png`. |
| **Tablet** iPad     | same slim core renders in the iPad layout; no `1013`; 0 JS errors. Screenshot: `docs/remote-smoke-artifacts/tunnel-tablet.png`.                                                                                                                                   |
| **Wide** 1600×950   | wide desktop-browser viewport renders the full slim-core app; no `1013`; 0 JS errors. Screenshot: `docs/remote-smoke-artifacts/tunnel-wide.png`.                                                                                                                  |

Telemetry captured as observations (no hard target): bootstrap core **~8.8 KiB,
gzip over the tunnel**; `frameP50/P95 ≈ 8.8 KiB`; `maxBacklog 0`; `stateCoalesced
0` (no burst during the run); WS stayed connected with **no `1013`** across the
reconnect. The wide-grid **interest recomputation** across multiple visible cells
is additionally covered by `useResourceInterest.test.ts` and the
`workspace-grid` Electron E2E; this live pass confirms the wide viewport renders
the slim core over the tunnel without a size-induced disconnect.

#### The one remaining human step (real-account data on physical hardware)

Everything above runs against the real backend over a real tunnel. Two things are
inherent to the **user's** environment and cannot be reproduced in this automated
harness — they exercise **no additional application code path** beyond what the
33 checks and the unit/E2E suites already prove:

1. **Real Azure DevOps / GitHub account data.** The provider **contract** (core
   badges, inbox/PR/review-bridge detail, revision folding, profile auth) is
   exercised above with synthetic data through the real code path, and unit-tested
   in `remote-core.test.ts`. Loading a real account's PRs requires the user's
   configured connections — the plan explicitly scopes the real-data live smoke as
   "run by the user."
2. **Literal physical phone/tablet hardware** — a real touch digitizer / cellular
   radio (vs. Chromium device emulation over the same tunnel). Pinch-zoom font
   sizing is a real-gesture affordance worth a human glance.

Reproduce the automated pass: `npm run smoke:remote-tunnel` (needs `cloudflared`
on PATH and `dist/` built via `VITE_BUILD_WATCH=1 npx vite build`).
