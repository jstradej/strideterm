// Base-branch ref resolution.
//
// The git UI lets the user (or auto-detection) pick a "base branch" such as
// "develop". But "develop" is ambiguous: there is the *local* branch `develop`
// and the *remote-tracking* ref `origin/develop`. Operations that bring the
// current branch up to date (rebase / merge-in) almost always want the
// remote-tracking ref — that's what the team shares and what `git fetch` keeps
// fresh. The local branch is frequently stale (in a worktree-heavy setup the
// user may never check it out), so rebasing onto it replays work onto an old
// base and is a footgun.
//
// `resolveBaseRef` maps a selected/detected base to the ref operations should
// actually target: the remote-tracking counterpart when one exists, otherwise
// the local branch (local-only repos, offline, or a deliberately local base).

export interface ResolvedBase {
  /** The raw selection (what was picked / detected), e.g. "develop". */
  selected: string;
  /** Short name without any remote prefix, e.g. "develop". */
  shortName: string;
  /** Local branch ref if one exists in branchNames, else "". */
  localRef: string;
  /** Remote-tracking ref if one exists, e.g. "origin/develop", else "". */
  remoteRef: string;
  /** The ref operations should target: remoteRef → localRef → selected. */
  opRef: string;
  /** True when opRef is a remote-tracking ref. */
  isRemote: boolean;
  /** True when there is no remote-tracking counterpart (must use local). */
  isLocalOnly: boolean;
}

/** A ref is "remote" when its first path segment is a configured remote name. */
export function isRemoteRef(ref: string, remoteNames: string[] = []): boolean {
  if (!ref) return false;
  const slash = ref.indexOf("/");
  if (slash < 0) return false;
  return remoteNames.includes(ref.slice(0, slash));
}

/** Strip a leading remote-name segment, e.g. "origin/develop" → "develop". */
export function shortBranchName(ref: string, remoteNames: string[] = []): string {
  return isRemoteRef(ref, remoteNames) ? ref.slice(ref.indexOf("/") + 1) : ref;
}

// Remotes in preference order: the configured default remote, then origin,
// then everything else — same precedence used elsewhere in the git UI.
function orderedRemotes(remoteNames: string[], defaultRemote: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const r of [defaultRemote, "origin", ...remoteNames]) {
    if (r && remoteNames.includes(r) && !seen.has(r)) {
      seen.add(r);
      out.push(r);
    }
  }
  return out;
}

export function resolveBaseRef(
  selected: string,
  branchNames: string[] = [],
  remoteNames: string[] = [],
  defaultRemote = "",
): ResolvedBase {
  const sel = (selected || "").trim();
  if (!sel) {
    return { selected: "", shortName: "", localRef: "", remoteRef: "", opRef: "", isRemote: false, isLocalOnly: true };
  }

  const names = new Set(branchNames);
  const selIsRemote = isRemoteRef(sel, remoteNames);
  const short = shortBranchName(sel, remoteNames);
  const localRef = names.has(short) ? short : "";

  let remoteRef = "";
  if (selIsRemote) {
    // Already a remote ref — trust it even if branchNames is incomplete.
    remoteRef = sel;
  } else {
    for (const r of orderedRemotes(remoteNames, defaultRemote)) {
      const cand = `${r}/${short}`;
      if (names.has(cand)) {
        remoteRef = cand;
        break;
      }
    }
  }

  const opRef = remoteRef || localRef || sel;
  return {
    selected: sel,
    shortName: short,
    localRef,
    remoteRef,
    opRef,
    isRemote: isRemoteRef(opRef, remoteNames),
    isLocalOnly: !remoteRef,
  };
}
