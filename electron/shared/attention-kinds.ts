/**
 * Shared vocabulary for attention-alert kinds.
 *
 * Lives under `electron/shared` because the same question — "does this alert
 * mean a human has to do something before the terminal can continue?" — is
 * asked in four places that otherwise share no code: the Electron main process
 * (taskbar badge / window flash), the backend's per-profile attention summary,
 * the renderer's title/badge selector, and the workspace tooltip. Each of them
 * used to spell the answer out inline as `kind === "waiting"`, and adding
 * `question` to only some of them is exactly how a blocking question ends up
 * described as a finished task.
 */

/** An agent sitting at its idle prompt, waiting to be told what to do next. */
export const ATTENTION_KIND_WAITING = "waiting";

/**
 * An agent blocked on something it is asking: a permission dialog, an
 * elicitation, `agent_needs_input`. Stronger than `waiting` — the agent
 * cannot proceed at all until it is answered.
 */
export const ATTENTION_KIND_QUESTION = "question";

/**
 * Whether an alert kind means the terminal is blocked on a human.
 *
 * `question` counts, and counting it is the point: it is the more urgent of
 * the two states, so treating only `waiting` as input-blocking downgrades a
 * permission prompt to the generic "something finished" badge and tooltip.
 */
export function isInputBlockingKind(kind: string | undefined | null): boolean {
  return kind === ATTENTION_KIND_WAITING || kind === ATTENTION_KIND_QUESTION;
}
