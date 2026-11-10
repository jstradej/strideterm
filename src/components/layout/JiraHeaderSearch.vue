<template>
  <div v-if="routes.length" ref="rootRef" class="jira-header-search">
    <input
      ref="inputRef"
      v-model="text"
      type="search"
      class="jira-header-search__input"
      placeholder="Search Jira or open an issue key…"
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
    <Teleport to="body">
      <div
        v-if="open"
        ref="listRef"
        class="jira-header-search__panel"
        :style="panelStyle"
        role="listbox"
        aria-label="Jira search results"
      >
        <p v-if="busy" class="jira-header-search__status" role="status">
          {{ isIssueKey(text.trim()) ? "Looking up the issue…" : "Searching Jira…" }}
        </p>
        <p v-else-if="error" class="jira-header-search__status jira-header-search__status--error" role="alert">
          {{ error }}
        </p>
        <p v-else-if="searchedText && !results.length" class="jira-header-search__status">No issues found.</p>
        <button
          v-for="(issue, index) in results"
          :key="`${issue.ref.connectionId}:${issue.ref.issueId}`"
          type="button"
          role="option"
          class="jira-header-search__result"
          :class="{ 'jira-header-search__result--active': index === activeIndex }"
          :aria-selected="index === activeIndex ? 'true' : 'false'"
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
          v-if="searchedText && !busy && !isIssueKey(searchedText)"
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
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref } from "vue";

import { jiraViewTabId } from "../../app/jira-view-tabs.js";
import { useJiraIssueLinkRoutes } from "../../composables/useJiraIssueLinkRoutes.js";
import { useDismissable } from "../../composables/useDismissable.js";
import { jiraCandidates, jiraIssueUrl } from "../../lib/jira-issue-links.js";
import { useAppStore } from "../../stores/app.js";
import { useNotificationStore } from "../../stores/notifications.js";
import { userFacingMessage } from "../../lib/error-message.js";
import { nudgeJiraPolling } from "../../lib/jira-activity.js";

type HeaderIssue = {
  ref: { connectionId: string; issueId: string; issueKey: string };
  summary?: string;
  status?: string;
  statusCategory?: string;
  updated?: string;
};

const RESULT_LIMIT = 10;
const DEBOUNCE_MS = 450;

const store = useAppStore();
const notifications = useNotificationStore();
const profileId = computed(() => String(store.myActiveProfileId || "default"));
const { routes } = useJiraIssueLinkRoutes(store.getApi() || {}, profileId);

const rootRef = ref<HTMLElement | null>(null);
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
  const rect = inputRef.value?.getBoundingClientRect();
  if (!rect) return;
  const width = Math.max(rect.width, 420);
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
  panelStyle.value = { top: `${rect.bottom + 4}px`, left: `${left}px`, width: `${width}px` };
}

function openPanel(): void {
  positionPanel();
  open.value = true;
}

function closePanel(): void {
  open.value = false;
  activeIndex.value = -1;
}

useDismissable(open, [rootRef, listRef], { onDismiss: closePanel, eventName: "mousedown" });

function onFocus(): void {
  nudgeJiraPolling(store.getApi());
  if (searchedText.value && searchedText.value === text.value.trim()) openPanel();
}

function onInput(): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  const value = text.value.trim();
  if (value.length < 2 || isIssueKey(value)) {
    if (!value) {
      generation++;
      busy.value = false;
      searchedText.value = "";
      results.value = [];
      error.value = "";
      closePanel();
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
  const optionCount = results.value.length + (searchedText.value && !isIssueKey(searchedText.value) ? 1 : 0);
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
  if (routes.value.length) nudgeJiraPolling(store.getApi());
}
window.addEventListener("resize", onWindowChange);
window.addEventListener("focus", onWindowFocus);
onBeforeUnmount(() => {
  window.removeEventListener("resize", onWindowChange);
  window.removeEventListener("focus", onWindowFocus);
  if (debounceTimer) clearTimeout(debounceTimer);
  generation++;
});
</script>

<style scoped>
.jira-header-search {
  flex: 0 1 340px;
  min-width: 160px;
  -webkit-app-region: no-drag;
}
.jira-header-search__input {
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
  max-height: min(420px, 70vh);
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
