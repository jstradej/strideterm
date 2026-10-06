// Electron wraps every IPC rejection as
//   "Error invoking remote method '<channel>': Error: <reason>"
// which fills a toast or a banner and cuts off the reason. Not anchored: a
// caller may have prefixed the message with its own context first.
const IPC_PREFIX = /Error invoking remote method '[^']+':\s*(?:Error:)?\s*/g;

/** The text worth showing the user for a failure (an Error or a message). */
export function userFacingMessage(errOrMessage: unknown): string {
  const raw =
    typeof errOrMessage === "string" ? errOrMessage : (errOrMessage as Error)?.message || String(errOrMessage ?? "");
  return raw.replace(IPC_PREFIX, "").replace(/^Error:\s*/, "");
}
