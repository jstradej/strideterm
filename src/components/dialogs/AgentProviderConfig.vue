<template>
  <div class="agent-config-section">
    <div class="agent-config-section__header">
      <span class="agent-config-section__label">{{ sectionLabel }}</span>
      <button
        v-if="allowCustomCommand"
        type="button"
        class="button button--ghost agent-config-section__advanced-btn"
        @click="toggleOverride"
      >
        {{ commandOverride ? "Use provider picker" : "Advanced: custom command" }}
      </button>
    </div>
    <template v-if="!commandOverride">
      <div class="grid grid--2col">
        <label>
          <span>Provider</span>
          <CustomSelect v-model="providerId" :options="providerOptions" @change="onProviderChange" />
        </label>
        <label
          title="Leave empty for the CLI's own default, pick from the suggestion list, or type any model ID your CLI version supports — Codex and Gemini change their model catalog often and we don't want a rebuild every time."
        >
          <span>Model</span>
          <input v-model="model" :list="modelListId" placeholder="Default" maxlength="100" />
          <datalist :id="modelListId">
            <option
              v-for="m in modelChoices"
              :key="m.id || 'default'"
              :value="m.id"
              :label="m.name + (m.suggestedRole === role ? ' (suggested)' : '')"
            />
          </datalist>
        </label>
      </div>
      <label v-if="allowSkipPermissions" class="checkbox-inline">
        <input v-model="skipPermissions" type="checkbox" />
        <span>Skip permission prompts (dangerous)</span>
      </label>
      <p v-else class="agent-config-section__isolation-note" :title="isolationTitle">
        Inspect-only — permission bypass is never enabled here. Isolation: <strong>{{ isolationLabel }}</strong>
      </p>
    </template>
    <label v-else title="Full CLI command including flags">
      <span>{{ commandLabel }}</span>
      <input v-model="panelCommandModel" :placeholder="commandPlaceholder" maxlength="500" />
    </label>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import CustomSelect from "../common/CustomSelect.vue";
import { PROVIDER_CHOICES, buildProviderCommand, type ProviderConfig } from "../../lib/agent-providers.js";

interface Props {
  role: "worker" | "judge";
  provider: ProviderConfig;
  panelCommand: string;
  commandOverride: boolean;
  providerOptions: Array<{ value: string; label: string; disabled?: boolean }>;
  /** false for the attached-mode Companion picker (plan §9) — hides the raw
   * custom-command escape hatch so the backend's inspect-only contract can't
   * be bypassed from the UI. */
  allowCustomCommand?: boolean;
  /** false for the attached-mode Companion picker — hides the skip-
   * permissions checkbox entirely; the attached Judge is always inspect-only. */
  allowSkipPermissions?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  allowCustomCommand: true,
  allowSkipPermissions: true,
});
const emit = defineEmits<{
  "update:provider": [provider: ProviderConfig];
  "update:panelCommand": [command: string];
  "update:commandOverride": [value: boolean];
}>();

// Plan §3.2 "Capability význam" — never claim a hard sandbox the provider
// can't demonstrably enforce. "prompt-only" is shown as "Prompt-enforced" to
// make clear it's a contract, not a technical guarantee.
const ISOLATION_LABELS: Record<string, string> = {
  enforced: "Enforced",
  "permission-gated": "Permission-gated",
  "prompt-only": "Prompt-enforced",
};
const ISOLATION_TITLES: Record<string, string> = {
  enforced: "This provider has a verified read-only/execution-disabled mode for project files.",
  "permission-gated":
    "No permission bypass flag is used — the provider's own per-tool approval prompt gates any write or execution attempt, and the app pauses the task instead of auto-approving it.",
  "prompt-only":
    "This provider cannot demonstrably gate tool use on its own. Only the runner's prompt contract restrains it — not an enforced technical boundary.",
};
const isolationLevel = computed(
  () => PROVIDER_CHOICES.find((c) => c.id === props.provider.providerId)?.inspectionIsolation || "permission-gated",
);
const isolationLabel = computed(() => ISOLATION_LABELS[isolationLevel.value] || isolationLevel.value);
const isolationTitle = computed(() => ISOLATION_TITLES[isolationLevel.value] || "");

const sectionLabel = computed(() => (props.role === "worker" ? "Worker agent" : "Judge agent"));
const commandLabel = computed(() => (props.role === "worker" ? "Worker command" : "Judge command"));
const commandPlaceholder = computed(() =>
  props.role === "worker"
    ? "claude --dangerously-skip-permissions --model sonnet"
    : "claude --dangerously-skip-permissions --model opus",
);
const modelListId = computed(() => `${props.role}-model-list-${props.provider.providerId}`);

const modelChoices = computed(() => {
  const p = PROVIDER_CHOICES.find((c) => c.id === props.provider.providerId);
  return p?.models || [];
});

// Per-field writable computeds so CustomSelect/input v-model bindings can
// stay simple, without mutating the `provider` prop object directly
// (vue/no-mutating-props) — each emits a merged copy via update:provider.
const providerId = computed({
  get: () => props.provider.providerId,
  set: (v: string) => emit("update:provider", { ...props.provider, providerId: v }),
});
const model = computed({
  get: () => props.provider.model,
  set: (v: string) => emit("update:provider", { ...props.provider, model: v }),
});
const skipPermissions = computed({
  get: () => props.provider.skipPermissions,
  set: (v: boolean) => emit("update:provider", { ...props.provider, skipPermissions: v }),
});
const panelCommandModel = computed({
  get: () => props.panelCommand,
  set: (v: string) => emit("update:panelCommand", v),
});

function onProviderChange() {
  // Auto-select suggested model for this role + reset skipPermissions to provider default
  const p = PROVIDER_CHOICES.find((c) => c.id === props.provider.providerId);
  const suggested = p?.models?.find((m) => m.suggestedRole === props.role) || p?.models?.[0];
  emit("update:provider", {
    ...props.provider,
    model: suggested ? suggested.id : props.provider.model,
    skipPermissions: p ? (p.defaultSkipPermissions ?? false) : props.provider.skipPermissions,
  });
}

function toggleOverride() {
  // When enabling advanced custom command, prefill with current picker state
  if (!props.commandOverride) {
    emit(
      "update:panelCommand",
      buildProviderCommand({
        providerId: props.provider.providerId,
        model: props.provider.model,
        skipPermissions: props.provider.skipPermissions,
      }),
    );
  }
  emit("update:commandOverride", !props.commandOverride);
}
</script>

<style scoped>
.agent-config-section {
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 10px 12px;
  margin-bottom: 0;
}
.agent-config-section__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}
.agent-config-section__label {
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  opacity: 0.7;
}
.agent-config-section__advanced-btn {
  font-size: 11px;
  padding: 2px 8px;
  opacity: 0.7;
}
.agent-config-section__advanced-btn:hover {
  opacity: 1;
}
.grid--2col {
  grid-template-columns: 1fr 1fr;
}
/* Force matching height for the Provider select and the Model input next to it
   — browser defaults render native select / input at slightly different heights
   which looked ragged in the agent config grid. */
.agent-config-section input[type="text"],
.agent-config-section input:not([type]),
.agent-config-section select {
  box-sizing: border-box;
  height: 32px;
  padding: 4px 8px;
  line-height: 20px;
}
.checkbox-inline {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
  cursor: pointer;
  font-size: 12px;
  opacity: 0.85;
}
.checkbox-inline input {
  width: auto;
  margin: 0;
}
.agent-config-section__isolation-note {
  margin: 8px 0 0;
  font-size: 11px;
  opacity: 0.75;
}
</style>
