import { generateKeyPairSync } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import ssh2 from "ssh2";
import type { Connection, SFTPWrapper } from "ssh2";
import { afterEach, describe, expect, test, vi } from "vitest";
import { derivePublicKeyLine, installPublicKey } from "./ssh-key-install.js";

const { Server, utils } = ssh2;
const { OPEN_MODE, STATUS_CODE } = utils.sftp;
const home = "/home/alice";
const sshDirectory = `${home}/.ssh`;
const authorizedKeys = `${sshDirectory}/authorized_keys`;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;
const hostKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
  type: "pkcs1",
  format: "pem",
});
const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privateKey = pair.privateKey.export({ type: "pkcs1", format: "pem" }).toString();
const sshKey = utils.parseKey(privateKey, "pem");
if (sshKey instanceof Error || Array.isArray(sshKey)) throw new Error("Could not build the SFTP test public key");
const publicLine = `${sshKey.type} ${sshKey.getPublicSSH().toString("base64")} integration-test-key`;

type RemoteNode = { kind: "directory" | "file" | "symlink"; mode: number; contents?: Buffer };
type OpenHandle = { path: string; flags: number };
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function makeFixture(
  initial: Record<string, RemoteNode> = {},
  reportedSizes: Map<string, number> = new Map(),
  failChmodPath?: string,
) {
  const entries = new Map<string, RemoteNode>([
    ["/", { kind: "directory", mode: 0o755 }],
    ["/home", { kind: "directory", mode: 0o755 }],
    [home, { kind: "directory", mode: 0o700 }],
    ...Object.entries(initial),
  ]);
  const connections = new Set<Connection>();
  const modesRequested: Array<{ path: string; mode: number }> = [];
  const readHandlesOpened: number[] = [];
  const handlesClosed: number[] = [];
  const readRequests: Array<{ offset: number; length: number }> = [];
  let shellRequests = 0;
  const server = new Server({ hostKeys: [hostKey] }, (connection) => {
    connections.add(connection);
    connection.on("error", () => {});
    connection.on("close", () => connections.delete(connection));
    connection.on("authentication", (context) => {
      if (context.method === "password" && context.username === "alice" && context.password === "test-password") {
        context.accept();
      } else context.reject(["password"]);
    });
    connection.on("ready", () => {
      connection.on("session", (acceptSession) => {
        const session = acceptSession();
        session.on("shell", () => {
          shellRequests++;
        });
        session.on("sftp", (acceptSftp) =>
          serveSftp(
            acceptSftp(),
            entries,
            modesRequested,
            reportedSizes,
            readHandlesOpened,
            handlesClosed,
            readRequests,
            failChmodPath,
          ),
        );
      });
    });
  });
  server.listen(0, "127.0.0.1");

  const listening = once(server, "listening");
  const ready = (async () => {
    await listening;
    return (server.address() as AddressInfo).port;
  })();
  cleanups.push(async () => {
    for (const connection of connections) connection.end();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  return {
    entries,
    modesRequested,
    ready,
    shellRequests: () => shellRequests,
    readHandlesOpened,
    handlesClosed,
    readRequests,
    failChmodPath,
  };
}

function serveSftp(
  sftp: SFTPWrapper,
  entries: Map<string, RemoteNode>,
  modesRequested: Array<{ path: string; mode: number }>,
  reportedSizes: Map<string, number>,
  readHandlesOpened: number[],
  handlesClosed: number[],
  readRequests: Array<{ offset: number; length: number }>,
  failChmodPath?: string,
) {
  const handles = new Map<number, OpenHandle>();
  let nextHandle = 0;
  sftp.on("REALPATH", (requestId, remotePath) => {
    if (remotePath !== ".") return sftp.status(requestId, STATUS_CODE.FAILURE);
    sftp.name(requestId, [{ filename: home, longname: home, attrs: attrs(entries.get(home)!) }]);
  });
  sftp.on("LSTAT", (requestId, remotePath) => {
    const entry = entries.get(remotePath);
    if (!entry) return sftp.status(requestId, STATUS_CODE.NO_SUCH_FILE);
    sftp.attrs(requestId, attrs(entry, reportedSizes.get(remotePath)));
  });
  sftp.on("MKDIR", (requestId, remotePath, inputAttrs) => {
    if (entries.has(remotePath)) return sftp.status(requestId, STATUS_CODE.FAILURE);
    const mode = inputAttrs.mode ?? 0o777;
    modesRequested.push({ path: remotePath, mode: mode & 0o7777 });
    entries.set(remotePath, { kind: "directory", mode: mode & 0o7777 });
    sftp.status(requestId, STATUS_CODE.OK);
  });
  sftp.on("SETSTAT", (requestId, remotePath, inputAttrs) => {
    const entry = entries.get(remotePath);
    if (!entry) return sftp.status(requestId, STATUS_CODE.NO_SUCH_FILE);
    if (remotePath === failChmodPath && typeof inputAttrs.mode === "number") {
      return sftp.status(requestId, STATUS_CODE.FAILURE);
    }
    if (typeof inputAttrs.mode === "number") {
      const mode = inputAttrs.mode & 0o7777;
      modesRequested.push({ path: remotePath, mode });
      entry.mode = mode;
    }
    sftp.status(requestId, STATUS_CODE.OK);
  });
  sftp.on("OPEN", (requestId, remotePath, flags, inputAttrs) => {
    let entry = entries.get(remotePath);
    const exists = Boolean(entry);
    if (flags & OPEN_MODE.EXCL && exists) return sftp.status(requestId, STATUS_CODE.FAILURE);
    if (!entry && !(flags & OPEN_MODE.CREAT)) return sftp.status(requestId, STATUS_CODE.NO_SUCH_FILE);
    if (!entry) {
      const mode = inputAttrs.mode ?? 0o666;
      modesRequested.push({ path: remotePath, mode: mode & 0o7777 });
      entry = { kind: "file", mode: mode & 0o7777, contents: Buffer.alloc(0) };
      entries.set(remotePath, entry);
    }
    if (entry.kind !== "file") return sftp.status(requestId, STATUS_CODE.FAILURE);
    if (flags & OPEN_MODE.TRUNC) entry.contents = Buffer.alloc(0);
    const handleId = nextHandle++;
    const handle = Buffer.alloc(4);
    handle.writeUInt32BE(handleId);
    handles.set(handleId, { path: remotePath, flags });
    if (flags & OPEN_MODE.READ) readHandlesOpened.push(handleId);
    sftp.handle(requestId, handle);
  });
  sftp.on("FSTAT", (requestId, handle) => {
    const opened = handles.get(handle.readUInt32BE(0));
    const entry = opened ? entries.get(opened.path) : undefined;
    if (!entry) return sftp.status(requestId, STATUS_CODE.FAILURE);
    sftp.attrs(requestId, attrs(entry));
  });
  sftp.on("READ", (requestId, handle, offset, length) => {
    readRequests.push({ offset, length });
    const opened = handles.get(handle.readUInt32BE(0));
    const entry = opened ? entries.get(opened.path) : undefined;
    if (!entry?.contents) return sftp.status(requestId, STATUS_CODE.FAILURE);
    const chunk = entry.contents.subarray(offset, offset + length);
    if (chunk.length === 0) return sftp.status(requestId, STATUS_CODE.EOF);
    sftp.data(requestId, chunk);
  });
  sftp.on("WRITE", (requestId, handle, offset, data) => {
    const opened = handles.get(handle.readUInt32BE(0));
    const entry = opened ? entries.get(opened.path) : undefined;
    if (!entry?.contents || !(opened!.flags & OPEN_MODE.WRITE)) {
      return sftp.status(requestId, STATUS_CODE.FAILURE);
    }
    const end = offset + data.length;
    const expanded = Buffer.alloc(Math.max(entry.contents.length, end));
    entry.contents.copy(expanded);
    data.copy(expanded, offset);
    entry.contents = expanded;
    sftp.status(requestId, STATUS_CODE.OK);
  });
  sftp.on("CLOSE", (requestId, handle) => {
    const handleId = handle.readUInt32BE(0);
    handles.delete(handleId);
    handlesClosed.push(handleId);
    sftp.status(requestId, STATUS_CODE.OK);
  });
}

function attrs(node: RemoteNode, reportedSize?: number) {
  const type = node.kind === "directory" ? S_IFDIR : node.kind === "symlink" ? S_IFLNK : S_IFREG;
  return {
    mode: type | node.mode,
    uid: 1000,
    gid: 1000,
    size: reportedSize ?? node.contents?.length ?? 0,
    atime: 0,
    mtime: 0,
  };
}

async function withSftp<T>(
  fixture: ReturnType<typeof makeFixture>,
  run: (_sftp: SFTPWrapper) => Promise<T>,
): Promise<T> {
  const port = await fixture.ready;
  const client = new ssh2.Client();
  const connected = new Promise<void>((resolve, reject) => {
    client.once("ready", resolve);
    client.once("error", reject);
    client.connect({ host: "127.0.0.1", port, username: "alice", password: "test-password", readyTimeout: 3000 });
  });
  try {
    await connected;
    const sftp = await new Promise<SFTPWrapper>((resolve, reject) => {
      client.sftp((error, session) => (error ? reject(error) : resolve(session)));
    });
    return await run(sftp);
  } finally {
    client.end();
  }
}

function node(fixture: ReturnType<typeof makeFixture>, remotePath: string): RemoteNode | undefined {
  return fixture.entries.get(remotePath);
}

describe("installPublicKey over a real loopback SSH/SFTP connection", () => {
  test("derives only the public line from a managed private key", () => {
    expect(derivePublicKeyLine(privateKey).line.split(" ").slice(0, 2)).toEqual(publicLine.split(" ").slice(0, 2));
    expect(() => derivePublicKeyLine("not a private key")).toThrow(/invalid or its passphrase is incorrect/i);
  });

  test("creates .ssh and authorized_keys with owner-only modes", async () => {
    const fixture = makeFixture();
    const result = await withSftp(fixture, (sftp) => installPublicKey(sftp, publicLine));

    expect(result).toEqual({ alreadyInstalled: false });
    expect(node(fixture, sshDirectory)).toEqual({ kind: "directory", mode: 0o700 });
    expect(node(fixture, authorizedKeys)).toMatchObject({ kind: "file", mode: 0o600 });
    expect(node(fixture, authorizedKeys)?.contents?.toString("utf8")).toBe(`${publicLine}\n`);
    expect(fixture.modesRequested).toContainEqual({ path: sshDirectory, mode: 0o700 });
    expect(fixture.modesRequested).toContainEqual({ path: authorizedKeys, mode: 0o600 });
    expect(fixture.shellRequests()).toBe(0);
  });

  test("preserves all existing bytes and appends after a non-terminated CRLF file", async () => {
    const existing = Buffer.from("# keep this comment\r\nssh-rsa AAAA unrelated-key old-comment", "utf8");
    const fixture = makeFixture({
      [sshDirectory]: { kind: "directory", mode: 0o755 },
      [authorizedKeys]: { kind: "file", mode: 0o644, contents: existing },
    });

    const result = await withSftp(fixture, (sftp) => installPublicKey(sftp, publicLine));

    expect(result.alreadyInstalled).toBe(false);
    expect(node(fixture, authorizedKeys)?.contents).toEqual(
      Buffer.concat([existing, Buffer.from(`\n${publicLine}\n`)]),
    );
    expect(node(fixture, sshDirectory)?.mode).toBe(0o700);
    expect(node(fixture, authorizedKeys)?.mode).toBe(0o600);
  });

  test("recognizes the key behind quoted options and ignores a different comment", async () => {
    const existing = Buffer.from(
      `from="host,command=echo keep",command="echo safe" ${publicLine.split(" ").slice(0, 2).join(" ")} previous-comment\r\n`,
    );
    const fixture = makeFixture({
      [sshDirectory]: { kind: "directory", mode: 0o700 },
      [authorizedKeys]: { kind: "file", mode: 0o600, contents: existing },
    });

    const result = await withSftp(fixture, (sftp) => installPublicKey(sftp, publicLine));

    expect(result).toEqual({ alreadyInstalled: true });
    expect(node(fixture, authorizedKeys)?.contents).toEqual(existing);
    expect(
      node(fixture, authorizedKeys)
        ?.contents?.toString("utf8")
        .match(/integration-test-key/g),
    ).toBeNull();
  });

  test("does not mistake quoted option text or comment-only lines for an installed key", async () => {
    const [type, data] = publicLine.split(" ");
    const existing = Buffer.from(
      `command="echo ${type} ${data}" ssh-rsa DIFFERENT another-key\n# ${type} ${data} comment-only\n`,
      "utf8",
    );
    const fixture = makeFixture({
      [sshDirectory]: { kind: "directory", mode: 0o700 },
      [authorizedKeys]: { kind: "file", mode: 0o600, contents: existing },
    });

    const result = await withSftp(fixture, (sftp) => installPublicKey(sftp, publicLine));

    expect(result.alreadyInstalled).toBe(false);
    expect(node(fixture, authorizedKeys)?.contents).toEqual(Buffer.concat([existing, Buffer.from(`${publicLine}\n`)]));
  });

  test("reports confirmed presence when chmod fails after finding an existing key", async () => {
    const fixture = makeFixture(
      {
        [sshDirectory]: { kind: "directory", mode: 0o700 },
        [authorizedKeys]: { kind: "file", mode: 0o644, contents: Buffer.from(`${publicLine}\n`) },
      },
      new Map(),
      authorizedKeys,
    );
    const onPublicKeyPresent = vi.fn();

    await expect(
      withSftp(fixture, (sftp) => installPublicKey(sftp, publicLine, { onPublicKeyPresent })),
    ).rejects.toThrow();

    expect(onPublicKeyPresent).toHaveBeenCalledExactlyOnceWith(true);
    expect(node(fixture, authorizedKeys)?.contents?.toString("utf8")).toBe(`${publicLine}\n`);
  });

  test("reports a newly written key before a later chmod failure", async () => {
    const fixture = makeFixture({ [sshDirectory]: { kind: "directory", mode: 0o700 } }, new Map(), authorizedKeys);
    const onPublicKeyPresent = vi.fn();

    await expect(
      withSftp(fixture, (sftp) => installPublicKey(sftp, publicLine, { onPublicKeyPresent })),
    ).rejects.toThrow();

    expect(onPublicKeyPresent).toHaveBeenCalledExactlyOnceWith(false);
    expect(node(fixture, authorizedKeys)?.contents?.toString("utf8")).toBe(`${publicLine}\n`);
  });

  test.each([
    [".ssh directory symlink", { [sshDirectory]: { kind: "symlink" as const, mode: 0o777 } }],
    [
      "authorized_keys symlink",
      {
        [sshDirectory]: { kind: "directory" as const, mode: 0o700 },
        [authorizedKeys]: { kind: "symlink" as const, mode: 0o777 },
      },
    ],
    [
      "authorized_keys directory",
      {
        [sshDirectory]: { kind: "directory" as const, mode: 0o700 },
        [authorizedKeys]: { kind: "directory" as const, mode: 0o700 },
      },
    ],
  ])("rejects a %s", async (_name, initial) => {
    const fixture = makeFixture(initial as Record<string, RemoteNode>);
    await expect(withSftp(fixture, (sftp) => installPublicKey(sftp, publicLine))).rejects.toThrow(
      /refusing to follow|refusing to overwrite/i,
    );
    expect(fixture.modesRequested.filter((entry) => entry.path === authorizedKeys)).toHaveLength(0);
  });

  test("rejects an oversized authorized_keys before writing", async () => {
    const contents = Buffer.alloc(1024 * 1024 + 1, 0x61);
    const fixture = makeFixture({
      [sshDirectory]: { kind: "directory", mode: 0o700 },
      [authorizedKeys]: { kind: "file", mode: 0o600, contents },
    });
    await expect(withSftp(fixture, (sftp) => installPublicKey(sftp, publicLine))).rejects.toThrow(/1 MiB safety limit/);
    expect(node(fixture, authorizedKeys)?.contents).toEqual(contents);
  });

  test("bounds chunked reads when the server reports a smaller size and always closes the read handle", async () => {
    const contents = Buffer.alloc(1024 * 1024 + 100, 0x61);
    const fixture = makeFixture(
      {
        [sshDirectory]: { kind: "directory", mode: 0o700 },
        [authorizedKeys]: { kind: "file", mode: 0o600, contents },
      },
      new Map([[authorizedKeys, 1]]),
    );

    await expect(withSftp(fixture, (sftp) => installPublicKey(sftp, publicLine))).rejects.toThrow(/1 MiB safety limit/);

    expect(fixture.readRequests.length).toBeGreaterThan(1);
    expect(fixture.readRequests.reduce((sum, request) => sum + request.length, 0)).toBeLessThanOrEqual(1024 * 1024 + 1);
    expect(fixture.handlesClosed).toEqual(fixture.readHandlesOpened);
    expect(node(fixture, authorizedKeys)?.contents).toEqual(contents);
  });

  test("checks cancellation before creating or appending remote files", async () => {
    const missingDirectory = makeFixture();
    await expect(
      withSftp(missingDirectory, (sftp) => installPublicKey(sftp, publicLine, { shouldContinue: () => false })),
    ).rejects.toThrow(/cancelled/i);
    expect(node(missingDirectory, sshDirectory)).toBeUndefined();

    const contents = Buffer.from("ssh-rsa AAAA existing-key\n", "utf8");
    const existingFile = makeFixture({
      [sshDirectory]: { kind: "directory", mode: 0o700 },
      [authorizedKeys]: { kind: "file", mode: 0o600, contents },
    });
    await expect(
      withSftp(existingFile, (sftp) => installPublicKey(sftp, publicLine, { shouldContinue: () => false })),
    ).rejects.toThrow(/cancelled/i);
    expect(node(existingFile, authorizedKeys)?.contents).toEqual(contents);
  });

  test("rejects malformed or multi-line public-key input before remote access", async () => {
    const fixture = makeFixture();
    await expect(withSftp(fixture, (sftp) => installPublicKey(sftp, `${publicLine}\nssh-rsa AAAA`))).rejects.toThrow(
      /exactly one line/i,
    );
    expect(node(fixture, sshDirectory)).toBeUndefined();
  });
});
