<template>
  <div
    v-if="routes.length"
    ref="rootRef"
    class="jira-header-search"
    :class="{ 'jira-header-search--mobile': isMobile }"
  >
    <button
      v-if="isMobile"
      ref="chipRef"
      type="button"
      class="workspace-chip workspace-chip--btn jira-header-search__chip"
      title="Search Jira and see your issues"
      aria-haspopup="dialog"
      :aria-expanded="open ? 'true' : 'false'"
      data-role="jira-header-chip"
      @click="toggleMobilePanel"
    >
      <strong>Jira</strong>
      <span class="disclosure-chevron disclosure-chevron--down jira-header-search__caret" aria-hidden="true" />
    </button>
    <div v-if="!isMobile" class="jira-header-search__field">
      <input
        ref="inputRef"
        v-model="text"
        type="search"
        class="jira-header-search__input"
        placeholder="Search Jira…"
        aria-label="Search Jira"
        autocomplete="off"
        spellcheck="false"
        role="combobox"
        aria-autocomplete="list"
        :aria-expanded="open ? 'true' : 'false'"
        @input="onInput"
        @focus="onFocus"
        @keydown="onKeydown"
      />
      <span v-if="syncedHint" class="jira-header-search__synced" aria-hidden="true">{{ syncedHint }}</span>
    </div>
    <button
      v-for="badge in isMobile ? [] : badges"
      :key="badge.category"
      type="button"
      class="jira-header-search__badge"
      :data-category="badge.category"
      :aria-pressed="open && listMode === badge.category ? 'true' : 'false'"
      :aria-label="badge.label"
      :title="badge.title"
      @mousedown.prevent
      @click="toggleList(badge.category)"
    >
      {{ badge.text }}
    </button>
    <Teleport to="body">
      <div
        v-if="open"
        ref="listRef"
        class="jira-header-search__panel"
        :style="panelStyle"
        :role="isMobile ? 'dialog' : 'listbox'"
        :aria-label="isMobile ? 'Jira' : showMine ? listTitle : 'Jira search results'"
      >
        <div v-if="isMobile" class="jira-header-search__tools">
          <input
            ref="inputRef"
            v-model="text"
            type="search"
            class="jira-header-search__input jira-header-search__input--panel"
            placeholder="Search Jira…"
            aria-label="Search Jira"
            autocomplete="off"
            spellcheck="false"
            @input="onInput"
            @keydown="onKeydown"
          />
          <div class="jira-header-search__counters">
            <button
              v-for="counter in counters"
              :key="counter.category"
              type="button"
              class="jira-header-search__counter"
              :data-category="counter.category"
              :aria-pressed="showMine === counter.category ? 'true' : 'false'"
              @mousedown.prevent
              @click="selectMobileList(counter.category)"
            >
              {{ counter.label }}
              <span class="jira-header-search__counter-count">{{ counter.count }}</span>
            </button>
            <span class="jira-header-search__mobile-age">{{ mobileAgeText }}</span>
            <button
              type="button"
              class="jira-header-search__mine-refresh"
              :disabled="myIssues.loading.value"
              title="Ask Jira for your issues now."
              @mousedown.prevent
              @click="refreshMine"
            >
              Refresh
            </button>
          </div>
        </div>
        <template v-if="showMine">
          <div v-if="!isMobile" class="jira-header-search__mine-head">
            <span class="jira-header-search__mine-title">{{ listTitle }}</span>
            <span class="jira-header-search__mine-age">{{ listAgeText }}</span>
            <button
              type="button"
              class="jira-header-search__mine-refresh"
              :disabled="myIssues.loading.value"
              title="Ask Jira for your issues now."
              @mousedown.prevent
              @click="refreshMine"
            >
              Refresh
            </button>
          </div>
          <p v-if="!visibleRows.length" class="jira-header-search__status" role="status">{{ listEmptyText }}</p>
        </template>
        <p v-else-if="isMobile && !text.trim() && !searchedText" class="jira-header-search__status" role="status">
          {{ listEmptyText }}
        </p>
        <template v-else>
          <p v-if="busy" class="jira-header-search__status" role="status">
            {{ isIssueKey(text.trim()) ? "Looking up the issue…" : "Searching Jira…" }}
          </p>
          <p v-else-if="error" class="jira-header-search__status jira-header-search__status--error" role="alert">
            {{ error }}
          </p>
          <p v-else-if="searchedText && !results.length" class="jira-header-search__status">No issues found.</p>
        </template>
        <button
          v-for="(issue, index) in visibleRows"
          :key="`${issue.ref.connectionId}:${issue.ref.issueId}`"
          type="button"
          :role="isMobile ? undefined : 'option'"
          class="jira-header-search__result"
          :class="{ 'jira-header-search__result--active': index === activeIndex }"
          :aria-selected="isMobile ? undefined : index === activeIndex ? 'true' : 'false'"
          :title="issue.summary || issue.ref.issueKey"
          @mousedown.prevent
          @mouseenter="activeIndex = index"
          @click="openIssue(issue)"
        >
          <span class="jira-header-search__key">{{ issue.ref.issueKey }}</span>
          <span class="jira-header-search__summary">{{ issue.summary || "" }}</span>
          <span v-if="issue.status" class="jira-header-search__state" :data-category="issue.statusCategory || ''">{{
            issue.status
          }}</span>
          <span v-if="routes.length > 1" class="jira-header-search__source">{{ sourceLabel(issue) }}</span>
        </button>
        <button
          v-if="!showMine && searchedText && !busy && !isIssueKey(searchedText)"
          type="button"
          class="jira-header-search__all"
          :class="{ 'jira-header-search__result--active': activeIndex === results.length }"
          @mousedown.prevent
          @mouseenter="activeIndex = results.length"
          @click="showAllInInbox"
        >
          Show all results in the Jira inbox
          <span v-if="truncated" class="jira-header-search__more">(more than {{ results.length }})</span>
        </button>
        <button
          v-if="showMine"
          type="button"
          class="jira-header-search__all"
          :class="{ 'jira-header-search__result--active': activeIndex === visibleRows.length }"
          @mousedown.prevent
          @mouseenter="activeIndex = visibleRows.length"
          @click="openInboxIssues"
        >
          Open the Jira inbox
          <span v-if="myIssues.hasMore.value" class="jira-header-search__more">(counts cover your 50 latest)</span>
        </button>
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";

import { jiraViewTabId } from "../../app/jira-view-tabs.js";
import { useJiraIssueLinkRoutes } from "../../composables/useJiraIssueLinkRoutes.js";
import { useDismissable } from "../../composables/useDismissable.js";
import { useIsNarrow } from "../../composables/useIsNarrow.js";
import { jiraCandidates, jiraIssueUrl } from "../../lib/jira-issue-links.js";
import { useAppStore } from "../../stores/app.js";
import { useNotificationStore } from "../../stores/notifications.js";
import { userFacingMessage } from "../../lib/error-message.js";
import { nudgeJiraPolling } from "../../lib/jira-activity.js";
import { formatSyncAge } from "../../app/relative-age.js";
import { useJiraMyIssues, type JiraMyIssueCategory } from "../../composables/useJiraMyIssues.js";

type HeaderIssue = {
  ref: { connectionId: string; issueId: string; issueKey: string };
  summary?: string;
  status?: string;
  statusCategory?: string;
  updated?: string;
};

const RESULT_LIMIT = 10;
const DEBOUNCE_MS = 450;
const PANEL_MARGIN = 8;

const store = useAppStore();
const notifications = useNotificationStore();
const profileId = computed(() => String(store.myActiveProfileId || "default"));
const { routes } = useJiraIssueLinkRoutes(store.getApi() || {}, profileId);

const { isMobile } = useIsNarrow();

const rootRef = ref<HTMLElement | null>(null);
const chipRef = ref<HTMLButtonElement | null>(null);
const inputRef = ref<HTMLInputElement | null>(null);
const listRef = ref<HTMLElement | null>(null);
const text = ref("");
const searchedText = ref("");
const results = ref<HeaderIssue[]>([]);
const truncated = ref(false);
const busy = ref(false);
const error = ref("");
const open = ref(false);
const activeIndex = ref(-1);
const panelStyle = ref<Record<string, string>>({});
let generation = 0;
let debounceTimer: ReturnType<typeof setTimeout> | undefined;

const myIssues = useJiraMyIssues(() => store.getApi(), profileId);
/** Which of my issue lists the panel shows; null while it shows search results. */
const listMode = ref<JiraMyIssueCategory | null>(null);
const clock = ref(Date.now());
const CATEGORY_LABEL: Record<JiraMyIssueCategory, string> = { new: "To Do", indeterminate: "In Progress" };
/** The my-issues list on screen: the picked one, or on a phone with nothing typed the In Progress list, else To Do. */
const showMine = computed<JiraMyIssueCategory | null>(() => {
  if (listMode.value) return listMode.value;
  if (!isMobile.value || text.value.trim() || searchedText.value) return null;
  return (["indeterminate", "new"] as const).find((category) => myIssues.issuesIn(category).length) ?? null;
});
const visibleRows = computed<HeaderIssue[]>(() => (showMine.value ? myIssues.issuesIn(showMine.value) : results.value));
const ageText = computed(() => {
  const at = myIssues.fetchedAt.value;
  if (at === null) return "not loaded yet";
  return `synced ${formatSyncAge(at, clock.value)} ago`;
});
const syncedText = computed(() => {
  const at = myIssues.fetchedAt.value;
  if (at === null) return "";
  return `synced ${formatSyncAge(at, clock.value)} ago`;
});
const syncedHint = computed(() => (text.value ? "" : syncedText.value));
const counters = computed(() =>
  (["new", "indeterminate"] as const).map((category) => ({
    category,
    label: CATEGORY_LABEL[category],
    count: `${myIssues.issuesIn(category).length}${myIssues.hasMore.value ? "+" : ""}`,
  })),
);
const mobileAgeText = computed(() => {
  if (myIssues.loading.value) return "Refreshing…";
  const base = syncedText.value || "not loaded yet";
  const failed = myIssues.failedLabels.value;
  return failed.length ? `${base} · ${failed.join(", ")} could not be refreshed` : base;
});
const badges = computed(() =>
  (["new", "indeterminate"] as const).flatMap((category) => {
    const count = myIssues.issuesIn(category).length;
    if (!count) return [];
    const text = `${count}${myIssues.hasMore.value ? "+" : ""}`;
    const label = `My ${CATEGORY_LABEL[category]} issues: ${text}`;
    return [{ category, text, label, title: `${label} · ${ageText.value}. Click to list them.` }];
  }),
);
const listTitle = computed(() => (showMine.value ? `My ${CATEGORY_LABEL[showMine.value]}` : ""));
const listAgeText = computed(() => {
  if (myIssues.loading.value) return "Refreshing…";
  const failed = myIssues.failedLabels.value;
  return failed.length ? `${ageText.value} · ${failed.join(", ")} could not be refreshed` : ageText.value;
});
const listEmptyText = computed(() => {
  if (myIssues.loading.value) return "Loading your issues…";
  if (myIssues.failedLabels.value.length) return "Your Jira issues could not be loaded.";
  return "Nothing here.";
});

function isIssueKey(value: string): boolean {
  return /^[A-Z][A-Z0-9_]{0,19}-[1-9][0-9]*$/i.test(value);
}

function textSearchJql(value: string): string {
  const words = value.match(/[\p{L}\p{N}_]+/gu) || [];
  return words.length ? `${words.map((word) => `text ~ "${word}"`).join(" AND ")} ORDER BY updated DESC` : "";
}

function sourceLabel(issue: HeaderIssue): string {
  return routes.value.find((route) => route.connectionId === issue.ref.connectionId)?.label || "";
}

function isHeaderIssue(value: unknown): value is HeaderIssue {
  const ref = (value as HeaderIssue | null)?.ref;
  return !!ref && typeof ref.connectionId === "string" && typeof ref.issueId === "string" && !!ref.issueKey;
}

function failureText(failures: Array<{ label: string; cause: unknown }>): string {
  return failures.map(({ label, cause }) => `${label}: ${userFacingMessage(cause, "request failed")}`).join("; ");
}

function positionPanel(): void {
  const rect = (isMobile.value ? chipRef.value : inputRef.value)?.getBoundingClientRect();
  if (!rect) return;
  if (isMobile.value) {
    const top = rect.bottom + 4;
    panelStyle.value = {
      top: `${top}px`,
      left: `${PANEL_MARGIN}px`,
      width: `${Math.max(0, window.innerWidth - 2 * PANEL_MARGIN)}px`,
      maxHeight: `calc(100dvh - var(--strideterm-keyboard-bottom, 0px) - ${top}px - ${PANEL_MARGIN}px)`,
    };
    return;
  }
  const width = Math.min(Math.max(rect.width, 420), Math.max(0, window.innerWidth - 2 * PANEL_MARGIN));
  const left = Math.max(PANEL_MARGIN, Math.min(rect.left, window.innerWidth - width - PANEL_MARGIN));
  panelStyle.value = { top: `${rect.bottom + 4}px`, left: `${left}px`, width: `${width}px` };
}

function openPanel(): void {
  positionPanel();
  clock.value = Date.now();
  open.value = true;
}

function closePanel(): void {
  open.value = false;
  listMode.value = null;
  activeIndex.value = -1;
}

// Background refreshes: the runtime logs a failing request and the list shows its age, there is no action to report.
function refreshMineInBackground(load: () => Promise<unknown>): void {
  void load()
    .catch(() => undefined)
    .finally(() => {
      clock.value = Date.now();
    });
}

function toggleList(category: JiraMyIssueCategory): void {
  if (open.value && listMode.value === category) {
    closePanel();
    return;
  }
  listMode.value = category;
  activeIndex.value = -1;
  openPanel();
  refreshMineInBackground(() => myIssues.load("if-stale"));
}

function toggleMobilePanel(): void {
  if (open.value) {
    closePanel();
    return;
  }
  openPanel();
  nudgeJiraPolling(store.getApi());
  refreshMineInBackground(() => myIssues.refreshIfOld());
  void nextTick(() => inputRef.value?.focus());
}

function selectMobileList(category: JiraMyIssueCategory): void {
  generation++;
  if (debounceTimer) clearTimeout(debounceTimer);
  busy.value = false;
  text.value = "";
  searchedText.value = "";
  results.value = [];
  error.value = "";
  listMode.value = category;
  activeIndex.value = -1;
}

async function refreshMine(): Promise<void> {
  try {
    const rows = await myIssues.load("force");
    const failed = (rows || []).filter((row) => row.error).map((row) => row.label);
    if (failed.length) notifications.showError("Some Jira connections could not be refreshed", failed.join(", "));
  } catch (cause) {
    notifications.showError("Could not refresh your Jira issues", userFacingMessage(cause, "Jira did not answer."));
  } finally {
    clock.value = Date.now();
  }
}

async function openInboxIssues(): Promise<void> {
  closePanel();
  try {
    const workspaceId = await ensureJiraInbox();
    if (!workspaceId)
      throw new Error("The Jira inbox does not exist in this profile yet. Create it on the desktop first.");
    await store.activateWorkspace(workspaceId);
    await store.activateView(jiraViewTabId(workspaceId, "issues"));
  } catch (cause) {
    notifications.showError("Could not open the Jira inbox", userFacingMessage(cause, "Could not open Jira."));
  }
}

useDismissable(open, [rootRef, listRef], { onDismiss: closePanel, eventName: "mousedown" });

function onFocus(): void {
  if (isMobile.value) return;
  // Warms the connection and my issues while the user is still deciding what to type.
  nudgeJiraPolling(store.getApi());
  refreshMineInBackground(() => myIssues.refreshIfOld());
  if (searchedText.value && searchedText.value === text.value.trim()) openPanel();
}

function onInput(): void {
  listMode.value = null;
  if (debounceTimer) clearTimeout(debounceTimer);
  const value = text.value.trim();
  if (value.length < 2 || isIssueKey(value)) {
    if (!value) {
      generation++;
      busy.value = false;
      searchedText.value = "";
      results.value = [];
      error.value = "";
      if (isMobile.value) activeIndex.value = -1;
      else closePanel();
    }
    return;
  }
  debounceTimer = setTimeout(() => void runSearch(value, false), DEBOUNCE_MS);
}

async function lookupKey(key: string, current: number): Promise<HeaderIssue[] | null> {
  const api = store.getApi();
  if (!api?.getJiraIssue) throw new Error("Jira is unavailable in this client.");
  const candidates = jiraCandidates(key, routes.value);
  const targets = candidates.length ? candidates : routes.value;
  const settled = await Promise.allSettled(
    targets.map((route) => api.getJiraIssue!({ connectionId: route.connectionId, issueId: key.toUpperCase() })),
  );
  if (current !== generation) return null;
  const found = settled.flatMap((entry) =>
    entry.status === "fulfilled" && isHeaderIssue(entry.value) ? [entry.value] : [],
  );
  if (!found.length && candidates.length) {
    const failures = settled.flatMap((entry, index) =>
      entry.status === "rejected" ? [{ label: targets[index].label, cause: entry.reason }] : [],
    );
    if (failures.length) throw new Error(failureText(failures));
  }
  return found;
}

async function textSearch(value: string, current: number): Promise<HeaderIssue[] | null> {
  const api = store.getApi();
  if (!api?.searchJiraIssues) throw new Error("Jira search is unavailable in this client.");
  const jql = textSearchJql(value);
  if (!jql) throw new Error("Enter an issue key or at least one word to search.");
  const targets = routes.value;
  const settled = await Promise.allSettled(
    targets.map((route) => api.searchJiraIssues!({ connectionId: route.connectionId, jql, limit: RESULT_LIMIT })),
  );
  if (current !== generation) return null;
  let more = false;
  const rows = settled.flatMap((entry) => {
    if (entry.status !== "fulfilled") return [];
    const result = entry.value as HeaderIssue[] | { issues?: unknown[]; hasMore?: boolean; truncated?: boolean };
    const list = Array.isArray(result) ? result : result?.issues || [];
    if (!Array.isArray(result) && (result?.hasMore === true || result?.truncated === true)) more = true;
    return list.filter(isHeaderIssue);
  });
  const failures = settled.flatMap((entry, index) =>
    entry.status === "rejected" ? [{ label: targets[index].label, cause: entry.reason }] : [],
  );
  if (failures.length && !rows.length) throw new Error(failureText(failures));
  if (failures.length)
    notifications.showError("Some Jira connections could not be searched", new Error(failureText(failures)));
  rows.sort((left, right) => Date.parse(right.updated || "") - Date.parse(left.updated || ""));
  truncated.value = more || rows.length > RESULT_LIMIT;
  return rows.slice(0, RESULT_LIMIT);
}

async function runSearch(value: string, openSingleKey: boolean): Promise<void> {
  if (debounceTimer) clearTimeout(debounceTimer);
  const current = ++generation;
  busy.value = true;
  error.value = "";
  results.value = [];
  truncated.value = false;
  searchedText.value = value;
  activeIndex.value = -1;
  openPanel();
  try {
    let found: HeaderIssue[] | null = null;
    if (isIssueKey(value)) {
      found = await lookupKey(value, current);
      if (found === null) return;
      if (found.length === 1 && openSingleKey) {
        busy.value = false;
        await openIssue(found[0]);
        return;
      }
      // Something like "UTF-8" looks like a key but names no issue: search it as text instead.
      if (!found.length) {
        searchedText.value = value.replace(/-/g, " ");
        found = await textSearch(searchedText.value, current);
      }
    } else {
      found = await textSearch(value, current);
    }
    if (found === null) return;
    results.value = found;
    activeIndex.value = found.length ? 0 : -1;
  } catch (cause) {
    if (current !== generation) return;
    const message = userFacingMessage(cause, "Jira search failed.");
    error.value = message;
    notifications.showError("Jira search failed", message);
  } finally {
    if (current === generation) busy.value = false;
  }
}

function jiraInboxId(): string {
  return (
    (store.payload?.appState?.workspaces || []).find(
      (workspace) => workspace.kind === "jira" && (workspace.profileId || "default") === profileId.value,
    )?.id || ""
  );
}

async function ensureJiraInbox(): Promise<string> {
  const existing = jiraInboxId();
  if (existing) return existing;
  if (store.isMobileSession()) return "";
  const api = store.getApi() as { ensureJiraWorkspace?: () => Promise<unknown> };
  if (!api.ensureJiraWorkspace) return "";
  const result = (await api.ensureJiraWorkspace()) as { id?: string; workspaceId?: string };
  const workspaceId = result.workspaceId || result.id || "";
  if (!workspaceId) throw new Error("The Jira workspace was not returned by the runtime.");
  return workspaceId;
}

async function openIssue(issue: HeaderIssue): Promise<void> {
  closePanel();
  try {
    const workspaceId = await ensureJiraInbox();
    if (workspaceId) {
      store.requestJiraIssueOpen(workspaceId, issue.ref);
      await store.activateWorkspace(workspaceId);
      return;
    }
    const route = routes.value.find((item) => item.connectionId === issue.ref.connectionId);
    const url = route ? jiraIssueUrl(route, issue.ref.issueKey) : null;
    const api = store.getApi();
    if (!url || !api?.openExternal) throw new Error("There is no Jira inbox in this profile to open the issue in.");
    await api.openExternal(url);
  } catch (cause) {
    notifications.showError(
      `Could not open ${issue.ref.issueKey}`,
      userFacingMessage(cause, "Could not open the issue."),
    );
  }
}

async function showAllInInbox(): Promise<void> {
  const value = searchedText.value;
  closePanel();
  try {
    const workspaceId = await ensureJiraInbox();
    if (!workspaceId)
      throw new Error("The Jira inbox does not exist in this profile yet. Create it on the desktop first.");
    store.requestJiraSearch(workspaceId, value);
    await store.activateWorkspace(workspaceId);
    await store.activateView(jiraViewTabId(workspaceId, "issues"));
  } catch (cause) {
    notifications.showError("Could not show the Jira results", userFacingMessage(cause, "Could not open Jira."));
  }
}

function onKeydown(event: KeyboardEvent): void {
  const footer = showMine.value || (searchedText.value && !isIssueKey(searchedText.value)) ? 1 : 0;
  const optionCount = visibleRows.value.length + footer;
  if (event.key === "Escape") {
    if (open.value) closePanel();
    else inputRef.value?.blur();
    return;
  }
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    if (!open.value || !optionCount) return;
    event.preventDefault();
    const step = event.key === "ArrowDown" ? 1 : -1;
    activeIndex.value = (activeIndex.value + step + optionCount) % optionCount;
    return;
  }
  if (event.key !== "Enter") return;
  event.preventDefault();
  if (open.value && showMine.value) {
    if (activeIndex.value >= 0 && activeIndex.value < visibleRows.value.length)
      void openIssue(visibleRows.value[activeIndex.value]);
    else if (activeIndex.value === visibleRows.value.length) void openInboxIssues();
    return;
  }
  const value = text.value.trim();
  if (!value) return;
  const settled = open.value && !busy.value && value === searchedText.value;
  if (settled && activeIndex.value >= 0 && activeIndex.value < results.value.length) {
    void openIssue(results.value[activeIndex.value]);
    return;
  }
  if (settled && activeIndex.value === results.value.length && optionCount > results.value.length) {
    void showAllInInbox();
    return;
  }
  void runSearch(value, true);
}

function onWindowChange(): void {
  if (open.value) void nextTick(positionPanel);
}
function onWindowFocus(): void {
  if (!routes.value.length) return;
  nudgeJiraPolling(store.getApi());
  refreshMineInBackground(() => myIssues.refreshIfOld());
}
watch(isMobile, closePanel);
watch(
  () => routes.value.length > 0,
  (hasRoutes) => {
    if (hasRoutes) refreshMineInBackground(() => myIssues.ensureLoaded());
  },
  { immediate: true },
);
window.addEventListener("resize", onWindowChange);
window.addEventListener("focus", onWindowFocus);
const clockTimer = setInterval(() => {
  clock.value = Date.now();
}, 60_000);
onBeforeUnmount(() => {
  clearInterval(clockTimer);
  window.removeEventListener("resize", onWindowChange);
  window.removeEventListener("focus", onWindowFocus);
  if (debounceTimer) clearTimeout(debounceTimer);
  generation++;
});
</script>

<style scoped>
.jira-header-search {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: 0 1 300px;
  min-width: 160px;
  -webkit-app-region: no-drag;
}
.jira-header-search__badge {
  flex: 0 0 auto;
  min-width: 22px;
  height: 20px;
  padding: 0 7px;
  border-radius: 999px;
  border: 1px solid rgba(var(--tint), 0.16);
  background: rgba(var(--tint), 0.08);
  color: var(--muted);
  font: inherit;
  font-size: 11px;
  font-weight: 600;
  line-height: 18px;
  cursor: pointer;
}
.jira-header-search__badge[aria-pressed="true"],
.jira-header-search__badge:hover {
  background: rgba(var(--tint), 0.16);
}
.jira-header-search__mine-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 6px 8px 4px;
  border-bottom: 1px solid rgba(var(--tint), 0.1);
  margin-bottom: 2px;
}
.jira-header-search__mine-title {
  font-weight: 600;
}
.jira-header-search__mine-age {
  flex: 1 1 auto;
  min-width: 0;
  color: var(--muted);
  font-size: 11px;
  overflow-wrap: anywhere;
}
.jira-header-search__mine-refresh {
  flex: 0 0 auto;
  padding: 1px 8px;
  border-radius: 6px;
  border: 1px solid rgba(var(--tint), 0.16);
  background: transparent;
  color: var(--text);
  font: inherit;
  font-size: 11px;
  cursor: pointer;
}
.jira-header-search__mine-refresh:disabled {
  opacity: 0.5;
  cursor: default;
}
.jira-header-search__field {
  position: relative;
  display: flex;
  flex: 1 1 auto;
  min-width: 0;
  container-type: inline-size;
}
@container (max-width: 200px) {
  .jira-header-search__synced {
    display: none;
  }
}
.jira-header-search--mobile {
  flex: 0 0 auto;
  min-width: 0;
}
.jira-header-search__chip {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
}
.jira-header-search__caret {
  flex: 0 0 auto;
  width: 10px;
  height: 10px;
  margin-left: 4px;
  opacity: 0.75;
}
.jira-header-search__tools {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 4px 4px 8px;
}
.jira-header-search__input--panel {
  height: 40px;
  padding: 0 12px;
  border-radius: 8px;
  font-size: 16px;
}
.jira-header-search__counters {
  display: flex;
  align-items: center;
  gap: 6px;
}
.jira-header-search__counter {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 32px;
  padding: 0 10px;
  border-radius: 999px;
  border: 1px solid rgba(var(--tint), 0.16);
  background: rgba(var(--tint), 0.08);
  color: var(--text);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.jira-header-search__counter[aria-pressed="true"] {
  background: rgba(var(--tint), 0.18);
  border-color: color-mix(in srgb, var(--accent, var(--text)), transparent 40%);
}
.jira-header-search__counter-count {
  font-weight: 600;
}
.jira-header-search__mobile-age {
  flex: 1 1 auto;
  min-width: 0;
  color: var(--muted);
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.jira-header-search__counters .jira-header-search__mine-refresh {
  min-height: 32px;
  padding: 0 10px;
}
.jira-header-search__synced {
  position: absolute;
  right: 10px;
  top: 50%;
  transform: translateY(-50%);
  pointer-events: none;
  color: var(--muted);
  font-size: 11px;
  white-space: nowrap;
}
.jira-header-search__input {
  flex: 1 1 auto;
  min-width: 0;
  width: 100%;
  box-sizing: border-box;
  height: 24px;
  padding: 2px 10px;
  border-radius: 999px;
  border: 1px solid rgba(var(--tint), 0.14);
  background: rgba(var(--tint), 0.07);
  color: var(--text);
  font-size: 12px;
}
.jira-header-search__input:focus {
  outline: none;
  border-color: color-mix(in srgb, var(--accent, var(--text)), transparent 40%);
}
.jira-header-search__panel {
  position: fixed;
  z-index: 1000;
  box-sizing: border-box;
  max-height: min(420px, 70vh);
  overflow-x: hidden;
  overflow-y: auto;
  padding: 4px;
  border-radius: 8px;
  border: 1px solid rgba(var(--tint), 0.16);
  background: var(--panel, var(--bg));
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
  font-size: 12px;
}
.jira-header-search__status {
  margin: 0;
  padding: 8px 10px;
  color: var(--muted);
}
.jira-header-search__status--error {
  color: var(--danger, #e5534b);
  white-space: normal;
  overflow-wrap: anywhere;
}
.jira-header-search__result,
.jira-header-search__all {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 8px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--text);
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.jira-header-search__result--active {
  background: rgba(var(--tint), 0.1);
}
.jira-header-search__key {
  flex: 0 0 auto;
  font-weight: 600;
  white-space: nowrap;
}
.jira-header-search__summary {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.jira-header-search__state,
.jira-header-search__source {
  flex: 0 0 auto;
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding: 1px 6px;
  border-radius: 999px;
  background: rgba(var(--tint), 0.08);
  color: var(--muted);
  font-size: 11px;
}
.jira-header-search__state[data-category="indeterminate"] {
  color: var(--text);
}
.jira-header-search__all {
  margin-top: 2px;
  border-top: 1px solid rgba(var(--tint), 0.1);
  border-radius: 0 0 6px 6px;
  color: var(--muted);
}
.jira-header-search__more {
  color: var(--muted);
}
</style>
