<template>
  <div class="review-panel">
    <article class="git-card review-card review-card--stack">
      <div class="section-head">
        <div>
          <p class="eyebrow">Comments</p>
          <h3>
            {{ filteredThreads.length + filteredDraftComments.length }} conversation{{
              filteredThreads.length + filteredDraftComments.length !== 1 ? "s" : ""
            }}{{ isFiltered ? ` (${totalCommentCount} total)` : "" }}
          </h3>
        </div>
        <div class="docker-card__actions">
          <button
            type="button"
            :class="['button', 'button--ghost', 'danger', busyAction === 'deleteAll' && 'button--busy']"
            :disabled="!!busyAction || !hasClearable"
            title="Delete all draft replies and draft comments permanently"
            @click="handleDeleteAllDrafts"
          >
            {{ busyAction === "deleteAll" ? "Deleting\u2026" : "Delete all drafts" }}
          </button>
          <button
            type="button"
            class="button"
            title="Create a new draft comment — you can edit and publish to Azure later"
            @click="openNewDraftComment"
          >
            New comment
          </button>
        </div>
      </div>

      <!-- Filter/sort bar -->
      <div style="display: flex; gap: 4px; padding: 0 10px 6px; flex-wrap: wrap; align-items: center">
        <button
          v-for="f in ['all', 'active', 'fixed', 'has-draft', 'mine']"
          :key="f"
          type="button"
          :class="['button', 'button--ghost', filter === f && 'button--active']"
          :style="
            filter === f
              ? 'font-size:11px;padding:2px 8px;background:var(--accent);color:var(--bg);'
              : 'font-size:11px;padding:2px 8px;'
          "
          :title="
            {
              all: 'Show all threads and comments',
              active: 'Show only threads with Active status',
              fixed: 'Show only threads marked as fixed by the agent',
              'has-draft': 'Show only threads that have a draft reply',
              mine: 'Show threads where you are an author or have a draft',
            }[f]
          "
          @click="gitUiStore.reviewSetCommentFilter(workspaceId, f)"
        >
          {{ { all: "All", active: "Active", fixed: "Fixed", "has-draft": "Has draft", mine: "Mine" }[f] }}
        </button>
        <span style="width: 1px; height: 16px; background: var(--border); margin: 0 2px"></span>
        <button
          v-for="s in sortOptions"
          :key="s.id"
          type="button"
          :class="['button', 'button--ghost', sort === s.id && 'button--active']"
          :style="
            sort === s.id
              ? 'font-size:11px;padding:2px 8px;background:var(--accent);color:var(--bg);'
              : 'font-size:11px;padding:2px 8px;'
          "
          :title="`Sort comments by ${s.label.toLowerCase()}${sort === s.id ? ' (click to reverse)' : ''}`"
          @click="gitUiStore.reviewSetCommentSort(workspaceId, s.id)"
        >
          {{ sort === s.id ? (sortDir === "asc" ? "↑" : "↓") : "↕" }} {{ s.label }}
        </button>
        <span style="flex: 1"></span>
        <input
          type="text"
          class="input"
          style="font-size: 11px; padding: 2px 8px; width: 140px; min-width: 80px"
          placeholder="Search..."
          title="Filter comments by text in file paths or comment body"
          :value="searchTerm"
          @input="gitUiStore.reviewSetCommentSearch(workspaceId, ($event.target as HTMLInputElement).value)"
        />
      </div>

      <div class="docker-list review-card__list review-card__list--dense">
        <template v-if="filteredThreads.length || filteredDraftComments.length">
          <!-- ═══ Azure threads ═══ -->
          <article v-for="thread in filteredThreads" :key="thread.id" class="docker-card review-comment-card">
            <!-- Thread header: index badge, status chip, file path, relative time -->
            <div class="docker-card__head">
              <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap">
                <h4 style="margin: 0">
                  {{ threadIndex(thread) ? `#${threadIndex(thread)}` : `Thread #${thread.id}` }}
                </h4>
                <span :class="['workspace-chip', statusChipClass(thread.status)]" style="font-size: 10px">{{
                  threadStatusLabel(thread.status)
                }}</span>
                <span
                  v-if="threadFixStatus.get(String(thread.id))"
                  class="workspace-chip workspace-chip--fixed"
                  style="font-size: 10px"
                  >Fixed</span
                >
                <span v-if="thread.filePath" class="review-comment-file">
                  {{ shortFilePath(thread.filePath)
                  }}<span v-if="thread.lineStart" class="review-comment-line">:{{ thread.lineStart }}</span>
                </span>
                <span class="review-comment__date">{{ formatRelativeTime(threadDate(thread)) }}</span>
              </div>
            </div>

            <!-- Code snippet context -->
            <div v-if="thread.filePath" class="review-comment-context" style="margin: 0 10px 4px">
              <code class="review-comment-context__path"
                >{{ thread.filePath }}{{ thread.lineStart ? `:${thread.lineStart}` : "" }}</code
              >
              <pre v-if="thread.codeSnippet" class="review-code-snippet">{{ thread.codeSnippet }}</pre>
            </div>

            <!-- Comment thread -->
            <div class="review-comment-thread">
              <div
                v-for="(comment, ci) in threadComments(thread)"
                :key="comment.id"
                :class="['review-comment', ci > 0 && 'review-comment--reply']"
              >
                <span
                  class="review-comment__avatar"
                  :style="{ background: avatarColor(comment.author?.displayName) }"
                  >{{ avatarInitials(comment.author?.displayName) }}</span
                >
                <div>
                  <div class="review-comment__header">
                    <strong>{{ comment.author?.displayName || "Unknown author" }}</strong>
                    <span class="review-comment__date">{{ formatRelativeTime(comment.publishedDate) }}</span>
                  </div>
                  <div class="review-comment__body">
                    <MarkdownContent :text="comment.content || ''" />
                  </div>
                </div>
              </div>
            </div>

            <!-- Code changes reply banner -->
            <div
              v-if="threadFixStatus.get(String(thread.id))?.fixSummary"
              class="review-comment review-comment--fix-summary"
            >
              <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 4px">
                <strong style="color: var(--success, #4caf50)">Reply with code changes</strong>
                <span class="workspace-chip workspace-chip--fixed" style="font-size: 10px">queued</span>
              </div>
              <div class="review-comment__body" style="opacity: 0.85">
                {{ threadFixStatus.get(String(thread.id))?.fixSummary }}
              </div>
            </div>

            <!-- Draft replies for this thread -->
            <div
              v-for="draft in draftsByThread(thread)"
              :key="draft.draftId"
              class="review-comment review-comment--draft"
            >
              <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 6px">
                <strong>Draft reply</strong>
                <span class="workspace-chip workspace-chip--local" style="font-size: 10px">{{
                  draft.status === "queued" || draft.status === "ready-to-sync" ? "queued" : "draft"
                }}</span>
                <span v-if="draft.authorAgent" class="review-comment__date"
                  >by {{ displayAuthor(draft.authorAgent) }}</span
                >
              </div>
              <div class="review-comment__body">
                <MarkdownContent :text="draft.body || ''" />
              </div>
              <div class="docker-card__actions" style="margin-top: 6px">
                <button
                  v-if="draft.status !== 'synced'"
                  type="button"
                  class="button button--ghost"
                  style="font-size: 11px; padding: 2px 8px"
                  :disabled="!!busyAction"
                  title="Edit the text of this draft reply"
                  @click="editDraft(thread)"
                >
                  Edit
                </button>
                <button
                  type="button"
                  :class="[
                    'button',
                    'button--ghost',
                    'danger',
                    busyAction === `delete-${draft.draftId}` && 'button--busy',
                  ]"
                  style="font-size: 11px; padding: 2px 8px"
                  :disabled="!!busyAction"
                  title="Permanently delete this draft reply"
                  @click="handleDeleteDraft(draft.draftId)"
                >
                  Delete
                </button>
              </div>
            </div>

            <!-- Thread actions -->
            <div class="docker-card__actions" style="padding: 6px 10px">
              <button
                type="button"
                class="button button--ghost"
                style="font-size: 11px"
                :disabled="!!busyAction"
                title="Write a reply to this thread — saved as draft, published with Push & publish"
                @click="replyToThread(thread)"
              >
                Reply
              </button>
              <button
                type="button"
                :class="['button', 'button--ghost', busyAction === `resolve-${thread.id}` && 'button--busy']"
                style="font-size: 11px"
                :disabled="!!busyAction"
                title="Mark this thread as resolved on Azure DevOps (immediate)"
                @click="handleResolveThread(thread.id)"
              >
                Resolve
              </button>
              <button
                v-if="thread.status !== 'active'"
                type="button"
                :class="['button', 'button--ghost', busyAction === `reactivate-${thread.id}` && 'button--busy']"
                style="font-size: 11px"
                :disabled="!!busyAction"
                title="Reopen this thread on Azure DevOps (immediate)"
                @click="handleReactivateThread(thread.id)"
              >
                Reactivate
              </button>
            </div>
          </article>

          <!-- ═══ Draft comments (no thread) ═══ -->
          <article
            v-for="comment in filteredDraftComments"
            :key="comment.commentKey"
            class="docker-card review-comment-card"
          >
            <div class="docker-card__head">
              <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap">
                <h4 style="margin: 0">
                  {{ comment.displayIndex ? `#${comment.displayIndex}` : comment.title || "Draft comment" }}
                </h4>
                <span class="workspace-chip workspace-chip--local" style="font-size: 10px">{{
                  comment.status || "draft"
                }}</span>
              </div>
            </div>

            <div
              v-if="comment.summary && !draftsByComment(comment).length"
              class="review-comment"
              style="border-top: none"
            >
              <span
                class="review-comment__avatar"
                :style="{ background: avatarColor(displayAuthor(comment.authorAgent)) }"
                >{{ avatarInitials(displayAuthor(comment.authorAgent)) }}</span
              >
              <div>
                <div class="review-comment__header">
                  <strong>{{ displayAuthor(comment.authorAgent) }}</strong>
                </div>
                <div class="review-comment__body">
                  <MarkdownContent :text="comment.summary" />
                </div>
              </div>
            </div>

            <div
              v-for="draft in draftsByComment(comment)"
              :key="draft.draftId"
              class="review-comment review-comment--draft"
            >
              <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 6px">
                <strong>Draft</strong>
                <span class="workspace-chip workspace-chip--local" style="font-size: 10px">{{
                  draft.status === "queued" || draft.status === "ready-to-sync" ? "queued" : "draft"
                }}</span>
                <span v-if="draft.authorAgent" class="review-comment__date"
                  >by {{ displayAuthor(draft.authorAgent) }}</span
                >
              </div>
              <div class="review-comment__body">
                <MarkdownContent :text="draft.body || ''" />
              </div>
              <div class="docker-card__actions" style="margin-top: 6px">
                <button
                  v-if="draft.status !== 'synced'"
                  type="button"
                  class="button button--ghost"
                  style="font-size: 11px; padding: 2px 8px"
                  :disabled="!!busyAction"
                  title="Edit the text of this draft"
                  @click="editLocalDraft(comment)"
                >
                  Edit
                </button>
                <button
                  type="button"
                  :class="[
                    'button',
                    'button--ghost',
                    'danger',
                    busyAction === `deleteComment-${comment.commentKey}` && 'button--busy',
                  ]"
                  style="font-size: 11px; padding: 2px 8px"
                  :disabled="!!busyAction"
                  title="Permanently delete this comment and its draft"
                  @click="handleDeleteComment(comment.commentKey)"
                >
                  Delete
                </button>
              </div>
            </div>
            <div v-if="!draftsByComment(comment).length" class="docker-card__actions" style="padding: 6px 10px">
              <button
                type="button"
                class="button button--ghost"
                style="font-size: 11px"
                title="Write a draft for this comment — saved locally until you queue and publish it"
                @click="editLocalDraft(comment)"
              >
                Add draft
              </button>
              <button
                type="button"
                :class="[
                  'button',
                  'button--ghost',
                  'danger',
                  busyAction === `deleteComment-${comment.commentKey}` && 'button--busy',
                ]"
                style="font-size: 11px"
                :disabled="!!busyAction"
                title="Permanently delete this draft comment"
                @click="handleDeleteComment(comment.commentKey)"
              >
                Delete
              </button>
            </div>
          </article>
        </template>
        <div v-else class="empty-card">
          <p>{{ isFiltered ? "No comments match this filter." : "No comments or threads yet." }}</p>
        </div>
      </div>
    </article>
  </div>
</template>

<script setup lang="ts">
import { ref } from "vue";
import { useAppStore } from "../../../stores/app.js";
import { useGitUiStore } from "../../../stores/git-ui.js";
import MarkdownContent from "./MarkdownContent.vue";

const props = defineProps<{
  prKey: string;
  workspaceId: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  filteredThreads: Array<Record<string, any>>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  filteredDraftComments: Array<Record<string, any>>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  draftsByThread: (thread: Record<string, any>) => Array<Record<string, any>>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  draftsByComment: (comment: Record<string, any>) => Array<Record<string, any>>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  threadIndex: (thread: Record<string, any>) => number | null;
  threadToCommentKey: Map<string, string>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  threadFixStatus: Map<string, Record<string, any>>;
  filter: string;
  sort: string;
  sortDir: string;
  searchTerm: string;
  isFiltered: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  allDrafts: Array<Record<string, any>>;
  hasClearable: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sortOptions: Array<Record<string, any>>;
  totalCommentCount: number;
}>();

const appStore = useAppStore();
const gitUiStore = useGitUiStore();

const busyAction = ref<string>("");

/* ── Avatar helpers ── */
function isHumanAuthor(agent: unknown) {
  return !agent || agent === "human";
}

function displayAuthor(agent: unknown) {
  if (isHumanAuthor(agent)) return "You";
  return agent;
}

function avatarInitials(name: unknown): string {
  if (isHumanAuthor(name)) return "ME";
  const n = String(name || "?");
  const parts = n.split(/[\s,]+/).filter(Boolean);
  return parts.length >= 2 ? (parts[0][0] + parts[1][0]).toUpperCase() : n.slice(0, 2).toUpperCase();
}

function avatarColor(name: unknown): string {
  if (isHumanAuthor(name)) return "hsl(210, 45%, 42%)";
  let hash = 0;
  for (const ch of String(name || "")) hash = ((hash << 5) - hash + ch.charCodeAt(0)) | 0;
  const hue = ((hash % 360) + 360) % 360;
  return `hsl(${hue}, 45%, 42%)`;
}

/* ── Relative time ── */
function formatRelativeTime(dateStr: string) {
  if (!dateStr) return "";
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 14) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  return `${weeks}w ago`;
}

/* ── Thread helpers ── */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function threadComments(thread: Record<string, any>): Array<Record<string, any>> {
  return Array.isArray(thread.comments) ? thread.comments : [];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function threadDate(thread: Record<string, any>): string {
  const comments = threadComments(thread);
  return comments.at(-1)?.publishedDate || thread.lastUpdatedDate || thread.publishedDate || "";
}

function shortFilePath(filePath: string) {
  if (!filePath) return "";
  const parts = filePath.replace(/^\//, "").split("/");
  if (parts.length <= 3) return filePath;
  return `.../${parts.slice(-2).join("/")}`;
}

function threadStatusLabel(status: unknown): string {
  const s = String(status || "active").toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function statusChipClass(status: unknown): string {
  const s = String(status || "active").toLowerCase();
  if (s === "active") return "workspace-chip--active";
  if (s === "fixed" || s === "closed" || s === "wontfix" || s === "bydesign") return "workspace-chip--muted";
  return "";
}

async function handleDeleteAllDrafts() {
  busyAction.value = "deleteAll";
  try {
    await appStore.reviewBridgeDeleteAllDrafts(props.prKey);
  } finally {
    busyAction.value = "";
  }
}

async function handleDeleteDraft(draftId: string) {
  busyAction.value = `delete-${draftId}`;
  try {
    await appStore.deleteReviewBridgeDraft(props.prKey, draftId);
  } finally {
    busyAction.value = "";
  }
}

async function handleResolveThread(threadId: number | string) {
  busyAction.value = `resolve-${threadId}`;
  try {
    await appStore.azureResolveThread(props.prKey, String(threadId));
  } finally {
    busyAction.value = "";
  }
}

async function handleReactivateThread(threadId: number | string) {
  busyAction.value = `reactivate-${threadId}`;
  try {
    await appStore.azureReactivateThread(props.prKey, String(threadId));
  } finally {
    busyAction.value = "";
  }
}

async function handleDeleteComment(commentKey: string) {
  busyAction.value = `deleteComment-${commentKey}`;
  try {
    await appStore.deleteReviewBridgeComment(props.prKey, commentKey);
  } finally {
    busyAction.value = "";
  }
}

function openNewDraftComment() {
  appStore.openDialog("TextAreaDialog", {
    eyebrow: "Review Bridge",
    title: "New comment",
    label: "Comment",
    placeholder: "Write your review comment...",
    submitLabel: "Create & queue",
    onCancel: () => appStore.closeDialog(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    onSubmit: (content: any) => {
      appStore.createReviewBridgeDraftComment({
        prKey: props.prKey,
        body: content,
        authorAgent: "human",
        autoQueue: true,
      });
      appStore.closeDialog();
    },
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function replyToThread(thread: Record<string, any>): void {
  appStore.openDialog("TextAreaDialog", {
    eyebrow: "Review Bridge",
    title: "Reply to thread",
    label: "Reply",
    placeholder: "Write your reply...",
    submitLabel: "Create & queue",
    onCancel: () => appStore.closeDialog(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    onSubmit: (content: any) => {
      appStore.createReviewBridgeDraftComment({
        prKey: props.prKey,
        body: content,
        threadId: thread.id,
        authorAgent: "human",
        autoQueue: true,
      });
      appStore.closeDialog();
    },
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function editDraft(thread: Record<string, any>): void {
  const drafts = props.draftsByThread(thread);
  const draft = drafts.find((d) => d.status !== "synced") || null;
  const commentKey = props.threadToCommentKey.get(String(thread.id)) || "";
  appStore.openDialog("TextAreaDialog", {
    eyebrow: "Review Bridge",
    title: draft ? "Edit draft reply" : "Create draft reply",
    label: "Draft reply",
    value: draft?.body || "",
    placeholder: "Write the draft reply...",
    submitLabel: draft ? "Save draft" : "Create draft",
    onCancel: () => appStore.closeDialog(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    onSubmit: async (content: any) => {
      await appStore.saveReviewBridgeDraft({ prKey: props.prKey, commentKey, body: content, authorAgent: "human" });
      await appStore.queueReviewBridgeDraft(props.prKey, null as unknown as string, commentKey);
      appStore.closeDialog();
    },
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function editLocalDraft(comment: Record<string, any>): void {
  const drafts = props.draftsByComment(comment);
  const draft = drafts.find((d) => d.status !== "synced") || null;
  appStore.openDialog("TextAreaDialog", {
    eyebrow: "Review Bridge",
    title: draft ? "Edit draft" : "Add draft",
    label: "Draft reply",
    value: draft?.body || "",
    placeholder: "Write the draft...",
    submitLabel: draft ? "Save draft" : "Create draft",
    onCancel: () => appStore.closeDialog(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    onSubmit: async (content: any) => {
      await appStore.saveReviewBridgeDraft({
        prKey: props.prKey,
        commentKey: comment.commentKey,
        body: content,
        authorAgent: "human",
      });
      await appStore.queueReviewBridgeDraft(props.prKey, null as unknown as string, comment.commentKey);
      appStore.closeDialog();
    },
  });
}
</script>
