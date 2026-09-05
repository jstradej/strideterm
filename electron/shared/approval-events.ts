import { z } from "zod";

/**
 * "strIDEterm just approved a permission prompt on your behalf."
 *
 * Auto-approval is silent by design — that is the whole point — but silent
 * must not mean invisible. This event is what puts each approval into the
 * Notification Center as a tier-3 entry (no sound, no OS popup, history only),
 * alongside the SQLite approval log the Settings viewer reads and the optional
 * Telegram `auto_approved` message.
 *
 * `profileId` travels in the payload for the same reason it does on
 * `notification:target-removed`: notification history is per-viewer, and the
 * remote server needs to route the event only to clients bound to the profile
 * that owns the workspace. It is always the EFFECTIVE id
 * (`workspace.profileId || "default"`).
 *
 * `requestId` is the UUID strIDEterm minted for this request — the same value
 * stored as `resource_id` in the audit log, so a Notification Center entry and
 * a log row can be tied together. It is also what makes the entry idempotent:
 * a renderer that missed the live event and back-fills from the audit log on
 * start-up keys on the same id and cannot produce a duplicate.
 */
export const approvalRecordedSchema = z
  .object({
    requestId: z.string().min(1),
    workspaceId: z.string().min(1),
    /** `workspaceId:panelId` — the notification thread this belongs to. */
    viewId: z.string().min(1),
    workspaceName: z.string(),
    panelTitle: z.string(),
    profileId: z.string().min(1),
    toolName: z.string(),
    /** Redacted, clipped `Tool: argument` summary — see summarizePermissionRequest. */
    summary: z.string(),
    /**
     * The argument WITHOUT the `Tool: ` prefix.
     *
     * The Notification Center already renders the tool name itself
     * (`Bash in Alpha: …`); handing it the prefixed summary produced
     * `Bash in Alpha: Bash: chmod +x deploy.sh`. Carrying both fields is what
     * lets each renderer take the shape it needs without string surgery.
     */
    detail: z.string(),
    /** ISO timestamp of the approval. */
    at: z.string().min(1),
  })
  .strict()
  .describe("approval:recorded");

export type ApprovalRecorded = z.infer<typeof approvalRecordedSchema>;

/** IPC / WebSocket channel name for the event above. */
export const APPROVAL_RECORDED_CHANNEL = "approval:recorded";
