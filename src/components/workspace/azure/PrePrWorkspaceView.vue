<template>
  <div class="git-view review-shell" style="overflow-y: auto">
    <div style="padding: 16px 20px; max-width: 720px">
      <div class="section-head">
        <div>
          <p class="eyebrow">New Branch</p>
          <h3>{{ gitSnapshot?.branch || "Working branch" }}</h3>
        </div>
        <button
          type="button"
          class="button button--ghost button--small"
          :disabled="busyAction === 'refresh'"
          @click="handleRefresh"
        >
          {{ busyAction === "refresh" ? "Refreshing…" : "↻ Refresh" }}
        </button>
      </div>

      <!-- Workflow steps -->
      <div style="margin-top: 16px; display: grid; gap: 8px">
        <div :class="['nb-step', hasDirtyOrCommits && 'nb-step--done', !hasDirtyOrCommits && 'nb-step--active']">
          <span class="nb-step__check">{{ hasDirtyOrCommits ? "✅" : "⬜" }}</span>
          <div>
            <strong>1. Implement your changes</strong>
            <p>Use the terminal tabs to write code, run tests, and verify your work.</p>
          </div>
        </div>
        <div :class="['nb-step', hasCommits && 'nb-step--done', hasDirtyOrCommits && !hasCommits && 'nb-step--active']">
          <span class="nb-step__check">{{ hasCommits ? "✅" : "⬜" }}</span>
          <div>
            <strong>2. Commit your changes</strong>
            <p>
              {{
                gitSnapshot?.dirty
                  ? `You have ${gitSnapshot.dirtyCount} uncommitted file(s).`
                  : hasCommits
                    ? `${gitSnapshot?.aheadCount || 0} commit(s) ready to push.`
                    : "Working tree is clean. Make some changes first."
              }}
            </p>
          </div>
        </div>
        <div :class="['nb-step', hasCommits && 'nb-step--active']">
          <span class="nb-step__check">{{ "⬜" }}</span>
          <div>
            <strong>3. Create a pull request</strong>
            <p>
              {{
                hasCommits
                  ? "Fill in the form below and create your PR."
                  : "Commit your changes first, then create a PR."
              }}
            </p>
          </div>
        </div>
      </div>

      <!-- Commits -->
      <div v-if="hasCommits" style="margin-top: 20px">
        <p class="eyebrow">Commits ({{ gitSnapshot?.aheadCount || 0 }} ahead of base)</p>
        <div class="review-commits-panel">
          <GitCommitLog
            :commits="recentCommits"
            :ahead-count="gitSnapshot?.aheadCount || 0"
            selected-commit=""
            @show-info="onShowCommitInfo"
          />
        </div>
      </div>

      <!-- PR creation form -->
      <div style="margin-top: 20px; border-top: 1px solid var(--border); padding-top: 16px">
        <p class="eyebrow">Create Pull Request</p>
        <h3 style="margin-top: 4px">{{ gitSnapshot?.branch || "?" }} &rarr; {{ prFormTarget || baseBranch || "?" }}</h3>
        <div class="git-pr-form" style="margin-top: 12px">
          <label class="git-pr-form__field">
            <span class="git-pr-form__label">Source branch</span>
            <input class="git-pr-form__input" type="text" :value="gitSnapshot?.branch || ''" disabled />
          </label>
          <label class="git-pr-form__field">
            <span class="git-pr-form__label">Target branch</span>
            <CustomSelect
              v-model="prFormTarget"
              class="git-branch-select"
              placeholder="-- select target --"
              :options="prFormTargetOptions"
            />
            <button
              v-if="!prFormLoadingBranches"
              type="button"
              class="button button--ghost button--small"
              style="margin-left: 6px"
              @click="loadPrBranches"
            >
              Load remote branches
            </button>
            <span v-else style="font-size: 12px; color: var(--muted); margin-left: 6px">Loading...</span>
            <span v-if="prFormBranchesError" style="font-size: 12px; color: var(--danger, #e53935); margin-left: 6px">{{
              prFormBranchesError
            }}</span>
          </label>
          <label class="git-pr-form__field">
            <span class="git-pr-form__label">Title</span>
            <input v-model="prFormTitle" class="git-pr-form__input" type="text" placeholder="Pull request title" />
          </label>
          <label class="git-pr-form__field">
            <span class="git-pr-form__label">Description</span>
            <textarea
              v-model="prFormDescription"
              class="git-pr-form__input git-pr-form__textarea"
              placeholder="Optional description"
              rows="4"
            ></textarea>
          </label>
          <label class="git-pr-form__field" style="flex-direction: row; align-items: center; gap: 8px">
            <input v-model="prFormDraft" type="checkbox" />
            <span>Create as draft</span>
          </label>
          <div class="git-operation-actions">
            <button type="button" class="button" :disabled="!prFormCanSubmit || prFormBusy" @click="handleCreatePr">
              {{ prFormBusy ? "Creating…" : prFormDraft ? "Create Draft Pull Request" : "Create Pull Request" }}
            </button>
          </div>
          <p v-if="prFormResult" :class="['git-card__hint', prFormResult.ok ? '' : 'git-card__hint--warning']">
            {{ prFormResult.summary }}
            <a
              v-if="prFormResult.url"
              :href="prFormResult.url"
              style="color: var(--accent); text-decoration: underline"
              @click.prevent="openExternal(prFormResult.url)"
              >Open in browser</a
            >
          </p>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, inject, watch } from "vue";
import { apiKey } from "../../../types/keys.js";
import { useAppStore } from "../../../stores/app.js";
import { useNotificationStore } from "../../../stores/notifications.js";
import GitCommitLog from "../git/GitCommitLog.vue";
import CustomSelect from "../../common/CustomSelect.vue";

const props = defineProps<{ workspaceId: string }>();

const appStore = useAppStore();
const notifications = useNotificationStore();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const api = inject<any>(apiKey);

const workspace = computed(() =>
  (appStore.payload?.appState?.workspaces || []).find((ws) => ws.id === props.workspaceId),
);
const isGitHub = computed(() => workspace.value?.review?.provider === "github");
const prKey = computed(() => workspace.value?.review?.prKey || "");
// This component is only mounted while the workspace has no PR yet (see
// AzureReviewPane's `v-if="!detail && isPrePrWorkspace"`), so this is always
// true for the lifetime of the instance — kept as its own computed (rather
// than assumed) so the watches below read the same way they did before the
// extraction.
const isPrePrWorkspace = computed(
  () => !workspace.value?.review?.prKey && ["azure-devops", "github"].includes(workspace.value?.review?.provider || ""),
);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const gitSnapshot = computed(() => appStore.getGitSnapshot(props.workspaceId) as Record<string, any> | null);
const aheadCount = computed(() => gitSnapshot.value?.aheadCount || 0);
const baseBranch = computed(() => workspace.value?.quickfix?.baseBranch || "");
const hasDirtyOrCommits = computed(() => !!(gitSnapshot.value?.dirty || (gitSnapshot.value?.aheadCount || 0) > 0));
const hasCommits = computed(() => (gitSnapshot.value?.aheadCount || 0) > 0);
const recentCommits = computed(() => {
  const log = gitSnapshot.value?.log || [];
  return log;
});
const aheadCommits = computed(() => {
  const log = gitSnapshot.value?.log || [];
  const ahead = gitSnapshot.value?.aheadCount || 0;
  return log.slice(0, ahead);
});

const prFormTarget = ref<string>("");
const prFormTitle = ref<string>("");
const prFormDescription = ref<string>("");
const prFormBranches = ref<string[]>([]);
const prFormLoadingBranches = ref(false);
const prFormBranchesError = ref("");
const prFormBusy = ref(false);
const prFormResult = ref<{ ok: boolean; summary: string; url?: string } | null>(null);
const prFormDraft = ref(false);
let prFormAutoFilled = false;

const prFormCanSubmit = computed(() => prFormTarget.value && prFormTitle.value.trim());

const prFormTargetOptions = computed(() => prFormBranches.value.map((b) => ({ value: b, label: b })));

function generatePrTitleAndDescription() {
  if (prFormAutoFilled) return;
  const commits = aheadCommits.value;
  if (!commits.length) return;

  if (commits.length === 1) {
    // Single commit: use subject as title
    prFormTitle.value = commits[0].subject || "";
  } else {
    // Multiple commits: use branch name as title, list commits as description
    const branch = gitSnapshot.value?.branch || "";
    // Try to extract meaningful name from branch (e.g., "fix/MSP-12345-some-description" → "MSP-12345 some description")
    const branchSuffix = branch.includes("/") ? branch.split("/").slice(1).join("/") : branch;
    prFormTitle.value = branchSuffix.replace(/[-_]/g, " ").replace(/\s+/g, " ").trim();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    prFormDescription.value = commits.map((c: any) => `- ${c.subject}`).join("\n");
  }
  prFormAutoFilled = true;
}

async function loadPrBranches() {
  prFormLoadingBranches.value = true;
  prFormBranchesError.value = "";
  try {
    const listFn = isGitHub.value ? api.githubListRemoteBranches : api.azureListRemoteBranches;
    const result = await listFn({ workspaceId: props.workspaceId });
    prFormBranches.value = result.branches || [];
    if (!prFormTarget.value) {
      prFormTarget.value =
        prFormBranches.value.find((b) => b === baseBranch.value) ||
        prFormBranches.value.find((b) => b === "develop") ||
        prFormBranches.value.find((b) => b === "main") ||
        prFormBranches.value[0] ||
        "";
    }
    generatePrTitleAndDescription();
  } catch (error) {
    prFormBranches.value = [];
    prFormBranchesError.value = (error as Error)?.message || "Failed to load remote branches.";
  } finally {
    prFormLoadingBranches.value = false;
  }
}

// Auto-load branches when pre-PR view is active
watch(
  isPrePrWorkspace,
  (active) => {
    if (active && !prFormBranches.value.length) {
      loadPrBranches();
    }
  },
  { immediate: true },
);

// Auto-generate title when commits change
watch(aheadCommits, () => {
  if (isPrePrWorkspace.value && !prFormAutoFilled) {
    generatePrTitleAndDescription();
  }
});

async function handleCreatePr() {
  if (!prFormCanSubmit.value || prFormBusy.value) return;
  prFormBusy.value = true;
  prFormResult.value = null;
  try {
    // Check for unpushed commits
    if (aheadCount.value > 0) {
      const pushConfirmed = await appStore.confirmInApp({
        title: "Push commits before creating PR?",
        message: `You have ${aheadCount.value} unpushed commit${aheadCount.value === 1 ? "" : "s"}. Push to remote before creating the PR?`,
        confirmLabel: "Push and create",
      });
      if (!pushConfirmed) {
        prFormResult.value = { ok: false, summary: "Push your commits to remote first, then try again." };
        return;
      }
      if (isGitHub.value) {
        await appStore.githubPushReviewWorkspace(props.workspaceId);
      } else {
        await appStore.azurePushReviewWorkspace(props.workspaceId);
      }
    }

    const createFn = isGitHub.value ? api.githubCreatePullRequest : api.azureCreatePullRequest;
    const { result } = await createFn({
      workspaceId: props.workspaceId,
      targetBranch: prFormTarget.value,
      title: prFormTitle.value.trim(),
      description: prFormDescription.value.trim(),
      isDraft: prFormDraft.value,
    });
    const prId = result.pullRequestNumber || result.pullRequestId;
    prFormResult.value = {
      ok: true,
      summary: `PR #${prId} created.`,
      url: result.url,
    };
  } catch (err) {
    prFormResult.value = { ok: false, summary: (err as Error)?.message || "Failed to create pull request." };
  } finally {
    prFormBusy.value = false;
  }
}

function openExternal(url: string) {
  if (api?.openExternal) api.openExternal(url);
  else window.open(url, "_blank");
}

const busyAction = ref<string>("");

async function handleRefresh() {
  busyAction.value = "refresh";
  try {
    await notifications.runWithToast("Refresh failed", async () => {
      if (isGitHub.value) {
        await appStore.refreshGitHub();
        if (prKey.value) await appStore.markGitHubPrSeen(prKey.value);
      } else {
        await appStore.refreshAzure();
        if (prKey.value) await appStore.markAzurePrSeen(prKey.value);
      }
    });
  } finally {
    busyAction.value = "";
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function onShowCommitInfo(entry: any) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ws = workspace.value as any;
  const rootPath = ws?.cwd || (ws?.gitRoots?.[0] ?? "");
  appStore.openDialog("GitCommitInfoDialog", {
    workspaceId: props.workspaceId,
    rootPath,
    hash: entry?.shortHash || entry?.hash || "",
    seed: {
      shortHash: entry?.shortHash || "",
      hash: entry?.hash || entry?.shortHash || "",
      subject: entry?.subject || "",
      author: entry?.author || "",
      relativeDate: entry?.relativeDate || "",
      refs: entry?.refs || "",
    },
    onClose: () => appStore.closeDialog(),
  });
}
</script>

<style scoped>
.nb-step {
  display: flex;
  gap: 10px;
  padding: 10px 14px;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: rgba(255, 255, 255, 0.03);
  font-size: 13px;
}

.nb-step strong {
  display: block;
}

.nb-step p {
  margin: 2px 0 0;
  font-size: 12px;
  color: var(--muted);
}

.nb-step--done {
  opacity: 0.5;
}

.nb-step--active {
  border-color: var(--accent, #ffa424);
  background: rgba(255, 164, 36, 0.06);
}

.nb-step__check {
  font-size: 16px;
  flex-shrink: 0;
  line-height: 1.2;
}

/* Bound the commit list so a long history scrolls inside a panel instead of
   pushing the PR form far down the page. */
.review-commits-panel {
  margin-top: 6px;
  max-height: 320px;
  overflow-y: auto;
  border: 1px solid var(--border);
  border-radius: 6px;
}
</style>
