import path from "node:path";

type WorkspaceLike = { cwd?: unknown; kind?: unknown; panels?: unknown } | null | undefined;

const REMOTE_KINDS = ["docker", "container", "ssh"];

/** The folder a workspace keeps its attachments in; throws for a workspace with no local filesystem root. */
export function localAttachmentRoot(workspace: WorkspaceLike): string {
  const cwd = workspace?.cwd;
  if (typeof cwd !== "string" || !path.isAbsolute(cwd)) throw new Error("Workspace has no local filesystem root");
  const panels = Array.isArray(workspace?.panels) ? workspace.panels : [];
  if (
    REMOTE_KINDS.includes(String(workspace?.kind ?? "").toLowerCase()) ||
    panels.some((panel) => {
      const launch = panel && typeof panel === "object" ? (panel as Record<string, unknown>).launch : null;
      return (
        launch &&
        typeof launch === "object" &&
        REMOTE_KINDS.includes(String((launch as Record<string, unknown>).kind ?? "").toLowerCase())
      );
    })
  )
    throw new Error("Attachments are unavailable for SSH or container workspaces");
  return cwd;
}
