<template>
  <div class="workspace-pane__body workspace-pane__body--git">
    <PaneShell
      v-if="showHeader"
      :title="paneTitle"
      :status="headerStatus"
      :actions="headerActions"
      @action="onHeaderAction"
    />
    <div v-if="!summary" class="terminal-empty" style="padding: 24px">
      <p>No pull request context available</p>
      <small>Open a GitHub PR from the inbox to see review details.</small>
    </div>
    <div
      v-else
      :class="[
        'azure-review',
        'review-shell',
        isMobile && menuOpen && 'review-shell--menu-open',
        isMobile && tabsMenuOpen && 'review-shell--tabs-menu-open',
      ]"
    >
      <button
        v-if="isMobile"
        type="button"
        class="review-shell__tabs-trigger"
        :aria-expanded="tabsMenuOpen"
        :aria-label="tabsMenuOpen ? 'Close tabs menu' : 'Open tabs menu'"
        @click="toggleTabsMenu"
      >
        <span class="review-shell__tabs-trigger__label">{{ activeReviewTabInfo.label }}</span>
        <span v-if="activeReviewTabInfo.count" class="azure-tab__count">{{ activeReviewTabInfo.count }}</span>
        <span class="review-shell__tabs-trigger__caret" aria-hidden="true">▼</span>
      </button>
      <button
        v-if="isMobile"
        type="button"
        class="review-shell__menu-trigger"
        :aria-expanded="menuOpen"
        :aria-label="menuOpen ? 'Close actions menu' : 'Open actions menu'"
        @click="toggleActionsMenu"
      >
        <span class="review-shell__menu-trigger__dot" aria-hidden="true">⋮</span>
        <span>{{ menuOpen ? "Close" : "Actions" }}</span>
      </button>
      <div
        v-if="isMobile && (menuOpen || tabsMenuOpen)"
        class="review-shell__menu-backdrop"
        aria-hidden="true"
        @click="closeAllMenus"
      ></div>

      <!-- Header -->
      <div class="azure-review__header">
        <div class="azure-review__title-row">
          <span class="azure-pr-card__repo">{{ summary.repository?.fullName }}</span>
          <span class="azure-pr-card__id">#{{ summary.pullRequest?.number }}</span>
          <span v-if="summary.pullRequest?.draft" class="azure-pr-card__draft">Draft</span>
        </div>
        <h3 style="margin: 4px 0 0">{{ summary.pullRequest?.title }}</h3>
        <div class="azure-pr-card__meta">
          <span>{{ summary.pullRequest?.sourceBranch }} &rarr; {{ summary.pullRequest?.targetBranch }}</span>
          <span>{{ summary.role }}</span>
        </div>
      </div>

      <!-- Quick actions — reused as the .git-view__toolbar slot so the
           mobile overlay rules in review.css can collapse them under the
           ⋮ trigger like the Azure pane does. -->
      <div class="git-view__toolbar azure-review__actions">
        <button type="button" class="button button--ghost" @click="openInBrowser">Open in browser</button>
        <button type="button" class="button button--ghost" @click="handleFetch">Fetch</button>
        <button type="button" class="button button--ghost" @click="handleRebase">Rebase on target</button>
        <button type="button" class="button button--ghost" @click="handlePush">Push branch</button>
      </div>

      <!-- Sub-tabs -->
      <div class="review-subtabs">
        <button
          v-for="tab in reviewTabs"
          :key="tab.id"
          type="button"
          :class="['azure-tab', activeTab === tab.id && 'azure-tab--active', tab.alert && 'azure-tab--alert']"
          @click="onReviewTabClick(tab.id)"
        >
          {{ tab.label }}<span v-if="tab.count" class="azure-tab__count">{{ tab.count }}</span>
        </button>
      </div>

      <div class="review-content">
        <!-- Summary panel -->
        <div v-if="activeTab === 'summary'" class="review-body">
          <!-- Reviewer summary -->
          <div v-if="summary.reviewerSummary" class="azure-review__section">
            <h4>Reviewers</h4>
            <div
              v-for="reviewer in summary.reviewerSummary.reviewers"
              :key="reviewer.login"
              class="azure-review__reviewer"
            >
              <span>{{ reviewer.displayName || reviewer.login }}</span>
              <span :class="['azure-review__state', `azure-review__state--${reviewer.state}`]">{{
                reviewer.state
              }}</span>
            </div>
          </div>

          <!-- Changed files -->
          <div v-if="summary.changedFiles?.length" class="azure-review__section">
            <h4>Changed files ({{ summary.changedFiles.length }})</h4>
            <div v-for="file in summary.changedFiles" :key="file.path" class="azure-review__file">
              <span class="azure-review__file-status">{{ file.changeType }}</span>
              <span>{{ file.path }}</span>
            </div>
          </div>

          <!-- Review actions -->
          <div v-if="summary.role === 'reviewer'" class="azure-review__section">
            <h4>Submit review</h4>
            <textarea
              v-model="reviewBody"
              placeholder="Leave a comment (optional)"
              rows="3"
              style="width: 100%"
            ></textarea>
            <div class="azure-review__actions" style="margin-top: 8px">
              <button type="button" class="button button--ghost" @click="submitReview('COMMENT')">Comment</button>
              <button type="button" class="button" @click="submitReview('APPROVE')">Approve</button>
              <button
                type="button"
                class="button button--ghost"
                style="color: var(--danger)"
                @click="submitReview('REQUEST_CHANGES')"
              >
                Request changes
              </button>
            </div>
          </div>

          <!-- General comment -->
          <div class="azure-review__section">
            <h4>Add comment</h4>
            <textarea v-model="commentBody" placeholder="Write a comment..." rows="3" style="width: 100%"></textarea>
            <div class="azure-review__actions" style="margin-top: 8px">
              <button type="button" class="button" :disabled="!commentBody.trim()" @click="addComment">
                Post comment
              </button>
            </div>
          </div>
        </div>

        <!-- Pipelines panel -->
        <ReviewPipelinesTab
          v-else-if="activeTab === 'pipelines'"
          :checks="checks"
          :refreshing="refreshingChecks"
          :pr-key="prKey"
          provider="github"
          @refresh="handleRefreshChecks"
        />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch } from "vue";
import { useAppStore } from "../../stores/app.js";
import { useIsNarrow } from "../../composables/useIsNarrow.js";
import PaneShell from "../layout/PaneShell.vue";
import ReviewPipelinesTab from "./shared/ReviewPipelinesTab.vue";

const props = withDefaults(defineProps<{ workspaceId?: string; showHeader?: boolean }>(), {
  workspaceId: "",
  showHeader: false,
});

const appStore = useAppStore();
const { isMobile } = useIsNarrow();
const menuOpen = ref(false);
const tabsMenuOpen = ref(false);

watch(isMobile, (mobile) => {
  if (!mobile) {
    menuOpen.value = false;
    tabsMenuOpen.value = false;
  }
});

function toggleActionsMenu() {
  if (menuOpen.value) {
    menuOpen.value = false;
  } else {
    menuOpen.value = true;
    tabsMenuOpen.value = false;
  }
}

function toggleTabsMenu() {
  if (tabsMenuOpen.value) {
    tabsMenuOpen.value = false;
  } else {
    tabsMenuOpen.value = true;
    menuOpen.value = false;
  }
}

function closeAllMenus() {
  menuOpen.value = false;
  tabsMenuOpen.value = false;
}

function onReviewTabClick(id: string) {
  activeTab.value = id;
  if (tabsMenuOpen.value) tabsMenuOpen.value = false;
}

const reviewBody = ref<string>("");
const commentBody = ref<string>("");
const activeTab = ref<string>("summary");
const refreshingChecks = ref(false);

const activeReviewTabInfo = computed(
  () => reviewTabs.value.find((t) => t.id === activeTab.value) || reviewTabs.value[0],
);

const workspace = computed(() =>
  (appStore.payload?.appState?.workspaces || []).find((w) => w.id === props.workspaceId),
);
const prKey = computed(() => workspace.value?.review?.prKey || "");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const summary = computed(() => (appStore.payload?.github as any)?.pullRequests?.[prKey.value] || null);
const checks = computed(() => summary.value?.checks || {});

const reviewTabs = computed(() => [
  { id: "summary", label: "Summary", count: null, alert: false },
  {
    id: "pipelines",
    label: "Pipelines",
    count: (checks.value.failedCount || 0) + (checks.value.pendingCount || 0) || null,
    alert: (checks.value.failedCount || 0) > 0,
  },
]);

const paneTitle = computed(() => {
  if (!summary.value) return "GitHub Review";
  return `PR #${summary.value.pullRequest?.number} \u00B7 ${summary.value.repository?.fullName || ""}`;
});

const headerStatus = computed(() => summary.value?.role || "");

const headerActions = computed(() => [
  { className: "workspace-pane__icon-btn", action: "refresh-github", title: "Refresh GitHub", label: "\u21BB" },
]);

function onHeaderAction(action: { action: string }) {
  if (action.action === "refresh-github") appStore.refreshGitHub();
}

function openInBrowser() {
  const url = summary.value?.pullRequest?.webUrl;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (url) (appStore as any).openExternal(url);
}

async function handleFetch() {
  try {
    await appStore.githubFetchReviewWorkspace(props.workspaceId);
  } catch {}
}

async function handleRebase() {
  try {
    await appStore.githubRebaseReviewWorkspace(props.workspaceId);
  } catch {}
}

async function handlePush() {
  try {
    await appStore.githubPushReviewWorkspace(props.workspaceId);
  } catch {}
}

async function submitReview(event: string) {
  if (!prKey.value) return;
  try {
    await appStore.githubSubmitReview(prKey.value, event, reviewBody.value.trim());
    reviewBody.value = "";
  } catch {}
}

async function addComment() {
  if (!prKey.value || !commentBody.value.trim()) return;
  try {
    await appStore.githubComment(prKey.value, commentBody.value.trim());
    commentBody.value = "";
  } catch {}
}

async function handleRefreshChecks() {
  refreshingChecks.value = true;
  try {
    await appStore.refreshGitHub();
  } finally {
    refreshingChecks.value = false;
  }
}
</script>
