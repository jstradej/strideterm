export interface SshTmuxTarget {
  name: string;
  readOnly?: boolean;
}

export interface SshTmuxSession {
  name: string;
  windows: number;
  attached: boolean;
  lastActivityAt: number | null;
}

export interface SshTmuxListInput {
  hostId: string;
  requestId?: string;
}

export interface SshTmuxPreviewInput extends SshTmuxListInput {
  name: string;
}

export interface SshTmuxCancelInput {
  requestId: string;
}

export interface SshTmuxFailure {
  ok: false;
  error: string;
  message: string;
}

export type SshTmuxListResult = { ok: true; sessions: SshTmuxSession[] } | SshTmuxFailure;
export type SshTmuxPreviewResult = { ok: true; output: string } | SshTmuxFailure;

export function normalizeSshTmuxName(value: unknown): string | null {
  // Preserve the actual tmux name, including significant leading or trailing spaces.

  if (
    typeof value !== "string" ||
    !value.length ||
    value.length > 512 ||
    /[\u0000-\u001f\u007f-\u009f\u2028\u2029\p{Surrogate}]/u.test(value)
  ) {
    return null;
  }
  return value;
}

export function normalizeSshTmuxTarget(value: unknown): SshTmuxTarget | null {
  if (!value || typeof value !== "object") return null;
  const target = value as Record<string, unknown>;
  const name = normalizeSshTmuxName(target.name);
  if (name === null || (target.readOnly !== undefined && typeof target.readOnly !== "boolean")) return null;
  return { name, ...(target.readOnly === undefined ? {} : { readOnly: target.readOnly }) };
}

function quotePosix(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export const SSH_TMUX_NO_MATCH_EXIT = 44;
export const SSH_TMUX_OUTPUT_MARKER = "\nSTRIDETERM_TMUX_OUTPUT\n";

// A tmux target can otherwise resolve to a session ID, client name, pattern or unique prefix.
// Compare the literal session name and pass only tmux's numeric ID to the next command.
function buildSshTmuxTargetCommand(name: string, command: string): string {
  if (normalizeSshTmuxName(name) === null) throw new Error("Invalid tmux session name.");
  const script = `
command -v tmux >/dev/null 2>&1 || { printf '%s\\n' 'tmux is not installed.' >&2; exit 127; }
sessions=$(tmux -u list-sessions -F '#{session_id} #{session_name}') || exit $?
id=
while IFS= read -r row; do
  [ "\${row#* }" = "$1" ] || continue
  candidate=\${row%% *}
  case "$candidate" in
    '$'[0-9]*) case "\${candidate#?}" in *[!0-9]*) continue;; esac;;
    *) continue;;
  esac
  id=$candidate
  break
done <<STRIDETERM_TMUX_SESSIONS
$sessions
STRIDETERM_TMUX_SESSIONS
if [ -n "$id" ]; then
  ${command}
fi
printf '%s\\n' 'tmux session no longer exists.' >&2
exit ${SSH_TMUX_NO_MATCH_EXIT}`;
  return `sh -c ${quotePosix(script)} strideterm-tmux ${quotePosix(name)}`;
}

export function buildSshTmuxAttachCommand(target: SshTmuxTarget): string {
  const readOnly = target.readOnly ? " -r" : "";
  // if-shell does not start a server, including on tmux versions before the -N flag.
  return buildSshTmuxTargetCommand(target.name, `exec tmux if-shell -F 1 "attach-session${readOnly} -t '$id'"`);
}

export function buildSshTmuxPreviewCommand(name: string): string {
  const capture = `printf '%s' ${quotePosix(SSH_TMUX_OUTPUT_MARKER)}; exec tmux -u capture-pane -p -S -100 -t "$id:"`;
  return `LC_ALL=C ${buildSshTmuxTargetCommand(name, capture)}`;
}
