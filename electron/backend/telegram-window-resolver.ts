/**
 * Pure helper: resolves a window slot ID for a Telegram-originated command.
 *
 * Telegram speaks in `profileId` (the user-facing scope — "which profile did
 * I pick from the menu?"), but the rest of the runtime — IPC handlers,
 * remote-server slot-aware routes, window registry — uses `windowId` as the
 * canonical scope unit. This helper bridges those two worlds at the Telegram
 * boundary.
 *
 * Precedence:
 *  1. Explicit `cmd.windowId` (set by `/screenshot N` and `/screenshot ws-name`
 *     direct paths in telegram-manager) wins — it's already authoritative.
 *  2. Otherwise `cmd.profileId` is looked up against `windowSlots` to find the
 *     slot that has that profile open in a desktop window.
 *  3. If neither resolves, returns `undefined` and the caller falls back to
 *     `getPrimaryWindow()` / global active workspace (single-window setups).
 *
 * Kept as a standalone, dependency-free function so the routing logic is
 * straightforward to unit-test and so future inputs (e.g. remote-mobile
 * apiSessionId) can plug into the same resolution path.
 */
export interface TelegramWindowResolverCommand {
  windowId?: string;
  profileId?: string;
}

export interface TelegramWindowResolverSlot {
  id: string;
  profileId?: string;
}

export function resolveWindowIdForTelegramCommand(
  cmd: TelegramWindowResolverCommand,
  windowSlots: ReadonlyArray<TelegramWindowResolverSlot>,
): string | undefined {
  if (cmd.windowId) return String(cmd.windowId);
  const profileId = cmd.profileId ? String(cmd.profileId) : "";
  if (!profileId) return undefined;
  const match = windowSlots.find((slot) => (slot.profileId || "default") === profileId);
  return match?.id;
}
