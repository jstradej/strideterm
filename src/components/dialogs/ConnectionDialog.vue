<template>
  <div class="dialog" style="width: min(680px, 100%)">
    <div class="dialog__header">
      <div>
        <p class="eyebrow">{{ isGitHub ? "GitHub" : "Azure DevOps" }}</p>
        <h2>{{ connection ? "Edit connection" : "Add connection" }}</h2>
      </div>
    </div>
    <form class="form" @submit.prevent="handleSubmit">
      <div :class="isGitHub ? 'grid' : 'grid grid--two-col'">
        <label>
          <span>Label</span>
          <input
            ref="labelRef"
            v-model="draft.label"
            required
            maxlength="60"
            :title="
              isGitHub
                ? undefined
                : `Human-readable name for this Azure DevOps connection. Shown in the inbox header and connection list.`
            "
          />
        </label>
        <label>
          <span>Poll seconds</span>
          <input
            v-model.number="draft.pollSeconds"
            type="number"
            min="15"
            max="3600"
            :title="
              isGitHub
                ? undefined
                : 'How often (in seconds) strIDEterm should re-poll Azure DevOps for this connection. Lower = fresher but more API calls; minimum 15s, maximum 1 hour.'
            "
          />
        </label>
      </div>
      <label v-if="isGitHub">
        <span>Host URL</span>
        <input v-model="draft.hostUrl" placeholder="https://github.com" required maxlength="300" />
        <small style="color: var(--muted); font-size: 12px"
          >Use https://github.com for GitHub.com or your GitHub Enterprise Server URL.</small
        >
      </label>
      <label v-else>
        <span>Organization URL</span>
        <input
          v-model="draft.orgUrl"
          placeholder="https://dev.azure.com/your-org"
          required
          maxlength="300"
          title="Your Azure DevOps organization root URL. Pasting a project or repository page URL also works — strIDEterm will normalize it down to the org root."
        />
        <small style="color: var(--muted); font-size: 12px"
          >A project or repository page URL also works. The app will normalize it.</small
        >
      </label>
      <template v-if="isGitHub">
        <label>
          <span>PAT {{ connection ? "(leave empty to keep current token)" : "" }}</span>
          <input v-model="draft.pat" type="password" placeholder="Personal Access Token" maxlength="300" />
          <small style="color: var(--muted); font-size: 12px">Fine-grained or classic PAT with repo scope.</small>
        </label>
      </template>
      <div v-else class="grid grid--two-col">
        <label>
          <span>Login / UPN</span>
          <input
            v-model="draft.login"
            placeholder="me@company.com"
            required
            maxlength="200"
            title="Your Azure DevOps account email / UPN. Used for git authentication when checking out PRs and pushing branches."
          />
        </label>
        <label>
          <span>PAT {{ connection ? "(leave empty to keep current token)" : "" }}</span>
          <input
            v-model="draft.pat"
            type="password"
            placeholder="Personal Access Token"
            maxlength="300"
            title="Personal Access Token (Code: read+write, Pull Request: read+write). Stored encrypted in the OS credential store; not in plain text. When editing, leave empty to keep the existing token."
          />
        </label>
      </div>
      <label>
        <span>Review checkout root</span>
        <div class="input-with-action">
          <input
            v-model="draft.reviewRoot"
            :placeholder="isGitHub ? 'C:/Users/me/.strideterm/github-pr' : 'C:/Users/me/.strideterm/azure-pr'"
            maxlength="500"
            :title="
              isGitHub
                ? undefined
                : 'Local directory under which strIDEterm will create per-PR review worktrees. Each PR gets a folder named pr-<id>; cloning is shared across PRs from the same repo.'
            "
          />
          <button
            v-if="api?.browseDirectory"
            type="button"
            class="button button--ghost input-with-action__btn"
            :title="isGitHub ? undefined : 'Pick a directory using the OS file picker.'"
            @click="browseReviewRoot"
          >
            Browse
          </button>
        </div>
      </label>
      <div :class="isGitHub ? 'grid' : 'grid grid--two-col'">
        <label v-if="isGitHub">
          <span>Owner filters</span>
          <input v-model="draft.ownerFilters" placeholder="my-org, my-user" maxlength="500" />
          <small style="color: var(--muted); font-size: 12px">Comma-separated GitHub org or user names.</small>
        </label>
        <label v-else>
          <span>Project filters</span>
          <input
            v-model="draft.projectFilters"
            placeholder="Platform, Mobile"
            maxlength="500"
            title="Comma-separated list of Azure DevOps project names or ids to poll. Empty = poll all projects visible to your PAT."
          />
          <small style="color: var(--muted); font-size: 12px">Comma-separated project ids or names.</small>
        </label>
        <label>
          <span>Repository filters</span>
          <input
            v-model="draft.repositoryFilters"
            :placeholder="isGitHub ? 'owner/repo, owner/other-repo' : 'web-app, api'"
            maxlength="500"
            :title="
              isGitHub
                ? undefined
                : 'Comma-separated list of repository names or ids inside the filtered projects. Empty = include every repo in the selected projects.'
            "
          />
          <small style="color: var(--muted); font-size: 12px">{{
            isGitHub ? "Optional owner/repo names." : "Optional repo ids or names."
          }}</small>
        </label>
      </div>
      <label style="display: flex; align-items: center; gap: 8px">
        <input
          v-model="draft.enabled"
          type="checkbox"
          :title="
            isGitHub
              ? undefined
              : 'When unchecked, strIDEterm keeps the connection but stops polling it. Useful for temporarily silencing one connection without deleting its config.'
          "
        />
        <span>Enable polling for this connection</span>
      </label>
      <p v-if="errorMessage" style="margin: 0; color: var(--danger)">{{ errorMessage }}</p>
      <div
        v-if="verification"
        style="
          border: 1px solid var(--border);
          border-radius: 6px;
          padding: 12px;
          background: rgba(255, 255, 255, 0.03);
          display: grid;
          gap: 6px;
        "
      >
        <strong>Connection verified</strong>
        <template v-if="isGitHub">
          <small style="color: var(--muted)"
            >Authenticated as <strong>{{ verification.login }}</strong
            >{{ verification.name && verification.name !== verification.login ? ` (${verification.name})` : "" }}</small
          >
        </template>
        <template v-else>
          <small style="color: var(--muted)">{{ verification.projectCount }} projects available.</small>
          <div style="display: flex; flex-wrap: wrap; gap: 6px">
            <span
              v-for="project in (verification.projects || []).slice(0, 8)"
              :key="project.name"
              class="workspace-chip"
              >{{ project.name }}</span
            >
          </div>
        </template>
      </div>
      <footer :class="isGitHub ? 'dialog__footer' : 'dialog__footer dialog__footer--end'">
        <button
          type="button"
          class="button button--ghost"
          :title="isGitHub ? undefined : 'Discard the changes you made and close the dialog.'"
          @click="emit('cancel')"
        >
          Cancel
        </button>
        <button
          type="button"
          :class="['button', 'button--ghost', busy && 'button--busy']"
          :disabled="busy"
          :title="
            isGitHub
              ? undefined
              : 'Verify the URL, login and PAT against Azure DevOps and list the projects this connection can see. Does not save.'
          "
          @click="testConnection"
        >
          {{ busy ? "Testing…" : "Test connection" }}
        </button>
        <button
          type="submit"
          :class="['button', busy && 'button--busy']"
          :disabled="busy"
          :title="
            isGitHub
              ? undefined
              : 'Save this connection and (when enabled) start polling it on the configured interval.'
          "
        >
          {{ busy ? "Saving…" : "Save connection" }}
        </button>
      </footer>
    </form>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, inject, onMounted, useAttrs } from "vue";
import type { Transport } from "../../transport.js";
import { useConnectionDialogForm } from "../../composables/useConnectionDialogForm.js";

defineOptions({ inheritAttrs: false });

interface ConnectionDraftSource {
  id?: string;
  label?: string;
  orgUrl?: string;
  login?: string;
  hostUrl?: string;
  reviewRoot?: string;
  projectFilters?: string[];
  ownerFilters?: string[];
  repositoryFilters?: string[];
  pollSeconds?: number;
  enabled?: boolean;
}

interface VerificationResult {
  projectCount?: number;
  projects?: { name: string }[];
  login?: string;
  name?: string;
}

interface Props {
  connection?: ConnectionDraftSource | null;
  defaultReviewRoot?: string;
  provider?: "azure" | "github";
}

const props = withDefaults(defineProps<Props>(), {
  connection: null,
  defaultReviewRoot: "",
  provider: "azure",
});

const emit = defineEmits<{
  cancel: [];
}>();
const attrs = useAttrs();

const isGitHub = computed(() => props.provider === "github");

const api = inject<Transport>("api");
const labelRef = ref<HTMLInputElement | null>(null);

const draft = reactive({
  id: props.connection?.id || "",
  label: props.connection?.label || "",
  orgUrl: props.connection?.orgUrl || "",
  login: props.connection?.login || "",
  hostUrl: props.connection?.hostUrl || "https://github.com",
  pat: "",
  reviewRoot: props.connection?.reviewRoot || props.defaultReviewRoot || "",
  projectFilters: (props.connection?.projectFilters || []).join(", "),
  ownerFilters: (props.connection?.ownerFilters || []).join(", "),
  repositoryFilters: (props.connection?.repositoryFilters || []).join(", "),
  pollSeconds: props.connection?.pollSeconds || 120,
  enabled: props.connection?.enabled !== false,
});

onMounted(() => labelRef.value?.focus());

function buildDraftPayload() {
  const base = {
    id: draft.id,
    label: draft.label.trim(),
    pat: draft.pat.trim(),
    reviewRoot: draft.reviewRoot.trim(),
    enabled: draft.enabled,
    pollSeconds: Number(draft.pollSeconds) || 120,
    repositoryFilters: draft.repositoryFilters
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean),
  };
  if (isGitHub.value) {
    return {
      ...base,
      hostUrl: draft.hostUrl.trim(),
      ownerFilters: draft.ownerFilters
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean),
    };
  }
  return {
    ...base,
    orgUrl: draft.orgUrl.trim(),
    login: draft.login.trim(),
    projectFilters: draft.projectFilters
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean),
  };
}

const { busy, errorMessage, verification, browseReviewRoot, testConnection, handleSubmit } = useConnectionDialogForm<
  ReturnType<typeof buildDraftPayload>,
  VerificationResult
>({
  draft,
  defaultReviewRoot: () => props.defaultReviewRoot,
  browseDirectory: api?.browseDirectory,
  buildPayload: buildDraftPayload,
  verify: (payload) =>
    (isGitHub.value ? api?.verifyGitHubConnection?.(payload) : api?.verifyAzureConnection?.(payload)) as
      Promise<VerificationResult | null> | undefined,
  onSave: (payload) => (attrs.onSave as ((payload: unknown) => Promise<void>) | undefined)?.(payload),
  providerLabel: isGitHub.value ? "GitHub" : "Azure DevOps",
});
</script>
