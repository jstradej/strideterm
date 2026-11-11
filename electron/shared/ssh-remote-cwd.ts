export const REMOTE_CWD_MAX_LENGTH = 500;

/** The tab's remote directory, or "" when unset or unusable. Control characters would end the typed command early. */
export function normalizeRemoteCwd(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();

  if (!trimmed || trimmed.length > REMOTE_CWD_MAX_LENGTH || /[\u0000-\u001f\u007f]/.test(trimmed)) return "";
  return trimmed;
}

function singleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Quotes for a Unix shell while keeping a leading `~` or `~/` expandable. */
export function quoteRemoteCwd(dir: string): string {
  if (dir === "~") return "~";
  if (dir.startsWith("~/")) return dir.length === 2 ? "~/" : `~/${singleQuote(dir.slice(2))}`;
  return singleQuote(dir);
}

/**
 * The startup command that first changes to `remoteCwd`. `keepShell` is for a command handed to `ssh`
 * itself, where the session would end with the `cd`; a command typed into a running shell needs no exec.
 */
export function remoteStartupCommand(
  remoteCwd: string,
  command: string,
  { keepShell }: { keepShell: boolean },
): string {
  const cd = `cd ${quoteRemoteCwd(remoteCwd)}`;
  const trimmed = command.trim();
  if (trimmed) return `${cd} && ${trimmed}`;
  return keepShell ? `${cd} && exec "$SHELL" -l` : cd;
}
