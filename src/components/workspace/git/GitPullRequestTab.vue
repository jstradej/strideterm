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
          <section v-if="jiraCandidateKeys.length" class="git-pr-jira-link" aria-label="Verify Jira issue candidate">
            <label class="git-pr-jira-field">
              <span class="git-pr-form__label">Jira candidate</span>
              <CustomSelect
                v-model="jiraCandidateSelection"
                placeholder="Choose key"
                :options="jiraCandidateKeys.map((key) => ({ value: key, label: key }))"
              />
            </label>
            <label v-if="jiraCandidateSelection" class="git-pr-jira-field">
              <span class="git-pr-form__label">Connection</span>
              <CustomSelect
                v-model="jiraCandidateConnection"
                placeholder="Choose connection"
                :options="jiraCandidateRoutes.map((route) => ({ value: route.connectionId, label: route.label }))"
              />
            </label>
            <div class="git-pr-jira-actions">
              <button
                class="button button--ghost"
                :class="{ 'button--pending': jiraVerifyBusy }"
                type="button"
                :aria-busy="jiraVerifyBusy ? 'true' : 'false'"
                :disabled="!jiraCandidateSelection || !jiraCandidateConnection || jiraVerifyBusy"
                @click="verifyJiraCandidate"
              >
                <span>Verify issue</span>
              </button>
            </div>
            <p v-if="verifiedJiraCandidate" class="git-pr-jira-note">
              Verified: {{ verifiedJiraCandidate.ref.issueKey }} · {{ verifiedJiraCandidate.summary }}
            </p>
            <p v-if="jiraVerifyMessage" class="git-pr-jira-note" role="status">{{ jiraVerifyMessage }}</p>
          </section>
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
          <section v-if="jiraLinkIssues.length" class="git-pr-jira-link">
            <label v-if="canCreateJiraLink" class="git-pr-jira-check"
              ><input v-model="addJiraLink" type="checkbox" /> Add a Jira link after the PR is created</label
            >
            <p v-else class="git-card__hint">Jira write actions are available in the desktop app.</p>
            <label v-if="jiraLinkIssues.length > 1" class="git-pr-jira-field">
              <span class="git-pr-form__label">Issue</span>
              <CustomSelect v-model="jiraIssueRefKey" placeholder="Choose a linked issue" :options="jiraLinkOptions" />
            </label>
            <p v-else class="git-pr-jira-note">
              {{ jiraLinkIssues[0].ref.issueKey }} · {{ jiraLinkIssues[0].summary }}
            </p>
            <p class="git-pr-jira-note">
              Only issues already linked to this workspace are available here. Jira linking is a separate confirmed
              action.
            </p>
            <p v-if="jiraLinkPhase === 'preview'" class="git-pr-jira-status" role="status">
              <Spinner size="sm" label="Preparing Jira link preview" /> Preparing Jira link preview…
            </p>
          </section>
          <div class="git-operation-actions">
            <button
              type="button"
              class="button"
              :disabled="
                !prCanSubmit || !!gitUi.busyAction || snapshot.aheadCount > 0 || !snapshot.upstream || snapshot.dirty
              "
              :title="
                !snapshot.upstream
                  ? 'Publish the branch first before creating a PR'
                  : snapshot.dirty
                    ? 'Commit or stash changes before creating a PR'
                    : snapshot.aheadCount > 0
                      ? 'Push your commits first — the PR is created from the branch on the remote'
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
          <div
            v-if="jiraLinkConfirmation"
            class="git-pr-jira-confirm"
            role="dialog"
            aria-label="Confirm Jira pull request link"
          >
            <p>PR creation succeeded. Confirm the separate Jira link.</p>
            <p>
              The link is added to the Jira issue by
              {{ jiraLinkConfirmation.account?.displayName || "the connected Jira account" }}.
            </p>
            <pre>{{ jiraLinkConfirmation.preview }}</pre>
            <div class="git-pr-jira-actions">
              <button
                class="button"
                :class="{ 'button--pending': jiraLinkPhase === 'execute' }"
                type="button"
                :aria-busy="jiraLinkPhase === 'execute' ? 'true' : 'false'"
                :disabled="jiraLinkBusy"
                @click="confirmJiraLink"
              >
                <span>Confirm Jira link</span>
              </button>
              <button
                class="button button--ghost"
                type="button"
                :disabled="jiraLinkBusy"
                @click="jiraLinkConfirmation = null"
              >
                Cancel
              </button>
            </div>
          </div>
          <p
            v-if="jiraLinkResult"
            class="git-card__hint"
            :class="{ 'git-card__hint--warning': !jiraLinkResult.ok }"
            role="status"
          >
            {{ jiraLinkResult.message }}
          </p>
        </div>
      </template>
    </article>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useGitUiStore } from "../../../stores/git-ui.js";
import { useAppStore } from "../../../stores/app.js";
import CustomSelect from "../../common/CustomSelect.vue";
import Spinner from "../../common/Spinner.vue";
import { submitPullRequest } from "./pull-request-submit.js";
import { userFacingMessage } from "../../../lib/error-message.js";
import { rlog } from "../../../lib/renderer-log.js";
import { jiraFailureCode } from "../jira/pane/jira-failure.js";

const props = withDefaults(
  defineProps<{
    workspaceId: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    snapshot: Record<string, any>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    gitUi: Record<string, any>;
    baseBranch?: string;
    hasNoRemote?: boolean;
    hasAzureConnection?: boolean;
    activeConnectionId?: string;
    activeConnectionLabel?: string;
    jiraRoutes?: Array<{ connectionId: string; label: string; webUrl: string; issueKeyPrefixes: string[] }>;
  }>(),
  {
    baseBranch: "",
    hasNoRemote: false,
    hasAzureConnection: false,
    activeConnectionId: "",
    activeConnectionLabel: "",
    jiraRoutes: () => [],
  },
);

const gitUiStore = useGitUiStore();
const appStore = useAppStore();
const api = appStore.getApi();
const jiraRoutes = computed(() => props.jiraRoutes || []);
const jiraCandidateKeys = computed(() => {
  const candidateText = [props.snapshot?.branch || "", prTitle.value, prDescription.value]
    .join(" ")
    .replace(/\[[^\]]+\]\([^)]+\)/g, " ")
    .replace(/\bhttps?:\/\/\S+/gi, " ");
  const matches = [...candidateText.matchAll(/(^|[^A-Z0-9_:.])([A-Z][A-Z0-9_]{0,19}-[1-9][0-9]*)(?![A-Z0-9_])/gi)].map(
    (match) => match[2],
  );
  return [...new Set(matches.map((key) => key.toUpperCase()))].filter((key) =>
    jiraRoutes.value.some((route) =>
      route.issueKeyPrefixes.some((prefix) => prefix.toUpperCase() === key.split("-")[0]),
    ),
  );
});
const jiraCandidateSelection = ref("");
const jiraCandidateConnection = ref("");
const jiraCandidateRoutes = computed(() => {
  const prefix = jiraCandidateSelection.value.split("-")[0].toUpperCase();
  return jiraRoutes.value.filter((route) => route.issueKeyPrefixes.some((item) => item.toUpperCase() === prefix));
});
const jiraVerifyBusy = ref(false);
let jiraVerifyGeneration = 0;
const jiraVerifyMessage = ref("");
type VerifiedJiraIssue = {
  ref: {
    provider?: string;
    connectionId?: string;
    issueId?: string;
    issueKey?: string;
  };
  summary?: string;
  title?: string;
  status?: string;
  ownIdentity?: { displayName: string };
};
const verifiedJiraCandidate = ref<VerifiedJiraIssue | null>(null);
async function verifyJiraCandidate() {
  const key = jiraCandidateSelection.value;
  const route = jiraRoutes.value.find((item) => item.connectionId === jiraCandidateConnection.value);
  if (!key || !route || !api.searchJiraIssues || !api.getJiraIssue) return;
  const generation = ++jiraVerifyGeneration;
  try {
    jiraVerifyBusy.value = true;
    jiraVerifyMessage.value = "";
    const result = (await api.searchJiraIssues({
      connectionId: route.connectionId,
      jql: `key = "${key}"`,
      limit: 5,
    })) as unknown;
    const issues: unknown[] = Array.isArray(result)
      ? result
      : result && typeof result === "object" && "issues" in result && Array.isArray(result.issues)
        ? result.issues
        : [];
    const issue = issues.find(
      (entry) =>
        entry !== null &&
        typeof entry === "object" &&
        "ref" in entry &&
        entry.ref !== null &&
        typeof entry.ref === "object" &&
        (entry as { ref: { connectionId?: unknown; issueKey?: unknown } }).ref.connectionId === route.connectionId &&
        typeof (entry as { ref: { issueKey?: unknown } }).ref.issueKey === "string" &&
        (entry as { ref: { issueKey: string } }).ref.issueKey.toUpperCase() === key.toUpperCase(),
    );
    const issueRef: { issueId?: unknown } | null =
      issue && typeof issue === "object" && "ref" in issue && issue.ref && typeof issue.ref === "object"
        ? (issue as { ref: { issueId?: unknown } }).ref
        : null;
    if (!issueRef || typeof issueRef.issueId !== "string")
      throw new Error("No matching issue found on this connection.");
    const verified = await api.getJiraIssue({
      connectionId: route.connectionId,
      issueId: issueRef.issueId,
    });
    if (
      !verified ||
      typeof verified !== "object" ||
      !("ref" in verified) ||
      !verified.ref ||
      typeof verified.ref !== "object"
    )
      throw new Error("Jira returned an invalid issue reference.");
    const verifiedRef = verified.ref as { connectionId?: unknown; issueKey?: unknown };
    if (verifiedRef.connectionId !== route.connectionId || typeof verifiedRef.issueKey !== "string")
      throw new Error("Jira returned an issue from a different connection.");
    if (generation !== jiraVerifyGeneration) return;
    verifiedJiraCandidate.value = verified as VerifiedJiraIssue;
    jiraVerifyMessage.value = "Issue verified. This does not create a workspace or Jira association.";
  } catch (cause) {
    if (generation !== jiraVerifyGeneration) return;
    verifiedJiraCandidate.value = null;
    jiraVerifyMessage.value = userFacingMessage(cause, "Could not verify Jira issue.");
    rlog("warn", "[jira] PR tab issue verification failed", {
      connectionId: route.connectionId,
      issueKey: key,
      code: jiraFailureCode(cause),
    });
  } finally {
    if (generation === jiraVerifyGeneration) jiraVerifyBusy.value = false;
  }
}
const canCreateJiraLink = computed(
  () => typeof api.previewJiraWrite === "function" && typeof api.executeJiraWrite === "function",
);

const prTitle = ref<string>("");
const prDescription = ref<string>("");
const prTargetBranch = ref<string>("");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const prResult = ref<Record<string, any> | null>(null);
type LinkedJiraIssue = {
  ref: { provider: "jira"; connectionId: string; issueId: string; issueKey: string };
  summary?: string;
  status?: string;
  ownIdentity?: { displayName: string };
};
const linkedJiraIssues = computed<LinkedJiraIssue[]>(() => {
  const workspace = appStore.payload?.appState?.workspaces?.find((item) => item.id === props.workspaceId);
  if (!workspace || (workspace.profileId || "default") !== appStore.myActiveProfileId) return [];
  return (workspace as typeof workspace & { workItems?: LinkedJiraIssue[] }).workItems || [];
});
const jiraLinkIssues = computed<LinkedJiraIssue[]>(() => {
  const verified = verifiedJiraCandidate.value;
  const ref = verified?.ref;
  if (
    !ref ||
    ref.provider !== "jira" ||
    typeof ref.connectionId !== "string" ||
    typeof ref.issueId !== "string" ||
    typeof ref.issueKey !== "string"
  )
    return linkedJiraIssues.value;
  const candidate: LinkedJiraIssue = {
    ref: ref as LinkedJiraIssue["ref"],
    summary: verified.summary || verified.title || "Verified Jira issue",
  };
  return linkedJiraIssues.value.some(
    (item) => item.ref.connectionId === ref.connectionId && item.ref.issueId === ref.issueId,
  )
    ? linkedJiraIssues.value
    : [...linkedJiraIssues.value, candidate];
});
const addJiraLink = ref(false);
const jiraIssueRefKey = ref("");
const jiraLinkPhase = ref<"preview" | "execute" | null>(null);
const jiraLinkBusy = computed(() => jiraLinkPhase.value !== null);
const jiraLinkConfirmation = ref<{
  token: string;
  intent: string;
  preview: string;
  account?: { displayName: string; purpose: string };
} | null>(null);
const jiraLinkResult = ref<{ ok: boolean; message: string } | null>(null);
const jiraIssueKey = (issue: LinkedJiraIssue) => `${issue.ref.connectionId}:${issue.ref.issueId}`;
const jiraLinkOptions = computed(() =>
  jiraLinkIssues.value.map((issue) => ({
    value: jiraIssueKey(issue),
    label: `${issue.ref.issueKey} · ${issue.summary || ""}`,
  })),
);
watch(
  jiraLinkIssues,
  (list) => {
    if (list.length === 1) jiraIssueRefKey.value = jiraIssueKey(list[0]);
    else if (!list.some((item) => jiraIssueKey(item) === jiraIssueRefKey.value)) jiraIssueRefKey.value = "";
  },
  { immediate: true },
);
const linkedJiraIssue = computed(
  () =>
    jiraLinkIssues.value.find((item) => jiraIssueKey(item) === jiraIssueRefKey.value) ||
    (!verifiedJiraCandidate.value && jiraLinkIssues.value.length === 1 ? jiraLinkIssues.value[0] : undefined),
);

const prTargetOptions = computed(() => {
  const localBranches = (props.snapshot?.branchNames || []).filter(
    (n: string) => !n.startsWith("origin/") && n !== props.snapshot?.branch,
  );
  const remoteBranches = (props.gitUi.remoteBranches || []).filter((n: string) => n !== props.snapshot?.branch);
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
  jiraLinkResult.value = null;
  jiraLinkConfirmation.value = null;
  prResult.value = await submitPullRequest(
    gitUiStore,
    props.workspaceId,
    {
      title: prTitle.value.trim(),
      description: prDescription.value.trim(),
      sourceBranch: props.snapshot?.branch || "",
      targetBranch: prTargetBranch.value,
      connectionId: props.activeConnectionId || "",
    },
    props.gitUi,
  );
  if (!prResult.value?.ok || !addJiraLink.value || !canCreateJiraLink.value) return;
  if (!linkedJiraIssue.value || !prResult.value.url) {
    jiraLinkResult.value = {
      ok: false,
      message: "Pull request created, but no linked Jira issue or PR URL was available for the separate Jira link.",
    };
    return;
  }
  try {
    jiraLinkPhase.value = "preview";
    const preview = (await api.previewJiraWrite?.({
      action: "remote-link",
      ref: linkedJiraIssue.value.ref,
      url: prResult.value.url,
      title: prTitle.value.trim(),
      globalId: prResult.value.url,
      intent: "Link the created pull request to this Jira issue",
    })) as
      | { token: string; intent: string; preview: string; account?: { displayName: string; purpose: string } }
      | undefined;
    if (!preview) throw new Error("Jira write preparation is unavailable.");
    jiraLinkConfirmation.value = preview;
  } catch (cause) {
    const reason = userFacingMessage(cause, "unknown error");
    rlog("warn", "[jira] PR link preview failed", {
      issueKey: linkedJiraIssue.value.ref.issueKey,
      code: jiraFailureCode(cause),
    });
    jiraLinkResult.value = {
      ok: false,
      message: `Pull request created, but Jira link preparation failed: ${reason}`,
    };
  } finally {
    jiraLinkPhase.value = null;
  }
}

async function confirmJiraLink() {
  if (!jiraLinkConfirmation.value || !linkedJiraIssue.value || !prResult.value?.url || !api.executeJiraWrite) return;
  const issueKey = linkedJiraIssue.value.ref.issueKey;
  const confirmation = jiraLinkConfirmation.value;
  try {
    jiraLinkPhase.value = "execute";
    const result = await api.executeJiraWrite({
      action: "remote-link",
      ref: linkedJiraIssue.value.ref,
      url: prResult.value.url,
      title: prTitle.value.trim(),
      globalId: prResult.value.url,
      confirmation,
    });
    jiraLinkConfirmation.value = null;
    if (!result.ok) {
      const error = result.error;
      const reason = userFacingMessage(error.message, "Jira did not accept the link.");
      rlog("warn", "[jira] PR link write failed", {
        issueKey,
        code: error.code,
        status: error.status,
        journalId: error.journalId,
      });
      jiraLinkResult.value = {
        ok: false,
        message:
          error.status === "unknown"
            ? `Pull request created, but the Jira link may have been added. Check ${issueKey} in Jira and reconcile before retrying. ${reason}`
            : `Pull request created, but Jira link failed: ${reason}`,
      };
      return;
    }
    jiraLinkResult.value = { ok: true, message: "Pull request created and Jira link added." };
  } catch (cause) {
    jiraLinkConfirmation.value = null;
    const reason = userFacingMessage(cause, "unknown error");
    rlog("warn", "[jira] PR link write failed", { issueKey, code: jiraFailureCode(cause) });
    jiraLinkResult.value = {
      ok: false,
      message: `Pull request created, but Jira link failed: ${reason}`,
    };
  } finally {
    jiraLinkPhase.value = null;
  }
}

watch(
  jiraCandidateKeys,
  (keys) => {
    if (keys.length === 1) jiraCandidateSelection.value = keys[0];
    else if (!keys.includes(jiraCandidateSelection.value)) jiraCandidateSelection.value = "";
  },
  { immediate: true },
);
watch(
  jiraCandidateRoutes,
  (routes) => {
    if (routes.length === 1) jiraCandidateConnection.value = routes[0].connectionId;
    else if (!routes.some((route) => route.connectionId === jiraCandidateConnection.value))
      jiraCandidateConnection.value = "";
  },
  { immediate: true },
);
watch(
  [jiraCandidateSelection, jiraCandidateConnection],
  () => {
    jiraVerifyGeneration++;
    jiraVerifyBusy.value = false;
    verifiedJiraCandidate.value = null;
    jiraVerifyMessage.value = "";
    if (jiraCandidateSelection.value && jiraCandidateConnection.value) void verifyJiraCandidate();
  },
  { immediate: true },
);

function openExternal(url: string) {
  if (window.strideterm?.openExternal) {
    window.strideterm.openExternal(url);
  } else {
    window.open(url, "_blank");
  }
}
</script>
