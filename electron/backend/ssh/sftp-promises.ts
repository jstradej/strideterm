import type { Client, FileEntryWithStats, SFTPWrapper, Stats } from "ssh2";

export function openSftpChannel(client: Client): Promise<SFTPWrapper> {
  return new Promise((resolve, reject) => {
    client.sftp((error, sftp) => (error ? reject(error) : resolve(sftp)));
  });
}

function call<T>(run: (cb: (error: Error | null | undefined, value?: T) => void) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    try {
      run((error, value) => (error ? reject(error) : resolve(value as T)));
    } catch (error) {
      reject(error);
    }
  });
}

export const sftpReaddir = (sftp: SFTPWrapper, path: string) =>
  call<FileEntryWithStats[]>((cb) => sftp.readdir(path, cb));
export const sftpLstat = (sftp: SFTPWrapper, path: string) => call<Stats>((cb) => sftp.lstat(path, cb));
export const sftpStat = (sftp: SFTPWrapper, path: string) => call<Stats>((cb) => sftp.stat(path, cb));
export const sftpRealpath = (sftp: SFTPWrapper, path: string) => call<string>((cb) => sftp.realpath(path, cb));
export const sftpReadlink = (sftp: SFTPWrapper, path: string) => call<string>((cb) => sftp.readlink(path, cb));
export const sftpMkdir = (sftp: SFTPWrapper, path: string, mode?: number) =>
  call<void>((cb) => sftp.mkdir(path, mode === undefined ? {} : { mode }, cb));
export const sftpRmdir = (sftp: SFTPWrapper, path: string) => call<void>((cb) => sftp.rmdir(path, cb));
export const sftpUnlink = (sftp: SFTPWrapper, path: string) => call<void>((cb) => sftp.unlink(path, cb));
export const sftpRename = (sftp: SFTPWrapper, from: string, to: string) =>
  call<void>((cb) => sftp.rename(from, to, cb));
export const sftpUtimes = (sftp: SFTPWrapper, path: string, atimeSeconds: number, mtimeSeconds: number) =>
  call<void>((cb) => sftp.utimes(path, atimeSeconds, mtimeSeconds, cb));
export const sftpChmod = (sftp: SFTPWrapper, path: string, mode: number) =>
  call<void>((cb) => sftp.chmod(path, mode, cb));

export function sftpSupportsPosixRename(sftp: SFTPWrapper): boolean {
  return (
    (sftp as unknown as { _extensions?: Record<string, string> })._extensions?.["posix-rename@openssh.com"] === "1"
  );
}

/** Atomic replace when the server offers `posix-rename@openssh.com`, otherwise a plain rename. */
export function sftpPosixRename(sftp: SFTPWrapper, from: string, to: string): Promise<void> {
  return call<void>((cb) => sftp.ext_openssh_rename(from, to, cb));
}
