<template>
  <div class="git-section" data-testid="pr-tab-panel">
    <article class="git-card">
      <div class="section-head">
        <div>
          <p class="eyebrow">Create Pull Request</p>
          <h3>{{ snapshot.branch }} &rarr; {{ prTargetBranch || "?" }}</h3>
        </div>
      </div>
      <div v-if="hasNoRemote" class="git-card__hint git-card__hint--warning" style="margin-bottom: 8px">
        This repo has no remote. Add a remote before connecting a PR provider.
      </div>
      <div
        v-else-if="!activeConnectionId && !hasAzureConnection"
        class="git-card__hint git-card__hint--warning"
        style="margin-bottom: 8px"
      >
        Connect Azure DevOps or GitHub to create pull requests. Use the credentials dropdown in the toolbar.
      </div>
      <template v-else>
        <p class="git-card__hint" style="margin-bottom: 8px">
          Using connection: <strong>{{ activeConnectionLabel }}</strong>
        </p>
        <div class="git-pr-form">
          <label class="git-pr-form__field">
            <span class="git-pr-form__label">Source branch</span>
            <input class="git-pr-form__input" type="text" :value="snapshot.branch" disabled />
          </label>
          <label class="git-pr-form__field">
            <span class="git-pr-form__label">Target branch</span>
            <CustomSelect
              v-model="prTargetBranch"
              class="git-branch-select"
              placeholder="-- select target --"
              :options="prTargetOptionsList"
            />
            <button
              v-if="!gitUi.remoteBranchesLoading"
              type="button"
              class="button button--ghost button--small"
              style="margin-left: 6px"
              @click="gitUiStore.azureListRemoteBranches(workspaceId)"
            >
              Load remote branches
            </button>
            <span v-else style="font-size: 12px; color: var(--muted); margin-left: 6px">Loading...</span>
          </label>
          <label class="git-pr-form__field">
            <span class="git-pr-form__label">Title</span>
            <input v-model="prTitle" class="git-pr-form__input" type="text" placeholder="Pull request title" />
          </label>
          <label class="git-pr-form__field">
            <span class="git-pr-form__label">Description</span>
            <textarea
              v-model="prDescription"
              class="git-pr-form__input git-pr-form__textarea"
              placeholder="Optional description"
              rows="4"
            ></textarea>
          </label>
          <div class="git-operation-actions">
            <button
              type="button"
              class="button"
              :disabled="
                !prCanSubmit || !!gitUi.busyAction || snapshot.aheadCount === 0 || !snapshot.upstream || snapshot.dirty
              "
              :title="
                !snapshot.upstream
                  ? 'Publish the branch first before creating a PR'
                  : snapshot.dirty
                    ? 'Commit or stash changes before creating a PR'
                    : snapshot.aheadCount === 0
                      ? 'Nothing to PR — no commits ahead of upstream'
                      : ''
              "
              @click="onCreatePr"
            >
              {{ gitUi.busyAction === "create-pr" ? "Creating…" : "Create Pull Request" }}
            </button>
          </div>
          <p v-if="prResult" :class="['git-card__hint', prResult.ok ? '' : 'git-card__hint--warning']">
            {{ prResult.summary || (prResult.ok ? "Pull request created." : "Failed to create pull request.") }}
            <a
              v-if="prResult.url"
              :href="prResult.url"
              style="color: var(--accent); text-decoration: underline"
              @click.prevent="openExternal(prResult.url)"
              >Open in browser</a
            >
          </p>
        </div>
      </template>
    </article>
  </div>
</template>

<script setup>
import { computed, ref, watch } from "vue";
import { useGitUiStore } from "../../../stores/git-ui.js";
import CustomSelect from "../../common/CustomSelect.vue";

const props = defineProps({
  workspaceId: { type: String, required: true },
  snapshot: { type: Object, required: true },
  gitUi: { type: Object, required: true },
  baseBranch: { type: String, default: "" },
  hasNoRemote: { type: Boolean, default: false },
  hasAzureConnection: { type: Boolean, default: false },
  activeConnectionId: { type: String, default: "" },
  activeConnectionLabel: { type: String, default: "" },
});

const gitUiStore = useGitUiStore();

const prTitle = ref("");
const prDescription = ref("");
const prTargetBranch = ref("");
const prResult = ref(null);

const prTargetOptions = computed(() => {
  const localBranches = (props.snapshot?.branchNames || []).filter(
    (n) => !n.startsWith("origin/") && n !== props.snapshot?.branch,
  );
  const remoteBranches = (props.gitUi.remoteBranches || []).filter((n) => n !== props.snapshot?.branch);
  const merged = [...new Set([...localBranches, ...remoteBranches])];
  const priority = ["develop", "main", "master"];
  merged.sort((a, b) => {
    const aIdx = priority.indexOf(a);
    const bIdx = priority.indexOf(b);
    if (aIdx >= 0 && bIdx >= 0) return aIdx - bIdx;
    if (aIdx >= 0) return -1;
    if (bIdx >= 0) return 1;
    return a.localeCompare(b);
  });
  return merged;
});

const prTargetOptionsList = computed(() => prTargetOptions.value.map((b) => ({ value: b, label: b })));
const prCanSubmit = computed(() => prTitle.value.trim() && prTargetBranch.value);

watch(
  () => props.baseBranch,
  (val) => {
    if (!prTargetBranch.value && val) {
      prTargetBranch.value = val.replace(/^origin\//, "");
    }
  },
  { immediate: true },
);

async function onCreatePr() {
  prResult.value = null;
  await gitUiStore.azureCreatePullRequest(props.workspaceId, {
    title: prTitle.value.trim(),
    description: prDescription.value.trim(),
    sourceBranch: props.snapshot?.branch || "",
    targetBranch: prTargetBranch.value,
    connectionId: props.activeConnectionId || "",
  });
  const result = props.gitUi.lastResult;
  if (result?.ok) {
    prResult.value = { ok: true, summary: `PR #${result.pullRequestId || ""} created.`, url: result.url || "" };
  } else {
    prResult.value = { ok: false, summary: result?.summary || "Failed to create pull request." };
  }
}

function openExternal(url) {
  if (window.strideterm?.openExternal) {
    window.strideterm.openExternal(url);
  } else {
    window.open(url, "_blank");
  }
}
</script>
