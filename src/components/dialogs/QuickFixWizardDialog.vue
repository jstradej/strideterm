<template>
  <div class="dialog" style="width: min(680px, 100%); position: relative; z-index: 10">
    <div class="dialog__header">
      <div>
        <p class="eyebrow">{{ providerLabel }}</p>
        <h2>New Branch</h2>
      </div>
    </div>

    <!-- Step indicator -->
    <div style="display: flex; gap: 4px; margin-top: 8px">
      <span
        v-for="(s, i) in visibleSteps"
        :key="s.id"
        :class="['workspace-chip', currentVisibleIndex >= i && 'workspace-chip--active']"
        style="font-size: 12px"
        >{{ s.label }}</span
      >
    </div>

    <div style="margin-top: 16px; min-height: 220px; max-height: 60vh; overflow-y: auto">
      <!-- Step: Connection -->
      <div v-if="currentStep === 'connection'">
        <p class="eyebrow">Select connection</p>
        <div class="nb-list">
          <button
            v-for="conn in connections"
            :key="conn.id"
            :class="['nb-item', selected.connectionId === conn.id && 'nb-item--active']"
            :title="
              provider === 'github'
                ? `Use the GitHub connection at ${conn.hostUrl} (signed in as ${conn.currentUserLogin}).`
                : `Use the Azure DevOps connection at ${conn.orgUrl}. The next steps will list projects visible to its PAT.`
            "
            @click="selectConnection(conn)"
          >
            <span class="nb-item__name">{{ conn.label || conn.orgUrl || conn.hostUrl }}</span>
            <small class="nb-item__hint">{{
              provider === "github" ? `${conn.currentUserLogin} · ${conn.hostUrl}` : conn.orgUrl
            }}</small>
          </button>
        </div>
      </div>

      <!-- Step: Project (Azure only) -->
      <div v-if="currentStep === 'project'">
        <p class="eyebrow">Select project</p>
        <p v-if="loading" style="color: var(--muted)">Loading projects…</p>
        <div v-else class="nb-list">
          <button
            v-for="proj in projects"
            :key="proj.id"
            :class="['nb-item', selected.projectName === proj.name && 'nb-item--active']"
            :title="`Pick the Azure DevOps project '${proj.name}'. The next step will list its repositories.`"
            @click="selectProject(proj)"
          >
            <span class="nb-item__name">{{ proj.name }}</span>
          </button>
        </div>
      </div>

      <!-- Step: Repository -->
      <div v-if="currentStep === 'repo'">
        <p class="eyebrow">Select repository</p>
        <p v-if="loading" style="color: var(--muted)">Loading repositories…</p>
        <div v-else>
          <input
            v-if="provider === 'github'"
            v-model="repoSearch"
            placeholder="Filter repositories…"
            style="width: 100%; margin-bottom: 8px"
            title="Filter the list below by repository name. Matching is case-insensitive substring."
          />
          <div class="nb-list">
            <button
              v-for="repo in sortedRepositories"
              :key="repo.id || repo.fullName"
              :class="[
                'nb-item',
                (provider === 'github' ? selected.fullName === repo.fullName : selected.repositoryId === repo.id) &&
                  'nb-item--active',
              ]"
              :title="`Pick repository ${repo.fullName || repo.name}${repo.defaultBranch ? ' (default branch: ' + repo.defaultBranch + ')' : ''}. The next step will list its branches so you can pick a base.`"
              @click="selectRepository(repo)"
            >
              <span class="nb-item__name">{{ repo.fullName || repo.name }}</span>
              <small v-if="repo.defaultBranch" class="nb-item__hint">default: {{ repo.defaultBranch }}</small>
            </button>
          </div>
        </div>
      </div>

      <!-- Step: Branch -->
      <div v-if="currentStep === 'branch'">
        <p class="eyebrow">Branch setup</p>
        <p v-if="loading" style="color: var(--muted)">Loading branches…</p>
        <!-- Two-column layout so the base-branch combo and new-branch composer
             sit side-by-side instead of each spanning the whole 680 px dialog
             (5.2). The grid collapses to a single column on narrow widths. -->
        <div v-else class="form qf-branch-grid" style="margin-top: 8px">
          <label>
            <span>Base branch</span>
            <div class="nb-combo" @keydown.escape.stop="branchDropdownOpen = false">
              <input
                ref="baseBranchInputRef"
                v-model="baseBranchSearch"
                placeholder="Search branches…"
                autocomplete="off"
                title="Type to filter the list of remote branches. The new branch will be created off whichever branch you pick here (typically your team's main / develop / release line)."
                @focus="branchDropdownOpen = true"
                @input="branchDropdownOpen = true"
              />
              <div
                v-if="selected.baseBranch && !branchDropdownOpen"
                class="nb-combo__selected"
                title="Click to re-open the branch picker and choose a different base."
                @click="
                  branchDropdownOpen = true;
                  $nextTick(() => baseBranchInputRef?.focus());
                "
              >
                {{ selected.baseBranch }}
              </div>
              <div v-if="branchDropdownOpen" class="nb-combo__dropdown">
                <button
                  v-for="b in filteredBranches"
                  :key="b"
                  :class="['nb-combo__option', selected.baseBranch === b && 'nb-combo__option--active']"
                  :title="`Use ${b} as the base branch — the new branch will be cut from its tip.`"
                  @mousedown.prevent="selectBaseBranch(b)"
                >
                  {{ b }}
                </button>
                <div v-if="!filteredBranches.length" class="nb-combo__empty">No matching branches</div>
              </div>
            </div>
          </label>
          <label>
            <span>New branch name</span>
            <div class="qf-branch-name">
              <input
                v-model="branchPrefix"
                placeholder="fix/"
                class="qf-branch-name__prefix"
                title="Branch prefix (e.g. fix/, feature/, chore/). Saved per user — the next time you open this wizard the same prefix is filled in."
                @change="savePrefixPreference"
              />
              <input
                ref="branchNameRef"
                v-model="branchSuffix"
                placeholder="my-branch-name"
                class="qf-branch-name__suffix"
                title="Slug part of the branch name. Use lowercase, dashes between words. The full branch name shown below is what will be pushed to the remote."
                @keydown.enter.prevent="canCreate && handleCreate()"
              />
            </div>
            <small v-if="validationError" style="color: var(--danger); font-size: 12px">{{ validationError }}</small>
            <small v-else style="color: var(--muted); font-size: 12px">{{
              fullBranchName ? `Branch: ${fullBranchName}` : "Type a branch name suffix"
            }}</small>
          </label>
        </div>
      </div>

      <!-- Error -->
      <p v-if="errorMessage" style="margin-top: 12px; color: var(--danger)">{{ errorMessage }}</p>
    </div>

    <footer class="dialog__footer qf-footer">
      <button
        v-if="canGoBack"
        type="button"
        class="button button--ghost"
        title="Return to the previous step. Your selections so far are preserved."
        @click="goBack"
      >
        Back
      </button>
      <span style="flex: 1"></span>
      <button
        type="button"
        class="button button--ghost"
        title="Discard your selections and close the wizard."
        @click="emit('cancel')"
      >
        Cancel
      </button>
      <button
        v-if="currentStep === 'branch'"
        type="button"
        :class="['button', busy && 'button--busy']"
        :disabled="!canCreate || busy"
        :title="
          !canCreate
            ? 'Pick a base branch and type a valid branch name to enable.'
            : `Clone (or reuse a cached clone of) the repository, create the branch '${fullBranchName}' off the chosen base, and open it as a new strIDEterm workspace.`
        "
        @click="handleCreate"
      >
        {{ busy ? "Creating…" : "Create workspace" }}
      </button>
    </footer>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, inject, onMounted, nextTick, useAttrs } from "vue";
import type { Transport } from "../../transport.js";

defineOptions({ inheritAttrs: false });

interface Connection {
  id: string;
  label?: string;
  orgUrl?: string;
  hostUrl?: string;
  currentUserLogin?: string;
}

interface ProjectEntry {
  id: string;
  name: string;
}

interface RepositoryEntry {
  id?: string;
  name: string;
  fullName?: string;
  owner?: string;
  remoteUrl?: string;
  defaultBranch?: string;
}

interface Props {
  connections?: Connection[];
  provider?: "azure" | "github";
}

const props = withDefaults(defineProps<Props>(), {
  connections: () => [],
  provider: "azure",
});

const emit = defineEmits<{
  cancel: [];
}>();
const attrs = useAttrs();

const api = inject<Transport>("api");

const isAzure = computed(() => props.provider === "azure");
const providerLabel = computed(() => (isAzure.value ? "Azure DevOps" : "GitHub"));
const STEPS = computed(() =>
  isAzure.value ? ["connection", "project", "repo", "branch"] : ["connection", "repo", "branch"],
);

const PREFIX_STORAGE_KEY = "strideterm:newbranch:prefix";

const currentStep = ref("connection");
const loading = ref(false);
const busy = ref(false);
const errorMessage = ref("");
const repoSearch = ref("");

const projects = ref<ProjectEntry[]>([]);
const repositories = ref<RepositoryEntry[]>([]);
const branches = ref<string[]>([]);

const branchPrefix = ref(loadPrefixPreference());
const branchSuffix = ref("");
const branchNameRef = ref<HTMLInputElement | null>(null);
const baseBranchInputRef = ref<HTMLInputElement | null>(null);
const baseBranchSearch = ref("");
const branchDropdownOpen = ref(false);

const selected = ref({
  connectionId: "",
  connectionLabel: "",
  // Azure fields
  projectName: "",
  repositoryId: "",
  repositoryName: "",
  // GitHub fields
  owner: "",
  repo: "",
  fullName: "",
  // Shared
  remoteUrl: "",
  baseBranch: "",
});

function loadPrefixPreference() {
  try {
    return localStorage.getItem(PREFIX_STORAGE_KEY) || "fix/";
  } catch {
    return "fix/";
  }
}

function savePrefixPreference() {
  try {
    localStorage.setItem(PREFIX_STORAGE_KEY, branchPrefix.value);
  } catch {}
}

// --- Branch name validation ---
const BRANCH_INVALID_CHARS = /[\x00-\x1f\x7f ~^:?*[\]\\{}@]/;
const BRANCH_INVALID_PATTERNS = /\.\.|\/\/|^[./]|[./]$|\.lock$/;

const validationError = computed(() => {
  const name = fullBranchName.value;
  if (!name) return "";
  if (BRANCH_INVALID_CHARS.test(name)) return "Contains invalid characters for a git branch name.";
  if (BRANCH_INVALID_PATTERNS.test(name))
    return "Invalid branch name pattern (no .., //, leading/trailing dots or slashes).";
  if (/\s/.test(name)) return "Branch name cannot contain spaces.";
  return "";
});

const fullBranchName = computed(() => {
  const suffix = branchSuffix.value.trim();
  if (!suffix) return "";
  return `${branchPrefix.value}${suffix}`;
});

const canCreate = computed(() => selected.value.baseBranch && fullBranchName.value && !validationError.value);

// --- Branch filtering ---
const filteredBranches = computed(() => {
  const query = baseBranchSearch.value.toLowerCase().trim();
  const sorted = [...branches.value].sort((a, b) => {
    const mainBranches = ["develop", "main", "master"];
    const aMain = mainBranches.indexOf(a);
    const bMain = mainBranches.indexOf(b);
    if (aMain >= 0 && bMain < 0) return -1;
    if (bMain >= 0 && aMain < 0) return 1;
    if (aMain >= 0 && bMain >= 0) return aMain - bMain;
    return a.localeCompare(b);
  });
  if (!query) return sorted;
  return sorted.filter((b) => b.toLowerCase().includes(query));
});

function selectBaseBranch(name: string) {
  selected.value.baseBranch = name;
  baseBranchSearch.value = "";
  branchDropdownOpen.value = false;
}

const sortedRepositories = computed(() => {
  const sorted = [...repositories.value].sort((a, b) => (a.fullName || a.name).localeCompare(b.fullName || b.name));
  if (!isAzure.value && repoSearch.value.trim()) {
    const q = repoSearch.value.toLowerCase().trim();
    return sorted.filter((r) => (r.fullName || r.name).toLowerCase().includes(q));
  }
  return sorted;
});

const visibleSteps = computed(() => {
  const steps = [];
  if (props.connections.length > 1) steps.push({ id: "connection", label: "Connection" });
  if (isAzure.value) steps.push({ id: "project", label: "Project" });
  steps.push({ id: "repo", label: "Repository" });
  steps.push({ id: "branch", label: "Branch" });
  return steps;
});

const currentVisibleIndex = computed(() => visibleSteps.value.findIndex((s) => s.id === currentStep.value));
const canGoBack = computed(() => STEPS.value.indexOf(currentStep.value) > 0);

function goBack() {
  const idx = STEPS.value.indexOf(currentStep.value);
  if (idx > 0) {
    currentStep.value = STEPS.value[idx - 1];
    errorMessage.value = "";
  }
}

async function selectConnection(conn: Connection) {
  selected.value.connectionId = conn.id;
  selected.value.connectionLabel = conn.label || conn.orgUrl || conn.hostUrl || "";
  errorMessage.value = "";
  if (isAzure.value) {
    await loadProjects();
  } else {
    await loadRepositories();
  }
}

// --- Azure: project step ---
async function loadProjects() {
  loading.value = true;
  currentStep.value = "project";
  try {
    const result = (await api?.azureQuickFixListProjects?.({ connectionId: selected.value.connectionId })) as
      | { projects?: ProjectEntry[] }
      | undefined;
    projects.value = result?.projects || [];
    if (projects.value.length === 1) {
      await selectProject(projects.value[0]);
      return;
    }
  } catch (err) {
    errorMessage.value = (err as Error)?.message || "Failed to load projects.";
  } finally {
    loading.value = false;
  }
}

async function selectProject(proj: ProjectEntry) {
  selected.value.projectName = proj.name;
  errorMessage.value = "";
  await loadRepositories();
}

// --- Repository step ---
async function loadRepositories() {
  loading.value = true;
  currentStep.value = "repo";
  try {
    let result: { repositories?: RepositoryEntry[] } | undefined;
    if (isAzure.value) {
      result = (await api?.azureQuickFixListRepositories?.({
        connectionId: selected.value.connectionId,
        projectName: selected.value.projectName,
      })) as { repositories?: RepositoryEntry[] } | undefined;
    } else {
      result = (await api?.githubQuickFixListRepos?.({ connectionId: selected.value.connectionId })) as
        | { repositories?: RepositoryEntry[] }
        | undefined;
    }
    repositories.value = result?.repositories || [];
    if (repositories.value.length === 1) {
      await selectRepository(repositories.value[0]);
      return;
    }
  } catch (err) {
    errorMessage.value = (err as Error)?.message || "Failed to load repositories.";
  } finally {
    loading.value = false;
  }
}

async function selectRepository(repo: RepositoryEntry) {
  if (isAzure.value) {
    selected.value.repositoryId = repo.id ?? "";
    selected.value.repositoryName = repo.name;
    selected.value.remoteUrl = repo.remoteUrl ?? "";
  } else {
    selected.value.owner = repo.owner ?? "";
    selected.value.repo = repo.name;
    selected.value.fullName = repo.fullName ?? "";
    selected.value.remoteUrl = repo.remoteUrl ?? "";
  }
  errorMessage.value = "";
  await loadBranches(repo.defaultBranch ?? "");
}

// --- Branch step ---
async function loadBranches(defaultBranch = ""): Promise<void> {
  loading.value = true;
  currentStep.value = "branch";
  try {
    let result: { branches?: string[] } | undefined;
    if (isAzure.value) {
      result = (await api?.azureQuickFixListBranches?.({
        connectionId: selected.value.connectionId,
        projectName: selected.value.projectName,
        repositoryId: selected.value.repositoryId,
      })) as { branches?: string[] } | undefined;
    } else {
      result = (await api?.githubQuickFixListBranches?.({
        connectionId: selected.value.connectionId,
        owner: selected.value.owner,
        repo: selected.value.repo,
      })) as { branches?: string[] } | undefined;
    }
    branches.value = result?.branches || [];
    const preferred =
      (defaultBranch && branches.value.find((b) => b === defaultBranch)) ||
      branches.value.find((b) => b === "develop") ||
      branches.value.find((b) => b === "main") ||
      branches.value.find((b) => b === "master") ||
      branches.value[0] ||
      "";
    selected.value.baseBranch = preferred;
  } catch (err) {
    errorMessage.value = (err as Error)?.message || "Failed to load branches.";
  } finally {
    loading.value = false;
    await nextTick();
    branchNameRef.value?.focus();
  }
}

// --- Create ---
async function handleCreate() {
  if (!canCreate.value || busy.value) return;
  busy.value = true;
  errorMessage.value = "";
  try {
    let result: unknown;
    if (isAzure.value) {
      result = await api?.azureQuickFixCreate?.({
        connectionId: selected.value.connectionId,
        projectName: selected.value.projectName,
        repositoryId: selected.value.repositoryId,
        repositoryName: selected.value.repositoryName,
        remoteUrl: selected.value.remoteUrl,
        baseBranch: selected.value.baseBranch,
        newBranchName: fullBranchName.value,
      });
    } else {
      result = await api?.githubQuickFixCreate?.({
        connectionId: selected.value.connectionId,
        owner: selected.value.owner,
        repo: selected.value.repo,
        remoteUrl: selected.value.remoteUrl,
        baseBranch: selected.value.baseBranch,
        newBranchName: fullBranchName.value,
      });
    }
    (attrs.onCreate as ((result: unknown) => void) | undefined)?.(result);
  } catch (err) {
    errorMessage.value = (err as Error)?.message || "Failed to create workspace.";
    busy.value = false;
  }
}

onMounted(() => {
  if (props.connections.length === 1) {
    selectConnection(props.connections[0]);
  }
});
</script>

<style scoped>
/* Separate the footer from the scrolling body (the repo/branch list caps at
   60vh and scrolls). Without this the Back/Cancel/Create buttons glue to the
   last list row when the list is long. */
.qf-footer {
  margin-top: 16px;
  padding-top: 16px;
  border-top: 1px solid var(--border);
}

.nb-list {
  display: grid;
  gap: 4px;
  margin-top: 8px;
}

.nb-item {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  padding: 8px 12px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.03);
  cursor: pointer;
  text-align: left;
  color: inherit;
  font: inherit;
}

.nb-item:hover {
  background: rgba(255, 255, 255, 0.07);
  border-color: var(--accent, #ffa424);
}

.nb-item--active {
  border-color: var(--accent, #ffa424);
  background: rgba(255, 164, 36, 0.1);
}

.nb-item__name {
  font-weight: 600;
  font-size: 13px;
}

.nb-item__hint {
  font-size: 11px;
  color: var(--muted);
}

/* Combobox for branch selection.
   The parent <label> already supplies the 4px gap below the <span> caption,
   so this container intentionally has no margin-top — that previously made
   the base-branch input sit ~4px lower than the New branch name input on
   the right side of the two-column form, breaking row alignment. */
.nb-combo {
  position: relative;
}

.nb-combo input {
  width: 100%;
}

.nb-combo__selected {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  padding: 0 10px;
  cursor: pointer;
  font-weight: 600;
  font-size: 13px;
  background: var(--bg, #1a1e2e);
  border: 1px solid var(--accent, #ffa424);
  border-radius: 4px;
}

.nb-combo__dropdown {
  position: absolute;
  top: 100%;
  left: 0;
  right: 0;
  z-index: 20;
  margin-top: 2px;
  max-height: 220px;
  overflow-y: auto;
  background: var(--bg-elevated, #1e2233);
  border: 1px solid var(--border);
  border-radius: 6px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
}

.nb-combo__option {
  display: block;
  width: 100%;
  text-align: left;
  padding: 6px 12px;
  font: inherit;
  font-size: 13px;
  color: inherit;
  background: none;
  border: none;
  cursor: pointer;
}

.nb-combo__option:hover {
  background: rgba(255, 255, 255, 0.07);
}

.nb-combo__option--active {
  background: rgba(255, 164, 36, 0.12);
  font-weight: 600;
}

.nb-combo__empty {
  padding: 12px;
  text-align: center;
  color: var(--muted);
  font-size: 12px;
}

/* Branch step layout — two columns side-by-side instead of each label
   spanning the whole 680 px dialog (5.2: comboboxes were spreading
   full-width). Collapses to a single column under 540 px. */
.qf-branch-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 12px;
}

@media (max-width: 540px) {
  .qf-branch-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}

.qf-branch-name {
  display: flex;
  gap: 6px;
  align-items: stretch;
}

.qf-branch-name__prefix {
  width: 90px;
  flex-shrink: 0;
}

.qf-branch-name__suffix {
  flex: 1;
  min-width: 0;
}
</style>
