<template>
  <div class="dialog" style="width:min(680px,100%);position:relative;z-index:10;">
    <div class="dialog__header">
      <div>
        <p class="eyebrow">GitHub</p>
        <h2>New Branch</h2>
      </div>
      <button type="button" class="button button--ghost" @click="emit('cancel')">Close</button>
    </div>

    <!-- Step indicator -->
    <div style="display:flex;gap:4px;margin-top:8px;">
      <span
        v-for="(s, i) in visibleSteps"
        :key="s.id"
        :class="['workspace-chip', currentVisibleIndex >= i && 'workspace-chip--active']"
        style="font-size:12px;"
      >{{ s.label }}</span>
    </div>

    <div style="margin-top:16px;min-height:220px;max-height:60vh;overflow-y:auto;">
      <!-- Step: Connection (only if multiple) -->
      <div v-if="currentStep === 'connection'">
        <p class="eyebrow">Select connection</p>
        <div class="nb-list">
          <button
            v-for="conn in connections"
            :key="conn.id"
            :class="['nb-item', selected.connectionId === conn.id && 'nb-item--active']"
            @click="selectConnection(conn)"
          >
            <span class="nb-item__name">{{ conn.label || conn.hostUrl }}</span>
            <small class="nb-item__hint">{{ conn.currentUserLogin }} · {{ conn.hostUrl }}</small>
          </button>
        </div>
      </div>

      <!-- Step: Repository -->
      <div v-if="currentStep === 'repo'">
        <p class="eyebrow">Select repository</p>
        <p v-if="loading" style="color:var(--muted);">Loading repositories…</p>
        <div v-else>
          <input v-model="repoSearch" placeholder="Filter repositories…" style="width:100%;margin-bottom:8px;" />
          <div class="nb-list">
            <button
              v-for="repo in filteredRepositories"
              :key="repo.id"
              :class="['nb-item', selected.fullName === repo.fullName && 'nb-item--active']"
              @click="selectRepository(repo)"
            >
              <span class="nb-item__name">{{ repo.fullName }}</span>
              <small v-if="repo.defaultBranch" class="nb-item__hint">default: {{ repo.defaultBranch }}</small>
            </button>
          </div>
        </div>
      </div>

      <!-- Step: Branch -->
      <div v-if="currentStep === 'branch'">
        <p class="eyebrow">Branch setup</p>
        <p v-if="loading" style="color:var(--muted);">Loading branches…</p>
        <div v-else class="form" style="margin-top:8px;">
          <label>
            <span>Base branch</span>
            <div class="nb-combo" @keydown.escape="branchDropdownOpen = false">
              <input
                ref="baseBranchInputRef"
                v-model="baseBranchSearch"
                placeholder="Search branches…"
                autocomplete="off"
                @focus="branchDropdownOpen = true"
                @input="branchDropdownOpen = true"
              />
              <div v-if="selected.baseBranch && !branchDropdownOpen" class="nb-combo__selected" @click="branchDropdownOpen = true; $nextTick(() => baseBranchInputRef?.focus())">
                {{ selected.baseBranch }}
              </div>
              <div v-if="branchDropdownOpen" class="nb-combo__dropdown">
                <button
                  v-for="b in filteredBranches"
                  :key="b"
                  :class="['nb-combo__option', selected.baseBranch === b && 'nb-combo__option--active']"
                  @mousedown.prevent="selectBaseBranch(b)"
                >{{ b }}</button>
                <div v-if="!filteredBranches.length" class="nb-combo__empty">No matching branches</div>
              </div>
            </div>
          </label>
          <label>
            <span>New branch name</span>
            <div style="display:flex;gap:6px;align-items:stretch;">
              <input
                v-model="branchPrefix"
                placeholder="fix/"
                style="width:110px;flex-shrink:0;"
                @change="savePrefixPreference"
              />
              <input
                ref="branchNameRef"
                v-model="branchSuffix"
                placeholder="my-branch-name"
                style="flex:1;"
                @keydown.enter.prevent="canCreate && handleCreate()"
              />
            </div>
            <small v-if="validationError" style="color:var(--danger);font-size:12px;">{{ validationError }}</small>
            <small v-else style="color:var(--muted);font-size:12px;">{{ fullBranchName ? `Branch: ${fullBranchName}` : 'Type a branch name suffix' }}</small>
          </label>
        </div>
      </div>

      <!-- Error -->
      <p v-if="errorMessage" style="margin-top:12px;color:var(--danger);">{{ errorMessage }}</p>
    </div>

    <footer class="dialog__footer">
      <button v-if="canGoBack" type="button" class="button button--ghost" @click="goBack">Back</button>
      <span style="flex:1;"></span>
      <button type="button" class="button button--ghost" @click="emit('cancel')">Cancel</button>
      <button
        v-if="currentStep === 'branch'"
        type="button"
        :class="['button', busy && 'button--busy']"
        :disabled="!canCreate || busy"
        @click="handleCreate"
      >{{ busy ? 'Creating…' : 'Create workspace' }}</button>
    </footer>
  </div>
</template>

<script setup>
import { ref, computed, inject, onMounted, nextTick, useAttrs } from "vue";

defineOptions({ inheritAttrs: false });

const props = defineProps({
  connections: { type: Array, default: () => [] },
});

const emit = defineEmits(["cancel"]);
const attrs = useAttrs();

const api = inject("api");

const STEPS = ["connection", "repo", "branch"];
const PREFIX_STORAGE_KEY = "strideterm:newbranch:prefix";

const currentStep = ref("connection");
const loading = ref(false);
const busy = ref(false);
const errorMessage = ref("");
const repoSearch = ref("");

const repositories = ref([]);
const branches = ref([]);

const branchPrefix = ref(loadPrefixPreference());
const branchSuffix = ref("");
const branchNameRef = ref(null);
const baseBranchInputRef = ref(null);
const baseBranchSearch = ref("");
const branchDropdownOpen = ref(false);

const selected = ref({
  connectionId: "",
  connectionLabel: "",
  owner: "",
  repo: "",
  fullName: "",
  remoteUrl: "",
  baseBranch: "",
});

function loadPrefixPreference() {
  try { return localStorage.getItem(PREFIX_STORAGE_KEY) || "fix/"; } catch { return "fix/"; }
}

function savePrefixPreference() {
  try { localStorage.setItem(PREFIX_STORAGE_KEY, branchPrefix.value); } catch {}
}

const BRANCH_INVALID_CHARS = /[\x00-\x1f\x7f ~^:?*\[\]\\{}@]/;
const BRANCH_INVALID_PATTERNS = /\.\.|\/\/|^[./]|[./]$|\.lock$/;

const validationError = computed(() => {
  const name = fullBranchName.value;
  if (!name) return "";
  if (BRANCH_INVALID_CHARS.test(name)) return "Contains invalid characters for a git branch name.";
  if (BRANCH_INVALID_PATTERNS.test(name)) return "Invalid branch name pattern.";
  if (/\s/.test(name)) return "Branch name cannot contain spaces.";
  return "";
});

const fullBranchName = computed(() => {
  const suffix = branchSuffix.value.trim();
  if (!suffix) return "";
  return `${branchPrefix.value}${suffix}`;
});

const canCreate = computed(() => selected.value.baseBranch && fullBranchName.value && !validationError.value);

const filteredRepositories = computed(() => {
  const q = repoSearch.value.toLowerCase().trim();
  const sorted = [...repositories.value].sort((a, b) => a.fullName.localeCompare(b.fullName));
  if (!q) return sorted;
  return sorted.filter((r) => r.fullName.toLowerCase().includes(q));
});

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

function selectBaseBranch(name) {
  selected.value.baseBranch = name;
  baseBranchSearch.value = "";
  branchDropdownOpen.value = false;
}

const visibleSteps = computed(() => {
  const steps = [];
  if (props.connections.length > 1) steps.push({ id: "connection", label: "Connection" });
  steps.push({ id: "repo", label: "Repository" });
  steps.push({ id: "branch", label: "Branch" });
  return steps;
});

const currentVisibleIndex = computed(() => visibleSteps.value.findIndex((s) => s.id === currentStep.value));
const canGoBack = computed(() => STEPS.indexOf(currentStep.value) > 0);

function goBack() {
  const idx = STEPS.indexOf(currentStep.value);
  if (idx > 0) {
    currentStep.value = STEPS[idx - 1];
    errorMessage.value = "";
  }
}

async function selectConnection(conn) {
  selected.value.connectionId = conn.id;
  selected.value.connectionLabel = conn.label || conn.hostUrl;
  errorMessage.value = "";
  await loadRepositories();
}

async function loadRepositories() {
  loading.value = true;
  currentStep.value = "repo";
  try {
    const result = await api.githubQuickFixListRepos({ connectionId: selected.value.connectionId });
    repositories.value = result.repositories || [];
    if (repositories.value.length === 1) {
      await selectRepository(repositories.value[0]);
      return;
    }
  } catch (err) {
    errorMessage.value = err?.message || "Failed to load repositories.";
  } finally {
    loading.value = false;
  }
}

async function selectRepository(repo) {
  selected.value.owner = repo.owner;
  selected.value.repo = repo.name;
  selected.value.fullName = repo.fullName;
  selected.value.remoteUrl = repo.remoteUrl;
  errorMessage.value = "";
  await loadBranches(repo.defaultBranch);
}

async function loadBranches(defaultBranch = "") {
  loading.value = true;
  currentStep.value = "branch";
  try {
    const result = await api.githubQuickFixListBranches({
      connectionId: selected.value.connectionId,
      owner: selected.value.owner,
      repo: selected.value.repo,
    });
    branches.value = result.branches || [];
    const preferred = branches.value.find((b) => b === defaultBranch)
      || branches.value.find((b) => b === "develop")
      || branches.value.find((b) => b === "main")
      || branches.value.find((b) => b === "master")
      || branches.value[0] || "";
    selected.value.baseBranch = preferred;
  } catch (err) {
    errorMessage.value = err?.message || "Failed to load branches.";
  } finally {
    loading.value = false;
    await nextTick();
    branchNameRef.value?.focus();
  }
}

async function handleCreate() {
  if (!canCreate.value || busy.value) return;
  busy.value = true;
  errorMessage.value = "";
  try {
    const result = await api.githubQuickFixCreate({
      connectionId: selected.value.connectionId,
      owner: selected.value.owner,
      repo: selected.value.repo,
      remoteUrl: selected.value.remoteUrl,
      baseBranch: selected.value.baseBranch,
      newBranchName: fullBranchName.value,
    });
    attrs.onCreate?.(result);
  } catch (err) {
    errorMessage.value = err?.message || "Failed to create workspace.";
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

.nb-combo {
  position: relative;
  margin-top: 4px;
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
</style>
