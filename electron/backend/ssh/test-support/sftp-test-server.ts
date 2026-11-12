import { generateKeyPairSync } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import path from "node:path";
import ssh2 from "ssh2";
import type { AuthContext, Connection, SFTPWrapper } from "ssh2";

const { Server, utils } = ssh2;
const { STATUS_CODE, flagsToString } = utils.sftp;

let sharedHostKey: string | undefined;
function hostKey(): string {
  sharedHostKey ??= generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
    type: "pkcs1",
    format: "pem",
  }) as string;
  return sharedHostKey;
}

export interface SftpTestServerOptions {
  /** Directory that plays the remote file system root: remote `/a/b` is `<rootDir>/a/b`. */
  rootDir: string;
  /** Remote answer to `realpath(".")`. */
  home?: string;
  /** Password the server accepts for user `alice`; default `ssh-password`. */
  password?: string;
  /** Refuse every authentication attempt (used to exercise failure paths). */
  rejectAuth?: boolean;
  /** Delay before each WRITE is acknowledged, to keep an upload running long enough to cancel it. */
  writeDelayMs?: number;
}

/**
 * An SSH server whose SFTP subsystem is backed by a real directory, for integration tests of the file service.
 * It implements the opcodes ssh2 clients need for browsing, `fastPut` / `fastGet`, rename and delete. It does not
 * advertise `posix-rename@openssh.com` (ssh2's server side cannot), so the plain-rename path is what runs here.
 */
export async function startSftpTestServer(options: SftpTestServerOptions) {
  const password = options.password ?? "ssh-password";
  const home = options.home ?? "/";
  const connections = new Set<Connection>();
  const stats = { connections: 0, sftpChannels: 0, openHandles: 0 };
  const toLocal = (remote: string): string => {
    const normalized = path.posix.normalize(remote.replaceAll("\\", "/"));
    return path.join(options.rootDir, ...normalized.split("/").filter(Boolean));
  };

  const server = new Server({ hostKeys: [hostKey()] }, (connection) => {
    stats.connections += 1;
    connections.add(connection);
    connection.on("error", () => {});
    connection.on("close", () => connections.delete(connection));
    connection.on("authentication", (context: AuthContext) => {
      if (
        !options.rejectAuth &&
        context.method === "password" &&
        context.username === "alice" &&
        context.password === password
      )
        context.accept();
      else context.reject(["password"]);
    });
    connection.on("ready", () => {
      connection.on("session", (accept) => {
        const session = accept();
        session.on("sftp", (acceptSftp) => {
          stats.sftpChannels += 1;
          serveSftp(acceptSftp(), toLocal, home, stats, options.writeDelayMs ?? 0);
        });
      });
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  return {
    port: (server.address() as AddressInfo).port,
    password,
    stats,
    toLocal,
    activeConnections: () => connections.size,
    /** Drops every client connection, as a network failure would. */
    dropConnections: () => {
      for (const connection of connections) connection.end();
    },
    async close() {
      for (const connection of connections) connection.end();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function attrsOf(stat: Awaited<ReturnType<typeof fs.lstat>>) {
  return {
    mode: Number(stat.mode),
    size: Number(stat.size),
    uid: 1000,
    gid: 1000,
    atime: Math.floor(Number(stat.atimeMs) / 1000),
    mtime: Math.floor(Number(stat.mtimeMs) / 1000),
  };
}

function statusFor(error: unknown): number {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENOENT" || code === "ENOTDIR") return STATUS_CODE.NO_SUCH_FILE;
  if (code === "EACCES" || code === "EPERM") return STATUS_CODE.PERMISSION_DENIED;
  return STATUS_CODE.FAILURE;
}

function serveSftp(
  sftp: SFTPWrapper,
  toLocal: (remote: string) => string,
  home: string,
  stats: { openHandles: number },
  writeDelayMs: number,
) {
  let nextHandle = 0;
  const files = new Map<number, FileHandle>();
  const dirs = new Map<number, { base: string; entries: string[]; sent: boolean }>();
  const handleId = (handle: Buffer) => handle.readUInt32BE(0);
  const newHandle = () => {
    const id = nextHandle++;
    const handle = Buffer.alloc(4);
    handle.writeUInt32BE(id);
    return { id, handle };
  };
  const fail = (requestId: number, error: unknown) => sftp.status(requestId, statusFor(error));
  const run = (requestId: number, work: () => Promise<void>) => {
    work().catch((error) => fail(requestId, error));
  };

  const closeAll = () => {
    for (const [id, file] of files) {
      files.delete(id);
      stats.openHandles -= 1;
      void file.close().catch(() => {});
    }
  };
  sftp.on("end", closeAll);
  sftp.on("close", closeAll);
  sftp.on("REALPATH", (requestId, remotePath) => {
    run(requestId, async () => {
      const resolved = remotePath === "." || remotePath === "" ? home : path.posix.resolve("/", remotePath);
      const stat = await fs.lstat(toLocal(resolved));
      sftp.name(requestId, [{ filename: resolved, longname: resolved, attrs: attrsOf(stat) }]);
    });
  });
  sftp.on("STAT", (requestId, remotePath) => {
    run(requestId, async () => sftp.attrs(requestId, attrsOf(await fs.stat(toLocal(remotePath)))));
  });
  sftp.on("LSTAT", (requestId, remotePath) => {
    run(requestId, async () => sftp.attrs(requestId, attrsOf(await fs.lstat(toLocal(remotePath)))));
  });
  sftp.on("FSTAT", (requestId, rawHandle) => {
    run(requestId, async () => {
      const file = files.get(handleId(rawHandle));
      if (!file) return void sftp.status(requestId, STATUS_CODE.FAILURE);
      sftp.attrs(requestId, attrsOf(await file.stat()));
    });
  });
  sftp.on("SETSTAT", (requestId, remotePath, requested) => {
    run(requestId, async () => {
      const target = toLocal(remotePath);
      if (typeof requested.mode === "number") await fs.chmod(target, requested.mode & 0o7777);
      if (typeof requested.mtime === "number") {
        await fs.utimes(target, requested.atime ?? requested.mtime, requested.mtime);
      }
      sftp.status(requestId, STATUS_CODE.OK);
    });
  });
  sftp.on("FSETSTAT", (requestId, rawHandle, requested) => {
    run(requestId, async () => {
      const file = files.get(handleId(rawHandle));
      if (!file) return void sftp.status(requestId, STATUS_CODE.FAILURE);
      if (typeof requested.mode === "number") await file.chmod(requested.mode & 0o7777);
      if (typeof requested.mtime === "number") await file.utimes(requested.atime ?? requested.mtime, requested.mtime);
      sftp.status(requestId, STATUS_CODE.OK);
    });
  });
  sftp.on("OPEN", (requestId, remotePath, flags, requested) => {
    run(requestId, async () => {
      const target = toLocal(remotePath);
      const existed = await fs.lstat(target).then(
        () => true,
        () => false,
      );
      const flagString = flagsToString(flags) ?? "r";
      const file = await fs.open(target, flagString);
      if (!existed && typeof requested.mode === "number") await file.chmod(requested.mode & 0o7777).catch(() => {});
      const { id, handle } = newHandle();
      files.set(id, file);
      stats.openHandles += 1;
      sftp.handle(requestId, handle);
    });
  });
  sftp.on("READ", (requestId, rawHandle, offset, length) => {
    run(requestId, async () => {
      const file = files.get(handleId(rawHandle));
      if (!file) return void sftp.status(requestId, STATUS_CODE.FAILURE);
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await file.read(buffer, 0, length, offset);
      if (bytesRead === 0) return void sftp.status(requestId, STATUS_CODE.EOF);
      sftp.data(requestId, buffer.subarray(0, bytesRead));
    });
  });
  sftp.on("WRITE", (requestId, rawHandle, offset, data) => {
    run(requestId, async () => {
      const file = files.get(handleId(rawHandle));
      if (!file) return void sftp.status(requestId, STATUS_CODE.FAILURE);
      await file.write(data, 0, data.length, offset);
      if (writeDelayMs) await new Promise((resolve) => setTimeout(resolve, writeDelayMs));
      sftp.status(requestId, STATUS_CODE.OK);
    });
  });
  sftp.on("CLOSE", (requestId, rawHandle) => {
    run(requestId, async () => {
      const id = handleId(rawHandle);
      const file = files.get(id);
      files.delete(id);
      dirs.delete(id);
      if (file) {
        stats.openHandles -= 1;
        await file.close();
      }
      sftp.status(requestId, STATUS_CODE.OK);
    });
  });
  sftp.on("OPENDIR", (requestId, remotePath) => {
    run(requestId, async () => {
      const base = toLocal(remotePath);
      const entries = await fs.readdir(base);
      const { id, handle } = newHandle();
      dirs.set(id, { base, entries, sent: false });
      sftp.handle(requestId, handle);
    });
  });
  sftp.on("READDIR", (requestId, rawHandle) => {
    run(requestId, async () => {
      const dir = dirs.get(handleId(rawHandle));
      if (!dir || dir.sent) return void sftp.status(requestId, STATUS_CODE.EOF);
      dir.sent = true;
      const names = await Promise.all(
        dir.entries.map(async (name) => ({
          filename: name,
          longname: name,
          attrs: attrsOf(await fs.lstat(path.join(dir.base, name))),
        })),
      );
      sftp.name(requestId, names);
    });
  });
  sftp.on("REMOVE", (requestId, remotePath) => {
    run(requestId, async () => {
      await fs.unlink(toLocal(remotePath));
      sftp.status(requestId, STATUS_CODE.OK);
    });
  });
  sftp.on("RMDIR", (requestId, remotePath) => {
    run(requestId, async () => {
      await fs.rmdir(toLocal(remotePath));
      sftp.status(requestId, STATUS_CODE.OK);
    });
  });
  sftp.on("MKDIR", (requestId, remotePath, requested) => {
    run(requestId, async () => {
      const target = toLocal(remotePath);
      await fs.mkdir(target);
      if (typeof requested.mode === "number") await fs.chmod(target, requested.mode & 0o7777).catch(() => {});
      sftp.status(requestId, STATUS_CODE.OK);
    });
  });
  sftp.on("RENAME", (requestId, oldPath, newPath) => {
    run(requestId, async () => {
      const target = toLocal(newPath);
      const exists = await fs.lstat(target).then(
        () => true,
        () => false,
      );
      if (exists) return void sftp.status(requestId, STATUS_CODE.FAILURE, "File exists");
      await fs.rename(toLocal(oldPath), target);
      sftp.status(requestId, STATUS_CODE.OK);
    });
  });
  sftp.on("READLINK", (requestId, remotePath) => {
    run(requestId, async () => {
      const target = await fs.readlink(toLocal(remotePath));
      sftp.name(requestId, [
        { filename: target, longname: target, attrs: attrsOf(await fs.lstat(toLocal(remotePath))) },
      ]);
    });
  });
}
