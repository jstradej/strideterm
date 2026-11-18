import { generateKeyPairSync } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import ssh2 from "ssh2";
import type { Connection, ServerChannel } from "ssh2";
import { afterEach, expect, test, vi } from "vitest";
import { buildSshTmuxPreviewCommand, SSH_TMUX_OUTPUT_MARKER } from "../../shared/ssh-tmux.js";
import type { CredentialStore } from "../shared/credential-store.js";
import { SshManager } from "./ssh-manager.js";
import { createSshTmuxService, SSH_TMUX_LIST_COMMAND } from "./ssh-tmux-service.js";

const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
  type: "pkcs1",
  format: "pem",
});
const cleanup: Array<() => Promise<void>> = [];
const owner = { windowId: "desk-a", profileId: "default" };
const target = { hostId: "host", name: "a ' literal ; 🧭" };
const row = (name: string, windows = 2, attached = 1, seconds = "1700000000") =>
  `strideterm-tmux\t${windows}\t${attached}\t${seconds}\t${name}\n`;

afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

async function listen(execute: (_stream: ServerChannel, _command: string) => void) {
  const connections = new Set<Connection>();
  const server = new ssh2.Server({ hostKeys: [privateKey] }, (connection) => {
    connections.add(connection);
    connection.on("error", () => {});
    connection.on("close", () => connections.delete(connection));
    connection.on("authentication", (context) => {
      if (context.method === "password" && context.password === "secret") context.accept();
      else context.reject(["password"]);
    });
    connection.on("ready", () => {
      connection.on("session", (accept) => {
        const session = accept();
        session.on("exec", (acceptExec, _reject, info) => execute(acceptExec(), info.command));
      });
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanup.push(async () => {
    for (const connection of connections) connection.end();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return (server.address() as AddressInfo).port;
}

function reply(stream: ServerChannel, code: number, stdout = "", stderr = "") {
  if (stdout) stream.write(stdout);
  if (stderr) stream.stderr.write(stderr);
  stream.exit(code);
  stream.end();
  stream.close();
}

function fixture(port: number, options: Partial<Parameters<typeof createSshTmuxService>[0]> = {}, password = true) {
  const credentialStore: CredentialStore = {
    getSecret: () => "secret",
    hasSecret: () => true,
    setSecret: async () => {},
    deleteSecret: async () => {},
    listRefs: () => ["test-password"],
    isEncryptionAvailable: () => true,
  };
  const host = {
    id: target.hostId,
    host: "127.0.0.1",
    port,
    username: "tester",
    hostKeyPolicy: "accept-new",
    auth: { methods: ["password"], ...(password ? { passwordRef: "test-password" } : {}) },
  };
  const state = { ssh: { hosts: [host], keys: [], certificates: [], knownHosts: {} as Record<string, unknown> } };
  const store = { getState: () => state, mutate: async (mutate: (_draft: typeof state) => void) => mutate(state) };
  const sshManager = new SshManager({ store, credentialStore });
  const service = createSshTmuxService({
    sshManager,
    getEffectiveLaunchMode: () => "ssh2",
    prepareExternalProbe: () => {
      throw new Error("Unexpected external SSH probe");
    },
    ...options,
  });
  cleanup.push(async () => {
    service.close();
    await Promise.all([...sshManager.pendingPrompts.keys()].map((id) => sshManager.stop(id)));
  });
  return { service, sshManager, state };
}

test("lists structured tmux sessions and captures plain text over a saved Built-in SSH connection", async () => {
  const commands: string[] = [];
  const port = await listen((stream, command) => {
    commands.push(command);
    const output =
      command === SSH_TMUX_LIST_COMMAND
        ? row(target.name) + row("  other session  ", 1, 0, "") + row("invalid\tname") + "strideterm-tmux\tbad\n"
        : "\u001b[31mhello\u001b[0m\0\n  world\t🧭\n";
    reply(stream, 0, `login banner${SSH_TMUX_OUTPUT_MARKER}${output}`);
  });
  const { service, sshManager, state } = fixture(port);
  await expect(service.list({ hostId: target.hostId }, owner)).resolves.toEqual({
    ok: true,
    sessions: [
      { name: target.name, windows: 2, attached: true, lastActivityAt: 1_700_000_000_000 },
      { name: "  other session  ", windows: 1, attached: false, lastActivityAt: null },
    ],
  });
  await expect(service.preview(target, owner)).resolves.toEqual({ ok: true, output: "hello\n  world\t🧭\n" });
  expect(commands).toEqual([SSH_TMUX_LIST_COMMAND, buildSshTmuxPreviewCommand(target.name)]);
  expect(state.ssh.knownHosts[`127.0.0.1:${port}`]).toBeDefined();
  expect(sshManager.activeSessions.size).toBe(0);
  expect(sshManager.pendingPrompts.size).toBe(0);
});

test.each([
  { code: 1, stderr: "no server running on /tmp/tmux-1000/default\n", expected: { ok: true, sessions: [] } },
  {
    code: 1,
    stderr: "error connecting to /tmp/tmux-1000/default (No such file or directory)\n",
    expected: { ok: true, sessions: [] },
  },
  { code: 127, stderr: "tmux: command not found\n", expected: { ok: false, error: "tmux-missing" } },
  {
    code: 255,
    stderr: "ssh: connect to host 127.0.0.1 port 22: Connection refused\n",
    expected: { ok: false, error: "connection" },
  },
  { code: 0, stderr: "", expected: { ok: false, error: "tmux-command" } },
])("maps tmux/SSH exit $code and stderr $stderr", async ({ code, stderr, expected }) => {
  const port = await listen((stream) => reply(stream, code, "", stderr));
  await expect(fixture(port).service.list({ hostId: target.hostId }, owner)).resolves.toMatchObject(expected);
});

test("bounds output and refuses an incomplete list", async () => {
  const text = "x".repeat(90 * 1024);
  const port = await listen((stream) => reply(stream, 0, SSH_TMUX_OUTPUT_MARKER + text));
  const { service } = fixture(port);
  await expect(service.list({ hostId: target.hostId }, owner)).resolves.toMatchObject({
    ok: false,
    error: "output-limit",
  });
  const preview = await service.preview(target, owner);
  expect(preview.ok && Buffer.byteLength(preview.output)).toBe(64 * 1024 - SSH_TMUX_OUTPUT_MARKER.length);
});

test("allows the requesting window to answer the Built-in SSH password prompt", async () => {
  const port = await listen((stream) => reply(stream, 0, SSH_TMUX_OUTPUT_MARKER));
  const { service, sshManager } = fixture(port, {}, false);
  const promptEvent = once(sshManager, "ssh:auth-prompt");
  const pending = service.list({ hostId: target.hostId }, owner);
  const [prompt] = await promptEvent;
  expect(service.ownerOf(prompt.sessionId)).toBe(owner.windowId);
  service.closeWindow("another-window");
  sshManager.answerAuthPrompt(prompt.sessionId, ["secret"], prompt.promptId);
  await expect(pending).resolves.toEqual({ ok: true, sessions: [] });
  expect(service.ownerOf(prompt.sessionId)).toBeUndefined();
});

test("dismisses an in-flight host key prompt when its owner changes profile", async () => {
  const exec = vi.fn();
  const port = await listen(exec);
  const { service, sshManager, state } = fixture(port);
  state.ssh.knownHosts[`127.0.0.1:${port}`] = {
    fingerprint: "SHA256:changed-key",
    keyType: "ssh-rsa",
    addedAt: "2025-01-01T00:00:00.000Z",
  };
  const hostKeyEvent = once(sshManager, "ssh:host-key-change");
  const pending = service.preview(target, owner);
  const [prompt] = await hostKeyEvent;
  const dismissed = once(sshManager, "ssh:auth-prompt-cancel");
  expect(service.ownerOf(prompt.sessionId)).toBe(owner.windowId);
  service.closeStaleWindows(() => "different-profile");
  await expect(pending).resolves.toMatchObject({ ok: false, error: "cancelled" });
  await expect(dismissed).resolves.toMatchObject([{ sessionId: prompt.sessionId, promptId: prompt.promptId }]);
  expect(exec).not.toHaveBeenCalled();
});

test("cancels only the matching request for the requesting window and profile", async () => {
  const port = await listen((stream) => reply(stream, 0, SSH_TMUX_OUTPUT_MARKER));
  const { service, sshManager } = fixture(port, {}, false);
  const request = { hostId: target.hostId, requestId: "request-1" };
  const otherOwner = { ...owner, windowId: "desk-b" };

  const listPromptEvent = once(sshManager, "ssh:auth-prompt");
  const list = service.list(request, owner);
  const [listPrompt] = await listPromptEvent;

  const previewPromptEvent = once(sshManager, "ssh:auth-prompt");
  const preview = service.preview({ ...target, requestId: "request-2" }, owner);
  const [previewPrompt] = await previewPromptEvent;

  const otherPromptEvent = once(sshManager, "ssh:auth-prompt");
  const otherList = service.list(request, otherOwner);
  const [otherPrompt] = await otherPromptEvent;

  await expect(service.preview({ ...target, requestId: request.requestId }, owner)).resolves.toMatchObject({
    ok: false,
    error: "busy",
  });
  const cancel = { requestId: request.requestId };
  expect(service.cancel(cancel, { ...owner, profileId: "other-profile" })).toBe(false);
  expect(service.cancel(cancel, { ...owner, windowId: "desk-c" })).toBe(false);
  expect(service.cancel({ requestId: "unknown" }, owner)).toBe(false);

  const dismissed = once(sshManager, "ssh:auth-prompt-cancel");
  expect(service.cancel(cancel, owner)).toBe(true);
  expect(service.cancel(cancel, owner)).toBe(false);
  await expect(list).resolves.toMatchObject({ ok: false, error: "cancelled" });
  await expect(dismissed).resolves.toMatchObject([{ sessionId: listPrompt.sessionId, promptId: listPrompt.promptId }]);
  expect(service.ownerOf(listPrompt.sessionId)).toBeUndefined();

  sshManager.answerAuthPrompt(previewPrompt.sessionId, ["secret"], previewPrompt.promptId);
  sshManager.answerAuthPrompt(otherPrompt.sessionId, ["secret"], otherPrompt.promptId);
  await expect(preview).resolves.toEqual({ ok: true, output: "" });
  await expect(otherList).resolves.toEqual({ ok: true, sessions: [] });
  expect(service.cancel(cancel, otherOwner)).toBe(false);
  expect(sshManager.pendingPrompts.size).toBe(0);
  expect(sshManager.activeSessions.size).toBe(0);
});

test("stops a timed-out request and rejects requests above the per-window limit", async () => {
  // A local server that asks for a password nobody gives: the request waits on that prompt until it times out.
  // Never the machine's own port 22 — a real sshd there (CI's Ubuntu runner) answers before the 200 ms run out
  // and the request ends as "authentication" instead.
  const port = await listen(() => {});
  const { service, sshManager } = fixture(port, { timeoutMs: 200 }, false);
  const first = service.list({ hostId: target.hostId }, owner);
  const second = service.preview(target, owner);
  await expect(service.preview(target, owner)).resolves.toMatchObject({ ok: false, error: "busy" });
  await expect(first).resolves.toMatchObject({ ok: false, error: "timeout" });
  await expect(second).resolves.toMatchObject({ ok: false, error: "timeout" });
  expect(sshManager.activeSessions.size).toBe(0);
  expect(sshManager.pendingPrompts.size).toBe(0);
});

test.each(["system-ssh", "wsl"] as const)("runs and cleans up a prepared %s probe", async (mode) => {
  const cleanupFn = vi.fn(async () => {});
  const prepareExternalProbe = vi.fn(async () => ({
    file: process.execPath,
    args: ["-e", `process.stdout.write(${JSON.stringify(SSH_TMUX_OUTPUT_MARKER + row("remote"))})`],
    env: process.env,
    cleanupFn,
  }));
  const { service } = fixture(22, { prepareExternalProbe, getEffectiveLaunchMode: () => mode });
  await expect(service.list({ hostId: target.hostId }, owner)).resolves.toMatchObject({
    ok: true,
    sessions: [{ name: "remote" }],
  });
  expect(prepareExternalProbe).toHaveBeenCalledWith(
    expect.objectContaining({ id: target.hostId }),
    SSH_TMUX_LIST_COMMAND,
    mode,
  );
  expect(cleanupFn).toHaveBeenCalledOnce();
});

test("cleans up an external probe that finishes preparing after cancellation", async () => {
  const cleanupFn = vi.fn(async () => {});
  const probe = { file: process.execPath, args: [], env: process.env, cleanupFn };
  let finishPreparing!: (_probe: typeof probe) => void;
  const preparing = new Promise<typeof probe>((resolve) => {
    finishPreparing = resolve;
  });
  const { service } = fixture(22, {
    prepareExternalProbe: () => preparing,
    getEffectiveLaunchMode: () => "system-ssh",
  });
  const requestId = "external-probe";
  const list = service.list({ hostId: target.hostId, requestId }, owner);
  expect(service.cancel({ requestId }, owner)).toBe(true);
  await expect(list).resolves.toMatchObject({ ok: false, error: "cancelled" });
  finishPreparing(probe);
  await vi.waitFor(() => expect(cleanupFn).toHaveBeenCalledOnce());
});

test("rejects arbitrary commands, invalid names, unsaved hosts and missing owners", async () => {
  const { service } = fixture(22);
  await expect(service.list({ hostId: target.hostId, command: "unexpected" }, owner)).resolves.toMatchObject({
    ok: false,
    error: "invalid-request",
  });
  await expect(service.preview({ ...target, name: "bad\nname" }, owner)).resolves.toMatchObject({
    ok: false,
    error: "invalid-request",
  });
  await expect(service.list({ hostId: "other" }, owner)).resolves.toMatchObject({ ok: false, error: "host-missing" });
  await expect(service.preview(target, { ...owner, windowId: "" })).resolves.toMatchObject({
    ok: false,
    error: "desktop-only",
  });
  await expect(service.list({ hostId: target.hostId, requestId: "a\nb" }, owner)).resolves.toMatchObject({
    ok: false,
    error: "invalid-request",
  });
  expect(service.cancel({ requestId: "" }, owner)).toBe(false);
});
