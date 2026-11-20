import { createHash } from "node:crypto";

/**
 * The sandbox launcher: a small Node script that runs on the machine where the sandbox runtime lives
 * (the host on Linux and macOS, the WSL distro on Windows) as the PTY's process. It is NOT sandboxed
 * itself: it reads the per-launch config strIDEterm wrote, prepares folders and tool config files,
 * starts the sandbox runtime as a library, answers "may the sandbox reach X?" through the runtime's
 * ask callback, and runs the tab's shell or agent inside the sandbox with the terminal attached.
 *
 * It is written to `<data dir>/sandbox/launcher-<hash>.mjs` by `writeLauncher`. It never reads the
 * sandbox settings from the workspace tree: the only input is the file named on its command line.
 *
 * Denials: when the sandbox proxy meets a destination no rule decides, the launcher appends one JSON
 * line to `denialsFile` and waits for `<decisionsDir>/<id>.json` (`{"allow": true|false}`) for at most
 * `askTimeoutMs`. strIDEterm writes that file after asking the user; silence is a denial.
 */
export const SANDBOX_LAUNCHER_SOURCE = String.raw`import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

const EXIT_NOT_STARTED = 125;

function fail(message) {
  process.stderr.write("strIDEterm sandbox: " + message + "\r\n");
  process.exit(EXIT_NOT_STARTED);
}

const configPath = process.argv[2];
if (!configPath) fail("no launch config was given.");
let cfg;
try {
  cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
} catch (error) {
  fail("the launch config cannot be read: " + error.message);
}
// The command's environment comes from this snapshot: below, TMPDIR is pointed at srt's own work folder.
const inheritedEnv = { ...process.env };

function exists(candidate) {
  try {
    fs.accessSync(candidate);
    return true;
  } catch {
    return false;
  }
}

function quote(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

for (const dir of cfg.ensureDirs || []) {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (error) {
    fail("cannot create " + dir + ": " + error.message);
  }
}

// This script is not sandboxed, and an agent can plant links in every folder it may write. A config file is
// therefore only written below its trusted root, through components that are real directories (never links),
// and the file itself is created fresh (O_EXCL: it never follows a link that took the name).
function prepareConfined(file) {
  const root = path.resolve(file.root);
  const target = path.resolve(file.path);
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("is outside " + root);
  }
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  let current = root;
  if (fs.lstatSync(current).isSymbolicLink()) throw new Error(root + " is a link");
  const parts = relative.split(path.sep);
  for (const part of parts.slice(0, -1)) {
    current = path.join(current, part);
    let stat = null;
    try {
      stat = fs.lstatSync(current);
    } catch {}
    if (!stat) fs.mkdirSync(current, { mode: 0o700 });
    else if (!stat.isDirectory()) throw new Error(current + " is not a plain folder");
  }
  return target;
}

function writeConfined(file) {
  const target = prepareConfined(file);
  try {
    fs.unlinkSync(target);
  } catch {}
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0);
  const fd = fs.openSync(target, flags, file.executable ? 0o700 : 0o600);
  try {
    fs.writeSync(fd, file.content);
  } finally {
    fs.closeSync(fd);
  }
}

const PORT_PLACEHOLDER = "@@STRIDETERM_SANDBOX_PROXY_PORT@@";
const writtenFiles = [];
for (const file of cfg.toolFiles || []) {
  try {
    writeConfined(file);
    if (file.removeOnExit) writtenFiles.push(file.path);
  } catch (error) {
    fail("cannot write " + file.path + ": " + error.message);
  }
}

// A link from a folder the launch owns to somewhere that exists (a per-workspace Gradle home sharing the artifact
// cache; the sandbox's own home pointing at the agent folders). The first of the targets that exists is used, and nothing
// is linked when none does. Created below its trusted root only, through real folders, and never over an entry.
for (const item of cfg.confinedLinks || []) {
  try {
    const target = (item.targets || [item.target]).find((candidate) => candidate && exists(candidate));
    if (!target) continue;
    const link = prepareConfined({ root: item.root, path: item.link });
    let stale = false;
    let present = true;
    try {
      // A link this launcher made earlier may point at a folder that is gone or has moved; a folder is never touched.
      stale = fs.lstatSync(link).isSymbolicLink() && fs.readlinkSync(link) !== target;
    } catch {
      present = false;
    }
    if (stale) fs.unlinkSync(link);
    if (!present || stale) fs.symlinkSync(target, link);
  } catch (error) {
    fail("cannot link " + item.link + ": " + error.message);
  }
}

// A folder of the agent that holds a credential-bearing config file (an MCP server's env, a hook) is not linked or
// granted whole. The sandbox's copy is a real folder with a link to every entry of the host's folder except the
// files that are replaced by a sanitized copy (below), and only those entries are granted. A link inside the host's
// folder, or an entry the sandbox made itself, is never followed or shared.
const mirrorGrants = [];
for (const item of cfg.confinedMirrors || []) {
  try {
    const source = (item.sources || []).find((candidate) => {
      try {
        return fs.statSync(candidate).isDirectory();
      } catch {
        return false;
      }
    });
    if (!source) continue;
    const dir = prepareConfined({ root: item.root, path: item.dir });
    let stat = null;
    try {
      stat = fs.lstatSync(dir);
    } catch {}
    if (stat && stat.isSymbolicLink()) {
      fs.unlinkSync(dir);
      stat = null;
    }
    if (!stat) fs.mkdirSync(dir, { mode: 0o700 });
    else if (!stat.isDirectory()) throw new Error(dir + " is not a plain folder");
    // A linked SQLite DB resolves WAL/SHM beside the host DB, outside the grant.
    // Leave these databases sandbox-owned; migrate only old links, never host or local data.
    const localSqlite = (name) => item.localSqlite && /\.sqlite(?:-(?:wal|shm|journal))?$/.test(name);
    for (const name of fs.readdirSync(dir)) {
      if (!localSqlite(name)) continue;
      const entry = path.join(dir, name);
      if (fs.lstatSync(entry).isSymbolicLink()) fs.unlinkSync(entry);
    }
    for (const name of fs.readdirSync(source)) {
      if ((item.exclude || []).includes(name)) continue;
      if (localSqlite(name)) continue;
      const real = path.join(source, name);
      if (fs.lstatSync(real).isSymbolicLink()) continue;
      const link = path.join(dir, name);
      let existing = null;
      try {
        existing = fs.lstatSync(link);
      } catch {}
      if (existing && !existing.isSymbolicLink()) continue;
      if (existing && fs.readlinkSync(link) !== real) {
        fs.unlinkSync(link);
        existing = null;
      }
      if (!existing) fs.symlinkSync(real, link);
      mirrorGrants.push(fs.realpathSync(real));
    }
  } catch (error) {
    fail("cannot mirror " + item.dir + ": " + error.message);
  }
}

// Configuration that can carry credentials of tools other than the model (MCP servers' env and headers, hooks, helper
// commands) is not copied: the sandbox gets the agent's state and sign-in, not what the host's other tools authenticate with.
const SEED_DROP_KEYS = new Set([
  "mcpServers",
  "mcpContextUris",
  "mcp",
  "mcp_servers",
  "servers",
  "env",
  "environment",
  "headers",
  "hooks",
  "apiKeyHelper",
  "awsAuthRefresh",
  "gcpAuthRefresh",
  "otelHeadersHelper",
  "githubRepoPaths",
]);
const SEED_SECRET_NAME = /token|secret|password|passwd|credential|authorization|api[_-]?key|private[_-]?key|cookie/i;
const SEED_MODEL_LOGIN_KEYS = new Set(["primaryApiKey", "oauthAccount", "customApiKeyResponses"]);
function filterSeed(value, top, keepEnv) {
  if (Array.isArray(value)) return value.map((item) => filterSeed(item, false, keepEnv));
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, inner] of Object.entries(value)) {
      if (key === "env" && keepEnv && inner && typeof inner === "object" && !Array.isArray(inner)) {
        // The agent's own sign-in to its model may be set here; nothing else is.
        const kept = {};
        for (const name of keepEnv) {
          if (Object.prototype.hasOwnProperty.call(inner, name) && typeof inner[name] === "string") kept[name] = inner[name];
        }
        out[key] = kept;
        continue;
      }
      if (SEED_DROP_KEYS.has(key)) continue;
      if (SEED_SECRET_NAME.test(key) && !(top && SEED_MODEL_LOGIN_KEYS.has(key))) continue;
      out[key] = filterSeed(inner, false, keepEnv);
    }
    return out;
  }
  return value;
}

function filterCopilotConfig(parsed) {
  const sanitized = filterSeed(parsed, false, []);
  for (const key of ["copilotTokens", "copilot_tokens"]) {
    const tokens = parsed[key];
    if (tokens && typeof tokens === "object" && !Array.isArray(tokens)) {
      const modelTokens = Object.fromEntries(Object.entries(tokens).filter(([, value]) => typeof value === "string"));
      if (Object.keys(modelTokens).length) sanitized[key] = modelTokens;
    }
  }
  const hooks = filterTrustedHooks(parsed.hooks);
  if (hooks) sanitized.hooks = hooks;
  return sanitized;
}

// strIDEterm's own notification hooks (node ".../hooks/notify.mjs" Event) are the one kind of hook that is kept in a
// sanitized settings file: the agent still has to tell strIDEterm when it stops or asks. Anything else a hook runs is
// dropped, and so is a hook command with more in it than the script and the event name.
const TRUSTED_HOOK_COMMAND = /^node "([^"\x60$;&|<>\n\r]*\/hooks\/notify\.mjs)" ([A-Za-z]+)$/;
function isTrustedHookCommand(value) {
  return typeof value === "string" && TRUSTED_HOOK_COMMAND.test(value.replace(/\\/g, "/"));
}
function currentHookCommand(value) {
  const match = TRUSTED_HOOK_COMMAND.exec(value.replace(/\\/g, "/"));
  if (!match || !cfg.notifyScript) return value;
  const current = 'node "' + cfg.notifyScript + '" ' + match[2];
  if (!isTrustedHookCommand(current)) throw new Error("invalid notification script path");
  return current;
}
function filterTrustedHooks(hooks) {
  if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) return null;
  const out = {};
  for (const [event, entries] of Object.entries(hooks)) {
    if (!Array.isArray(entries)) continue;
    const kept = [];
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue;
      if (Array.isArray(entry.hooks)) {
        const inner = entry.hooks.filter(
          (hook) => hook && typeof hook === "object" && hook.type === "command" && isTrustedHookCommand(hook.command),
        );
        if (inner.length) kept.push({ matcher: typeof entry.matcher === "string" ? entry.matcher : "", hooks: inner.map(pickHook) });
      } else if (entry.type === "command") {
        const trusted = pickHook(entry);
        if (trusted.command || trusted.bash || trusted.powershell) kept.push(trusted);
      }
    }
    if (kept.length) out[event] = kept;
  }
  return Object.keys(out).length ? out : null;
}
function pickHook(hook) {
  const out = {};
  for (const key of ["type", "command", "bash", "powershell", "timeout", "timeoutSec", "name"]) {
    if (hook[key] === undefined) continue;
    if (["command", "bash", "powershell"].includes(key) && !isTrustedHookCommand(hook[key])) continue;
    if (typeof hook[key] === "string" || typeof hook[key] === "number")
      out[key] = ["command", "bash", "powershell"].includes(key) ? currentHookCommand(hook[key]) : hook[key];
  }
  return out;
}

// JSON with comments and trailing commas (OpenCode's opencode.jsonc); null when it cannot be read at all.
function parseLooseJson(text) {
  try {
    return JSON.parse(text);
  } catch {}
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      out += c;
      if (c === "\\") out += text[++i] || "";
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
    } else out += c;
  }
  try {
    return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
  } catch {
    return null;
  }
}

// TOML (Codex's config.toml): MCP server tables, hooks, env / header tables and any key that looks like a secret go.
const TOML_DROP_TABLE = /^(mcp_servers|hooks)(\.|$)|(^|\.)(env|headers|http_headers|env_http_headers)$|^shell_environment_policy\.set$/;
const TOML_DROP_KEY_SEGMENT = new Set(["env", "headers", "http_headers", "env_http_headers"]);
const TOML_INLINE_SECRET = /[{,]\s*["']?[\w-]*(?:token|secret|password|passwd|credential|authorization|api[_-]?key|private[_-]?key|cookie)[\w-]*["']?\s*=/i;
function tomlScan(line, state) {
  let i = 0;
  while (i < line.length) {
    const c = line[i];
    if (state.q) {
      if (state.q.length === 3) {
        if (line.startsWith(state.q, i)) {
          state.q = "";
          i += 3;
        } else i++;
      } else if (c === "\\" && state.q === '"') i += 2;
      else {
        if (c === state.q) state.q = "";
        i++;
      }
      continue;
    }
    if (line.startsWith('"""', i) || line.startsWith("'''", i)) {
      state.q = line.slice(i, i + 3);
      i += 3;
    } else if (c === '"' || c === "'") {
      state.q = c;
      i++;
    } else if (c === "#") break;
    else {
      if (c === "[" || c === "{") state.depth++;
      else if (c === "]" || c === "}") state.depth--;
      i++;
    }
  }
  if (state.q.length === 1) state.q = "";
}
function tomlDropKey(keyText) {
  const segments = keyText.replace(/["']/g, "").split(".");
  return (
    segments[0] === "mcp_servers" ||
    segments[0] === "hooks" ||
    segments.some((segment) => TOML_DROP_KEY_SEGMENT.has(segment)) ||
    SEED_SECRET_NAME.test(keyText)
  );
}
function filterToml(text) {
  const out = [];
  const state = { depth: 0, q: "" };
  let skipTable = false;
  let skipping = false;
  for (const line of text.split(/\r?\n/)) {
    if (skipping) {
      tomlScan(line, state);
      if (state.depth <= 0 && !state.q) skipping = false;
      continue;
    }
    const atTop = state.depth === 0 && !state.q;
    if (atTop) {
      const header = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(?:#.*)?$/.exec(line);
      if (header) {
        skipTable = TOML_DROP_TABLE.test(header[1].replace(/["']/g, ""));
        if (!skipTable) out.push(line);
        continue;
      }
      const key = /^\s*("[^"]*"|'[^']*'|[A-Za-z0-9_.-]+)\s*=/.exec(line);
      if (skipTable || (key && (tomlDropKey(key[1]) || TOML_INLINE_SECRET.test(line)))) {
        tomlScan(key ? line.slice(key[0].length) : line, state);
        if (state.depth > 0 || state.q) skipping = true;
        continue;
      }
    }
    tomlScan(line, state);
    out.push(line);
  }
  return out.join("\n");
}

// KEY=VALUE files (Gemini's .env): only the names the agent's own sign-in uses.
function filterEnvFile(text, keepEnv) {
  const keep = new Set(keepEnv || []);
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (match && keep.has(match[1])) out.push(line);
  }
  return out.join("\n");
}

// Claude keeps its model sign-in (claudeAiOauth) and the OAuth sign-ins of MCP servers (mcpOAuth) in one file. The
// sandbox gets a copy with the model login only. Claude rotates the refresh token when it renews the login, and a host
// whose token was rotated inside the copy is signed out, so a newer login is carried back when the command ends: only
// that one object, only over an existing login of the host, only when it expires later, written through a temp file.
const credentialWriteBacks = [];
function isOauthLogin(value) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof value.accessToken === "string" &&
    typeof value.refreshToken === "string" &&
    Number.isFinite(value.expiresAt)
  );
}
function plainLogin(value) {
  const out = {};
  for (const [key, inner] of Object.entries(value)) {
    if (typeof inner === "string" || typeof inner === "number" || typeof inner === "boolean" || inner === null) out[key] = inner;
    else if (Array.isArray(inner) && inner.every((item) => typeof item === "string")) out[key] = inner;
  }
  return out;
}
function writeBackCredentials() {
  for (const item of credentialWriteBacks) {
    try {
      const stat = fs.lstatSync(item.copy);
      if (!stat.isFile()) continue;
      const mine = JSON.parse(fs.readFileSync(item.copy, "utf8")).claudeAiOauth;
      if (!isOauthLogin(mine)) continue;
      const host = fs.realpathSync(item.host);
      const hostDoc = JSON.parse(fs.readFileSync(host, "utf8"));
      if (!hostDoc || typeof hostDoc !== "object" || Array.isArray(hostDoc)) continue;
      if (!isOauthLogin(hostDoc.claudeAiOauth) || hostDoc.claudeAiOauth.expiresAt >= mine.expiresAt) continue;
      const temp = host + ".strideterm-" + process.pid + ".tmp";
      const fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
      try {
        fs.writeSync(fd, JSON.stringify({ ...hostDoc, claudeAiOauth: plainLogin(mine) }));
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(temp, host);
    } catch {}
  }
}

// The sandbox's own copy of an agent state file (Claude's .claude.json): copied from the host's file once and then
// the sandbox's to change, so nothing it writes reaches the host's configuration. Never over an existing entry, so a
// link the agent planted under that name is not written through. The host's file is read, never opened for writing.
// A sanitized view of a config file (refresh) is written again on every launch: the host's file stays the source,
// and what the sandbox changed in its own copy is not kept.
for (const item of cfg.seededFiles || []) {
  try {
    const dest = prepareConfined({ root: item.root, path: item.dest });
    let present = true;
    try {
      fs.lstatSync(dest);
    } catch {
      present = false;
    }
    if (present && !item.refresh) continue;
    const source = (item.sources || []).find((candidate) => {
      try {
        return fs.statSync(candidate).isFile();
      } catch {
        return false;
      }
    });
    if (!source) {
      if (present) {
        try {
          fs.unlinkSync(dest);
        } catch {}
      }
      continue;
    }
    let content = fs.readFileSync(source);
    if (item.filter === "json" || item.filter === "copilot-config") {
      const parsed = parseLooseJson(content.toString("utf8"));
      const plain = parsed && typeof parsed === "object" && !Array.isArray(parsed);
      const sanitized = !plain ? {} : item.filter === "copilot-config" ? filterCopilotConfig(parsed) : filterSeed(parsed, false, item.keepEnv || []);
      const hooks = plain && item.filter === "json" ? filterTrustedHooks(parsed.hooks) : null;
      if (hooks) sanitized.hooks = hooks;
      content = JSON.stringify(sanitized, null, 2);
    } else if (item.filter === "toml") {
      content = filterToml(content.toString("utf8"));
    } else if (item.filter === "env") {
      content = filterEnvFile(content.toString("utf8"), item.keepEnv);
    }
    if (item.filter === "claude-credentials") {
      const parsed = parseLooseJson(content.toString("utf8"));
      const plain = parsed && typeof parsed === "object" && !Array.isArray(parsed);
      content = JSON.stringify(plain && isOauthLogin(parsed.claudeAiOauth) ? { claudeAiOauth: parsed.claudeAiOauth } : {}, null, 2);
      credentialWriteBacks.push({ copy: dest, host: source });
    }
    if (item.filter === "claude-state") {
      let parsed;
      try {
        parsed = JSON.parse(content.toString("utf8"));
      } catch {
        continue;
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      content = JSON.stringify(filterSeed(parsed, true, undefined), null, 2);
    }
    writeConfined({ root: item.root, path: item.dest, content });
  } catch (error) {
    fail("cannot prepare " + item.dest + ": " + error.message);
  }
}

// srt keeps the sockets that carry the sandbox's network (and a relay's gateway socket) in os.tmpdir(). That must be
// neither a folder the agent may write (it could delete the sockets) nor a long path (sun_path holds ~104 characters),
// so each launch gets a folder under a private root in /var/tmp, outside every write grant. The agent can see it but
// not change it. Hiding it is not possible: srt binds the socket before it covers the folder.
function makeWorkDir() {
  let base;
  try {
    base = fs.realpathSync(cfg.runtimeBase || "/var/tmp");
  } catch (error) {
    fail("cannot resolve " + (cfg.runtimeBase || "/var/tmp") + ": " + error.message);
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  const root = path.join(base, "strideterm-" + (uid === null ? "user" : uid));
  try {
    fs.mkdirSync(root, { mode: 0o700 });
  } catch (error) {
    if (error.code !== "EEXIST") fail("cannot create " + root + ": " + error.message);
  }
  let stat;
  try {
    stat = fs.lstatSync(root);
  } catch (error) {
    fail("cannot inspect " + root + ": " + error.message);
  }
  if (!stat.isDirectory()) fail(root + " is not a plain folder (a link or a file took its name).");
  if (uid !== null && stat.uid !== uid) fail(root + " belongs to another user.");
  try {
    fs.chmodSync(root, 0o700);
  } catch (error) {
    fail("cannot restrict " + root + ": " + error.message);
  }
  try {
    for (const name of fs.readdirSync(root)) {
      const match = /^srt-(\d+)-/.exec(name);
      if (!match || Number(match[1]) === process.pid) continue;
      try {
        process.kill(Number(match[1]), 0);
        continue;
      } catch (error) {
        if (error.code !== "ESRCH") continue;
      }
      fs.rmSync(path.join(root, name), { recursive: true, force: true });
    }
  } catch {}
  try {
    return fs.mkdtempSync(path.join(root, "srt-" + process.pid + "-"));
  } catch (error) {
    fail("cannot create a work folder in " + root + ": " + error.message);
  }
}
const workDir = makeWorkDir();
process.on("exit", () => {
  try {
    fs.rmSync(workDir, { recursive: true, force: true });
  } catch {}
});
process.env.TMPDIR = workDir;
process.env.TMP = workDir;
process.env.TEMP = workDir;

let relay = null;
let relaySocket = null;

function cleanup() {
  for (const file of writtenFiles) {
    try {
      fs.unlinkSync(file);
    } catch {}
  }
  if (relay) {
    try {
      relay.kill();
    } catch {}
  }
}

if (cfg.relay) {
  const route = cfg.runtime.network.mitmProxy;
  if (!route || route.socketPath) fail("the gateway relay needs a sandbox proxy route without a socket of its own.");
  relaySocket = path.join(workDir, "gateway.sock");
  route.socketPath = relaySocket;
  relay = spawn(
    "socat",
    ["UNIX-LISTEN:" + relaySocket + ",fork,mode=0600", "TCP:" + cfg.relay.tcpHost + ":" + cfg.relay.tcpPort],
    { stdio: "ignore" },
  );
  relay.on("error", (error) => fail("the gateway relay did not start: " + error.message));
  const deadline = Date.now() + 4000;
  while (!exists(relaySocket) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (!exists(relaySocket)) fail("the gateway relay did not come up.");
}

const optional = cfg.optional || {};
const filesystem = cfg.runtime.filesystem;
filesystem.allowRead = [...new Set([...filesystem.allowRead, ...mirrorGrants])];
filesystem.allowWrite = [...new Set([...filesystem.allowWrite, ...mirrorGrants])];
filesystem.allowRead = filesystem.allowRead.filter((item) => !(optional.allowRead || []).includes(item) || exists(item));
filesystem.allowWrite = filesystem.allowWrite.filter((item) => !(optional.allowWrite || []).includes(item) || exists(item));
// A protected path may be reached through a link (the Windows agent folder linked into the distro's home): the
// real location is what the sandbox has to protect, once.
const protectedPaths = new Set();
for (const item of optional.denyWrite || []) {
  if (exists(item)) {
    try {
      protectedPaths.add(fs.realpathSync(item));
    } catch {
      protectedPaths.add(item);
    }
  } else if (exists(path.dirname(item))) {
    // Not there yet: the agent must not be the one to create it (a config the host CLI loads later).
    try {
      protectedPaths.add(path.join(fs.realpathSync(path.dirname(item)), path.basename(item)));
    } catch {}
  }
}
filesystem.denyWrite = [...new Set([...filesystem.denyWrite, ...protectedPaths])];

let sandboxModule;
try {
  sandboxModule = await import(pathToFileURL(cfg.srtModule).href);
} catch (error) {
  fail("the sandbox runtime cannot be loaded from " + cfg.srtModule + ": " + error.message);
}
const SandboxManager = sandboxModule.SandboxManager;

const decided = new Map();
const pendingAsks = new Map();

function appendDenial(entry) {
  fs.appendFileSync(cfg.denialsFile, JSON.stringify(entry) + "\n");
}

async function waitForDecision(id) {
  const decisionFile = path.join(cfg.decisionsDir, id + ".json");
  const deadline = Date.now() + cfg.askTimeoutMs;
  while (Date.now() < deadline) {
    try {
      const parsed = JSON.parse(fs.readFileSync(decisionFile, "utf8"));
      return parsed && parsed.allow === true;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

function deny(reason) {
  return SandboxManager.askCallbackDenyReason ? { allow: false, reason } : false;
}

async function ask(request) {
  const key = request.host + ":" + (request.port || "");
  if (decided.has(key)) return decided.get(key) ? true : deny("denied for this session");
  if (!pendingAsks.has(key)) {
    const id = cfg.sessionId + "-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
    pendingAsks.set(
      key,
      (async () => {
        try {
          appendDenial({ id, host: request.host, port: request.port || null, at: Date.now() });
        } catch {
          return false;
        }
        const allowed = await waitForDecision(id);
        decided.set(key, allowed);
        return allowed;
      })(),
    );
  }
  const allowed = await pendingAsks.get(key);
  pendingAsks.delete(key);
  return allowed ? true : deny("strIDEterm did not allow " + request.host + " for this workspace");
}

try {
  await SandboxManager.initialize(cfg.runtime, ask);
} catch (error) {
  cleanup();
  fail("the sandbox could not start: " + (error && error.message ? error.message : String(error)));
}

if (!(cfg.command || []).length) {
  cleanup();
  fail("no command to run.");
}
// srt starts the sandbox with --new-session, so the command is not in the terminal's foreground group and the kernel
// never sends it SIGWINCH. A poller inside the sandbox watches the terminal size and signals the command's group.
// The terminal is kept on fd 3: a background list's stdin is /dev/null.
const RESIZE_RELAY =
  'exec 3<&0; p=$(stty size <&3 2>/dev/null); { while sleep 0.3; do n=$(stty size <&3 2>/dev/null) || exit 0; ' +
  'if [ "$n" != "$p" ]; then p=$n; kill -WINCH 0 2>/dev/null; fi; done; } & exec 3<&- "$@"';
const command = (
  process.stdin.isTTY ? ["sh", "-c", RESIZE_RELAY, "strideterm-resize", ...cfg.command] : cfg.command
)
  .map(quote)
  .join(" ");
let wrapped;
try {
  wrapped = await SandboxManager.wrapWithSandbox(command);
} catch (error) {
  cleanup();
  fail("the sandbox could not wrap the command: " + (error && error.message ? error.message : String(error)));
}

// srt hides a read-denied folder (the home, /home, /mnt) under an empty tmpfs and binds the allowed paths back into
// it. That tmpfs is writable, so a write anywhere else under it "succeeded" and vanished with the sandbox: an agent
// asked to save a file in the user's home reported it written while nothing reached the disk. Each cover is made
// read-only once every mount has landed (the remount is not recursive, so the paths bound inside keep their access),
// and such a write now fails as a read-only file system.
function readOnlyDenyCovers(text) {
  const start = text.indexOf("bwrap ");
  if (start < 0) return text;
  const end = text.indexOf(" -- ", start);
  if (end < 0) return text;
  const landings = [...text.slice(start, end).matchAll(/(?:^|\s)--tmpfs\s+('(?:[^']|'"'"')*'|[^\s'"]+)/g)].map(
    (match) => match[1],
  );
  if (!landings.length) return text;
  return text.slice(0, end) + landings.map((landing) => " --remount-ro " + landing).join("") + text.slice(end);
}
wrapped = readOnlyDenyCovers(wrapped);

// The launcher may itself have been started through a login shell (WSL), whose startup files can export
// host credentials. Only the names strIDEterm sanctioned for this launch, plus the basics a shell needs,
// pass into the sandbox; everything else the process inherited is dropped.
const baseline = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LANGUAGE", "TERM", "COLORTERM", "TMPDIR"];
const keep = new Set([...baseline, ...(cfg.keepEnv || [])]);
const env = {};
for (const [name, value] of Object.entries(inheritedEnv)) {
  if (keep.has(name) || name.startsWith("LC_")) env[name] = value;
}
env.STRIDETERM_SANDBOX = "1";
// The sandbox runtime cannot bind a link, so a home that has to point at folders elsewhere is a folder of links the
// launcher made above, and the agent is told to use it.
if (cfg.homeOverride) env.HOME = cfg.homeOverride;
if ((cfg.pathPrepend || []).length) env.PATH = [...cfg.pathPrepend, env.PATH].filter(Boolean).join(":");
if ((cfg.pathAppend || []).length) env.PATH = [env.PATH, ...cfg.pathAppend].filter(Boolean).join(":");
for (const name of cfg.unsetEnv || []) delete env[name];
const proxy = /HTTP_PROXY(?:=|\s+)['"]?https?:\/\/(?:([^:@'"\s]*):([^@'"\s]*)@)?([^:'"\s/]+):(\d+)/.exec(wrapped);
if (proxy) {
  env.STRIDETERM_SANDBOX_PROXY_USER = decodeURIComponent(proxy[1] || "");
  env.STRIDETERM_SANDBOX_PROXY_PASS = proxy[2] || "";
  env.STRIDETERM_SANDBOX_PROXY_HOST = proxy[3];
  env.STRIDETERM_SANDBOX_PROXY_PORT = proxy[4];
  // A tool file can name the proxy port only as a literal (Maven reads <port> as a number before it
  // interpolates), so the files that carry the placeholder are written once more now that the port is known.
  for (const file of cfg.toolFiles || []) {
    if (!file.content.includes(PORT_PLACEHOLDER)) continue;
    try {
      writeConfined({ ...file, content: file.content.split(PORT_PLACEHOLDER).join(proxy[4]) });
    } catch (error) {
      cleanup();
      fail("cannot write " + file.path + ": " + error.message);
    }
  }
}

const child = spawn(wrapped, { shell: true, stdio: "inherit", env });
child.on("error", (error) => {
  cleanup();
  fail("the command could not be started: " + error.message);
});
child.on("exit", (code, signal) => {
  try {
    SandboxManager.cleanupAfterCommand();
  } catch {}
  writeBackCredentials();
  cleanup();
  if (signal === "SIGINT" || signal === "SIGTERM") process.exit(0);
  process.exit(signal ? 1 : (code ?? 0));
});
process.on("SIGINT", () => child.kill("SIGINT"));
process.on("SIGTERM", () => child.kill("SIGTERM"));
process.on("SIGHUP", () => child.kill("SIGHUP"));
`;

export const SANDBOX_LAUNCHER_HASH = createHash("sha256").update(SANDBOX_LAUNCHER_SOURCE).digest("hex").slice(0, 12);
