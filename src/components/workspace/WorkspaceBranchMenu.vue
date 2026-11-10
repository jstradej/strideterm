<template>
  <button
    ref="chipRef"
    type="button"
    class="workspace-chip workspace-chip--btn workspace-branch-chip"
    :class="summary.dirty ? 'workspace-chip--dirty' : 'workspace-chip--clean'"
    :title="title"
    aria-haspopup="menu"
    :aria-expanded="open ? 'true' : 'false'"
    data-role="workspace-branch-chip"
    @click="toggle"
  >
    <strong class="workspace-chip__branch">{{ summary.branch }}</strong>
    <span v-if="summary.dirty" style="margin-left: 4px">{{ summary.dirtyCount }} uncommitted</span>
    <span v-else style="margin-left: 4px">clean</span>
    <span class="disclosure-chevron disclosure-chevron--down workspace-branch-chip__caret" aria-hidden="true" />
  </button>

  <Teleport to="body">
    <div
      v-if="open"
      ref="popoverRef"
      class="branch-menu"
      role="menu"
      :style="popoverStyle"
      data-role="workspace-branch-menu"
      @keydown="onKeydown"
    >
      <div class="branch-menu__head">
        <input
          ref="searchRef"
          v-model="query"
          type="text"
          class="branch-menu__search"
          placeholder="Search for branches and actions"
          aria-label="Search for branches and actions"
        />
        <select
          v-if="roots.length > 1"
          class="branch-menu__root"
          :value="rootPath"
          title="Repository the actions below run in"
          aria-label="Repository"
          @change="onRootChange(($event.target as HTMLSelectElement).value)"
        >
          <option v-for="root in roots" :key="root" :value="root">{{ rootLabel(root) }}</option>
        </select>
      </div>
      <p v-if="busyLabel" class="branch-menu__status">{{ busyLabel }}</p>

      <ul ref="listRef" class="branch-menu__list">
        <template v-for="(row, idx) in rows" :key="row.key">
          <li v-if="row.kind === 'divider'" class="branch-menu__divider" role="separator" />
          <li
            v-else-if="row.kind === 'note'"
            :class="['branch-menu__note', row.error && 'branch-menu__note--error']"
            role="presentation"
          >
            {{ row.label }}
          </li>
          <li
            v-else
            :class="[
              'branch-menu__row',
              `branch-menu__row--${row.kind}`,
              idx === activeIndex && 'branch-menu__row--active',
              row.kind === 'branch' && row.current && 'branch-menu__row--current',
              row.kind === 'branch' && menuFor?.key === row.key && 'branch-menu__row--open',
              row.kind === 'action' && row.disabled && !row.running && 'branch-menu__row--disabled',
            ]"
            :role="row.kind === 'section' || row.kind === 'folder' ? 'treeitem' : 'menuitem'"
            :aria-disabled="row.kind === 'action' && row.disabled ? 'true' : undefined"
            :aria-expanded="row.kind === 'section' || row.kind === 'folder' ? row.expanded : undefined"
            :title="row.title"
            :data-row-index="idx"
            @mouseenter="onRowHover(idx)"
            @click="activateRow(idx)"
          >
            <span class="branch-menu__indent" :style="{ width: `${row.depth * 14}px` }" />
            <span
              v-if="row.kind === 'section' || row.kind === 'folder'"
              :class="['disclosure-chevron', row.expanded && 'disclosure-chevron--open']"
              aria-hidden="true"
            />
            <span v-if="row.icon" :class="['branch-menu__icon', `branch-menu__icon--${row.iconKind}`]">{{
              row.icon
            }}</span>
            <span class="branch-menu__label">{{ row.label }}</span>
            <Spinner v-if="row.kind === 'action' && row.running" size="sm" :label="`${row.label}…`" />
            <span v-if="row.hint" class="branch-menu__hint">{{ row.hint }}</span>
            <span
              v-if="row.kind === 'branch'"
              class="disclosure-chevron branch-menu__submenu-caret"
              :class="menuInline && menuFor?.key === row.key && 'disclosure-chevron--open'"
              aria-hidden="true"
            />
          </li>
          <li v-if="row.kind === 'branch' && menuInline && menuFor?.key === row.key" class="branch-menu__inline">
            <BranchActionList
              :items="menuItems"
              :active-index="subActiveIndex"
              @run="runMenuItem"
              @hover="subActiveIndex = $event"
            />
          </li>
        </template>
      </ul>
    </div>

    <div
      v-if="open && menuFor && !menuInline"
      ref="submenuRef"
      class="branch-menu branch-menu--sub"
      :style="submenuStyle"
    >
      <BranchActionList
        :items="menuItems"
        :active-index="subActiveIndex"
        @run="runMenuItem"
        @hover="subActiveIndex = $event"
      />
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import {
  computed,
  defineComponent,
  h,
  nextTick,
  onBeforeUnmount,
  onMounted,
  reactive,
  ref,
  watch,
  type PropType,
} from "vue";
import { useAppStore } from "../../stores/app.js";
import { useGitUiStore } from "../../stores/git-ui.js";
import { useDismissable } from "../../composables/useDismissable.js";
import { useResourceInterest } from "../../composables/useResourceInterest.js";
import { buildBranchForest, type BranchForestNode } from "./git/branch-forest.js";
import { useBranchActions } from "./git/branch-actions.js";
import Spinner from "../common/Spinner.vue";

const props = defineProps<{
  workspaceId: string;
  summary: { branch: string; dirty: boolean; dirtyCount: number };
  title: string;
}>();

interface MenuItem {
  id: string;
  label: string;
  disabled?: boolean;
  danger?: boolean;
  title?: string;
  divider?: boolean;
  run?: () => unknown;
}

const BranchActionList = defineComponent({
  props: {
    items: { type: Array as PropType<MenuItem[]>, required: true },
    activeIndex: { type: Number, required: true },
  },
  emits: ["run", "hover"],
  setup(listProps, { emit }) {
    return () =>
      h(
        "ul",
        { class: "branch-menu__actions", role: "menu" },
        listProps.items.map((item, idx) =>
          item.divider
            ? h("li", { key: item.id, class: "branch-menu__divider", role: "separator" })
            : h(
                "li",
                {
                  key: item.id,
                  role: "menuitem",
                  title: item.title,
                  "aria-disabled": item.disabled ? "true" : undefined,
                  class: [
                    "branch-menu__row",
                    "branch-menu__row--action",
                    idx === listProps.activeIndex && "branch-menu__row--active",
                    item.disabled && "branch-menu__row--disabled",
                    item.danger && "branch-menu__row--danger",
                  ],
                  onClick: () => emit("run", item),
                  onMouseenter: () => emit("hover", idx),
                },
                [h("span", { class: "branch-menu__label" }, item.label)],
              ),
        ),
      );
  },
});

interface LocalBranch {
  name: string;
  isCurrent: boolean;
  upstream: string;
  ahead: number;
  behind: number;
  lastCommitTimestamp: number;
  lastRelativeDate?: string;
  lastSubject?: string;
  merged: boolean;
  worktreePath?: string;
}
interface RemoteBranch {
  name: string;
  remote: string;
  lastCommitTimestamp: number;
  lastRelativeDate?: string;
  lastSubject?: string;
}

interface BaseRow {
  key: string;
  depth: number;
  label: string;
  icon?: string;
  iconKind?: string;
  hint?: string;
  title?: string;
}
type Row =
  | (BaseRow & { kind: "action"; disabled: boolean; run: () => unknown; keepOpen?: boolean; running?: boolean })
  | (BaseRow & { kind: "section" | "folder"; expanded: boolean })
  | (BaseRow & { kind: "branch"; ref: string; remote: boolean; current: boolean; local?: LocalBranch })
  | (BaseRow & { kind: "divider" })
  | (BaseRow & { kind: "note"; error?: boolean });
type BranchRow = Extract<Row, { kind: "branch" }>;

const RECENT_LIMIT = 5;

const appStore = useAppStore();
const gitUiStore = useGitUiStore();

const open = ref(false);
const query = ref("");
const activeIndex = ref(-1);
const chipRef = ref<HTMLButtonElement | null>(null);
const popoverRef = ref<HTMLElement | null>(null);
const submenuRef = ref<HTMLElement | null>(null);
const searchRef = ref<HTMLInputElement | null>(null);
const listRef = ref<HTMLElement | null>(null);
const popoverStyle = ref<Record<string, string>>({});
const submenuStyle = ref<Record<string, string>>({});
const expanded = reactive<Record<string, boolean>>({});
const menuFor = ref<BranchRow | null>(null);
const menuInline = ref(false);
const subActiveIndex = ref(-1);

useResourceInterest(() => (open.value && props.workspaceId ? `git:${props.workspaceId}` : null));

const gitUi = computed(() => gitUiStore.get(props.workspaceId));
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- git workspace entry is open-ended server JSON
const gitEntry = computed<any>(() => appStore.getGitWorkspaceEntry(props.workspaceId));
const roots = computed<string[]>(() => Object.keys(gitEntry.value?.roots || {}));
const rootPath = computed(
  () => gitUiStore.getActiveRoot(props.workspaceId) || String(gitEntry.value?.primaryRoot || ""),
);
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- git snapshot is open-ended server JSON
const snapshot = computed<any>(() =>
  appStore.getGitSnapshot(props.workspaceId, gitUiStore.getActiveRoot(props.workspaceId) || null),
);

const branchList = computed(() => {
  const bl = gitUi.value.branchList;
  return {
    current: String(bl?.current || snapshot.value?.branch || props.summary.branch || ""),
    local: (bl?.local || []) as LocalBranch[],
    remotes: (bl?.remotes || []) as RemoteBranch[],
    defaultBranch: String(bl?.defaultBranch || snapshot.value?.defaultBranch || ""),
  };
});
const remoteNames = computed(() =>
  Array.from(
    new Set([
      ...Object.keys(snapshot.value?.remotes || {}).filter((name) => name && !name.includes(":")),
      ...branchList.value.remotes.map((r) => r.remote),
    ]),
  ).filter(Boolean),
);

const currentBranch = computed(() => {
  const branch = branchList.value.current;
  return branch && branch !== "HEAD" ? branch : "";
});
const busy = computed(
  () => !!gitUi.value.busyAction || !!gitUi.value.pendingAction || !!appStore.isReviewGitBusy?.(props.workspaceId),
);
const busyLabel = computed(() => {
  // A fetch shows its spinner on its own row instead.
  if (gitUi.value.busyAction === "fetch") return "";
  if (gitUi.value.busyAction) return String(gitUi.value.busyPhase || "Git action running…");
  if (gitUi.value.pendingAction) return "A Git action is waiting for confirmation in the Git tab.";
  return "";
});
const dirty = computed(() => !!(snapshot.value?.dirty ?? props.summary.dirty));
const isDiverged = computed(() => {
  const s = snapshot.value;
  return !!(s && s.aheadCount > 0 && s.behindCount > 0 && s.upstream);
});
const pushRemote = computed(() => {
  const upstream = String(snapshot.value?.upstream || "");
  return remoteNames.value.find((r) => upstream.startsWith(`${r}/`)) || remoteNames.value[0] || "origin";
});

// ---- Top actions --------------------------------------------------------------

const updateAction = computed(() => {
  const s = snapshot.value;
  const upstream = String(s?.upstream || "");
  const strategy = String(appStore.payload?.appState?.settings?.git?.ui?.updateStrategy || "rebase");
  let disabledReason = "";
  if (!s) disabledReason = "Repository state is still loading.";
  else if (!currentBranch.value) disabledReason = "HEAD is detached — check out a branch first.";
  else if (!upstream) disabledReason = "This branch has no upstream. Push it first to publish and track it.";
  else if (busy.value) disabledReason = "Another Git action is running.";
  const hint = isDiverged.value
    ? `↑${s.aheadCount} ↓${s.behindCount}`
    : s?.behindCount
      ? `↓${s.behindCount}`
      : upstream;
  const title =
    disabledReason ||
    (isDiverged.value
      ? `Your branch and ${upstream} both have new commits. Downloads the remote commits, then ${
          strategy === "merge"
            ? `merges ${upstream} into ${currentBranch.value} with a merge commit`
            : `replays your commits on top of ${upstream} (their hashes change, so the next push needs a force push)`
        }. You confirm in the Git tab before anything changes; the strategy is set in the Git tab.`
      : `Downloads new commits from ${upstream} and moves ${currentBranch.value} forward to them, updating your files.${
          dirty.value ? " Your uncommitted changes are put aside first and restored afterwards." : ""
        } Nothing is sent to the remote.`);
  return { disabled: !!disabledReason, hint, title, strategy, upstream };
});

const pushAction = computed(() => {
  const s = snapshot.value;
  const upstream = String(s?.upstream || "");
  const upstreamMatches = upstream === `${pushRemote.value}/${currentBranch.value}`;
  let disabledReason = "";
  if (!s) disabledReason = "Repository state is still loading.";
  else if (!currentBranch.value) disabledReason = "HEAD is detached — check out a branch first.";
  else if (!remoteNames.value.length) disabledReason = "This repository has no remote.";
  else if (busy.value) disabledReason = "Another Git action is running.";
  else if (!isDiverged.value && !(s.aheadCount > 0 || !upstream || !upstreamMatches))
    disabledReason = "Nothing to push — the branch is up to date with its upstream.";
  const label = isDiverged.value ? "Force Push…" : !upstream || !upstreamMatches ? "Publish Branch" : "Push";
  const hint = s?.aheadCount ? `↑${s.aheadCount}` : "";
  const title =
    disabledReason ||
    (isDiverged.value
      ? `${upstream} has commits that ${currentBranch.value} does not, so a normal push would be rejected. Opens the Git tab, where a force push can replace the remote branch with yours — it asks first, and it stops if someone pushed in the meantime. Use Update instead if you want to keep the remote commits.`
      : !upstream || !upstreamMatches
        ? `Creates ${currentBranch.value} on ${pushRemote.value} with your commits and links the two, so later Update and Push know where to go.`
        : `Sends your ${s.aheadCount} new commit${s.aheadCount === 1 ? "" : "s"} on ${currentBranch.value} to ${upstream}, where others can see them. Your files do not change.`);
  return { disabled: !!disabledReason, label, hint, title };
});

function topActions(): Row[] {
  const s = snapshot.value;
  const remotesMissing = !remoteNames.value.length;
  return [
    {
      kind: "action",
      key: "action:update",
      depth: 0,
      label: "Update",
      icon: "↓",
      iconKind: "action",
      hint: updateAction.value.hint,
      title: updateAction.value.title,
      disabled: updateAction.value.disabled,
      run: runUpdate,
    },
    {
      kind: "action",
      key: "action:commit",
      depth: 0,
      label: "Commit…",
      icon: "✓",
      iconKind: "action",
      hint: s?.dirtyCount ? `${s.dirtyCount} changed` : "",
      title:
        "Opens the Changes view of the Git tab, where you pick the changed files, write a message and save them as a commit. Nothing is committed until you do that there.",
      disabled: false,
      run: () => openGitTab("changes"),
    },
    {
      kind: "action",
      key: "action:push",
      depth: 0,
      label: pushAction.value.label,
      icon: "↑",
      iconKind: "action",
      hint: pushAction.value.hint,
      title: pushAction.value.title,
      disabled: pushAction.value.disabled,
      run: runPush,
    },
    {
      kind: "action",
      key: "action:fetch",
      depth: 0,
      label: "Fetch",
      icon: "⟳",
      iconKind: "action",
      title: remotesMissing
        ? "This repository has no remote."
        : "Downloads new commits and branches from the remote so the ↑↓ counts and the Remote list are current. Your branches and files do not change. The menu stays open.",
      disabled: remotesMissing || busy.value,
      run: () => gitUiStore.gitFetch(props.workspaceId),
      // Fetch changes no branch, so the menu stays open for whatever comes next.
      keepOpen: true,
      running: gitUi.value.busyAction === "fetch",
    },
    { kind: "divider", key: "divider:actions", depth: 0, label: "" },
    {
      kind: "action",
      key: "action:new-branch",
      depth: 0,
      label: "New Branch…",
      icon: "+",
      iconKind: "action",
      title: `Asks for a name, then creates a new branch starting at the commit you are on${
        currentBranch.value ? ` (${currentBranch.value})` : ""
      } and switches to it. Your uncommitted changes come along. The branch stays local until you push it.`,
      disabled: busy.value || !s,
      run: () => branchActions.newBranchFrom(""),
    },
  ];
}

// ---- Branch tree ----------------------------------------------------------------

function isExpanded(key: string, fallback: boolean): boolean {
  return expanded[key] ?? fallback;
}

function localRow(branch: LocalBranch, key: string, label: string, depth: number): BranchRow {
  const badge =
    branch.ahead && branch.behind
      ? `↑${branch.ahead} ↓${branch.behind}`
      : branch.ahead
        ? `↑${branch.ahead}`
        : branch.behind
          ? `↓${branch.behind}`
          : "";
  return {
    kind: "branch",
    key,
    depth,
    label,
    ref: branch.name,
    remote: false,
    current: branch.isCurrent || branch.name === currentBranch.value,
    local: branch,
    icon: branch.isCurrent || branch.name === currentBranch.value ? "★" : "⎇",
    iconKind: branch.isCurrent || branch.name === currentBranch.value ? "current" : "local",
    hint: [branch.upstream, badge].filter(Boolean).join(" "),
    title: [branch.name, branch.lastSubject, branch.lastRelativeDate].filter(Boolean).join(" — "),
  };
}

function remoteRow(branch: RemoteBranch, key: string, label: string, depth: number): BranchRow {
  return {
    kind: "branch",
    key,
    depth,
    label,
    ref: branch.name,
    remote: true,
    current: false,
    icon: "☁",
    iconKind: "remote",
    title: [branch.name, branch.lastSubject, branch.lastRelativeDate].filter(Boolean).join(" — "),
  };
}

function compareLeaves(a: { ref: string; label: string }, b: { ref: string; label: string }): number {
  const pin = (ref: string) => (ref === currentBranch.value ? 0 : ref === branchList.value.defaultBranch ? 1 : 2);
  return pin(a.ref) - pin(b.ref) || a.label.localeCompare(b.label);
}

function pushForest<T>(
  out: Row[],
  nodes: BranchForestNode<T>[],
  depth: number,
  leaf: (..._args: [payload: T, key: string, label: string, depth: number]) => BranchRow,
  openFolder: (..._args: [key: string]) => boolean,
): void {
  for (const node of nodes) {
    if (node.kind === "folder") {
      const isOpen = isExpanded(node.key, openFolder(node.key));
      out.push({ kind: "folder", key: node.key, depth, label: node.label, expanded: isOpen });
      if (isOpen) pushForest(out, node.children, depth + 1, leaf, openFolder);
    } else {
      out.push(leaf(node.payload, node.key, node.label, depth));
    }
  }
}

function pushSection(out: Row[], key: string, label: string, count: number, fallback: boolean): boolean {
  const isOpen = isExpanded(key, fallback);
  out.push({ kind: "section", key, depth: 0, label, hint: String(count), expanded: isOpen });
  return isOpen;
}

const rows = computed<Row[]>(() => {
  const q = query.value.trim().toLowerCase();
  const local = branchList.value.local;
  const remotes = branchList.value.remotes;
  const out: Row[] = [];

  const actions = topActions().filter((row) => !q || (row.kind === "action" && row.label.toLowerCase().includes(q)));
  out.push(...actions);
  if (actions.length) out.push({ kind: "divider", key: "divider:tree", depth: 0, label: "" });

  const hasBranchData = !!gitUi.value.branchList;
  if (!hasBranchData) {
    if (gitUi.value.branchesError) {
      out.push({ kind: "note", key: "note:error", depth: 0, label: String(gitUi.value.branchesError), error: true });
    } else {
      out.push({ kind: "note", key: "note:loading", depth: 0, label: "Loading branches…" });
    }
    return out;
  }

  if (q) {
    const localHits = local.filter((b) => b.name.toLowerCase().includes(q));
    const remoteHits = remotes.filter((b) => b.name.toLowerCase().includes(q));
    if (localHits.length) {
      out.push({ kind: "section", key: "search:local", depth: 0, label: "Local", expanded: true });
      for (const b of localHits) out.push(localRow(b, `search:local:${b.name}`, b.name, 1));
    }
    if (remoteHits.length) {
      out.push({ kind: "section", key: "search:remote", depth: 0, label: "Remote", expanded: true });
      for (const b of remoteHits) out.push(remoteRow(b, `search:remote:${b.name}`, b.name, 1));
    }
    if (!localHits.length && !remoteHits.length && !actions.length) {
      out.push({ kind: "note", key: "note:empty", depth: 0, label: "No matches" });
    }
    return out;
  }

  const showRecent = local.length > RECENT_LIMIT;
  if (showRecent && pushSection(out, "section:recent", "Recent", Math.min(RECENT_LIMIT, local.length), true)) {
    const recent = [...local]
      .sort(
        (a, b) =>
          Number(b.name === currentBranch.value) - Number(a.name === currentBranch.value) ||
          (b.lastCommitTimestamp || 0) - (a.lastCommitTimestamp || 0),
      )
      .slice(0, RECENT_LIMIT);
    for (const b of recent) out.push(localRow(b, `recent:${b.name}`, b.name, 1));
  }

  if (local.length && pushSection(out, "section:local", "Local", local.length, !showRecent)) {
    const forest = buildBranchForest(
      local.map((b) => ({ path: b.name, ref: b.name, payload: b })),
      "local",
      compareLeaves,
    );
    const current = currentBranch.value;
    pushForest(out, forest, 1, localRow, (key) => {
      // Open the folders on the way to the current branch.
      const path = key.slice("local:dir:".length);
      return !!current && current.startsWith(`${path}/`);
    });
  }

  if (remotes.length && pushSection(out, "section:remote", "Remote", remotes.length, false)) {
    const forest = buildBranchForest(
      remotes.map((b) => ({ path: b.name, ref: b.name, payload: b })),
      "remote",
      compareLeaves,
    );
    // The remote names themselves ("origin") start open; their sub-folders do not.
    pushForest(out, forest, 1, remoteRow, (key) => !key.slice("remote:dir:".length).includes("/"));
  }
  return out;
});

function isSelectable(row: Row | undefined): boolean {
  return !!row && row.kind !== "divider" && row.kind !== "note";
}

// ---- Branch submenu ---------------------------------------------------------------

function remoteShortName(ref: string): string {
  const remote = remoteNames.value.find((name) => ref.startsWith(`${name}/`));
  return remote ? ref.slice(remote.length + 1) : ref;
}

const menuItems = computed<MenuItem[]>(() => {
  const row = menuFor.value;
  if (!row) return [];
  const ref = row.ref;
  const head = currentBranch.value;
  const items: MenuItem[] = [];
  const blocked = busy.value ? "Another Git action is running." : "";
  if (row.current) {
    items.push({
      id: "update",
      label: "Update",
      disabled: updateAction.value.disabled,
      title: updateAction.value.title,
      run: runUpdate,
    });
    items.push({
      id: "push",
      label: pushAction.value.label,
      disabled: pushAction.value.disabled,
      title: pushAction.value.title,
      run: runPush,
    });
  } else {
    const dirtyLocal = !row.remote && dirty.value;
    items.push({
      id: "checkout",
      label: "Checkout",
      disabled: !!blocked || dirtyLocal,
      title:
        blocked ||
        (dirtyLocal
          ? "You have uncommitted changes. Commit or stash them first, so switching branches cannot mix them up."
          : row.remote
            ? `Switches to a local branch ${remoteShortName(ref)} that follows ${ref}: creates it if it does not exist yet, or moves an existing one forward to ${ref}. If your local ${remoteShortName(ref)} follows something else, you are asked before it is reset.`
            : `Switches your working copy to ${ref}: the files change to that branch's version. Nothing is deleted.`),
      run: () =>
        row.remote
          ? gitUiStore.gitCheckoutRemoteBranch(props.workspaceId, ref)
          : gitUiStore.gitCheckoutBranch(props.workspaceId, ref),
    });
  }
  items.push({
    id: "new-from",
    label: `New Branch from '${ref}'…`,
    disabled: !!blocked,
    title:
      blocked ||
      `Asks for a name, then creates a new local branch starting at ${ref} and switches to it. ${ref} itself is not changed. The new branch stays local until you push it.`,
    run: () => branchActions.newBranchFrom(ref),
  });
  if (!row.current) {
    const noHead = head ? "" : "HEAD is detached — check out a branch first.";
    const fetchFirst = row.remote;
    const confirmNote = `${fetchFirst ? ` The latest ${ref} is downloaded first.` : ""} You confirm in the Git tab before anything changes; uncommitted changes are put aside and restored. If both sides changed the same lines, the Git tab helps you resolve the conflicts. Nothing is pushed.`;
    items.push({ id: "div:integrate", label: "", divider: true });
    items.push({
      id: "merge",
      label: `Merge '${ref}' into '${head || "HEAD"}'`,
      disabled: !!(blocked || noHead),
      title:
        blocked ||
        noHead ||
        `Brings the commits from ${ref} into ${head} and records them with a merge commit. Your existing commits stay as they are.${confirmNote}`,
      run: () => gitUiStore.gitMergeBase(props.workspaceId, ref, { fetchFirst }),
    });
    items.push({
      id: "rebase",
      label: `Rebase '${head || "HEAD"}' onto '${ref}'`,
      disabled: !!(blocked || noHead),
      title:
        blocked ||
        noHead ||
        `Moves your ${head} commits so they start from the latest ${ref}, as if you had begun your work there — no merge commit, a straight history. The commits get new hashes, so if ${head} was already pushed, the next push has to be a force push.${confirmNote}`,
      run: () => gitUiStore.gitRebaseBase(props.workspaceId, ref, { fetchFirst }),
    });
  }
  items.push({ id: "div:manage", label: "", divider: true });
  if (row.remote) {
    items.push({
      id: "delete-remote",
      label: "Delete on Remote…",
      danger: true,
      disabled: !!blocked,
      title:
        blocked ||
        `Deletes ${remoteShortName(ref)} on the server for everyone — it cannot be undone from here. You confirm first. Local branches are not touched.`,
      run: () => branchActions.deleteRemote(ref),
    });
  } else {
    items.push({
      id: "rename",
      label: "Rename…",
      disabled: !!blocked,
      title:
        blocked ||
        `Asks for a new name and renames the local branch ${ref}. Commits and files stay the same. A branch already pushed keeps its old name on the remote.`,
      run: () => branchActions.rename(ref),
    });
    if (!row.current && row.local) {
      const local = row.local;
      items.push({
        id: "delete",
        label: "Delete",
        danger: true,
        disabled: !!blocked,
        title:
          blocked ||
          (local.worktreePath
            ? `${ref} is checked out in another worktree (${local.worktreePath}). You confirm first; the worktree folder is removed together with the branch.`
            : local.merged
              ? `Deletes the local branch ${ref}. Its commits are already in another branch, so nothing is lost. You confirm first; the remote branch is not touched.`
              : `Deletes the local branch ${ref}. It has commits that are in no other branch — they will be lost. You confirm first; the remote branch is not touched.`),
        run: () => branchActions.deleteLocal(local),
      });
    }
  }
  return items;
});

function openSubmenu(row: BranchRow): void {
  menuFor.value = row;
  subActiveIndex.value = -1;
  const rowEl = listRef.value?.querySelector<HTMLElement>(`[data-row-index="${rows.value.indexOf(row)}"]`);
  const popRect = popoverRef.value?.getBoundingClientRect();
  if (!rowEl || !popRect) {
    menuInline.value = true;
    return;
  }
  const rowRect = rowEl.getBoundingClientRect();
  const width = 260;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const left =
    popRect.right + 2 + width <= vw - 8
      ? popRect.right + 2
      : popRect.left - 2 - width >= 8
        ? popRect.left - 2 - width
        : -1;
  menuInline.value = left < 0;
  if (menuInline.value) return;
  submenuStyle.value = {
    position: "fixed",
    left: `${left}px`,
    top: `${Math.max(8, Math.min(rowRect.top - 5, vh - 320))}px`,
    width: `${width}px`,
  };
}

function closeSubmenu(): void {
  menuFor.value = null;
  subActiveIndex.value = -1;
}

// ---- Running things -------------------------------------------------------------

const branchActions = useBranchActions(
  () => props.workspaceId,
  () => afterAction(),
);

async function afterAction(): Promise<void> {
  // Confirmations (merge, rebase, force push, reset to remote) and conflict
  // resolution live in the Git tab — bring it up so the user sees the question.
  const ui = gitUiStore.get(props.workspaceId);
  if (ui.pendingAction || ui.conflictDialog?.open) await appStore.activateView(`git:${props.workspaceId}`);
  void gitUiStore.gitListBranches(props.workspaceId, { force: true });
}

async function run(action: () => unknown): Promise<void> {
  close();
  await action();
  await afterAction();
}

async function runInPlace(action: () => unknown): Promise<void> {
  closeSubmenu();
  await action();
  await afterAction();
}

function runUpdate(): Promise<void> | void {
  const { upstream, strategy } = updateAction.value;
  if (isDiverged.value) {
    return strategy === "merge"
      ? gitUiStore.gitMergeBase(props.workspaceId, upstream, { fetchFirst: true })
      : gitUiStore.gitRebaseBase(props.workspaceId, upstream, { fetchFirst: true });
  }
  return gitUiStore.gitPull(props.workspaceId, { stashDirty: dirty.value });
}

function runPush(): Promise<void> {
  if (isDiverged.value) return openGitTab("");
  return gitUiStore.gitPush(props.workspaceId);
}

async function openGitTab(tab: string): Promise<void> {
  if (tab) gitUiStore.gitSwitchTab(props.workspaceId, tab);
  await appStore.activateView(`git:${props.workspaceId}`);
}

function runMenuItem(item: MenuItem): Promise<void> | undefined {
  if (item.divider || item.disabled || !item.run) return undefined;
  return run(item.run);
}

function activateRow(idx: number): Promise<void> | undefined {
  const row = rows.value[idx];
  if (!isSelectable(row)) return undefined;
  activeIndex.value = idx;
  if (row.kind === "section" || row.kind === "folder") {
    expanded[row.key] = !row.expanded;
    closeSubmenu();
    return undefined;
  }
  if (row.kind === "branch") {
    if (menuFor.value?.key === row.key) closeSubmenu();
    else openSubmenu(row);
    return undefined;
  }
  if (row.kind === "action" && !row.disabled) return row.keepOpen ? runInPlace(row.run) : run(row.run);
  return undefined;
}

function onRowHover(idx: number): void {
  activeIndex.value = idx;
  // Like a menu bar: once a branch menu is open, hovering another branch moves it.
  const row = rows.value[idx];
  if (menuFor.value && !menuInline.value && row?.kind === "branch" && row.key !== menuFor.value.key) openSubmenu(row);
}

// ---- Open / close / keyboard --------------------------------------------------------

function updatePosition(): void {
  const rect = chipRef.value?.getBoundingClientRect();
  if (!rect) return;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const width = Math.min(400, vw - 16);
  const top = rect.bottom + 4;
  popoverStyle.value = {
    position: "fixed",
    top: `${top}px`,
    left: `${Math.max(8, Math.min(rect.left, vw - width - 8))}px`,
    width: `${width}px`,
    maxHeight: `${Math.max(240, vh - top - 12)}px`,
  };
}

function openMenu(): void {
  if (open.value) return;
  updatePosition();
  open.value = true;
  query.value = "";
  activeIndex.value = -1;
  closeSubmenu();
  void gitUiStore.gitListBranches(props.workspaceId);
  nextTick(() => searchRef.value?.focus());
}

function close(): void {
  if (!open.value) return;
  open.value = false;
  closeSubmenu();
}

function toggle(): void {
  if (open.value) close();
  else openMenu();
}

function onRootChange(path: string): void {
  gitUiStore.setActiveRoot(props.workspaceId, path);
  closeSubmenu();
  void gitUiStore.gitListBranches(props.workspaceId, { force: true });
}

function rootLabel(path: string): string {
  return (
    path
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .pop() || path
  );
}

function moveActive(dir: number): void {
  const list = rows.value;
  if (!list.length) return;
  let next = activeIndex.value;
  for (let i = 0; i < list.length; i++) {
    next = (next + dir + list.length) % list.length;
    if (isSelectable(list[next])) break;
  }
  activeIndex.value = next;
  nextTick(() =>
    listRef.value?.querySelector<HTMLElement>(`[data-row-index="${next}"]`)?.scrollIntoView?.({ block: "nearest" }),
  );
}

function moveSubActive(dir: number): void {
  const items = menuItems.value;
  let next = subActiveIndex.value;
  for (let i = 0; i < items.length; i++) {
    next = (next + dir + items.length) % items.length;
    if (!items[next].divider) break;
  }
  subActiveIndex.value = next;
}

// Returns the started action so Vue's error handler sees a rejection.
function onKeydown(e: KeyboardEvent): Promise<void> | undefined {
  const inSubmenu = !!menuFor.value && subActiveIndex.value >= 0;
  const row = rows.value[activeIndex.value];
  switch (e.key) {
    case "ArrowDown":
    case "ArrowUp":
      e.preventDefault();
      if (inSubmenu) moveSubActive(e.key === "ArrowDown" ? 1 : -1);
      else {
        closeSubmenu();
        moveActive(e.key === "ArrowDown" ? 1 : -1);
      }
      break;
    case "ArrowRight":
      if (row?.kind === "branch" && !inSubmenu) {
        e.preventDefault();
        if (menuFor.value?.key !== row.key) openSubmenu(row);
        moveSubActive(1);
      } else if ((row?.kind === "section" || row?.kind === "folder") && !row.expanded && !query.value) {
        e.preventDefault();
        expanded[row.key] = true;
      }
      break;
    case "ArrowLeft":
      if (menuFor.value) {
        e.preventDefault();
        closeSubmenu();
      } else if ((row?.kind === "section" || row?.kind === "folder") && row.expanded && !query.value) {
        e.preventDefault();
        expanded[row.key] = false;
      }
      break;
    case "Enter":
      e.preventDefault();
      if (inSubmenu) return runMenuItem(menuItems.value[subActiveIndex.value]);
      if (row?.kind === "branch") {
        if (menuFor.value?.key !== row.key) openSubmenu(row);
        moveSubActive(1);
        break;
      }
      return activateRow(activeIndex.value);
    case "Escape":
      e.preventDefault();
      e.stopPropagation();
      if (menuFor.value) closeSubmenu();
      else {
        close();
        chipRef.value?.focus();
      }
      break;
    case "Tab":
      close();
      break;
  }
  return undefined;
}

useDismissable(open, [chipRef, popoverRef, submenuRef], { onDismiss: close, eventName: "mousedown" });

watch(query, () => {
  closeSubmenu();
  activeIndex.value = -1;
  if (query.value.trim()) moveActive(1);
});
watch(
  () => props.workspaceId,
  () => close(),
);

function onViewportChange(): void {
  close();
}
onMounted(() => {
  window.addEventListener("blur", onViewportChange);
  window.addEventListener("resize", onViewportChange);
});
onBeforeUnmount(() => {
  window.removeEventListener("blur", onViewportChange);
  window.removeEventListener("resize", onViewportChange);
});
</script>

<style>
/* Not scoped: the menu is teleported to <body>, and the submenu list is a render function. */
.workspace-branch-chip {
  display: inline-flex;
  align-items: center;
}
.workspace-branch-chip__caret {
  width: 10px;
  height: 10px;
  margin-left: 4px;
  opacity: 0.75;
}

.branch-menu {
  z-index: 10050;
  display: flex;
  flex-direction: column;
  background: var(--menu-bg);
  border: 1px solid rgba(var(--tint), 0.16);
  border-radius: 6px;
  box-shadow: var(--menu-shadow);
  color: var(--text);
  font-size: 12.5px;
  overflow: hidden;
}
.branch-menu--sub {
  padding: 4px 0;
}
.branch-menu__head {
  display: flex;
  gap: 6px;
  align-items: center;
  padding: 8px;
  border-bottom: 1px solid var(--border);
}
.branch-menu__search {
  flex: 1 1 auto;
  min-width: 0;
  padding: 5px 8px;
  background: rgba(var(--tint), 0.05);
  border: 1px solid var(--border);
  border-radius: 4px;
  color: var(--text);
  font: inherit;
  outline: none;
}
.branch-menu__search:focus {
  border-color: var(--accent);
}
.branch-menu__root {
  flex: 0 1 40%;
  min-width: 0;
  padding: 4px 6px;
  background: rgba(var(--tint), 0.05);
  border: 1px solid var(--border);
  border-radius: 4px;
  color: var(--text);
  font: inherit;
}
.branch-menu__status {
  margin: 0;
  padding: 5px 10px;
  border-bottom: 1px solid var(--border);
  color: var(--muted);
  font-size: 11.5px;
}
.branch-menu__list,
.branch-menu__actions {
  margin: 0;
  padding: 4px 0;
  list-style: none;
}
.branch-menu__list {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
}
.branch-menu__row {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0 4px;
  padding: 4px 8px;
  border-radius: 4px;
  cursor: pointer;
  white-space: nowrap;
}
.branch-menu__row--active,
.branch-menu__row--open {
  background: rgba(var(--tint), 0.1);
}
.branch-menu__row--current .branch-menu__label {
  color: var(--accent);
  font-weight: 600;
}
.branch-menu__row--disabled {
  opacity: 0.45;
  cursor: default;
}
.branch-menu__row--danger .branch-menu__label {
  color: var(--danger);
}
.branch-menu__row--section {
  color: var(--muted);
  font-weight: 600;
}
.branch-menu__indent {
  flex: 0 0 auto;
}
.branch-menu__icon {
  flex: 0 0 14px;
  width: 14px;
  text-align: center;
  color: var(--muted);
}
.branch-menu__icon--current {
  color: var(--accent);
}
.branch-menu__icon--local {
  color: #6dc070;
}
.branch-menu__icon--remote {
  color: #80a8e0;
}
.branch-menu__label {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.branch-menu__hint {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--muted);
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
}
.branch-menu__submenu-caret {
  width: 12px;
  height: 12px;
  color: var(--muted);
}
.branch-menu__divider {
  height: 1px;
  margin: 4px 0;
  background: var(--border);
}
.branch-menu__note {
  padding: 8px 12px;
  color: var(--muted);
  font-style: italic;
}
.branch-menu__note--error {
  color: var(--danger);
  font-style: normal;
}
.branch-menu__inline {
  margin: 0 4px 4px 28px;
  border-left: 1px solid var(--border);
}
</style>
