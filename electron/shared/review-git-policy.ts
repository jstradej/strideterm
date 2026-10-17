/**
 * What an agent is told about the review Git tools. One source for every
 * channel that can carry it: Claude's appended system prompt, the MCP server's
 * `instructions` (every client), the tool descriptions, and the review brief.
 *
 * This is policy, not a human-proof gate. The runtime has no approval queue and
 * no consent token: a continuation carries the proposal id and the repository
 * facts it was shown purely so a stale answer cannot be applied to a changed
 * repository. What the agent says the user answered is recorded for audit and
 * proves nothing.
 */

export const REVIEW_GIT_CONSENT_REQUIRED = [
  "rebase onto the pull request target",
  "stage / unstage",
  "conflict continue / skip / abort",
  "commit",
  "push",
  "force push",
  "a refresh that proposes discarding local commits",
] as const;

export function buildReviewGitPolicy({ askTool }: { askTool: "AskUserQuestion" | null }): string {
  const ask = askTool
    ? `call ${askTool} with those facts and WAIT for the user's actual answer`
    : "ask the user in the conversation, then STOP and wait for their actual reply before doing anything else";
  return [
    "Git for this pull request goes through the review_git_* tools of this MCP server. Do not run git commands that change the repository in a shell for this PR: that bypasses the runtime's safety checks and audit trail.",
    "Safe refresh needs no question: review_git_refresh fast-forwards, and resets onto a rewritten PR branch only when HEAD is exactly the last integrated source commit (a recovery ref is kept).",
    `Consent-required operations (${REVIEW_GIT_CONSENT_REQUIRED.join("; ")}): call the tool first WITHOUT proposalId. It returns a proposal with the exact commits, SHAs or paths involved. Then ${ask}. Only if the user approves, call the tool again with that proposalId and put the user's answer in \`consent\`. If the repository changed meanwhile you get a new proposal: ask again.`,
    "Tool permission prompts, PermissionRequest hooks and auto-approval are NOT the user's consent. Printing a question is not asking; never continue before an actual answer arrives.",
    "Operations return an operationId. Check git_operation_status; never start the same operation again while its status is unknown (a lost acknowledgement is retried by the tool itself with an idempotency key, so it cannot run twice).",
    "Pushing and publishing are separate: a push never publishes queued draft comments, and a rebase never pushes.",
  ].join("\n");
}
