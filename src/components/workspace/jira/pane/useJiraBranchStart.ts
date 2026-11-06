import { computed, getCurrentScope, nextTick, onScopeDispose, ref, watch } from "vue";
import { parseAgentCommand } from "../../../../../electron/shared/agent-ssh.js";
import { PROVIDER_CHOICES } from "../../../../../electron/shared/agent-provider-catalog.js";
import {
  JIRA_DEVELOPMENT_DEFAULT_MODE,
  OPERATION_KIND_JIRA_DEVELOPMENT,
  jiraDevelopmentTask,
  type JiraDevelopmentMode,
  jiraIssueFilePath,
  type JiraDevelopmentAgent,
  type StartJiraDevelopmentInput,
} from "../../../../../electron/shared/jira-development.js";
import type { OperationFinished } from "../../../../../electron/shared/operation-events.js";
import { openPathInFilesTab } from "../../../../app/open-in-files-tab.js";
import { userFacingMessage } from "../../../../lib/error-message.js";
import { useNotificationStore } from "../../../../stores/notifications.js";
import { type TaskRepo, type TaskProject, type TaskConnection } from "./jira-pane-types.js";
import type { JiraPaneContext } from "./jira-pane-context.js";
import { jiraBranchName } from "../jira-branch-name.js";

const TARGET_KEY_PREFIX = "strideterm.jira.branchTarget.";
const AGENT_KEY = "strideterm.jira.developmentAgent";
const AGENT_MODEL_KEY_PREFIX = "strideterm.jira.developmentModel.";
const AGENT_PROVIDERS: readonly JiraDevelopmentAgent[] = ["claude", "codex", "copilot", "opencode"];

type BranchProvider = "azure" | "github";

type BranchTarget = {
  connectionKey: string;
  projectId?: string;
  repoId: string;
  baseBranch: string;
};

const PROVIDER_LABEL: Record<BranchProvider, string> = { azure: "Azure DevOps", github: "GitHub" };

function targetStorageKey(jiraConnectionId: string, projectKey: string) {
  return `${TARGET_KEY_PREFIX}${jiraConnectionId}.${projectKey.toUpperCase()}`;
}

function rememberedTarget(jiraConnectionId: string, projectKey: string): BranchTarget | null {
  try {
    const raw = window.localStorage.getItem(targetStorageKey(jiraConnectionId, projectKey));
    const value = raw ? (JSON.parse(raw) as Partial<BranchTarget>) : null;
    return value?.connectionKey && value.repoId && value.baseBranch ? (value as BranchTarget) : null;
  } catch {
    return null;
  }
}

function rememberedAgent(): JiraDevelopmentAgent | "" | null {
  try {
    const value = window.localStorage.getItem(AGENT_KEY);
    return value === "" || (AGENT_PROVIDERS as readonly string[]).includes(value || "")
      ? (value as JiraDevelopmentAgent | "")
      : null;
  } catch {
    return null;
  }
}

function rememberAgent(agent: JiraDevelopmentAgent | "") {
  try {
    window.localStorage.setItem(AGENT_KEY, agent);
  } catch {
    // The agent choice is a convenience; the dialog falls back to the first installed agent.
  }
}

type AgentModelChoice = { model: string; effort: string };

function rememberedModel(agent: JiraDevelopmentAgent): AgentModelChoice {
  try {
    const value = JSON.parse(
      window.localStorage.getItem(`${AGENT_MODEL_KEY_PREFIX}${agent}`) || "null",
    ) as Partial<AgentModelChoice> | null;
    return { model: String(value?.model || ""), effort: String(value?.effort || "") };
  } catch {
    return { model: "", effort: "" };
  }
}

function rememberModel(agent: JiraDevelopmentAgent, choice: AgentModelChoice) {
  try {
    window.localStorage.setItem(`${AGENT_MODEL_KEY_PREFIX}${agent}`, JSON.stringify(choice));
  } catch {
    // Like the agent choice: a convenience, the dialog falls back to the template's own model.
  }
}

function rememberTarget(jiraConnectionId: string, projectKey: string, target: BranchTarget) {
  try {
    window.localStorage.setItem(targetStorageKey(jiraConnectionId, projectKey), JSON.stringify(target));
  } catch {
    // Remembering the last target is a convenience; the branch workspace is created either way.
  }
}

export function useJiraBranchStart(ctx: JiraPaneContext) {
  const { beginBusy, dynamicApi, isBusy, reportFailure, savedRepoBinding, selected, store, branchDialogOpen } = ctx;
  const branchConnectionKey = ref("");
  const branchProjectId = ref("");
  const branchProjectName = ref("");
  const branchRepoId = ref("");
  const branchRepos = ref<TaskRepo[]>([]);
  const branchProjects = ref<TaskProject[]>([]);
  const branchBases = ref<string[]>([]);
  const branchBase = ref("");
  const branchName = ref("");
  let branchNameDefault = "";
  const branchError = ref("");
  const repoPreferenceNotice = ref("");
  const branchProjectsLoading = ref(false);
  const branchReposLoading = ref(false);
  const branchBasesLoading = ref(false);
  const branchAgent = ref<JiraDevelopmentAgent | "">("");
  const branchModel = ref("");
  const branchEffort = ref("");
  const branchAgentChoice = computed(() => PROVIDER_CHOICES.find((choice) => choice.id === branchAgent.value));
  /** "" keeps whatever the agent's tab template sets; the list is a suggestion, any model id can be typed. */
  const branchModelChoices = computed(() =>
    (branchAgentChoice.value?.models || []).filter((model) => model.id && model.id !== "default"),
  );
  const branchEffortOptions = computed(() =>
    branchAgentChoice.value?.effortLevels.length
      ? [
          { value: "", label: "Template default" },
          ...branchAgentChoice.value.effortLevels.map((level) => ({ value: level, label: level })),
        ]
      : [],
  );
  watch(
    branchAgent,
    (agent) => {
      const remembered = agent ? rememberedModel(agent) : { model: "", effort: "" };
      branchModel.value = remembered.model;
      branchEffort.value = branchEffortOptions.value.some((option) => option.value === remembered.effort)
        ? remembered.effort
        : "";
    },
    { immediate: true },
  );
  const branchMode = ref<JiraDevelopmentMode>(JIRA_DEVELOPMENT_DEFAULT_MODE);
  // One text per mode, so switching tabs keeps what the user wrote in the other.
  const branchTasks = ref<Record<JiraDevelopmentMode, string>>({ analyze: "", implement: "" });
  const branchTaskDefaults: Record<JiraDevelopmentMode, string> = { analyze: "", implement: "" };
  const branchTask = computed({
    get: () => branchTasks.value[branchMode.value],
    set: (value: string) => {
      branchTasks.value[branchMode.value] = value;
    },
  });
  let projectsRequest = 0;
  let reposRequest = 0;
  let basesRequest = 0;

  const branchConnections = computed(() => {
    const integrations = (
      store.payload as
        | {
            appState?: {
              settings?: {
                integrations?: {
                  azureDevops?: { connections?: TaskConnection[] };
                  github?: { connections?: TaskConnection[] };
                };
              };
            };
          }
        | undefined
    )?.appState?.settings?.integrations;
    const own = (list: TaskConnection[] | undefined, provider: BranchProvider) =>
      (list || [])
        .filter((item) => item.enabled !== false && (item.profileId || "default") === store.myActiveProfileId)
        .map((item) => ({ key: `${provider}:${item.id}`, provider, id: item.id, label: item.label }));
    return [
      ...own(integrations?.azureDevops?.connections, "azure"),
      ...own(integrations?.github?.connections, "github"),
    ];
  });
  const hasBranchConnections = computed(() => branchConnections.value.length > 0);
  const branchConnectionOptions = computed(() =>
    branchConnections.value.map((item) => ({
      value: item.key,
      label: `${PROVIDER_LABEL[item.provider]} · ${item.label}`,
    })),
  );
  const activeConnection = computed(() =>
    branchConnections.value.find((item) => item.key === branchConnectionKey.value),
  );
  const branchProvider = computed<BranchProvider>(() => activeConnection.value?.provider ?? "azure");
  const branchProjectOptions = computed(() =>
    branchProjects.value.map((project) => ({ value: project.id, label: project.name })),
  );
  const branchRepoOptions = computed(() =>
    branchRepos.value.map((repo) => ({
      value: repo.id || repo.fullName || repo.name,
      label: repo.fullName || repo.name,
    })),
  );
  const branchBaseOptions = computed(() => branchBases.value.map((branch) => ({ value: branch, label: branch })));
  /** One entry per agent CLI that has a plain tab template, labelled with the template's own title. */
  const branchAgentOptions = computed<Array<{ value: JiraDevelopmentAgent | ""; label: string }>>(() => {
    const templates =
      (store.payload as { appState?: { tabTemplates?: Array<{ title?: string; command?: string; launch?: unknown }> } })
        ?.appState?.tabTemplates || [];
    const options: Array<{ value: JiraDevelopmentAgent | ""; label: string }> = [];
    for (const provider of AGENT_PROVIDERS) {
      const template = templates.find((item) => !item.launch && parseAgentCommand(item.command)?.provider === provider);
      if (template) options.push({ value: provider, label: template.title || provider });
    }
    return [...options, { value: "", label: "No agent — only the branch and the issue files" }];
  });
  const branchTaskFacts = computed(() => {
    const issue = selected.value;
    const repo = currentRepo();
    return issue?.ref
      ? {
          issueKey: issue.ref.issueKey,
          summary: issue.summary || issue.title || "",
          branch: branchName.value.trim() || "(new branch)",
          baseBranch: branchBase.value || "(base branch)",
          repository: repo ? repo.fullName || repo.name : "(repository)",
        }
      : null;
  });
  /** Instructions the user edited are theirs; the default follows the branch, base and repository chosen above. */
  const branchTaskEdited = (mode: JiraDevelopmentMode) =>
    Boolean(branchTasks.value[mode].trim()) && branchTasks.value[mode] !== branchTaskDefaults[mode];
  function applyDefaultTask(mode: JiraDevelopmentMode) {
    branchTaskDefaults[mode] = branchTaskFacts.value ? jiraDevelopmentTask(branchTaskFacts.value, mode) : "";
    branchTasks.value[mode] = branchTaskDefaults[mode];
  }
  watch(
    branchTaskFacts,
    (facts) => {
      if (!facts) return;
      for (const mode of ["analyze", "implement"] as const) if (!branchTaskEdited(mode)) applyDefaultTask(mode);
    },
    { immediate: true },
  );
  function resetBranchTask() {
    applyDefaultTask(branchMode.value);
  }
  function applyDefaultAgent() {
    const values = branchAgentOptions.value.map((option) => option.value);
    if (values.includes(branchAgent.value) && branchAgent.value) return;
    const remembered = rememberedAgent();
    branchAgent.value = remembered !== null && values.includes(remembered) ? remembered : values[0] || "";
  }
  const canStartBranch = computed(() =>
    Boolean(
      selected.value?.ref &&
      activeConnection.value &&
      branchRepoId.value &&
      branchBase.value &&
      branchName.value.trim(),
    ),
  );
  const startBranchDisabledReason = computed(() => {
    if (!hasBranchConnections.value) return "Add an Azure DevOps or GitHub connection first.";
    if (!activeConnection.value) return "Choose a connection first.";
    if (branchProvider.value === "azure" && !branchProjectId.value) return "Choose a project first.";
    if (!branchRepoId.value) return "Choose a repository first.";
    if (!branchBase.value) return "Choose a base branch first.";
    if (!branchName.value.trim()) return "Enter a name for the new branch first.";
    return "";
  });

  function repoKey(repo: TaskRepo) {
    return repo.id || repo.fullName || repo.name;
  }
  function currentRepo() {
    return branchRepos.value.find((item) => repoKey(item) === branchRepoId.value);
  }
  /** A branch name the user typed is theirs; only an empty or still-default name is regenerated for the open issue. */
  function applyDefaultBranchName() {
    const issue = selected.value;
    if (!issue?.ref) return;
    if (branchName.value.trim() && branchName.value !== branchNameDefault) return;
    branchNameDefault = jiraBranchName(issue.ref.issueKey, issue.summary || issue.title || "");
    branchName.value = branchNameDefault;
  }
  function resetBranchTarget() {
    branchConnectionKey.value = "";
    branchProjectId.value = "";
    branchProjectName.value = "";
    branchRepoId.value = "";
    branchRepos.value = [];
    branchProjects.value = [];
    branchBases.value = [];
    branchBase.value = "";
    projectsRequest++;
    reposRequest++;
    basesRequest++;
    branchProjectsLoading.value = false;
    branchReposLoading.value = false;
    branchBasesLoading.value = false;
  }
  async function loadBranchProjects() {
    const connection = activeConnection.value;
    if (!connection) return;
    const requestedKey = connection.key;
    const isStale = () => requestedKey !== branchConnectionKey.value;
    branchError.value = "";
    const request = ++projectsRequest;
    reposRequest++;
    basesRequest++;
    branchReposLoading.value = false;
    branchBasesLoading.value = false;
    const loadingFlag = connection.provider === "github" ? branchReposLoading : branchProjectsLoading;
    loadingFlag.value = true;
    try {
      branchRepos.value = [];
      branchBases.value = [];
      branchProjects.value = [];
      branchProjectId.value = "";
      branchProjectName.value = "";
      branchRepoId.value = "";
      branchBase.value = "";
      if (connection.provider === "github") {
        const result = await dynamicApi.githubQuickFixListRepos?.({ connectionId: connection.id });
        if (isStale()) return;
        branchRepos.value = result?.repositories || [];
        if (branchRepos.value.length === 1) {
          branchRepoId.value = repoKey(branchRepos.value[0]);
          await selectBranchRepo();
        }
      } else {
        const result = await dynamicApi.azureQuickFixListProjects?.({ connectionId: connection.id });
        if (isStale()) return;
        branchProjects.value = result?.projects || [];
        if (branchProjects.value.length === 1) {
          branchProjectId.value = branchProjects.value[0].id;
          await loadBranchRepos();
        }
      }
    } catch (cause) {
      if (!isStale()) reportFailure("Could not load repository projects", cause, branchError);
    } finally {
      if (request === projectsRequest) loadingFlag.value = false;
    }
  }
  async function loadBranchRepos() {
    const connection = activeConnection.value;
    if (connection?.provider !== "azure" || !branchProjectId.value) return;
    const project = branchProjects.value.find((item) => item.id === branchProjectId.value);
    if (!project) return;
    branchProjectName.value = project.name;
    const requestedProjectId = branchProjectId.value;
    const requestedKey = connection.key;
    const isStale = () => requestedProjectId !== branchProjectId.value || requestedKey !== branchConnectionKey.value;
    branchError.value = "";
    const request = ++reposRequest;
    basesRequest++;
    branchBasesLoading.value = false;
    branchReposLoading.value = true;
    try {
      branchRepos.value = [];
      branchBases.value = [];
      branchRepoId.value = "";
      branchBase.value = "";
      const result = await dynamicApi.azureQuickFixListRepositories?.({
        connectionId: connection.id,
        projectName: project.name,
      });
      if (isStale()) return;
      branchRepos.value = result?.repositories || [];
      if (branchRepos.value.length === 1) {
        branchRepoId.value = repoKey(branchRepos.value[0]);
        await selectBranchRepo();
      }
    } catch (cause) {
      if (!isStale()) reportFailure("Could not load repositories", cause, branchError);
    } finally {
      if (request === reposRequest) branchReposLoading.value = false;
    }
  }
  async function selectBranchRepo() {
    const connection = activeConnection.value;
    const repo = currentRepo();
    if (!connection || !repo) return;
    const requestedRepoId = branchRepoId.value;
    const isStale = () => requestedRepoId !== branchRepoId.value;
    branchError.value = "";
    const request = ++basesRequest;
    branchBasesLoading.value = true;
    try {
      const result =
        connection.provider === "azure"
          ? await dynamicApi.azureQuickFixListBranches?.({
              connectionId: connection.id,
              projectName: branchProjectName.value,
              repositoryId: requestedRepoId,
            })
          : await dynamicApi.githubQuickFixListBranches?.({
              connectionId: connection.id,
              owner: repo.owner || "",
              repo: repo.name,
            });
      if (isStale()) return;
      branchBases.value = result?.branches || [];
      branchBase.value =
        repo.defaultBranch && branchBases.value.includes(repo.defaultBranch)
          ? repo.defaultBranch
          : branchBases.value[0] || "";
      applyDefaultBranchName();
    } catch (cause) {
      if (!isStale()) reportFailure("Could not load repository branches", cause, branchError);
    } finally {
      if (request === basesRequest) branchBasesLoading.value = false;
    }
  }
  async function onBranchConnectionChange() {
    await loadBranchProjects();
  }
  async function applyTarget(target: BranchTarget) {
    branchConnectionKey.value = target.connectionKey;
    await loadBranchProjects();
    if (branchProvider.value === "azure") {
      const project = branchProjects.value.find((item) => String(item.id) === String(target.projectId));
      if (!project) throw new Error("The remembered Azure project is no longer available. Choose a project again.");
      branchProjectId.value = project.id;
      await loadBranchRepos();
    }
    const repo = branchRepos.value.find((item) => repoKey(item) === target.repoId);
    if (!repo) throw new Error("The remembered repository is no longer available. Choose a repository again.");
    branchRepoId.value = repoKey(repo);
    await selectBranchRepo();
    if (!branchBases.value.includes(target.baseBranch))
      throw new Error("The remembered base branch is no longer available. Choose a branch again.");
    branchBase.value = target.baseBranch;
  }
  function lastTargetForIssue(): BranchTarget | null {
    const issue = selected.value;
    if (!issue?.ref) return null;
    const projectKey = issue.projectKey || issue.ref.issueKey.replace(/-\d+$/, "");
    const remembered = rememberedTarget(issue.ref.connectionId, projectKey);
    if (remembered) return remembered;
    const saved = savedRepoBinding.value;
    return saved
      ? {
          connectionKey: `${saved.provider}:${saved.connectionId}`,
          projectId: saved.projectId,
          repoId: saved.repoId,
          baseBranch: saved.baseBranch,
        }
      : null;
  }
  /** Picks the only connection, or the last target used for this Jira project, once the panel opens. */
  async function prefillBranchTarget() {
    if (branchRepoId.value || isBusy("branch-target")) return;
    const end = beginBusy("branch-target");
    try {
      const target = lastTargetForIssue();
      if (target && branchConnections.value.some((item) => item.key === target.connectionKey)) {
        await applyTarget(target);
      } else if (branchConnections.value.length === 1 && !branchConnectionKey.value) {
        branchConnectionKey.value = branchConnections.value[0].key;
        await loadBranchProjects();
      }
    } catch (cause) {
      reportFailure("Could not restore the last repository target", cause, branchError);
    } finally {
      end();
    }
  }
  async function startBranch() {
    const issue = selected.value;
    const connection = activeConnection.value;
    const repo = currentRepo();
    if (!canStartBranch.value || !issue?.ref || !connection || !repo || isBusy("branch-start")) return;
    const issueRef = {
      connectionId: issue.ref.connectionId,
      issueId: issue.ref.issueId,
      issueKey: issue.ref.issueKey,
    };
    const newBranchName = branchName.value.trim();
    const baseBranch = branchBase.value;
    const agent = branchAgent.value || null;
    const model = agent ? branchModel.value.trim() : "";
    const effort = agent ? branchEffort.value : "";
    const mode = branchMode.value;
    const task = branchTaskEdited(mode) ? branchTasks.value[mode].trim() : undefined;
    const target: StartJiraDevelopmentInput["target"] =
      connection.provider === "azure"
        ? {
            provider: "azure",
            connectionId: connection.id,
            projectName: branchProjectName.value,
            repositoryId: branchRepoId.value,
            repositoryName: repo.name,
            remoteUrl: repo.remoteUrl || "",
            baseBranch,
            newBranchName,
          }
        : {
            provider: "github",
            connectionId: connection.id,
            owner: repo.owner || "",
            repo: repo.name,
            remoteUrl: repo.remoteUrl || "",
            baseBranch,
            newBranchName,
          };
    const endStart = beginBusy("branch-start");
    try {
      branchError.value = "";
      if (!dynamicApi.startJiraDevelopment) throw new Error("Starting development is not available here.");
      const started = await dynamicApi.startJiraDevelopment({
        jiraIssueRef: issueRef,
        target,
        agent,
        mode,
        ...(model ? { model } : {}),
        ...(effort ? { effort: effort as NonNullable<StartJiraDevelopmentInput["effort"]> } : {}),
        ...(task ? { task } : {}),
        idempotencyKey: crypto.randomUUID(),
      });
      // The dialog stays open with the run's progress until the workspace is ready: closing it at once left the
      // user looking at an unchanged inbox while the repository was cloned.
      branchStartOperationId.value = started.operationId;
      const outcome = started.outcome ?? (await operationOutcome(started.operationId));
      if (!outcome && scopeDisposed) return;
      if (outcome && "error" in outcome) throw new Error(outcome.error.message);
      if (!outcome)
        useNotificationStore().pushEphemeralToast({
          title: `Development on ${issueRef.issueKey} is still being set up`,
          body: "The result will appear in the Notification Center.",
          durationMs: 10_000,
        });
      rememberTarget(issueRef.connectionId, issue.projectKey || issueRef.issueKey.replace(/-\d+$/, ""), {
        connectionKey: connection.key,
        projectId: connection.provider === "azure" ? branchProjectId.value : undefined,
        repoId: branchRepoId.value,
        baseBranch,
      });
      rememberAgent(branchAgent.value);
      if (agent) rememberModel(agent, { model, effort });
      branchDialogOpen.value = false;
      branchName.value = "";
      branchNameDefault = "";
      branchMode.value = JIRA_DEVELOPMENT_DEFAULT_MODE;
      applyDefaultTask("analyze");
      applyDefaultTask("implement");
      if (!agent && outcome) openIssueFileWhenReady(issueRef.issueKey, outcome);
    } catch (cause) {
      const text = reportFailure("Could not start development", cause, branchError);
      useNotificationStore().showError(`Could not start development on ${issueRef.issueKey}`, text);
    } finally {
      branchStartOperationId.value = "";
      endStart();
    }
  }
  const branchStartOperationId = ref("");
  const operationsState = () =>
    (
      store.payload as
        | { operations?: { running?: Array<{ operationId: string; step: string }>; lastResults?: OperationFinished[] } }
        | null
        | undefined
    )?.operations;
  const OPERATION_WAIT_MS = 5 * 60_000;
  let scopeDisposed = false;
  const operationWaiters = new Map<string, (outcome: OperationFinished | null) => void>();
  const stopOperationFinished = dynamicApi.onOperationFinished?.((event) =>
    operationWaiters.get(event.operationId)?.(event),
  );
  if (getCurrentScope())
    onScopeDispose(() => {
      scopeDisposed = true;
      stopOperationFinished?.();
      for (const settle of [...operationWaiters.values()]) settle(null);
    });
  /** The run's outcome from the live event or the payload, whichever comes first; null after the deadline or on unmount. */
  function operationOutcome(operationId: string, waitMs = OPERATION_WAIT_MS): Promise<OperationFinished | null> {
    return new Promise((resolve) => {
      let settled = false;
      let stopWatch = () => {};
      const settle = (outcome: OperationFinished | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        stopWatch();
        operationWaiters.delete(operationId);
        resolve(outcome);
      };
      const timer = setTimeout(() => settle(null), waitMs);
      operationWaiters.set(operationId, settle);
      stopWatch = watch(
        () => operationsState()?.lastResults?.find((result) => result.operationId === operationId),
        (outcome) => {
          if (outcome) settle(outcome);
        },
        { immediate: true },
      );
      if (settled) stopWatch();
    });
  }
  /** What the running start is doing now, worded for the dialog; empty while nothing runs. */
  const branchStartProgress = computed(() => {
    const id = branchStartOperationId.value;
    if (!id) return "";
    const step = operationsState()?.running?.find((item) => item.operationId === id)?.step || "";
    const agentLabel = branchAgentOptions.value.find((option) => option.value === branchAgent.value)?.label;
    if (step === "issue") return "Copying the issue into the checkout…";
    if (step === "agent") return `Starting ${agentLabel || "the agent"}…`;
    return `Preparing the repository and creating ${branchName.value.trim() || "the branch"}…`;
  });
  /** Without an agent there is nothing to look at but the issue copy, so it opens in the Files tab once it is written. */
  function openIssueFileWhenReady(issueKey: string, outcome: OperationFinished) {
    if (outcome.kind !== OPERATION_KIND_JIRA_DEVELOPMENT || "error" in outcome) return;
    const workspaceId = String(outcome.result.workspaceId || "");
    const cwd = (
      store.payload as { appState?: { workspaces?: Array<{ id: string; cwd?: string }> } } | null | undefined
    )?.appState?.workspaces?.find((workspace) => workspace.id === workspaceId)?.cwd;
    if (!cwd) return;
    const title = `Could not open the ${issueKey} issue file`;
    openPathInFilesTab(workspaceId, `${cwd}/${jiraIssueFilePath(issueKey)}`).then(
      (result) => {
        if (result !== "opened")
          useNotificationStore().showError(
            title,
            `The Files tab could not show it (${result}). Open it from the workspace.`,
          );
      },
      (cause) => useNotificationStore().showError(title, userFacingMessage(cause, "Could not open the issue file.")),
    );
  }
  function addBranchConnection(provider: BranchProvider) {
    if (provider === "github") store.openGitHubConnectionDialog("");
    else store.openAzureConnectionDialog("");
  }
  function resetBranchIssueFields() {
    branchName.value = "";
    branchNameDefault = "";
    branchError.value = "";
  }
  watch(
    () => (selected.value?.ref ? `${selected.value.ref.connectionId}:${selected.value.ref.issueId}` : ""),
    resetBranchIssueFields,
  );
  watch(
    () => store.myActiveProfileId,
    () => {
      resetBranchTarget();
      resetBranchIssueFields();
    },
  );
  async function openBranchStart() {
    branchDialogOpen.value = true;
    applyDefaultBranchName();
    applyDefaultAgent();
    await nextTick();
    document.querySelector<HTMLElement>(".jira-branch-start .jira-branch-name input")?.focus();
    await prefillBranchTarget();
    await nextTick();
    document.querySelector<HTMLElement>(".jira-branch-start .jira-branch-name input")?.focus();
  }
  function closeBranchStart() {
    // Once the run is accepted it no longer needs the dialog; it reports to the Notification Center when done.
    if (isBusy("branch-start") && !branchStartOperationId.value) return;
    branchDialogOpen.value = false;
  }
  return {
    branchConnectionKey,
    branchProjectId,
    branchRepoId,
    branchBase,
    branchName,
    branchError,
    repoPreferenceNotice,
    branchProjectsLoading,
    branchReposLoading,
    branchBasesLoading,
    branchProvider,
    hasBranchConnections,
    branchConnectionOptions,
    branchProjectOptions,
    branchRepoOptions,
    branchBaseOptions,
    canStartBranch,
    startBranchDisabledReason,
    onBranchConnectionChange,
    loadBranchRepos,
    selectBranchRepo,
    startBranch,
    addBranchConnection,
    openBranchStart,
    closeBranchStart,
    branchAgent,
    branchAgentOptions,
    branchModel,
    branchModelChoices,
    branchEffort,
    branchEffortOptions,
    branchMode,
    branchStartOperationId,
    branchStartProgress,
    branchTask,
    resetBranchTask,
  };
}
