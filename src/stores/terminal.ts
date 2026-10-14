import { defineStore } from "pinia";
import { nextTick, shallowRef, watch } from "vue";
import type { SearchAddon } from "@xterm/addon-search";
import { createTerminalController } from "../app/terminal-controller.js";
import type { TerminalView, TerminalDiagnosticsSnapshot } from "../app/terminal-controller.js";
import {
  openTerminalLink,
  getWindowsPtyOptions,
  downloadTextFile,
  safeFilenamePart,
  shortcutTabDirection,
} from "../app/helpers.js";
import { resolveRemoteSelection, type TerminalReadyReason, type Transport } from "../transport.js";
import type { StatePayload } from "../../electron/shared/types/state.js";
import { useAppStore } from "./app.js";
import { resolveInputOriginWorkspaceId, resolveTerminalTextSelectionTarget } from "../app/selectors.js";
import type { TerminalTextSnapshot, TerminalTextSnapshotOptions } from "../app/terminal-text-snapshot.js";
import type { CompanionPrimaryTaskRunner } from "../../electron/shared/companion-primary.js";
import { useNotificationStore } from "./notifications.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AppConfig = any;

interface InitOptions {
  getActiveSessionId: () => string | null;
  getOverlay: () => unknown;
  getPayload: () => StatePayload | null | undefined;
}

interface TerminalReadyChallenge {
  requestId: number;
  documentEpoch: number;
  openAttempt: number;
  connectionGeneration: number;
  target: { profileId: string; workspaceId: string | null; panelId: string | null };
  respond: (ready: boolean, viewKind: "terminal" | "nonterminal" | "empty-state", reason?: TerminalReadyReason) => void;
  /** Tells the transport why the request is being held; it re-dispatches every 300 ms regardless. */
  waiting?: (reason: TerminalReadyReason) => void;
}

/**
 * How long a challenge whose target this renderer's payload does not name yet is held before it is
 * answered `false`. The transport validated the target against the server's own selection before
 * dispatching; the app store can apply that same selection a moment later (it drops out-of-order
 * snapshots and holds a payload while a workspace activation is pending), and an immediate "no" for
 * that lag was a final answer: the phone does not ask again until something else changes.
 */
export const TERMINAL_READY_TARGET_GRACE_MS = 2_000;

let remoteReadyRequestListener: ((event: Event) => void) | null = null;
let terminalViewDisposedListener: ((event: Event) => void) | null = null;

/**
 * Workspace whose UI a terminal write came from. Reads the live payload
 * (workspaces + task runner) so an attached task's Primary tab credits the
 * task workspace instead of the source workspace that owns the session.
 */
function inputOriginWorkspaceId(sessionId: string): string {
  try {
    const payload = useAppStore().payload;
    return resolveInputOriginWorkspaceId(
      payload?.appState?.workspaces,
      (payload?.taskRunner as CompanionPrimaryTaskRunner) || null,
      sessionId,
    );
  } catch {
    // A missing/partial payload must never block a keystroke.
    return "";
  }
}

export const useTerminalStore = defineStore("terminal", () => {
  // These Maps are imperative caches, not reactive state.
  // shallowRef makes them accessible via .value without deep tracking.
  const views = shallowRef(new Map<string, TerminalView>()); // sessionId → { mount, term, fitAddon, ... }
  const buffers = shallowRef(new Map<string, string>()); // sessionId → queued data string
  const retainedTestSessionIds = new Set<string>();

  let controller: ReturnType<typeof createTerminalController> | null = null;
  let reconnectFitTimer = 0;

  function init(
    api: Transport,
    appConfig: AppConfig,
    { getActiveSessionId, getOverlay, getPayload }: InitOptions,
  ): void {
    if (remoteReadyRequestListener) {
      window.removeEventListener("strideterm:remote-terminal-ready-request", remoteReadyRequestListener);
      remoteReadyRequestListener = null;
    }
    if (terminalViewDisposedListener) {
      window.removeEventListener("strideterm:terminal-view-disposed", terminalViewDisposedListener);
      terminalViewDisposedListener = null;
    }
    const pendingReady = new Map<number, TerminalReadyChallenge>();
    const parsedReplayGenerationBySession = new Map<string, number>();
    // Proofs a dropped-connection report erased, with the generation they were for. That report can
    // come from one failed HTTP request while the socket stays up, and the server replays an id only
    // on the subscribe that adds it, so on that same socket nothing would ever prove the view again.
    const lostReplayProofBySession = new Map<string, number>();
    // `${generation}:${sessionId}` already re-requested, so one lost proof costs one replay, not one
    // per 300 ms dispatch.
    const replayRequested = new Set<string>();
    // requestId -> when this renderer first saw the challenge's target disagree with its payload.
    const targetMismatchSince = new Map<number, number>();
    let currentConnectionGeneration = 0;

    const completeTerminalReadyForReplay = (sessionId: string, generation: number) => {
      if (currentConnectionGeneration === 0 && generation > 0) currentConnectionGeneration = generation;
      if (generation !== currentConnectionGeneration) return;
      parsedReplayGenerationBySession.set(sessionId, generation);
      for (const [requestId, challenge] of pendingReady) {
        if (challenge.connectionGeneration !== generation) continue;
        // A payload that has not caught up with the target yet is the next dispatch's to judge, with
        // its grace period, not a "no" here.
        if (!targetMatches(challenge.target, getPayload())) continue;
        if (getActiveSessionId() !== sessionId) continue;
        pendingReady.delete(requestId);
        challenge.respond(true, "terminal");
      }
    };

    // The host's challenge names the target the transport reported (selection-changed), so it is
    // resolved by the transport's own function: the server's selection, never the local view.
    function selectedTarget(state: unknown): TerminalReadyChallenge["target"] {
      return resolveRemoteSelection(state).target;
    }

    function targetMatches(target: TerminalReadyChallenge["target"], state: unknown): boolean {
      const current = selectedTarget(state);
      return (
        current.profileId === target.profileId &&
        current.workspaceId === target.workspaceId &&
        current.panelId === target.panelId
      );
    }

    let lastTargetKey = "";
    api.onStateUpdated?.((state) => {
      if (!api.isRemote) return;
      const current = selectedTarget(state);
      const key = JSON.stringify(current);
      if (lastTargetKey && key !== lastTargetKey) {
        for (const [requestId, challenge] of pendingReady) {
          if (targetMatches(challenge.target, state)) continue;
          pendingReady.delete(requestId);
          challenge.respond(false, "empty-state", "target-changed");
        }
      }
      lastTargetKey = key;
    });

    terminalViewDisposedListener = (event: Event) => {
      const sessionId = (event as CustomEvent<{ sessionId?: string }>).detail?.sessionId;
      if (sessionId) parsedReplayGenerationBySession.delete(sessionId);
    };
    window.addEventListener("strideterm:terminal-view-disposed", terminalViewDisposedListener);

    // The controller reads `api.onSearchRequested` from the key handler when
    // the user presses Ctrl/Cmd+F inside a terminal. We don't want to bolt
    // that onto the Transport interface (it has nothing to do with the
    // wire), so we wrap the api here and add a renderer-only callback that
    // re-broadcasts as a window CustomEvent. The corresponding TerminalPane
    // listens for "strideterm:terminal-search" and shows its overlay —
    // avoids threading refs through the layout tree.
    const apiWithSearch = {
      ...api,
      // Every terminal write declares the workspace whose UI it came from, so
      // the backend credits the right workspace with `lastWorkedAt`. Wrapped
      // here (rather than inside the controller) because this is the one place
      // that already has both the transport and the store.
      writeTerminal: (sessionId: string, data: string) =>
        api.writeTerminal(sessionId, data, inputOriginWorkspaceId(sessionId)),
      onSearchRequested: (sessionId: string) => {
        window.dispatchEvent(new CustomEvent("strideterm:terminal-search", { detail: { sessionId } }));
      },
    };
    controller = createTerminalController({
      views,
      buffers,
      getActiveSessionId,
      getOverlay,
      getPayload,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      api: apiWithSearch as any,
      appConfig,
      openTerminalLink,
      getWindowsPtyOptions,
      shortcutTabDirection,
      downloadTextFile,
      safeFilenamePart,
      // Typing into a terminal acknowledges that session's notification —
      // the user demonstrably acted on the result, unlike merely clicking
      // through to the tab.
      onUserInput: (sessionId: string, data: string) => {
        useNotificationStore().resolveByEngagement(sessionId, data);
      },
      // Pull-up-to-refresh on remote/mobile: when the user keeps swiping
      // past the bottom of the terminal buffer (no more newer content),
      // fetch a fresh /api/state. Local Electron transport doesn't expose
      // `refresh` because the desktop already gets push updates over IPC,
      // so the gesture is a no-op there.
      onOverscrollRefresh: api.refresh
        ? () => {
            window.dispatchEvent(new CustomEvent("strideterm:manual-refresh"));
            void api.refresh!();
          }
        : undefined,
      // Long press inside a terminal opens the "Select text" panel. Wired on
      // every transport, not just remote: a touchscreen laptop or a Windows
      // tablet running the desktop build has exactly the same problem with
      // dragging out an xterm selection by finger.
      onTextSelectionRequested: (sessionId: string) => {
        requestTextSelection(sessionId);
      },
    });

    api.onTerminalData!(({ sessionId, data, seq }) => {
      controller!.handleTerminalData({ sessionId, data, seq });
    });

    // Remote-only: the server pushes terminal:replay on (re)subscribe as the
    // ordered reset point for a session. `seq`/`throughSeq` flow through so
    // the controller can drop live frames already covered by the replay.
    api.onTerminalReplay?.(({ sessionId, data, throughSeq, connectionGeneration }) => {
      const replaySessionId = sessionId || "";
      parsedReplayGenerationBySession.delete(replaySessionId);
      lostReplayProofBySession.delete(replaySessionId);
      controller!.handleTerminalReplay({
        sessionId: replaySessionId,
        data,
        throughSeq,
        onParsed:
          api.isRemote && typeof connectionGeneration === "number"
            ? () => completeTerminalReadyForReplay(replaySessionId, connectionGeneration)
            : undefined,
      });
    });

    api.onTerminalExit!(({ sessionId, exitCode, intentional }) => {
      controller!.handleTerminalExit({ sessionId, exitCode, intentional });
    });

    api.onConnectionState?.((connection) => {
      if (typeof connection?.connectionGeneration === "number") {
        if (connection.connectionGeneration !== currentConnectionGeneration) replayRequested.clear();
        currentConnectionGeneration = connection.connectionGeneration;
      }
      if (!connection?.connected) {
        for (const [sessionId, generation] of parsedReplayGenerationBySession) {
          lostReplayProofBySession.set(sessionId, generation);
        }
        parsedReplayGenerationBySession.clear();
        for (const challenge of pendingReady.values()) challenge.respond(false, "empty-state", "disconnected");
        pendingReady.clear();
        targetMismatchSince.clear();
        return;
      }
      if (!connection.reconnected) return;
      controller?.scheduleAllVisibleResize();
      window.clearTimeout(reconnectFitTimer);
      reconnectFitTimer = window.setTimeout(() => controller?.scheduleAllVisibleResize(), 150);
    });

    if (api.isRemote) {
      remoteReadyRequestListener = (event: Event) => {
        const challenge = (event as CustomEvent<TerminalReadyChallenge>).detail;
        if (!challenge || typeof challenge.respond !== "function") return;
        if (!targetMatches(challenge.target, getPayload())) {
          // The transport re-dispatches a held request every 300 ms, so holding it IS the retry.
          const now = Date.now();
          const since = targetMismatchSince.get(challenge.requestId) ?? now;
          if (now - since < TERMINAL_READY_TARGET_GRACE_MS) {
            if (!targetMismatchSince.has(challenge.requestId)) {
              const oldest = targetMismatchSince.keys().next();
              if (targetMismatchSince.size >= 8 && !oldest.done) targetMismatchSince.delete(oldest.value);
              targetMismatchSince.set(challenge.requestId, since);
            }
            challenge.waiting?.("target-mismatch");
            return;
          }
          targetMismatchSince.delete(challenge.requestId);
          pendingReady.delete(challenge.requestId);
          challenge.respond(false, "empty-state", "target-mismatch");
          return;
        }
        targetMismatchSince.delete(challenge.requestId);
        const activeSessionId = getActiveSessionId();
        if (challenge.connectionGeneration > currentConnectionGeneration) {
          currentConnectionGeneration = challenge.connectionGeneration;
        }
        if (challenge.connectionGeneration !== currentConnectionGeneration) {
          challenge.waiting?.("stale-generation");
          return;
        }
        if (activeSessionId) {
          const replayedGeneration = parsedReplayGenerationBySession.get(activeSessionId);
          if (replayedGeneration === challenge.connectionGeneration) {
            pendingReady.delete(challenge.requestId);
            challenge.respond(true, "terminal");
            return;
          }
          // The proof was erased while this very socket stayed up, and the server will not replay an
          // id it already streams unless asked: ask, once.
          const replayKey = `${challenge.connectionGeneration}:${activeSessionId}`;
          if (
            lostReplayProofBySession.get(activeSessionId) === challenge.connectionGeneration &&
            !replayRequested.has(replayKey) &&
            api.requestTerminalReplay?.(activeSessionId)
          ) {
            replayRequested.add(replayKey);
          }
          if (pendingReady.size >= 8 && !pendingReady.has(challenge.requestId)) {
            const oldest = pendingReady.values().next().value;
            if (oldest) {
              pendingReady.delete(oldest.requestId);
              oldest.respond(false, "empty-state", "superseded");
            }
          }
          pendingReady.set(challenge.requestId, challenge);
          challenge.waiting?.("replay-pending");
          return;
        }
        const viewKind = challenge.target.panelId ? "nonterminal" : "empty-state";
        void nextTick(() => {
          window.setTimeout(() => {
            if (challenge.connectionGeneration !== currentConnectionGeneration) return;
            challenge.respond(true, viewKind);
          }, 0);
        });
      };
      window.addEventListener("strideterm:remote-terminal-ready-request", remoteReadyRequestListener);
    }

    window.addEventListener("strideterm:theme-changed", () => controller?.syncTheme());

    const transportKey: "terminalFontSizeLocal" | "terminalFontSizeRemote" = api.isRemote
      ? "terminalFontSizeRemote"
      : "terminalFontSizeLocal";
    let lastFontSize: number | undefined;
    watch(
      () => {
        const s = useAppStore().payload?.appState?.settings as Record<string, unknown> | undefined;
        const v = s?.[transportKey];
        return typeof v === "number" ? v : undefined;
      },
      (next) => {
        if (typeof next === "number" && next !== lastFontSize) {
          lastFontSize = next;
          controller?.syncFontSize(next);
        }
      },
      { immediate: true },
    );
  }

  function attachTerminalPane(sessionId: string, paneBody: HTMLDivElement): unknown {
    return controller?.attachTerminalPane(sessionId, paneBody);
  }

  function detachTerminalPane(sessionId: string, paneBody?: Element | null): void {
    controller?.detachTerminalPane(sessionId, paneBody);
  }

  function focusActiveTerminal(): void {
    controller?.focusActiveTerminal();
  }

  function scheduleActiveResize(options?: unknown): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return controller?.scheduleActiveResize(options as any);
  }

  function scheduleAllVisibleResize(): void {
    return controller?.scheduleAllVisibleResize();
  }

  function pruneTerminalViews(validSessionIds: Set<string> | string[]): void {
    const ids = new Set(validSessionIds);
    for (const sessionId of retainedTestSessionIds) ids.add(sessionId);
    controller?.pruneTerminalViews(ids);
  }

  function retainTestSession(sessionId: string): void {
    retainedTestSessionIds.add(sessionId);
  }

  function releaseTestSession(sessionId: string): void {
    retainedTestSessionIds.delete(sessionId);
    controller?.disposeTerminalView(sessionId);
  }

  function exportTerminalTranscript(sessionId: string, options?: unknown): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    controller?.exportTerminalTranscript(sessionId, options as any);
  }

  function clearTerminalViewport(sessionId: string): void {
    controller?.clearTerminalViewport(sessionId);
  }

  // Synthetic write — used when the renderer needs to surface a note in the
  // terminal (e.g. "Already disconnected") without a backend session to
  // produce real terminal:data events.
  function writeToTerminal(sessionId: string, data: string): void {
    controller?.handleTerminalData({ sessionId, data });
  }

  function disconnectHiddenPaneObservers(visibleSessionIds: string[]): void {
    const ids = new Set(visibleSessionIds);
    controller?.disconnectHiddenPaneObservers(ids);
  }

  function syncTheme(): void {
    return controller?.syncTheme();
  }

  function syncFontSize(size: number): void {
    controller?.syncFontSize(size);
  }

  function getSearchAddon(sessionId: string): SearchAddon | null {
    return controller?.getSearchAddon(sessionId) ?? null;
  }

  function getVisibleTerminalText(sessionId: string): string {
    return controller?.getVisibleTerminalText(sessionId) ?? "";
  }

  /**
   * Immutable text snapshot of one terminal's screen. Renderer-local: it reads
   * the xterm buffer this client already has, so it costs no IPC, no HTTP and
   * no PTY replay on either transport.
   */
  function getTerminalTextSnapshot(
    sessionId: string,
    options?: TerminalTextSnapshotOptions,
  ): TerminalTextSnapshot | null {
    return controller?.getTerminalTextSnapshot(sessionId, options) ?? null;
  }

  /**
   * Open the "Select text" panel for a session. The single entry point for
   * every trigger — the terminal long press, the TerminalPane control and the
   * MobileInputBar menu all land here, so the profile check and the header
   * label are written once.
   *
   * The snapshot itself is passed as a plain string prop and deliberately not
   * stored in the Pinia state: it must not enter deep reactivity, and it must
   * never ride along in a state broadcast.
   */
  function requestTextSelection(sessionId: string, options?: TerminalTextSnapshotOptions): boolean {
    if (!sessionId) return false;
    const app = useAppStore();
    const target = resolveTerminalTextSelectionTarget(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (app.payload?.appState?.workspaces as any) || [],
      app.myActiveProfileId,
      sessionId,
    );
    if (!target) return false;
    if (!getTerminalTextSnapshot(sessionId, options)) return false;
    app.openDialog("TerminalTextSelectionDialog", {
      sessionId: target.sessionId,
      workspaceId: target.workspaceId,
      panelId: target.panelId,
      title: target.title,
      onClose: () => app.closeDialog(),
    });
    return true;
  }

  // Renderer-local performance diagnostics. Enabled only while the Performance
  // panel is open + visible; the panel polls getTerminalDiagnostics() which
  // returns interval deltas and resets. Never enters server state.
  function setTerminalDiagnosticsEnabled(enabled: boolean): void {
    controller?.setDiagnosticsEnabled(enabled);
  }

  function getTerminalDiagnostics(): TerminalDiagnosticsSnapshot | null {
    return controller?.getDiagnosticsSnapshot() ?? null;
  }

  // Programmatic equivalent of pressing Ctrl/Cmd+F — used by the header
  // button and the "Find in terminal" context-menu entry. Routes through
  // the same window event so the overlay open path is single-sourced.
  function requestSearch(sessionId: string): void {
    window.dispatchEvent(new CustomEvent("strideterm:terminal-search", { detail: { sessionId } }));
  }

  return {
    views,
    buffers,
    init,
    attachTerminalPane,
    detachTerminalPane,
    focusActiveTerminal,
    scheduleActiveResize,
    scheduleAllVisibleResize,
    pruneTerminalViews,
    retainTestSession,
    releaseTestSession,
    exportTerminalTranscript,
    clearTerminalViewport,
    writeToTerminal,
    disconnectHiddenPaneObservers,
    syncTheme,
    syncFontSize,
    getSearchAddon,
    getVisibleTerminalText,
    getTerminalTextSnapshot,
    requestTextSelection,
    setTerminalDiagnosticsEnabled,
    getTerminalDiagnostics,
    requestSearch,
  };
});
