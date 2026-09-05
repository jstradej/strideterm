/// <reference types="node" />
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { existsSync, mkdirSync } from "node:fs";
import { getLogger } from "./logger.js";
import {
  matchesNestedCommandEntry,
  buildNestedCommandEntry,
  getNotifyScriptPath,
  findHookIndex,
  configureHookEntries,
  removeHookEntries,
  detectHookEntriesStatus,
} from "./hook-config-engine.js";
import { SHARD_LEASE_TTL_MS } from "./notify-url-registry.js";

const log = getLogger("claude-hook");

/**
 * Manages Claude Code notification hooks in ~/.claude/settings.json.
 *
 * Provides configure/remove/detect operations that safely merge with
 * existing user settings without overwriting other hooks or config.
 *
 * Registers six hook types against the same notify.mjs script:
 * - Notification   — idle_prompt / permission_prompt / elicitation / auth
 * - Stop           — end of each assistant turn
 * - SubagentStop   — sub-agent completion
 * - UserPromptSubmit — user submitted a new prompt (resets idle state)
 * - PreToolUse     — a subagent was launched (matcher-scoped to the Agent/Task
 *                    tool) so the tab/dot can show "running" while background
 *                    agents work after the turn's Stop
 * - PermissionRequest — Claude is about to ask for permission. The only hook
 *                    whose RESPONSE matters: strIDEterm may answer `allow`
 *                    (Settings → Auto-approve permission prompts, off by
 *                    default), and either way the payload names the tool and
 *                    its arguments so the alert can say what is being approved
 *
 * The script receives the hook name as argv[2] and POSTs it to notify-server.js
 * in the body as the `hook` field; dispatcher.js routes from there.
 */

// Hook types to register. Order matters only for log readability.
export const HOOKS_TO_REGISTER = [
  "Notification",
  "Stop",
  "SubagentStop",
  "UserPromptSubmit",
  "PreToolUse",
  // PermissionRequest fires when Claude is about to ask for permission. The
  // matcher stays EMPTY on purpose: which tools may be auto-approved is
  // strIDEterm's decision (settings + never-list + session state), not
  // something to hard-code into the user's ~/.claude/settings.json where it
  // would then be invisible and unchangeable from the UI. With auto-approve
  // off — the default — the hook only supplies the tool name and arguments
  // that make the "question" alert say what is being approved.
  "PermissionRequest",
];
// Registration key === canonical hook name for Claude (no aliasing needed).
const CLAUDE_EVENT_MAP: Record<string, string> = Object.fromEntries(HOOKS_TO_REGISTER.map((h) => [h, h]));

// Markers used to identify strIDEterm hooks in Claude Code settings.
// We check for the env var reference (legacy curl-based hook) and the
// notify script path (Node-based hook) so upgrades are seamless.
const HOOK_MARKERS = ["STRIDETERM_NOTIFY_URL", "hooks/notify.mjs", "hooks\\notify.mjs"];

// Cross-platform Node.js script that reads stdin and POSTs to the strIDEterm
// notify-server. Written to <userDataPath>/hooks/notify.mjs at runtime.
//
// argv[2] is the hook name (see HOOKS_TO_REGISTER) injected by buildHookEntry.
// The script parses stdin as JSON, augments it with the hook name, and POSTs to
// all URLs mapped to the current CLAUDE_PROJECT_DIR.
//
// For every hook but one the response is discarded. `PermissionRequest` is the
// exception: Claude Code reads this script's stdout to decide whether to show
// the permission dialog, so the script collects the responses and prints a
// decision only when EXACTLY ONE strIDEterm instance returned one.
//
// A command hook DOES inherit the parent environment (Claude Code documents
// this, and the auto-approve ownership token depends on it), but that
// environment is a snapshot of the terminal as it was when the shell started:
// it cannot describe a notify server that moved to a new port afterwards, and
// an agent started outside a strIDEterm PTY has none of it at all. URLs are
// therefore ALSO resolved from a registry the runtime keeps up to date: the
// env URL is tried first because it names one panel exactly, and the registry
// (keyed by project directory) is the fallback when nothing could be delivered
// over it.
//
// Paths resolve from `import.meta.url` so each installed script points at its
// own <userDataPath> — critical for dev instances (dev.ps1 / --data-dir) whose
// runtime writes notify-urls.json under ~/.strideterm-dev. Using os.homedir()
// here would route every hook back to ~/.strideterm regardless of instance.
//
// Logs to <userDataPath>/logs/hook.log (errors/warnings only, auto-truncated
// at 3MB for retention). Successful delivery is visible in strideterm.log
// via notify-server entries.
const NOTIFY_SCRIPT_CONTENT = `import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

// __dirname equivalent for ESM — resolves to <userDataPath>/hooks/
const HOOKS_DIR = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.dirname(HOOKS_DIR);

const LOG_PATH = path.join(DATA_DIR, "logs", "hook.log");
const LOG_MAX_BYTES = 3 * 1024 * 1024; // 3 MB
function log(level, msg) {
  try {
    const line = new Date().toISOString().replace("T", " ").replace("Z", "") + " " + level + "  [hook] " + msg + "\\n";
    try { if (fs.statSync(LOG_PATH).size > LOG_MAX_BYTES) fs.writeFileSync(LOG_PATH, ""); } catch {}
    try { fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true }); } catch {}
    fs.appendFileSync(LOG_PATH, line);
  } catch {}
}

// Where notify URLs are looked up. The SHARED directory is the one that
// matters: ~/.claude/settings.json is global, so exactly ONE installed
// notify.mjs is ever registered there, and it has to be able to reach an
// instance whose data directory is a different one — dev (~/.strideterm-dev)
// running beside prod (~/.strideterm). A registry under DATA_DIR could only
// ever see its own instance, which is why the shared path is
// instance-independent.
//
// Inside it, every instance owns ONE file — instances/<instanceId>.json — and
// writes nothing else. Two installations starting at the same moment therefore
// cannot lose each other's entries: a single shared document would have them
// both read the old content, add their own line and rename over each other,
// and the loser's sessions would silently stop receiving hooks. The aggregate
// notify-urls.json is still read (an older writer's only output, and this
// build keeps it as a mirror) and so is the per-data-dir copy — but only when
// no leased shard answered: neither mirror carries a lease, so one written
// while a now-abandoned installation was alive would otherwise re-publish its
// dead port forever.
// STRIDETERM_HOOKS_DIR relocates the shared registry — a test seam, honoured
// by the runtime side too. Nothing in production sets it.
const SHARED_DIR = process.env.STRIDETERM_HOOKS_DIR || path.join(os.homedir(), ".strideterm-hooks");
const SHARED_URLS_PATH = path.join(SHARED_DIR, "notify-urls.json");
const SHARED_INSTANCES_DIR = path.join(SHARED_DIR, "instances");
const LOCAL_URLS_PATH = path.join(HOOKS_DIR, "notify-urls.json");
// A shard carries a lease its owner renews. One whose lease ran out belongs to
// an installation that is GONE — a crashed run, a deleted dev data dir, an
// uninstalled portable copy — and nobody but its owner ever writes it, so
// without this every hook would keep POSTing at its dead (or by now recycled)
// port, paying the connect timeout each time. Mirrors the runtime's
// SHARD_LEASE_TTL_MS.
const SHARD_LEASE_TTL_MS = ${SHARD_LEASE_TTL_MS};

/**
 * Every registry file to merge: one leased shard per instance, then the legacy
 * pair. Shards come FIRST so an expired one is recognised — and its URLs
 * tombstoned — before any unleased mirror gets a chance to name them again.
 */
function registryFiles() {
  const files = [];
  try {
    for (const name of fs.readdirSync(SHARED_INSTANCES_DIR)) {
      if (name.slice(-5) === ".json") files.push({ file: path.join(SHARED_INSTANCES_DIR, name), leased: true });
    }
  } catch {}
  // The legacy mirrors are written as bare maps by scripts and builds that
  // know nothing about leases, so there is no lease to honour on them.
  files.push({ file: SHARED_URLS_PATH, leased: false });
  files.push({ file: LOCAL_URLS_PATH, leased: false });
  return files;
}

/**
 * Age of a shard: its updatedAt when the writer stamped one, otherwise the
 * file mtime, which every write refreshes — an untimestamped shard is neither
 * assumed fresh (residue would never expire) nor assumed dead (a live sibling
 * on an older build would lose its routing).
 */
function shardAgeMs(file, stamped) {
  if (typeof stamped === "number" && stamped > 0) return Date.now() - stamped;
  try { return Date.now() - fs.statSync(file).mtimeMs; } catch { return Infinity; }
}

// Hook name — passed as argv[2] by buildHookEntry. Falls back to payload
// hook_event_name (Claude Code may include this) or "Notification" as a
// last resort for older hook scripts not re-installed yet.
const hookNameArg = process.argv[2] || "";
const envUrl = process.env.STRIDETERM_NOTIFY_URL || "";
const envProjectDir = process.env.CLAUDE_PROJECT_DIR || "";
// Per-PTY ownership token, injected by strIDEterm into the terminal it spawned.
// A hook process that inherited the terminal's environment can echo it back and
// thereby PROVE which panel it belongs to; one that cannot is routed by project
// directory alone and is never allowed to auto-approve anything.
const ownershipToken = process.env.STRIDETERM_SESSION_TOKEN || "";

// Path normalization. Must match runtime.ts#normalizeCwd exactly. Case is
// folded only on case-insensitive filesystems: on Linux /work/Repo and
// /work/repo are two different directories, and merging them would route a
// hook into a workspace it does not belong to.
const CASE_INSENSITIVE_FS = process.platform === "win32" || process.platform === "darwin";
const norm = (p) => {
  const slashed = String(p || "").replace(/\\\\/g, "/").replace(/\\/+$/, "");
  return CASE_INSENSITIVE_FS ? slashed.toLowerCase() : slashed;
};

function readRegistry(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/** An entry is a bare URL string (older writers) or { url, instanceId, sid }. */
function entryUrl(item) {
  return typeof item === "string" ? item : item && typeof item.url === "string" ? item.url : "";
}

let anyRegistryRead = false;

function resolveUrls(projectDir) {
  if (!projectDir) return [];
  // Only the URL matters here — the instance id is what lets the WRITER
  // replace its own entry without evicting another instance that happens to
  // have restored the same workspace/panel ids.
  const routable = [];
  const dead = Object.create(null);
  // Workspace keys an expired shard claimed. Their URLs are refused, but the
  // KEY still has to exist — see where the empty buckets are materialised.
  const expiredKeys = Object.create(null);
  let liveShards = 0;
  for (const source of registryFiles()) {
    const parsed = readRegistry(source.file);
    if (!parsed) continue;
    // Readability and freshness are separate questions: a shard we could read
    // but must not route to still proves the registry itself is there, which
    // is what keeps the "cannot read any registry" error honest.
    anyRegistryRead = true;
    // A shard is { updatedAt, urls }; the legacy mirrors are the bare map.
    const leased = parsed.urls && typeof parsed.urls === "object" && !Array.isArray(parsed.urls);
    const data = leased ? parsed.urls : parsed;
    if (source.leased && shardAgeMs(source.file, leased ? parsed.updatedAt : 0) > SHARD_LEASE_TTL_MS) {
      log("DEBUG", "ignoring expired registry shard " + path.basename(source.file));
      // A TOMBSTONE, not merely a skip. Both legacy mirrors are bare maps with
      // no lease of their own, and one written while this installation was
      // still alive names the very same URL — refusing the shard and then
      // merging a mirror would publish the dead port straight back.
      for (const key of Object.keys(data)) {
        if (!Array.isArray(data[key])) continue;
        expiredKeys[key] = true;
        for (const item of data[key]) {
          const url = entryUrl(item);
          if (url) dead[url] = true;
        }
      }
      continue;
    }
    if (source.leased) liveShards += 1;
    routable.push({ leased: source.leased, data });
  }
  const merged = {};
  for (const source of routable) {
    // The legacy mirrors are a FALLBACK, not a peer. They carry no lease, so
    // an abandoned installation's mirror outlives its shard — including past
    // the sweep that DELETES the shard, after which nothing is left to
    // recognise its URLs by. A shard registry that answered at all is
    // authoritative; the mirrors are for a machine that has none.
    if (!source.leased && liveShards > 0) continue;
    for (const key of Object.keys(source.data)) {
      const list = source.data[key];
      if (!Array.isArray(list)) continue;
      // The bucket is created even when every URL in it turns out to be
      // tombstoned: the key still belongs to this workspace, and an absent one
      // falls through to the longest-PREFIX match, which would route the hook
      // to a parent workspace's panel.
      if (!merged[key]) merged[key] = [];
      for (const item of list) {
        const url = entryUrl(item);
        if (!url || dead[url]) continue;
        if (merged[key].indexOf(url) === -1) merged[key].push(url);
      }
    }
  }
  // An expired shard's workspace keys, as EMPTY buckets. Refusing its URLs is
  // only half the answer: with no key at all, a hook run in an expired CHILD
  // workspace (C:/repo/sub) falls through to the longest-PREFIX match and is
  // delivered to a live PARENT workspace's panel (C:/repo) — a different panel
  // in a different workspace, which never made the tool call. The expired
  // shard is not in routable, so its keys cannot come from the merge above,
  // and a mirror's tombstoned copy cannot supply them either: the mirrors are
  // skipped entirely while any leased shard answers. Written only where
  // nothing live claims the key, so dev and prod sharing one workspace path
  // keep their live routing.
  for (const key of Object.keys(expiredKeys)) {
    if (!merged[key]) merged[key] = [];
  }
  if (!anyRegistryRead) return [];
  const needle = norm(projectDir);
  if (Array.isArray(merged[needle])) return merged[needle];
  // Longest-prefix match so claude invoked in a subdirectory still routes
  // to its owning strideterm workspace. External agents running outside
  // any registered workspace will never match and exit silently — that
  // is intentional so their notifications don't leak into strideterm.
  let bestKey = "";
  for (const key of Object.keys(merged)) {
    if ((needle === key || needle.startsWith(key + "/")) && key.length > bestKey.length) {
      bestKey = key;
    }
  }
  return bestKey ? (merged[bestKey] || []) : [];
}

// A PermissionRequest's tool_input carries whatever the tool was called with —
// for Write and Edit that is the entire file content, which routinely runs to
// hundreds of kilobytes. None of it is needed: strIDEterm decides from the tool
// NAME and summarizes from one short argument. Trim before sending so a large
// edit gets a decision instead of a 413 and an unexplained prompt.
const PERMISSION_FIELD_MAX = 2000;
const PERMISSION_INPUT_MAX = 8000;
function compactToolInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const out = {};
  let budget = PERMISSION_INPUT_MAX;
  for (const key of Object.keys(input)) {
    if (budget <= 0) {
      out.__truncated = true;
      break;
    }
    const value = input[key];
    if (value === null || typeof value === "number" || typeof value === "boolean") {
      out[key] = value;
      budget -= 8;
      continue;
    }
    let text;
    if (typeof value === "string") {
      text = value;
    } else {
      try { text = JSON.stringify(value); } catch { text = ""; }
      text = String(text || "");
    }
    const clipped = text.length > PERMISSION_FIELD_MAX ? text.slice(0, PERMISSION_FIELD_MAX) + "…" : text;
    out[key] = clipped;
    budget -= clipped.length;
  }
  return out;
}

let body = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { body += chunk; });
process.stdin.on("end", () => {
  let parsed;
  try {
    parsed = body.trim() ? JSON.parse(body) : {};
  } catch {
    parsed = { raw_body: body };
  }
  parsed.hook = hookNameArg || parsed.hook_event_name || parsed.hook || "Notification";

  // Resolve notify URLs. Two sources, tried in order rather than merged:
  //   1. STRIDETERM_NOTIFY_URL — inherited from the PTY strIDEterm spawned.
  //      It names THIS panel and nothing else, which is why it is preferred:
  //      the registry is keyed by project directory, so falling straight to it
  //      would deliver a panel's events to every other panel sharing the cwd.
  //   2. the registry, keyed by CLAUDE_PROJECT_DIR (Claude Code) or
  //      payload.cwd (Codex).
  // The env URL is not authoritative, though. It is frozen at the moment the
  // terminal was created, so a notify server that later stopped and restarted
  // on a different port — the agent-hook checkbox switched off and back on —
  // leaves every running shell pointing at a dead port, and the registry is
  // the only place the live one is written down. So: use it, and when nothing
  // could be DELIVERED over it (refused, timed out, or answered 403 because
  // another instance now owns that port) fall back to the registry instead of
  // dropping the event.
  // If neither source yields anything, exit silently: this hook is firing from
  // an agent run the user started outside any strideterm PTY (e.g. "claude" in
  // another terminal) and we must not leak its notifications into strideterm.
  const payloadCwd = typeof parsed.cwd === "string" ? parsed.cwd : "";
  const projectDir = envProjectDir || payloadCwd;
  const envUrls = envUrl ? [envUrl] : [];
  const registryUrls = resolveUrls(projectDir).filter((u) => u !== envUrl);

  if (envUrls.length === 0 && registryUrls.length === 0) {
    if (projectDir && !anyRegistryRead) {
      log("ERROR", "cannot read any registry under " + SHARED_DIR + " or " + LOCAL_URLS_PATH);
    }
    log("DEBUG", "no match for projectDir=" + (projectDir || "<unset>") + " (hook=" + parsed.hook + ") — skipping");
    process.exit(0);
  }
  const primaryUrls = envUrls.length ? envUrls : registryUrls;
  const fallbackUrls = envUrls.length ? registryUrls : [];

  // PermissionRequest is the one hook whose RESPONSE matters: Claude Code reads
  // our stdout to decide whether to show the permission dialog. Every other
  // hook keeps discarding the body.
  const wantsDecision = parsed.hook === "PermissionRequest";
  if (wantsDecision) {
    parsed.tool_input = compactToolInput(parsed.tool_input);
    parsed.strideterm_session_token = ownershipToken;
    // Identity of THIS delivery — one hook process, one offer, one commit.
    // Minted here so both legs of the handshake carry the same value and the
    // instance that offered can recognise the commit as its own.
    //
    // Deliberately NOT derived from the payload. session_id + prompt_id looks
    // like a permission-request identity and is not one: prompt_id names the
    // USER PROMPT being processed, so every tool of one turn — Bash, then
    // Write, then AskUserQuestion — shares it. Keyed on that, the second
    // request replayed the first one's stored allow, which handed a blanket
    // approval to tools the never-list exists to stop. Nothing in the
    // PermissionRequest input identifies the request itself (there is no
    // tool_use_id), so there is nothing to correlate two separate hook runs
    // on — and the PermissionRequest legs do not retry, so nothing needs it.
    parsed.strideterm_delivery_id = crypto.randomUUID();
  }

  // One retry after a short delay: a transient failure (strideterm
  // restarting, notify server rebinding) would otherwise lose the event
  // forever. Per-request timeout is 2s so the worst case (2s + 0.5s + 2s)
  // stays inside Claude Code's 5s hook timeout.
  //
  // The PermissionRequest legs pass allowRetry=false. They need two round
  // trips inside the same 5s budget, and a retried offer is worse than a
  // missed one anyway: losing it just shows the prompt, which is the correct
  // fallback, while a duplicate could be counted as a second instance.
  function postJson(u, bodyObj, timeoutMs, allowRetry, callback) {
    let p;
    try { p = new URL(u); } catch { log("ERROR", "invalid url: " + u); callback(new Error("invalid url"), null, false); return; }
    const outgoing = JSON.stringify(bodyObj);
    const options = {
      hostname: p.hostname,
      port: p.port,
      path: p.pathname + p.search,
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(outgoing) },
      timeout: timeoutMs,
    };
    let settled = false;
    const fail = (msg) => {
      if (settled) return;
      settled = true;
      if (allowRetry) {
        log("WARN", msg + " — retrying (hook=" + parsed.hook + ")");
        setTimeout(() => postJson(u, bodyObj, timeoutMs, false, callback), 500);
      } else {
        log("ERROR", msg + " (hook=" + parsed.hook + ")");
        callback(new Error(msg), null, false);
      }
    };
    const req = http.request(options, (res) => {
      if (settled) return;
      settled = true;
      if (res.statusCode !== 200 && res.statusCode !== 403) {
        log("WARN", "POST " + p.port + " -> " + res.statusCode + " (hook=" + parsed.hook + ")");
      }
      // Anything but 200 is NOT a delivery. A 403 in particular means the port
      // is answering but the instance behind it is not ours — a recycled port
      // after a restart — which is exactly when the registry has to be tried.
      if (res.statusCode !== 200) { res.resume(); callback(null, null, false); return; }
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { raw += chunk; });
      res.on("end", () => {
        let answer = null;
        try {
          answer = JSON.parse(raw || "{}");
        } catch {
          log("WARN", "unparseable response from port " + p.port + " (hook=" + parsed.hook + ")");
        }
        callback(null, answer, true);
      });
      res.on("error", () => callback(null, null, false));
    });
    req.on("error", (e) => fail("POST failed: " + e.message));
    req.on("timeout", () => { req.destroy(); fail("POST timeout " + timeoutMs + "ms"); });
    req.end(outgoing);
  }

  // Deliver to every URL of one round and report whether ANY of them took it.
  // An empty round answers immediately: this process must always reach its own
  // exit, and a callback that never fires would leave Claude waiting out the
  // full hook timeout for nothing.
  function fanOut(urls, done) {
    if (urls.length === 0) { done(false); return; }
    let pending = urls.length;
    let anyDelivered = false;
    for (const u of urls) {
      postJson(u, parsed, 2000, true, (err, answer, delivered) => {
        if (delivered) anyDelivered = true;
        if (--pending <= 0) done(anyDelivered);
      });
    }
  }

  if (!wantsDecision) {
    fanOut(primaryUrls, (delivered) => {
      if (delivered || fallbackUrls.length === 0) { process.exit(0); return; }
      log("WARN", "env notify URL unreachable — retrying via the registry (hook=" + parsed.hook + ")");
      fanOut(fallbackUrls, () => process.exit(0));
    });
    return;
  }

  // Two-phase handshake. Phase 1 asks every reachable instance whether it
  // WOULD answer; nothing is recorded yet. Only when exactly one offered is
  // phase 2 sent, and only that commit writes the audit row, raises the
  // Notification Center entry and returns the decision we print.
  //
  // Two instances over the same repo (dev alongside prod) both receive the
  // hook, and there is no way to tell whose "allow" the user meant — so when
  // it is not clear, don't approve: staying silent shows the prompt, which is
  // the same outcome as having no hook at all.
  const OFFER_TIMEOUT_MS = 1500;
  const COMMIT_TIMEOUT_MS = 1500;
  const offerBody = Object.assign({}, parsed, { phase: "offer" });
  const offers = [];

  function offerRound(urls, done) {
    if (urls.length === 0) { done(false); return; }
    let pending = urls.length;
    let anyDelivered = false;
    for (const u of urls) {
      postJson(u, offerBody, OFFER_TIMEOUT_MS, false, (err, answer, delivered) => {
        if (delivered) anyDelivered = true;
        const requestId = !err && answer && answer.offer && typeof answer.offer.requestId === "string" ? answer.offer.requestId : "";
        if (requestId) offers.push({ url: u, requestId });
        if (--pending <= 0) done(anyDelivered);
      });
    }
  }

  function commitChosen() {
    if (offers.length === 0) { process.exit(0); return; }
    if (offers.length > 1) {
      log("WARN", "conflict: " + offers.length + " instances offered to answer PermissionRequest - leaving the prompt to the user");
      process.exit(0);
      return;
    }
    const chosen = offers[0];
    const commitBody = Object.assign({}, parsed, { phase: "commit", request_id: chosen.requestId });
    postJson(chosen.url, commitBody, COMMIT_TIMEOUT_MS, false, (err, answer) => {
      const hookOutput = !err && answer && answer.hookOutput ? answer.hookOutput : null;
      if (!hookOutput) { process.exit(0); return; }
      // Claude Code reads this document verbatim; the instance that committed
      // is the one that shaped it, wrapper included. Flush before exiting:
      // stdout to a pipe is asynchronous on POSIX, and a bare process.exit()
      // here would truncate the decision.
      process.stdout.write(JSON.stringify(hookOutput), () => process.exit(0));
    });
  }

  offerRound(primaryUrls, (delivered) => {
    // The two offer legs plus a commit stay inside Claude's 5s hook timeout,
    // and the case that triggers a second leg is a refused connection, which
    // fails at once rather than burning the timeout.
    if (delivered || fallbackUrls.length === 0) { commitChosen(); return; }
    log("WARN", "env notify URL unreachable — retrying the offer via the registry");
    offerRound(fallbackUrls, () => commitChosen());
  });
});
process.stdin.resume();
`;

function getClaudeSettingsPath(): string {
  return path.join(os.homedir(), ".claude", "settings.json");
}

// PreToolUse fires on EVERY tool call, so it must be matcher-scoped to the
// subagent-launching tool — otherwise every Read/Edit/Bash would spawn notify.mjs
// and POST. The tool is "Agent" in current Claude Code and "Task" in older
// builds; "Agent|Task" is an exact-match list (Claude treats a matcher of only
// [A-Za-z0-9_|-] as exact strings, not a regex). Every other hook keeps the
// shared empty-matcher entry (fires unconditionally).
function buildClaudeHookEntry(notifyScriptPath: string, canonicalName: string) {
  const entry = buildNestedCommandEntry(notifyScriptPath, canonicalName) as { matcher: string; hooks: unknown[] };
  if (canonicalName === "PreToolUse") entry.matcher = "Agent|Task";
  return entry;
}

/**
 * Ensures the notify.mjs hook script exists at ~/.strideterm/hooks/notify.mjs.
 * Overwrites on every startup to keep it up to date.
 */
export async function ensureNotifyScript(userDataPath: string): Promise<{ ok: boolean; path: string; error?: string }> {
  const scriptPath = getNotifyScriptPath(userDataPath);
  const dir = path.dirname(scriptPath);
  try {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    await fs.writeFile(scriptPath, NOTIFY_SCRIPT_CONTENT, "utf8");
    return { ok: true, path: scriptPath };
  } catch (error) {
    return { ok: false, path: scriptPath, error: (error as NodeJS.ErrnoException).message };
  }
}

/**
 * Checks if a strIDEterm hook is already configured in a given hook category.
 * Returns the index in settings.hooks[hookName], or -1 if not found.
 *
 * Default hookName is "Notification" for backward compatibility with earlier
 * callers/tests that assumed only Notification was registered.
 */
export function findExistingHook(settings: Record<string, unknown>, hookName = "Notification"): number {
  return findHookIndex(settings, hookName, HOOK_MARKERS, matchesNestedCommandEntry);
}

/**
 * Configure the Claude Code notification hooks.
 *
 * Registers four hook types (HOOKS_TO_REGISTER) pointing at the same
 * notify.mjs script, each invoked with its hook name as argv[2].
 *
 * - Creates ~/.claude/settings.json if it doesn't exist
 * - Merges with existing hooks (never overwrites unrelated config)
 * - Updates existing strIDEterm hook entries if found (no duplication)
 *
 * Returns { ok, error?, detail?, scriptPath?, settingsPath?, registered?: string[] }
 */
export async function configureClaudeHook(userDataPath: string): Promise<{
  ok: boolean;
  error?: string;
  detail?: string;
  scriptPath?: string;
  settingsPath?: string;
  registered?: string[];
}> {
  const scriptResult = await ensureNotifyScript(userDataPath);
  if (!scriptResult.ok) {
    return {
      ok: false,
      error: `Failed to write hook script: ${scriptResult.error}`,
      detail: "script-write-failed",
    };
  }

  const settingsPath = getClaudeSettingsPath();
  const result = await configureHookEntries(settingsPath, CLAUDE_EVENT_MAP, scriptResult.path, {
    hookMarkers: HOOK_MARKERS,
    buildEntry: buildClaudeHookEntry,
    matchesEntry: matchesNestedCommandEntry,
    readFailedDetail: "settings-read-failed",
    writeFailedDetail: "settings-write-failed",
  });
  if (!result.ok) return result;

  log.info("claude hooks configured", {
    scriptPath: scriptResult.path,
    settingsPath,
    registered: result.registered,
  });
  return {
    ok: true,
    scriptPath: scriptResult.path,
    settingsPath,
    registered: result.registered,
  };
}

/**
 * Remove all strIDEterm hooks from Claude Code settings.
 * Leaves all other hooks and settings intact.
 *
 * Returns { ok, error?, removed?: boolean, removedFrom?: string[] }
 */
export async function removeClaudeHook() {
  const settingsPath = getClaudeSettingsPath();
  const result = await removeHookEntries(settingsPath, HOOKS_TO_REGISTER, {
    hookMarkers: HOOK_MARKERS,
    matchesEntry: matchesNestedCommandEntry,
  });

  if (!result.ok) {
    log.warn("removeClaudeHook: failed", { settingsPath, err: result.error });
  } else if (result.removed) {
    log.info("claude hooks removed", { settingsPath, removedFrom: result.removedFrom });
  } else {
    log.debug("removeClaudeHook: no strIDEterm hooks found or settings missing");
  }
  return result;
}

/**
 * Detect current hook configuration status.
 *
 * Returns { status, scriptPath?, settingsPath?, error?, missingHooks?: string[] }
 * - status: "configured" | "not-configured" | "error" | "script-missing" | "partial"
 * - "partial" means some hooks are registered but not all (upgrade available).
 */
export async function detectClaudeHookStatus(userDataPath: string) {
  const settingsPath = getClaudeSettingsPath();
  const scriptPath = getNotifyScriptPath(userDataPath);
  const result = await detectHookEntriesStatus(settingsPath, scriptPath, CLAUDE_EVENT_MAP, {
    hookMarkers: HOOK_MARKERS,
    matchesEntry: matchesNestedCommandEntry,
  });
  return { ...result, settingsPath, scriptPath };
}

// For testing
export { getClaudeSettingsPath, getNotifyScriptPath, NOTIFY_SCRIPT_CONTENT, HOOK_MARKERS };
