import { getCurrentScope, onScopeDispose, watch } from "vue";
import { storeToRefs } from "pinia";
import type { ApprovalRecorded } from "../../electron/shared/approval-events.js";
import type { Transport } from "../transport.js";
import { useAppStore } from "../stores/app.js";
import { useNotificationStore } from "../stores/notifications.js";
import { fireNotificationAlert } from "./useNotificationSound.js";

interface AttentionAlertEntry {
  /** Stable backend identity — see AttentionAlert.alertId. */
  alertId?: string;
  panelId?: string;
  sessionId?: string;
  title?: string;
  detail?: string;
  kind?: string;
  exitCode?: number | null;
  tier?: number;
  urgency?: string;
  /** Human context for the alert — see AttentionAlert.message. */
  message?: string;
  /** Backend event time; becomes the notification event's `occurredAt`. */
  at?: string;
}

interface AttentionAlertBucket {
  alerts?: AttentionAlertEntry[];
}

/**
 * "Approval sent", not "Auto-approved".
 *
 * strIDEterm knows it handed a decision to the hook's stdout. Whether Claude
 * Code acted on it is not something any part of this flow observes, and the
 * audit row is worded the same way for the same reason.
 */
const APPROVAL_TITLE = "Approval sent";

/** How far back one back-fill query reaches. */
const BACKFILL_LIMIT = 50;

/**
 * Pages ONE resume batch may walk — see `backfillCheckpoints`.
 *
 * The first back-fill deliberately reaches back one page: the recent tail is
 * what a renderer with no history of its own needs. A resume asks a different
 * question — the gap has a known start, and auto-approve can write more than a
 * page of rows while a profile is not the one on screen — so it keeps asking
 * until the log runs out. The cap bounds one batch, not the gap: a walk that
 * hits it keeps its continuation cursor and the next batch picks it up, so a
 * long gap is closed in chunks instead of being declared closed early.
 */
const BACKFILL_MAX_RESUME_PAGES = 5;

/**
 * Backoff for a back-fill attempt that FAILED, in milliseconds — one entry per
 * consecutive failure, and the walk stops scheduling timers once they run out.
 *
 * A failure is not the same shape of problem as a missed trigger. A profile
 * that already has a checkpoint is skipped by the ordinary state push, so a
 * resume that threw — the one lifecycle trigger there was going to be — left
 * the gap open for the life of the renderer with nothing left to ask again.
 * Two things fix that, and both are needed: `backfillRetryProfileIds` lets the
 * NEXT ordinary payload through the checkpoint gate, and these timers cover
 * the case where no payload comes. Bounded on purpose — a permanently broken
 * transport or a locked SQLite file must not turn into a tight retry loop.
 */
const BACKFILL_RETRY_DELAYS_MS = [2_000, 10_000, 30_000];

/** The audit-log row shape the back-fill reads. */
interface ApprovalAuditRow {
  /**
   * The store's primary key. It is the column the query orders by, which
   * makes it the only cursor a page walk can trust — see `fetchApprovalRows`.
   */
  id?: number;
  timestamp?: string;
  resourceId?: string;
  workspaceId?: string;
  workspaceName?: string;
  panelTitle?: string;
  sessionId?: string;
  profileId?: string;
  toolName?: string;
  summary?: string;
}

/**
 * How far one profile's approval history has been rebuilt — see
 * `backfillCheckpoints`.
 *
 * Keyed on the store's row id rather than a timestamp for two reasons. A
 * timestamp cannot page an `id DESC` ordering losslessly (a whole page stamped
 * one millisecond is served again forever), and an EMPTY log has no timestamp
 * to record at all: the marker used to be the empty string, which is also what
 * "no checkpoint" looked like, so a resume after an empty first read reached
 * back a single page and silently abandoned everything below it.
 */
interface BackfillCheckpoint {
  /**
   * Every row up to this id is accounted for. `0` means "nothing yet" — a
   * first read that found an empty log — which is a real, recorded state and
   * not the absence of one: the map ENTRY is what stops the ordinary state
   * push from re-querying, while `0` still tells a resume to reach back over
   * the whole log.
   */
  cursorId: number;
  /**
   * A downward walk that ran into the page cap: the newest id it covers, and
   * the oldest id it managed to read.
   *
   * `cursorId` must NOT jump to `walkTopId` while these are set — everything
   * between the cursor and `walkBeforeId` is still unread, and a high
   * watermark that moved anyway made those rows unaskable for the life of the
   * renderer. The next batch continues the same walk from `walkBeforeId`
   * instead. Both are `0` when no walk is outstanding.
   */
  walkTopId: number;
  walkBeforeId: number;
}

/** What one back-fill batch read, and whether it reached the bottom of the gap. */
interface ApprovalBackfillBatch {
  rows: ApprovalAuditRow[];
  /** Newest id this walk covers, or 0 when no row could be keyed. */
  topId: number;
  /** Oldest id read, and therefore the next exclusive `beforeId`. */
  bottomId: number;
  /** True once a page came back short — the gap has no more rows below. */
  exhausted: boolean;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AttentionByWs = Record<string, AttentionAlertBucket | any>;

/**
 * Watches the attention payload for new alerts and converts them into
 * persistent notifications + toast triggers.
 *
 * Also watches for alerts that DISAPPEAR and auto-marks the corresponding
 * notifications as read, keeping the notification center in sync with the
 * live attention state.
 *
 * Returns `latestToast` ref — a notification entry that just appeared.
 * The consuming component can show it briefly and then clear it.
 *
 * `api` is passed in rather than read from the app store because this runs
 * during App.vue's setup, before `appStore.init(api)` — the transport is only
 * reachable through the injection App.vue already holds.
 */
export function useNotificationCapture(
  api?: Pick<Transport, "onApprovalRecorded" | "queryApprovalAuditLog" | "onConnectionState"> | null,
) {
  const appStore = useAppStore();
  const notifStore = useNotificationStore();
  // Share the toast slot with the store so app-level errors (showError) and
  // other non-alert sources can push toasts through the same ref App.vue binds.
  // storeToRefs preserves the Ref wrapping (vs. a plain destructure that would
  // unwrap to a value and break `.value = …` writes in this composable).
  const { latestToast } = storeToRefs(notifStore);

  /**
   * Backend `alertId`s this renderer has already handled.
   *
   * Keyed on the alert's OWN identity, never on the presence edge of
   * `workspaceId:panelId`. The old key was pruned whenever the alert dropped
   * out of the payload, so anything that made an alert momentarily absent —
   * a stale cached `attention` replayed by an optimistic workspace
   * activation, a reconnect, an out-of-order broadcast — turned the same
   * backend alert into a brand new "arrival" and appended a duplicate event
   * (V2 plan, Fáze 2). Ids therefore accumulate for the life of the
   * renderer: an alert that disappears and comes back is the SAME alert, and
   * a genuinely new one always carries a new id. The store's
   * `addAlertEvent()` is the second, persistent line of defence for the
   * cases this in-memory set cannot cover (reload, a second window).
   */
  const seenAlertIds = new Set<string>();

  // Track viewIds that currently have active alerts (for auto-read on disappear).
  let activeAlertViewIds = new Set<string>();

  /**
   * Identity used for deduplication. A backend that predates `alertId`
   * (or a hand-built test payload) falls back to the legacy composite key so
   * the capture still fires exactly once per panel — the fallback is a
   * degraded mode, not a second identity for a modern alert.
   */
  function alertKey(workspaceId: string, alert: AttentionAlertEntry): string {
    return alert.alertId || `legacy:${workspaceId}:${alert.panelId || alert.sessionId}`;
  }

  // Collect all viewIds that currently have active alerts.
  function collectActiveViewIds(byWs: AttentionByWs): Set<string> {
    const ids = new Set<string>();
    for (const entry of Object.values(byWs)) {
      for (const alert of entry?.alerts || []) {
        if (alert.sessionId) ids.add(alert.sessionId);
      }
    }
    return ids;
  }

  /**
   * Every alert identity in the payload, for the sticky question toast to
   * watch. Per ALERT, not per panel: a panel whose question A was replaced by
   * question B still has an alert, and a toast waiting on the panel would
   * therefore keep showing A's text forever.
   */
  function collectAlertIds(byWs: AttentionByWs): string[] {
    const ids: string[] = [];
    for (const [wsId, entry] of Object.entries(byWs)) {
      for (const alert of entry?.alerts || []) {
        ids.push(alertKey(wsId, alert));
      }
    }
    return ids;
  }

  // Seed seen keys from current payload so startup alerts don't fire notifications.
  function seedSeen() {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const attention = appStore.payload?.attention as any;
    const byWs: AttentionByWs = attention?.byWorkspace || attention?.byProject || {};
    for (const [wsId, entry] of Object.entries(byWs)) {
      for (const alert of entry?.alerts || []) {
        seenAlertIds.add(alertKey(wsId, alert));
      }
    }
    activeAlertViewIds = collectActiveViewIds(byWs);
  }

  /**
   * Structured capture diagnostic (V2 plan, Fáze 6). Identity and the
   * decision only — never the alert title, body or task detail, which can
   * carry the user's own prompt text.
   *
   * Only reached for an alert this renderer had not seen before, so the
   * steady state (the same live alert re-broadcast every few seconds) logs
   * nothing. An `inserted: false` line therefore means a real duplicate got
   * past the in-memory guard — a reload, a second window, a stale snapshot —
   * which is exactly the case worth being able to grep for.
   */
  function logAlertCapture(info: { alertId: string; workspaceId: string; panelId: string; inserted: boolean }): void {
    try {
      (
        window as unknown as { strideterm?: { logRenderer?: (l: string, m: string, x?: unknown) => void } }
      ).strideterm?.logRenderer?.("debug", "notification capture", {
        ...info,
        ...(info.inserted ? {} : { skipped: "duplicate-source-alert" }),
      });
    } catch {
      // logging never throws
    }
  }

  seedSeen();
  markStaleNotificationsRead();
  bindApprovalRecorded();

  /**
   * How far each profile's history has already been rebuilt, keyed by profile
   * id — see `BackfillCheckpoint` for why the cursor is a row id and not a
   * timestamp, and why an entry can legitimately point at nothing.
   *
   * The back-fill CANNOT run during setup. `useNotificationCapture()` is called
   * from App.vue's setup, and `appStore.init(api)` only runs after the mount
   * finishes — so at that moment there is no payload, `myActiveProfileId` is
   * null, and a filter written against it would keep the rows of whichever
   * profile the fallback happened to name ("default") and drop every row of
   * the profile this window actually shows. It never ran again, so a window
   * pinned to any non-default profile simply had no approval history.
   *
   * Waiting for the authoritative id and keying on it also covers the user
   * switching profiles inside one window.
   *
   * A profile lands here only once its rows have been read AND inserted. The
   * marker used to be written before the await, so one transient failure — the
   * remote transport not up yet at bootstrap, an IPC restart, a briefly locked
   * SQLite file — retired the profile permanently: the rows stayed in the
   * audit log and the Notification Center stayed incomplete for the life of
   * the renderer. The durable record deserves better than one attempt.
   *
   * A CHECKPOINT, not a "profile done" flag. An entry means "synchronised up
   * to this moment", never "synchronised for good": this renderer drops every
   * live `approval:recorded` whose profile is not the one the window currently
   * shows, and a disconnected remote client is handed nothing it missed. So
   * both of those — re-entering a profile, and reconnecting — resume from the
   * checkpoint instead of trusting a lifetime marker, which used to leave the
   * gap in the Notification Center for good while the rows sat in the audit
   * log.
   */
  const backfillCheckpoints = new Map<string, BackfillCheckpoint>();
  /**
   * Attempts currently running, so two triggers landing together cannot issue
   * the same query twice. Cleared in `finally` — and a failure leaves the
   * checkpoint exactly where it was, which is what makes the next trigger a
   * retry rather than a read that skips the gap.
   */
  const backfillInFlightProfileIds = new Set<string>();
  /**
   * Resumes owed to a profile once its running attempt lets go.
   *
   * Two things queue here, and both used to be dropped on the floor:
   *  - a lifecycle trigger (profile re-entry, reconnect) that landed while an
   *    attempt was in flight. It is not a duplicate query, it is NEWS: a gap
   *    may have opened since the running attempt took its snapshot. Losing it
   *    was permanent, because the attempt in flight then wrote a checkpoint
   *    and the ordinary state push never asks a profile that has one.
   *  - a walk that ran into `BACKFILL_MAX_RESUME_PAGES` with rows still below
   *    it, which asks for its own continuation.
   */
  const backfillResumePendingProfileIds = new Set<string>();
  /**
   * Profiles whose last attempt threw, and which therefore owe a retry.
   *
   * CONSUMED when the next attempt starts, so it costs at most one extra query
   * per state push rather than one per push for ever. It exists because the
   * checkpoint gate below is the wrong answer after a failure: the checkpoint
   * is still there (a failed read must not move it), and it is exactly what
   * stops the ordinary payload watcher from asking again.
   */
  const backfillRetryProfileIds = new Set<string>();
  /** Consecutive failures per profile, indexing `BACKFILL_RETRY_DELAYS_MS`. */
  const backfillRetryFailures = new Map<string, number>();
  /** The one armed backoff timer per profile, so a retry cannot stack. */
  const backfillRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();

  function cancelBackfillRetryTimer(profileId: string): void {
    const timer = backfillRetryTimers.get(profileId);
    if (timer !== undefined) clearTimeout(timer);
    backfillRetryTimers.delete(profileId);
  }

  /** A successful attempt closes the retry: no marker, no timer, no backoff. */
  function clearBackfillRetry(profileId: string): void {
    cancelBackfillRetryTimer(profileId);
    backfillRetryProfileIds.delete(profileId);
    backfillRetryFailures.delete(profileId);
  }

  /**
   * Arm a retry for an attempt that threw.
   *
   * The marker is the durable half — the next state push may come at any time
   * and must be allowed past the checkpoint gate. The timer is the half that
   * covers "no push ever comes", which is the normal case for a reconnect
   * resume: successfully reconnecting does not produce a second reconnect.
   * Past the last backoff step the timers stop, but the marker STAYS, so a
   * later payload still retries — the same terms a profile with no checkpoint
   * at all has always had.
   */
  function scheduleBackfillRetry(profileId: string): void {
    const failures = (backfillRetryFailures.get(profileId) || 0) + 1;
    backfillRetryFailures.set(profileId, failures);
    backfillRetryProfileIds.add(profileId);
    if (failures > BACKFILL_RETRY_DELAYS_MS.length) return;
    if (backfillRetryTimers.has(profileId)) return;
    const timer = setTimeout(
      () => {
        backfillRetryTimers.delete(profileId);
        // A resume: the checkpoint — and any unfinished walk under it — is
        // exactly where the failed attempt left it, so this continues that walk
        // from the same `beforeId` instead of starting a new one at the top.
        requestApprovalBackfill(profileId, { resume: true });
      },
      BACKFILL_RETRY_DELAYS_MS[failures - 1],
    );
    backfillRetryTimers.set(profileId, timer);
  }

  // Vue disposes the watchers below with the component scope, but not a
  // `setTimeout`. An armed retry outliving the renderer would query a
  // transport that is being torn down, on behalf of a history nobody holds.
  if (getCurrentScope()) {
    onScopeDispose(() => {
      for (const timer of backfillRetryTimers.values()) clearTimeout(timer);
      backfillRetryTimers.clear();
    });
  }

  /**
   * `resume: true` marks a trigger that KNOWS a gap may have opened — a real
   * entry into a profile, or a reconnect — and asks again from the checkpoint.
   * Without it a profile that has a checkpoint is left alone, so the ordinary
   * state push does not query on every payload.
   *
   * A resume that arrives while an attempt is already running is QUEUED, never
   * dropped: see `backfillResumePendingProfileIds`.
   */
  function requestApprovalBackfill(profileId: string | null | undefined, options?: { resume?: boolean }): void {
    if (!profileId) return;
    // No channel to ask on: nothing to retry either, and it will not appear
    // later — `api` is fixed for the life of the composable.
    if (!api?.queryApprovalAuditLog) return;
    if (backfillInFlightProfileIds.has(profileId)) {
      if (options?.resume) backfillResumePendingProfileIds.add(profileId);
      return;
    }
    // A retry owed by a failed attempt gets through the checkpoint gate: the
    // checkpoint is still there because the failure must not move it, and
    // without this the state push that is meant to be the retry is refused.
    const owedRetry = backfillRetryProfileIds.has(profileId);
    if (backfillCheckpoints.has(profileId) && !options?.resume && !owedRetry) return;
    // The attempt about to run IS that retry — a fresh failure arms a new one.
    backfillRetryProfileIds.delete(profileId);
    cancelBackfillRetryTimer(profileId);
    backfillInFlightProfileIds.add(profileId);
    void backfillApprovals(profileId).finally(() => {
      // Release the in-flight marker FIRST, then honour whatever queued while
      // it was held — otherwise the follow-up would see the profile as busy
      // and drop itself for the same reason. `sourceAlertId` makes any overlap
      // between the two reads free.
      backfillInFlightProfileIds.delete(profileId);
      if (backfillResumePendingProfileIds.delete(profileId)) {
        requestApprovalBackfill(profileId, { resume: true });
      }
    });
  }

  // Three triggers, all needed. The profile watcher covers the first payload
  // and every later profile switch — each of those IS an entry into a profile,
  // so it resumes. The payload watcher is what RETRIES a profile that has no
  // checkpoint at all, because a reconnect or the next state push re-delivers
  // the same profile id and a watcher keyed on the value alone would never
  // fire again. The connection handler covers the third gap: a reconnect after
  // approvals were recorded while this client was not listening.
  watch(
    () => appStore.myActiveProfileId,
    (profileId) => requestApprovalBackfill(profileId, { resume: true }),
    { immediate: true },
  );
  watch(
    () => appStore.payload,
    () => requestApprovalBackfill(appStore.myActiveProfileId),
  );
  bindConnectionResync();

  /**
   * Stable history identity of one approval, shared by the live event and the
   * audit-log back-fill so the two can never produce two entries for the same
   * approval.
   */
  function approvalSourceId(requestId: string): string {
    return `approval:${requestId}`;
  }

  /**
   * Notification Center body for an approval.
   *
   * `detail` is the argument on its own. Older payloads and audit rows carry
   * only the prefixed `summary` ("Bash: chmod +x deploy.sh"), and printing
   * that after a tool name the renderer already wrote produced
   * "Bash in Alpha: Bash: chmod +x deploy.sh" — so the prefix is stripped
   * when it is exactly this tool's.
   */
  function approvalBody(toolName: string, workspaceName: string, summary: string, detail?: string): string {
    const tool = toolName || "tool";
    const prefix = `${tool}: `;
    const text = (detail || "").trim() || (summary.startsWith(prefix) ? summary.slice(prefix.length) : summary);
    return text ? `${tool} in ${workspaceName}: ${text}` : `${tool} in ${workspaceName}`;
  }

  /** A row's cursor value, or 0 when it carries nothing usable. */
  function rowCursorId(row?: ApprovalAuditRow): number {
    const value = Math.floor(Number(row?.id));
    return Number.isFinite(value) && value > 0 ? value : 0;
  }

  /**
   * Read one profile's audit rows, newest first, above `checkpoint.cursorId`.
   *
   * Scoped in the QUERY, not only in the caller's loop. The desktop store
   * holds every profile's rows, so an unscoped query spends the page budget on
   * approvals this window will then throw away — and the window ends up with
   * an empty history because the newest 50 rows belonged to the other profile.
   * (The remote server ignores the parameter and scopes to the caller's own
   * bound session, which is the same answer.)
   *
   * Paging is a KEYSET walk on the row id, the column the store orders by.
   * `afterId` is the exclusive floor of the gap and `beforeId` steps down a
   * page at a time. Neither an `offset` nor a timestamp window can do this:
   * rows arriving at the top mid-walk shift an offset and skip a row, and `to`
   * is an inclusive timestamp — a page whose rows all share one millisecond
   * comes back unchanged, which read as "nowhere left to walk" while the rows
   * underneath were never asked for.
   *
   * A walk the previous batch left unfinished is CONTINUED rather than
   * restarted: its top was recorded then, and re-deriving it from today's
   * newest row would count rows written since as folded in.
   */
  async function fetchApprovalRows(
    activeProfileId: string,
    checkpoint: BackfillCheckpoint,
    maxPages: number,
  ): Promise<ApprovalBackfillBatch> {
    const query = api?.queryApprovalAuditLog;
    const outstanding = checkpoint.walkBeforeId > checkpoint.cursorId;
    const batch: ApprovalBackfillBatch = {
      rows: [],
      topId: outstanding ? checkpoint.walkTopId : 0,
      bottomId: outstanding ? checkpoint.walkBeforeId : 0,
      exhausted: false,
    };
    if (!query) return batch;
    let before = outstanding ? checkpoint.walkBeforeId : 0;
    for (let page = 0; page < maxPages; page += 1) {
      const result = (await query({
        limit: BACKFILL_LIMIT,
        profileId: activeProfileId,
        ...(checkpoint.cursorId > 0 ? { afterId: checkpoint.cursorId } : {}),
        ...(before > 0 ? { beforeId: before } : {}),
      })) as { entries?: ApprovalAuditRow[] } | null;
      const entries = result?.entries || [];
      batch.rows.push(...entries);
      if (!batch.topId) batch.topId = rowCursorId(entries[0]);
      const oldest = rowCursorId(entries[entries.length - 1]);
      if (oldest > 0) batch.bottomId = oldest;
      // A short page IS the bottom of the gap.
      if (entries.length < BACKFILL_LIMIT) {
        batch.exhausted = true;
        break;
      }
      if (oldest <= 0 || (before > 0 && oldest >= before)) {
        // A full page the walk cannot step down from: its last row carries no
        // id, or the answer did not honour the cursor. Queueing a continuation
        // would re-read the same page forever, and claiming the gap is closed
        // would strand the rows below it — so `topId` is dropped, the cursor
        // stays where it was, and the next lifecycle resume asks again.
        batch.exhausted = true;
        batch.topId = 0;
        break;
      }
      // The oldest row sits at the cursor's doorstep: the gap is closed.
      if (oldest <= checkpoint.cursorId + 1) {
        batch.exhausted = true;
        break;
      }
      before = oldest;
    }
    return batch;
  }

  /**
   * Rebuild missing approval entries from the audit log.
   *
   * `approval:recorded` is a live event and nothing replays it: an approval
   * made while no renderer of that profile was listening — the window was
   * closed, the renderer was reloading, a remote client was disconnected, the
   * window was showing another profile, or (on macOS) the app kept running
   * with no windows at all — left a row in SQLite and nothing in the
   * Notification Center. The audit log is the durable record, so it is the one
   * that fills the gap.
   *
   * Idempotent by `sourceAlertId`: an approval already in history is skipped,
   * whether it got there live or from a previous back-fill — which is what
   * makes a retry after a failed attempt safe even if the failure happened
   * halfway through inserting the rows.
   */
  async function backfillApprovals(activeProfileId: string): Promise<void> {
    const recorded = backfillCheckpoints.get(activeProfileId);
    const checkpoint: BackfillCheckpoint = recorded || { cursorId: 0, walkTopId: 0, walkBeforeId: 0 };
    // A RESUME is a read with a known floor — the checkpoint. Whether the
    // trigger called itself one is beside the point: a profile this renderer
    // has never read is a first read however it was reached, and a profile it
    // has is a resume even on the retry after a failure.
    const resume = Boolean(recorded);
    try {
      const batch = await fetchApprovalRows(activeProfileId, checkpoint, resume ? BACKFILL_MAX_RESUME_PAGES : 1);
      // Oldest first, so the newest approval ends up at the top of the thread
      // exactly as it would have if the live events had arrived in order.
      for (const row of [...batch.rows].reverse()) {
        const requestId = String(row.resourceId || "");
        if (!requestId) continue;
        const rowProfileId = String(row.profileId || "") || "default";
        if (rowProfileId !== activeProfileId) continue;
        const workspaceName = String(row.workspaceName || "") || String(row.workspaceId || "");
        const timestamp = String(row.timestamp || "");
        notifStore.addAlertEvent({
          title: APPROVAL_TITLE,
          body: approvalBody(String(row.toolName || ""), workspaceName, String(row.summary || "")),
          kind: "info",
          tier: 3,
          urgency: "normal",
          workspaceId: String(row.workspaceId || ""),
          workspaceName,
          tabName: String(row.panelTitle || ""),
          viewId: String(row.sessionId || ""),
          category: "approval",
          meta: { profileId: rowProfileId, requestId },
          sourceAlertId: approvalSourceId(requestId),
          occurredAt: timestamp || new Date().toISOString(),
          // A replay, not an arrival. The store prepends a live event, which
          // is right until a gap needs more than one batch to close: the walk
          // pages DOWNWARDS, so the second batch carries rows older than the
          // first, and prepending them reversed the thread, pulled `latestAt`
          // backwards and pushed genuinely newer entries out of both caps. The
          // audit row id is the tiebreak for a burst that shares a millisecond.
          historical: true,
          historyRank: rowCursorId(row),
        });
      }
      // Written only here, with the rows in hand and inserted. Anything that
      // threw above leaves the checkpoint untouched, and the next payload,
      // profile switch or reconnect retries it.
      if (!resume) {
        // The FIRST read is a deliberate one-page tail: there is no known gap
        // below it, and the recent history is all a renderer that has none of
        // its own needs. The cursor lands on the newest row it saw — or stays
        // at 0 for an empty log, which is a recorded state of its own and NOT
        // the same as having no checkpoint.
        backfillCheckpoints.set(activeProfileId, { cursorId: batch.topId, walkTopId: 0, walkBeforeId: 0 });
      } else if (batch.exhausted) {
        // The walk reached the bottom of the gap, so the whole range between
        // the old cursor and this walk's top is accounted for.
        backfillCheckpoints.set(activeProfileId, {
          cursorId: Math.max(checkpoint.cursorId, batch.topId),
          walkTopId: 0,
          walkBeforeId: 0,
        });
      } else {
        // The page cap stopped the walk with rows still underneath it. The
        // high watermark stays put — advancing it to the top of a walk that
        // never reached the bottom is exactly how the rest of a long gap
        // became permanently unaskable — and the continuation cursor is kept
        // so the next batch resumes the same walk instead of starting over.
        backfillCheckpoints.set(activeProfileId, {
          cursorId: checkpoint.cursorId,
          walkTopId: batch.topId,
          walkBeforeId: batch.bottomId,
        });
        backfillResumePendingProfileIds.add(activeProfileId);
      }
      clearBackfillRetry(activeProfileId);
    } catch {
      // A missing or unreachable audit log must never keep the notification
      // pipeline from starting — the live events still work. The checkpoint is
      // deliberately left where it was, but that alone is not enough: it is
      // also what stops the ordinary state push from asking again, so the
      // failure has to arm its own retry rather than hope for a lifecycle
      // trigger that, for a reconnect resume, is never coming.
      scheduleBackfillRetry(activeProfileId);
    }
  }

  /**
   * Resume the back-fill after a reconnect.
   *
   * A dropped connection is a gap by construction: `approval:recorded` is a
   * live event and the server replays nothing a client missed while it was
   * away. The checkpoint is what makes the catch-up cheap — the resume asks
   * only for rows newer than the last one this renderer folded in.
   *
   * The first `connected` of the session is not a reconnect and is left to the
   * profile watcher; only a connection that comes back after a drop (or one
   * the transport itself labels `reconnected`) resumes.
   */
  function bindConnectionResync(): void {
    if (!api?.onConnectionState) return;
    let disconnected = false;
    api.onConnectionState((connection) => {
      if (!connection?.connected) {
        disconnected = true;
        return;
      }
      const reconnected = disconnected || Boolean(connection.reconnected);
      disconnected = false;
      if (reconnected) requestApprovalBackfill(appStore.myActiveProfileId, { resume: true });
    });
  }

  /**
   * Auto-approved permission prompts land in the history as tier-3 entries:
   * no sound, no OS popup, no toast — tier 3 already means "history only".
   *
   * That is deliberate. The whole point of auto-approve is not being
   * interrupted; the point of THIS entry is that "not interrupted" never
   * becomes "no idea what happened". The Settings approval log is the
   * searchable record, this is the at-a-glance one.
   */
  function bindApprovalRecorded(): void {
    if (!api?.onApprovalRecorded) return;
    api.onApprovalRecorded((event: ApprovalRecorded) => {
      // Same per-window profile scoping as an attention alert: a window
      // showing profile A must not grow history for profile B. Before the
      // payload lands there is no answer to "which profile is this window?" —
      // and guessing "default" would file another profile's approval here — so
      // the event is left to the back-fill, which reads the same row from the
      // audit log once the profile IS known.
      const activeProfileId = appStore.myActiveProfileId;
      if (!activeProfileId || event.profileId !== activeProfileId) return;
      // addAlertEvent, not addEvent: the same approval may also arrive from
      // the start-up back-fill, and one approval is one history entry.
      notifStore.addAlertEvent({
        title: APPROVAL_TITLE,
        body: approvalBody(event.toolName, event.workspaceName, event.summary, event.detail),
        kind: "info",
        tier: 3,
        urgency: "normal",
        workspaceId: event.workspaceId,
        workspaceName: event.workspaceName,
        tabName: event.panelTitle,
        viewId: event.viewId,
        category: "approval",
        meta: { profileId: event.profileId, requestId: event.requestId },
        sourceAlertId: approvalSourceId(event.requestId),
        occurredAt: event.at,
      });
    });
  }

  const startupAt = Date.now();
  const STARTUP_GRACE_MS = 15_000;

  watch(
    () => appStore.payload?.attention,
    (attention) => {
      if (!attention) return;
      const inStartupGrace = Date.now() - startupAt < STARTUP_GRACE_MS;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const byWs: AttentionByWs = (attention as any).byWorkspace || (attention as any).byProject || {};
      // Published BEFORE any toast is pushed below, so a toast raised by this
      // very payload already finds its own alert among the live ones.
      notifStore.setLiveAlertIds(collectAlertIds(byWs));
      const workspaces = appStore.payload?.appState?.workspaces || [];
      const wsMap = new Map(workspaces.map((ws) => [ws.id, ws]));

      // Scope notifications to THIS WINDOW's profile. In a multi-window
      // multi-profile setup, the renderer in profile B otherwise pops a
      // toast and writes a notifStore entry for every alert in profile A
      // (which the user in B can't see in their sidebar). Mark them as
      // seen so they don't fire later if the user switches profiles.
      const activeProfileId = appStore.activeProfile?.id || "default";

      // --- Phase 1: Detect NEW alerts and create notifications ---
      for (const [wsId, entry] of Object.entries(byWs) as [string, AttentionAlertBucket][]) {
        for (const alert of entry?.alerts || []) {
          const key = alertKey(wsId, alert);
          if (seenAlertIds.has(key)) continue;
          seenAlertIds.add(key);

          // During startup grace period, mark as seen but don't notify
          if (inStartupGrace) continue;

          const ws = wsMap.get(wsId);
          // Skip alerts whose workspace lives in another profile — the user
          // in this window can't see that workspace, a toast/notification
          // would just be noise. Unknown-workspace alerts (ws deleted)
          // still surface as legacy fallback.
          if (ws && (ws.profileId || "default") !== activeProfileId) continue;
          const wsName = ws?.name || wsId;
          const tabName = alert.title || alert.panelId || "";

          // An alert that carries a stable `alertId` is its own identity, so
          // exactly-once is already guaranteed by `addAlertEvent()` below.
          // Suppressing it because the panel happens to have an unread thread
          // dropped the SECOND real alert of that panel FOREVER: the id was
          // added to `seenAlertIds` a few lines up, so it could never be
          // reconsidered (V3 review, §4 P1). Thread grouping is the store's
          // job; a new source alert must always reach the history.
          //
          // The id-less legacy fallback keeps the old suppression — without a
          // per-alert identity it is the only guard against one panel's
          // re-broadcast piling up events.
          const alertViewId = alert.sessionId || "";
          if (!alert.alertId) {
            const hasUnread = alertViewId && notifStore.items.some((n) => !n.read && n.viewId === alertViewId);
            if (hasUnread) continue;
          }

          // Detect task-specific alerts (detail starts with "task-")
          const alertDetail = alert.detail as string | undefined;
          const isTaskAlert = typeof alertDetail === "string" && alertDetail.startsWith("task-");
          const taskDetail = isTaskAlert ? (alertDetail as string).replace(/^task-\w+:\s*/, "") : "";
          // Rate-limit alerts: backend emits detail like "rate-limited:claude, resumes 5:50am".
          // Surface them with an exclamation in the title so they stand out from regular
          // waiting alerts — the user wanted to be jolted when an agent gets blocked.
          const isRateLimitAlert = typeof alertDetail === "string" && alertDetail.startsWith("rate-limited");

          let title: string;
          let body: string;
          if (isRateLimitAlert) {
            title = "Rate limit hit!";
            const detailRest = (alertDetail as string).replace(/^rate-limited:\s*/, "");
            body = `${tabName} in ${wsName} — ${detailRest}`;
          } else if (isTaskAlert && (alertDetail as string).startsWith("task-completed")) {
            title = "Task completed";
            body = taskDetail ? `${wsName}: ${taskDetail}` : `${wsName} task finished successfully.`;
          } else if (isTaskAlert && (alertDetail as string).startsWith("task-failed")) {
            title = "Task failed";
            body = taskDetail ? `${wsName}: ${taskDetail}` : `${wsName} task failed.`;
          } else if (alert.kind === "question") {
            // Claude uses two message templates: "Claude needs your permission
            // to use <Tool>" for a tool approval, and a bare "Claude needs
            // your permission" for a question asked through AskUserQuestion
            // (which it renders as a permission dialog). A summary derived from
            // the PermissionRequest hook — "Bash: chmod +x deploy.sh" — arrives
            // in the same field and is preferred by the backend.
            const alertMessage = (alert.message || "").trim();
            const toolFromMessage = /needs your permission to use (\S+)/.exec(alertMessage)?.[1] || "";
            const toolFromSummary = /^([A-Za-z_][\w-]*)(?::\s|$)/.exec(alertMessage)?.[1] || "";
            const tool = toolFromSummary || toolFromMessage;
            title = tool ? `Permission needed: ${tool}` : "Agent asks a question";
            body = alertMessage || `${tabName} in ${wsName} needs your answer.`;
          } else if (alert.kind === "waiting") {
            title = "Waiting for input";
            body = `${tabName} in ${wsName} is waiting for input.`;
          } else {
            title = "Task completed";
            const exitInfo = Number.isInteger(alert.exitCode) ? ` (exit ${alert.exitCode})` : "";
            body = `${tabName} in ${wsName} finished${exitInfo}.`;
          }

          const category = isRateLimitAlert ? "rate-limit" : isTaskAlert ? "task" : "terminal";
          const wsProfileId = ws?.profileId || "default";
          // Exactly-once against the PERSISTED history: this renderer's
          // in-memory `seenAlertIds` cannot see what another window already
          // wrote, nor what this window wrote before a reload.
          const { event: entry, inserted } = notifStore.addAlertEvent({
            title,
            body,
            kind: alert.kind || "completed",
            tier: Number.isInteger(alert.tier) ? alert.tier : 1,
            urgency: alert.urgency === "urgent" ? "urgent" : "normal",
            workspaceId: wsId,
            workspaceName: wsName,
            tabName,
            viewId: alert.sessionId || "",
            category,
            meta: { profileId: wsProfileId },
            sourceAlertId: key,
            occurredAt: alert.at || new Date().toISOString(),
          });
          logAlertCapture({ alertId: key, workspaceId: wsId, panelId: alert.panelId || "", inserted });
          // A duplicate is silent: no toast, no sound, no OS notification.
          if (!inserted) continue;

          // Attach category on the toast payload so NotificationToast can pick
          // the right icon without reaching into the session store.
          // Skip toast assignment while the dock is pinned — the dock itself
          // shows the arrival, and leaving latestToast stale would surface it
          // as a toast the moment the user unpins.
          if (!notifStore.pinned) {
            // Through the store: an unanswered question owns the toast slot
            // and anything arriving after it queues rather than erasing it.
            notifStore.pushToast({ ...entry, category, viewId: alertViewId, sourceAlertId: key });
          }
          // Include profile name in system notification body so the OS-level
          // alert identifies which profile the event came from.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const wsProfile = (appStore.payload?.appState as any)?.profiles?.find(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (p: any) => p.id === wsProfileId,
          );
          const profileLabel = wsProfile?.name && wsProfileId !== "default" ? wsProfile.name : null;
          const systemBody = profileLabel ? `[${profileLabel}] ${entry.body}` : entry.body;
          fireNotificationAlert(entry.title, systemBody, {
            tier: entry.tier,
            urgency: entry.urgency,
            kind: entry.kind,
            // Sound coalescing is per SESSION — one ding per panel per 5 s.
            sessionKey: `${wsId}:${alertViewId}`,
            // OS-popup dedupe is per ALERT. The two are different questions:
            // "the same alert reached N windows" must show one popup, while
            // "two different questions 4 s apart in one panel" must show two.
            // Keying the popup on the session collapsed the second case, and
            // the urgent cooldown upstream is 3 s — shorter than the 5 s
            // dedupe window — so a genuinely new alert was being dropped.
            dedupeKey: key,
          });
        }
      }

      // --- Phase 2: Detect DISAPPEARED alerts and resolve their sessions ---
      const nextActiveViewIds = collectActiveViewIds(byWs);
      for (const viewId of activeAlertViewIds) {
        if (!nextActiveViewIds.has(viewId)) {
          // Alert for this viewId disappeared on the backend — the live
          // waiting state is over. Transition the thread to resolved so
          // it drops out of "Needs input" but stays in history briefly.
          for (const s of [...notifStore.sessions]) {
            if (s.viewId === viewId && s.state === "waiting") {
              notifStore.setState(s.id, "resolved");
            }
          }
        }
      }
      activeAlertViewIds = nextActiveViewIds;
      // NOTE: `seenAlertIds` is deliberately NOT pruned here. Pruning on the
      // absence of an alert is precisely the bug this phase removes — see the
      // comment on the set itself.
    },
  );

  /**
   * On startup, remove any notifications whose corresponding attention alert
   * no longer exists. Notifications mirror live alert state, not history.
   */
  function markStaleNotificationsRead() {
    // On startup, any session still in "waiting" but without a live
    // backend alert has been resolved while the app was closed.
    // Demote to "resolved" (keeps history) rather than dropping.
    let changed = false;
    for (const s of [...notifStore.sessions]) {
      if (s.viewId && s.state === "waiting" && !activeAlertViewIds.has(s.viewId)) {
        notifStore.setState(s.id, "resolved");
        changed = true;
      }
    }
    return changed;
  }

  return { latestToast };
}
