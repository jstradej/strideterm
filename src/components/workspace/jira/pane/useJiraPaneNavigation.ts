import { computed, ref } from "vue";
import type { JiraPaneContext } from "./jira-pane-context.js";
import type { JiraIssue } from "./jira-pane-types.js";

const ROW_GROUPS = ".jira-results, .jira-native-issue-list, .jira-board-unmapped, .jira-sprint-issues";
const PROTECTED_REGIONS = "[role=menu], [role=dialog], [role=listbox], .custom-select, .jira-write-card";

function isEditable(element: HTMLElement) {
  if (["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName)) return true;
  if (element.isContentEditable) return true;
  const editable = element.getAttribute("contenteditable");
  return editable !== null && editable !== "false";
}

function navKeyOf(issue: { ref?: { connectionId?: string; issueId?: string }; id?: string; key?: string }) {
  return `${issue.ref?.connectionId || ""}:${issue.ref?.issueId || issue.id || issue.key || ""}`;
}

/**
 * Keyboard model and the board drawer. Keys are handled by the pane root only, so they can never reach a terminal
 * or another pane, and never while the user types in a field. The list is one Tab stop (roving tabindex).
 */
export function useJiraPaneNavigation(ctx: JiraPaneContext) {
  const rovingKey = ref("");

  /** Wide pane + board columns on screen: an opened card shows as a drawer beside them. */
  const boardDrawerMode = computed(
    () =>
      ctx.boardIssueDetailOpen.value &&
      !ctx.isCompactPane.value &&
      !ctx.nativeListPresentation.value &&
      ctx.boardColumns.value.length > 0,
  );

  const navigableIssues = computed<JiraIssue[]>(() => {
    if (ctx.nativeListPresentation.value) return ctx.nativeVisibleIssues.value as unknown as JiraIssue[];
    if (ctx.activeView.value === "issues") return ctx.visibleIssueList.value as unknown as JiraIssue[];
    const columns = ctx.nativeBoardColumnViews.value;
    const fromColumns = columns ? columns.flatMap((column) => column.issues) : [];
    return [...fromColumns, ...ctx.unmappedBoardIssues.value, ...ctx.sprintIssues.value] as unknown as JiraIssue[];
  });
  const effectiveRovingKey = computed(() => {
    const keys = navigableIssues.value.map(navKeyOf);
    return keys.includes(rovingKey.value) ? rovingKey.value : (keys[0] ?? "");
  });

  /** Binds the keyboard attributes of one issue row; spread it with `v-bind`. */
  function navRow(issue: JiraIssue) {
    const key = navKeyOf(issue);
    return { "data-nav-row": "", "data-nav-key": key, tabindex: effectiveRovingKey.value === key ? 0 : -1 };
  }

  function issueForRow(row: HTMLElement) {
    const key = row.dataset.navKey;
    return navigableIssues.value.find((issue) => navKeyOf(issue) === key);
  }

  function focusRow(row: HTMLElement, options: { follow: boolean }) {
    rovingKey.value = row.dataset.navKey || "";
    row.focus({ preventScroll: true });
    row.scrollIntoView?.({ block: "nearest" });
    if (!options.follow) return;
    const issue = issueForRow(row);
    if (issue) void ctx.openIssue(issue, { currentTarget: row });
  }

  function onPaneFocusin(event: FocusEvent) {
    const row = event.target instanceof HTMLElement ? event.target.closest<HTMLElement>("[data-nav-row]") : null;
    if (row?.dataset.navKey) rovingKey.value = row.dataset.navKey;
  }

  function rowsIn(container: ParentNode | null) {
    return container ? Array.from(container.querySelectorAll<HTMLElement>("[data-nav-row]")) : [];
  }

  function moveInList(row: HTMLElement, step: number | "first" | "last", follow: boolean) {
    const column = row.closest<HTMLElement>(".jira-board-column");
    const rows = rowsIn(column?.querySelector(".jira-board-column__cards") ?? row.closest(ROW_GROUPS));
    const index = rows.indexOf(row);
    if (index < 0) return;
    const next = step === "first" ? rows[0] : step === "last" ? rows[rows.length - 1] : rows[index + step] || undefined;
    if (next && next !== row) focusRow(next, { follow });
  }

  function moveBetweenColumns(row: HTMLElement, direction: 1 | -1, follow: boolean) {
    const column = row.closest<HTMLElement>(".jira-board-column");
    const columns = column
      ? Array.from(column.parentElement?.querySelectorAll<HTMLElement>(".jira-board-column") ?? [])
      : [];
    let index = columns.indexOf(column as HTMLElement);
    if (index < 0) return;
    const rowIndex = Math.max(0, rowsIn(column).indexOf(row));
    for (index += direction; index >= 0 && index < columns.length; index += direction) {
      const candidates = rowsIn(columns[index]);
      if (!candidates.length) continue;
      focusRow(candidates[Math.min(rowIndex, candidates.length - 1)], { follow });
      return;
    }
  }

  function onEscape(event: KeyboardEvent) {
    if (!ctx.selected.value && !ctx.boardIssueDetailOpen.value) return;
    event.preventDefault();
    ctx.clearSelectedIssue();
  }

  function onPaneKeydown(event: KeyboardEvent) {
    if (event.defaultPrevented) return;
    const root = ctx.jiraRootRef.value;
    const target = event.target;
    if (!root || !(target instanceof HTMLElement) || !root.contains(target)) return;
    if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return;
    if (event.key === "Escape") {
      if (!isEditable(target) && !target.closest(PROTECTED_REGIONS)) onEscape(event);
      return;
    }
    if (isEditable(target) || target.closest(PROTECTED_REGIONS)) return;
    if (event.key === "/") {
      const input = ctx.quickSearchInputRef.value;
      if (!input) return;
      event.preventDefault();
      input.focus();
      input.select();
      return;
    }
    const row = target.closest<HTMLElement>("[data-nav-row]");
    if (!row) return;
    const follow = Boolean(ctx.selected.value || ctx.boardIssueDetailOpen.value);
    const inColumn = Boolean(row.closest(".jira-board-column"));
    switch (event.key) {
      case "j":
      case "ArrowDown":
        event.preventDefault();
        moveInList(row, 1, follow);
        break;
      case "k":
      case "ArrowUp":
        event.preventDefault();
        moveInList(row, -1, follow);
        break;
      case "Home":
        event.preventDefault();
        moveInList(row, "first", follow);
        break;
      case "End":
        event.preventDefault();
        moveInList(row, "last", follow);
        break;
      case "ArrowRight":
      case "ArrowLeft":
        if (!inColumn) return;
        event.preventDefault();
        moveBetweenColumns(row, event.key === "ArrowRight" ? 1 : -1, follow);
        break;
      case "Enter": {
        const issue = issueForRow(row);
        if (!issue) return;
        event.preventDefault();
        void ctx.openIssue(issue, { currentTarget: row });
        break;
      }
    }
  }

  return { boardDrawerMode, navRow, onPaneKeydown, onPaneFocusin };
}
