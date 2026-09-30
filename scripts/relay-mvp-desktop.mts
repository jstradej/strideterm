#!/usr/bin/env node
/// <reference types="node" />
/**
 * One headless strIDEterm installation for the managed-relay MVP run.
 *
 * WHY A PROCESS AND NOT AN IMPORT. The cross-repo scenario lives in `strideterm-mobile` and runs
 * under Node's type-stripping loader, which cannot load this repo's backend at all (several modules
 * use TypeScript parameter properties, which strip-only mode rejects). More importantly, an
 * installation IS a process with a data directory — running two of them as two processes is what the
 * MVP is actually about, and importing two runtimes into one process would be a weaker claim.
 *
 * WHAT IT STARTS. The real `createRuntime()` on the data directory it is given — the same code the
 * Electron shell runs, minus the window — with the relay's loopback-only internal origin wired
 * exactly as `electron/main.ts` wires it. Real PTYs, real remote handlers, real mobile transport
 * against whatever Firebase emulator the environment names.
 *
 * THE CONTROL API. A loopback-only HTTP server the test scenario drives it through: create an
 * invitation, read the pairing progress, approve a device, read the relay's status, write to a PTY.
 * Every route requires a per-run random token in `x-relay-mvp-token`, printed on stdout with the
 * URL — it is a test harness, and it is bound to 127.0.0.1, but a control API that answered any
 * local process would be a worse one.
 *
 * Usage (from the strideterm repo):
 *   npx tsx scripts/relay-mvp-desktop.mts --data-dir <dir> --state <state.json>
 * Prints one JSON line when ready: {"controlUrl":"http://127.0.0.1:PORT","token":"…","installationId":"…"}
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";

import { getLogger, setLogDir } from "../electron/backend/logger.js";
import { applySystemCaTrust } from "../electron/backend/net/system-ca.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");

function arg(name: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] ?? "") : "";
}

const dataDir = arg("--data-dir");
const stateFile = arg("--state");
if (!dataDir || !stateFile) {
  console.error("relay-mvp-desktop: --data-dir and --state are both required");
  process.exit(1);
}
fs.mkdirSync(dataDir, { recursive: true });

// Logs into THIS run's data directory, exactly as `electron/main.ts` does for `--data-dir`, and
// before the backend is imported: `getLogger`/`createAuditLogger` are called at module scope, so a
// static import would have opened its files in the default directory first. Without this the harness
// wrote its own and the relay origin's audit log into `~/.strideterm/logs` — the operator's real one
// — which both pollutes a production directory and leaves a test's trail behind after a runner that
// promises to clean up everything it created.
setLogDir(path.join(dataDir, "logs"));
// Same TLS trust as the app (electron/main.ts): before anything can open an outbound connection.
getLogger("relay-mvp-desktop").info("tls trust store", applySystemCaTrust());

const { createRuntime } = await import("../electron/backend/runtime.js");
const { startRemoteServer } = await import("../electron/backend/remote-server.js");

fs.copyFileSync(stateFile, path.join(dataDir, "strideterm-state.json"));
const initialState = JSON.parse(fs.readFileSync(stateFile, "utf8")) as {
  settings?: { remoteAccess?: { enabled?: boolean } };
};

// A fresh installation asks GitHub for the release list ten seconds after boot, and this run has to
// be able to say truthfully that it touched nothing outside loopback. So the harness seeds the very
// cache file the product itself writes, with a check that just happened: the checker's own 24-hour
// throttle then returns the cache and never opens a socket. Nothing in the product is changed or
// stubbed for the test — the installation simply starts up already knowing.
fs.writeFileSync(
  path.join(dataDir, "version-check.json"),
  JSON.stringify(
    {
      lastCheckAt: new Date().toISOString(),
      etag: "",
      latestVersion: "",
      latestUrl: "",
      versionsBehind: 0,
      releases: [],
    },
    null,
    2,
  ),
  "utf8",
);

// Real PTYs, but no shell-integration injection: it is noise in a headless run and its output would
// have to be filtered out of every terminal assertion.
process.env.STRIDETERM_SHELL_INTEGRATION = "0";

const token = randomBytes(24).toString("base64url");

/* eslint-disable @typescript-eslint/no-explicit-any -- a test harness driving the runtime's dynamic surface */
const runtime: any = await createRuntime({
  userDataPath: dataDir,
  deferInitialRefresh: true,
  dependencies: {
    // A headless run has no OS keychain, and Mobile's keys are never stored as plaintext — so without
    // one the runtime refuses to turn Mobile on at all. This stands in for the keychain (the data dir
    // is a throwaway) so the integration can be exercised end to end; it is not encryption.
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (value: string) => Buffer.from(`harness:${value}`, "utf8"),
      decryptString: (value: Buffer) => value.toString("utf8").replace(/^harness:/, ""),
    },
    // The relay's internal origin, wired exactly as electron/main.ts wires it.
    startRelayOrigin: async (loopbackOrigin: {
      host: string;
      port: number;
      guardToken: string;
      publicOrigin: string;
    }) =>
      startRemoteServer({
        runtime,
        staticRoot: path.join(REPO_ROOT, "dist"),
        loopbackOrigin,
      }),
  },
});

/**
 * The user's OWN remote access — the LAN/tunnel listener — started exactly as electron/main.ts
 * starts it, and only when this installation's state says the user enabled it.
 *
 * It is here so the run can prove the two transports are independent with both of them live at
 * once: the relay's internal origin is a second instance of the same server on loopback, and the
 * claim that turning one on does not disturb the other is only worth something if a run has had
 * both open on the same runtime at the same time.
 */
let lanServer: { close: () => Promise<void> } | null = null;
if (initialState?.settings?.remoteAccess?.enabled) {
  lanServer = await startRemoteServer({
    runtime,
    staticRoot: path.join(REPO_ROOT, "dist"),
  });
}

/** Every `mobile:pairing-progress` this installation emitted, in order — where the SAS surfaces. */
const pairingProgress: unknown[] = [];
runtime.on("mobile:pairing-progress", (entry: unknown) => pairingProgress.push(entry));

async function readBody(request: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

/** Constant-time compare for the control token, so the harness is not itself a bad example. */
function tokenMatches(header: string | string[] | undefined): boolean {
  if (typeof header !== "string") return false;
  const presented = Buffer.from(header, "utf8");
  const expected = Buffer.from(token, "utf8");
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}

const server = http.createServer((request, response) => {
  void (async () => {
    const json = (status: number, body: unknown): void => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    if (!tokenMatches(request.headers["x-relay-mvp-token"])) {
      json(403, { error: "forbidden" });
      return;
    }
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    try {
      switch (`${request.method} ${url.pathname}`) {
        case "GET /ready":
          json(200, { ok: true, relay: runtime.getMobileRelayStatus() });
          return;
        case "GET /remote/lan": {
          const remote = runtime.getPayload().appState.settings.remoteAccess;
          json(200, {
            running: lanServer !== null,
            enabled: Boolean(remote?.enabled),
            host: String(remote?.host ?? ""),
            port: Number(remote?.port ?? 0),
          });
          return;
        }
        // Numbers only, for the soak run's "no unbounded growth" claim. A process that is leaking
        // says so here; a claim that it is not is otherwise unfalsifiable.
        case "GET /process": {
          const memory = process.memoryUsage();
          json(200, {
            rss: memory.rss,
            heapUsed: memory.heapUsed,
            external: memory.external,
            uptimeMs: Math.round(process.uptime() * 1000),
          });
          return;
        }
        case "GET /relay/status":
          json(200, runtime.getMobileRelayStatus());
          return;
        // The same switch Settings → Mobile drives (`runtime.setMobileRelayEnabled`), exposed so a
        // harness can turn the connector off and on again. That is not a convenience: the manager
        // backs off exponentially after a refusal, and on the deployed tier its FIRST attempts are
        // refused by design — `issueRelayConnectorGrant` is authorized against a pairing that does
        // not exist yet when the installation starts. By the time a pairing lands, the next retry can
        // be minutes away, which is longer than a phone will wait for a terminal. Off-and-on clears
        // the backoff and re-attaches now.
        case "POST /relay/enabled": {
          const body = await readBody(request);
          await runtime.setMobileRelayEnabled(body.enabled !== false);
          json(200, { ok: true, relay: runtime.getMobileRelayStatus() });
          return;
        }
        // The only account bootstrap surface is an explicitly opted-in QA harness process. The
        // caller supplies a link minted by Identity Toolkit with returnOobLink=true; the runtime
        // then executes its normal parser, owner verification, installation enrolment and trial.
        // This route is loopback-only and token-protected like every other control route, and it is
        // deliberately unavailable to dev, prod and ordinary desktop launches.
        case "POST /account/bootstrap": {
          if (process.env.STRIDETERM_ENV !== "qa" || process.env.STRIDETERM_QA_HEADLESS_ACCOUNT_BOOTSTRAP !== "1") {
            json(404, { error: "unknown route" });
            return;
          }
          const body = await readBody(request);
          if (
            typeof body.email !== "string" ||
            body.email.length > 320 ||
            typeof body.link !== "string" ||
            body.link.length > 4096
          ) {
            json(400, { error: "invalid bootstrap payload" });
            return;
          }
          await runtime.accountBootstrapExternalSignIn(body.email, body.link);
          const bootstrap = await runtime.accountBootstrapDiagnostics();
          if (process.env.STRIDETERM_QA_CLAIM_PROBE === "1") {
            await new Promise((resolve) => setTimeout(resolve, 15_000));
            const delayed = await runtime.accountBootstrapDiagnostics();
            const refreshed = await runtime.accountBootstrapDiagnostics(true);
            json(200, { ok: true, bootstrap, delayed, refreshed });
          } else {
            json(200, { ok: true, bootstrap });
          }
          return;
        }
        case "GET /account/diagnostics": {
          if (process.env.STRIDETERM_ENV !== "qa" || process.env.STRIDETERM_QA_HEADLESS_ACCOUNT_BOOTSTRAP !== "1") {
            json(404, { error: "unknown route" });
            return;
          }
          json(200, await runtime.accountBootstrapDiagnostics());
          return;
        }
        case "POST /account/cleanup": {
          if (process.env.STRIDETERM_ENV !== "qa" || process.env.STRIDETERM_QA_HEADLESS_ACCOUNT_BOOTSTRAP !== "1") {
            json(404, { error: "unknown route" });
            return;
          }
          const body = await readBody(request);
          if (
            typeof body.email !== "string" ||
            body.email.length > 320 ||
            typeof body.link !== "string" ||
            body.link.length > 4096 ||
            body.confirmationPhrase !== "DELETE MY ACCOUNT"
          ) {
            json(400, { error: "invalid cleanup payload" });
            return;
          }
          await runtime.accountBootstrapExternalDeletion(body.email, body.link, body.confirmationPhrase);
          json(200, { ok: true, deleted: true });
          return;
        }
        case "POST /pairing/invitation": {
          const body = await readBody(request);
          json(200, await runtime.createMobilePairingInvitation(body));
          return;
        }
        case "GET /pairing/progress":
          json(200, { entries: pairingProgress });
          return;
        case "POST /pairing/approve": {
          const body = await readBody(request);
          json(200, await runtime.approveMobileDevice(body.deviceId));
          return;
        }
        case "POST /mobile/reconfigure": {
          const body = await readBody(request);
          json(200, { ok: true, payload: !!(await runtime.setMobileEnabled(body.enabled !== false)) });
          return;
        }
        case "GET /state": {
          const payload = runtime.getPayload();
          // A deliberately narrow snapshot: what the scenario asserts on, and nothing that would
          // put a token or a workspace's contents into a test log.
          json(200, {
            windowSlots: payload.appState.windowSlots,
            remoteAccess: {
              enabled: payload.appState.settings.remoteAccess.enabled,
              reportedUrls: payload.remoteAccess?.urls ?? [],
            },
            relay: runtime.getMobileRelayStatus(),
            devices: (payload.appState.settings.integrations.mobile.devices ?? []).map((device: any) => ({
              deviceId: device.deviceId,
              state: device.state,
              revoked: device.revoked,
            })),
          });
          return;
        }
        case "POST /workspace/activate": {
          const body = await readBody(request);
          await runtime.activateWorkspace(body.workspaceId);
          json(200, { ok: true });
          return;
        }
        case "POST /terminal/write": {
          const body = await readBody(request);
          runtime.writeToSession(body.sessionId, body.data);
          json(200, { ok: true });
          return;
        }
        case "GET /terminal/replay": {
          const snapshot = runtime.getTerminalReplaySnapshot(url.searchParams.get("sessionId") ?? "");
          json(200, { length: String(snapshot?.data ?? "").length });
          return;
        }
        // Answers a yes/no about the PTY's replay buffer without handing its contents out. The
        // device run needs to know that what a phone typed reached this desktop's shell, and a
        // route that returned the buffer would put terminal output in a test harness's log.
        case "GET /terminal/contains": {
          const snapshot = runtime.getTerminalReplaySnapshot(url.searchParams.get("sessionId") ?? "");
          const needle = url.searchParams.get("needle") ?? "";
          json(200, {
            found: needle.length > 0 && String(snapshot?.data ?? "").includes(needle),
          });
          return;
        }
        case "POST /device/revoke": {
          const body = await readBody(request);
          await runtime.revokeMobileDevice(body.deviceId);
          json(200, { ok: true });
          return;
        }
        case "POST /shutdown":
          json(200, { ok: true });
          setTimeout(() => {
            void lanServer?.close().catch(() => undefined);
            void runtime
              .stop()
              .catch(() => undefined)
              .then(() => process.exit(0));
          }, 50);
          return;
        default:
          json(404, { error: "unknown route" });
      }
    } catch (error) {
      json(500, { error: (error as Error).message });
    }
  })();
});

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
const port = typeof address === "object" && address ? address.port : 0;

// One line, machine-readable, on stdout: the runner parses it and stops waiting.
console.log(
  JSON.stringify({
    ready: true,
    controlUrl: `http://127.0.0.1:${port}`,
    token,
    dataDir,
  }),
);
