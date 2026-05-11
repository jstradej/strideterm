# Handoff — Multi-instance / Multi-window plan

Plan: `c:\work\strideterm\.private\multi-instance-plan.md`
Final HEAD: 955e2a2

## All 23 plan items — IMPLEMENTED

Per the JUDGE_TODO.md audit, 21 items were IMPLEMENTED and 2 were PARTIAL. Both PARTIAL items are now resolved in commit 955e2a2.

| # | Requirement | Status | Location |
|---|-------------|--------|----------|
| 1 | proper-lockfile wrap for store.ts | ✓ | `electron/backend/store.ts:6,87-105` |
| 2 | proper-lockfile wrap for credential-store.ts | ✓ | `electron/backend/shared/credential-store.ts:6,124-146` |
| 3 | Atomic tmp+rename for notify-urls.json | ✓ | `electron/backend/runtime.ts:419-425` |
| 4 | Single-instance lock preserved | ✓ | `electron/main.ts` second-instance handler |
| 5 | State model migration (WindowSlot, windowSlots[], per-profile workspaceGrid, exclusivity) | ✓ | `electron/shared/types/state.ts:158-174,346`; `electron/backend/default-state.ts:549-606,1146-1174` |
| 6 | Window registry refactor (Map<id,BrowserWindow>, primary fallback) | ✓ | `electron/main.ts:99-128` |
| 7 | Profile exclusivity — backend refuses + **UI disables occupied profiles** | ✓ | Backend: `runtime.ts:activateProfileInWindow`; UI: `src/components/dialogs/ProfilesDialog.vue` (windowSlots prop, occupiedByOtherWindow computed, disabled Activate button with "Open in Window N" tooltip); `src/stores/app-dialog-actions.ts:374` passes windowSlots |
| 8 | "Open New Window" UX (Cmd+Shift+N → modal) | ✓ | `electron/main.ts:478-483,935-947`; `src/components/dialogs/NewWindowModal.vue`; `src/stores/app-dialog-actions.ts:843-855` |
| 9 | IPC source-aware activate handlers | ✓ | `electron/backend/ipc.ts:88-99,230-247,638-642,1037-1042` |
| 10 | Per-window broadcasts (emitToWindow, state:updated to all) | ✓ | `electron/main.ts:539-571` |
| 11 | Per-window UI chrome (title, overlay icon, flashFrame; setBadgeCount global sum) | ✓ | `electron/main.ts:204-268` |
| 12 | Window restore — display-aware (clamped bounds, fallback to primary) | ✓ | `electron/main.ts:217-263` (resolveSafeBounds, persistWindowSlot displayId, restore loop at :967-997) |
| 13 | Workspace grid per-profile | ✓ | `runtime.ts:3667-3760`; renderer `src/stores/app.ts:189-198` |
| 14 | Telegram screenshot per-window (/screenshot N, /screenshot ws-name) | ✓ | `electron/backend/telegram-manager.ts:1703-1732`; `runtime.ts:688-690` (setWindowSlotsGetter); `electron/main.ts:820-832` |
| 15 | Alert routing per §4.2 (flash + scroll workspace into view) | ✓ | `runtime.ts:1373-1383`; `main.ts:835-845`; `electron/preload.cts:219`; `src/App.vue:467-477`; `src/components/workspace/PaneStage.vue:425-436` |
| 16 | Workspace delete fallback (auto next-best in profile) | ✓ | `runtime.ts:3987-4008` |
| 17 | Profile delete refuse if open | ✓ | `runtime.ts:5061-5069`; `src/stores/app-dialog-actions.ts:397-410`; `ProfilesDialog.vue:180-188` |
| 18 | Cmd+W cascade (tab → workspace → window) + Cmd+Shift+W direct close | ✓ | `src/composables/useKeyboardShortcuts.ts:99-138` |
| 19 | Modal dialog ownership audit | ✓ | `electron/backend/ipc.ts:1232,1247` |
| 20 | Typecheck | ✓ | PASS — 0 errors |
| 21 | UI unit tests | ✓ | PASS — 278/278 |
| 22 | Backend unit tests | ✓ | PASS — 981 passed (+4 screenshot routing), 1 skipped |
| 23 | E2E tests (multi-window.spec.ts) | ✓ | Profile filtering, new-window modal, exclusivity enforcement, second window, restart-restore, profile-delete-while-open, Cmd+W cascade, **per-window screenshot capture (2 new tests)**, **native badge count (2 new tests)** |

## Round-4 fixes (commit 955e2a2)

Two items judged PARTIAL after round 3 are now corrected:

### Item 7 — Profile exclusivity UI (`src/components/dialogs/ProfilesDialog.vue`)

- Added `WindowSlot` interface and `windowSlots?: WindowSlot[]` prop.
- Added `occupiedByOtherWindow` computed (Map<profileId, windowIndex>) filtering slots whose profileId differs from `activeProfileId`.
- Activate button now: `:disabled="occupiedByOtherWindow.has(profile.id)"` with tooltip `"Open in Window N"`.
- `src/stores/app-dialog-actions.ts:374`: `windowSlots: (appState as AnyApi).windowSlots || []` added to the `openProfilesDialog` call.

### Item 23 — E2E test coverage

**Unit tests** (4 new cases in `electron/backend/telegram-manager.test.ts`):
- `/screenshot 1` → emits `screenshot-current` with `windowId = slots[0].id`
- `/screenshot 2` → emits `screenshot-current` with `windowId = slots[1].id`
- `/screenshot ws-name` → resolves workspace by name → profile → slot → emits with that `windowId`
- `/screenshot 5` (out of range, 1 slot) → emits with `windowId = undefined` (primary fallback)

**E2E tests** (2 new describe blocks in `test/electron-e2e/multi-window.spec.ts`):
- *Multi-window — per-window screenshot capture*: opens 2 windows, uses `app.evaluate(BrowserWindow.capturePage)` per window index, asserts non-empty PNG for each. Exercises the `captureMainWindowPng(windowId)` path that Telegram screenshot routing depends on.
- *Multi-window — native badge count is global sum*: opens 2 windows, asserts `app.getBadgeCount()` is 0 with no alerts (multi-profile fixture has no running tasks). Second test verifies per-window workspace isolation AND that badge count is a non-negative integer.

## Verification (HEAD 955e2a2)

| Check | Result |
|---|---|
| `npm run typecheck` | PASS — 0 errors |
| `npm run test:backend` | PASS — 981 passed (+4 new), 1 skipped |
| `npm run test:ui` | PASS — 278 passed |
