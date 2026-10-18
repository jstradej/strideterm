import { errorMessage } from "../../electron/shared/error-message.js";

// Electron wraps every IPC rejection as
//   "Error invoking remote method '<channel>': Error: <reason>"
// which fills a toast or a banner and cuts off the reason. Not anchored: a
// caller may have prefixed the message with its own context first.
const IPC_PREFIX = /Error invoking remote method '[^']+':\s*(?:Error:)?\s*/g;

/** The text worth showing the user for an Error, message, or structured failure. */
export function userFacingMessage(errOrMessage: unknown, fallback = ""): string {
  const raw = errorMessage(errOrMessage, fallback);
  return raw.replace(IPC_PREFIX, "").replace(/^Error:\s*/, "");
}
