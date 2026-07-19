<template>
  <div class="agent-config-section">
    <div class="agent-config-section__header">
      <span class="agent-config-section__label">{{ sectionLabel }}</span>
      <button type="button" class="button button--ghost agent-config-section__advanced-btn" @click="toggleOverride">
        {{ commandOverride ? "Use provider picker" : "Advanced: custom command" }}
      </button>
    </div>
    <template v-if="!commandOverride">
      <div class="grid grid--2col">
        <label>
          <span>Provider</span>
          <CustomSelect v-model="provider.providerId" :options="providerOptions" @change="onProviderChange" />
        </label>
        <label
          title="Leave empty for the CLI's own default, pick from the suggestion list, or type any model ID your CLI version supports — Codex and Gemini change their model catalog often and we don't want a rebuild every time."
        >
          <span>Model</span>
          <input v-model="provider.model" :list="modelListId" placeholder="Default" maxlength="100" />
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
      <label class="checkbox-inline">
        <input v-model="provider.skipPermissions" type="checkbox" />
        <span>Skip permission prompts (dangerous)</span>
      </label>
    </template>
    <label v-else title="Full CLI command including flags">
      <span>{{ commandLabel }}</span>
      <input v-model="panel.command" :placeholder="commandPlaceholder" maxlength="500" />
    </label>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import CustomSelect from "../common/CustomSelect.vue";
import { PROVIDER_CHOICES, buildProviderCommand, type ProviderConfig } from "../../lib/agent-providers.js";

interface PanelRef {
  command: string;
}

interface Props {
  role: "worker" | "judge";
  provider: ProviderConfig;
  panel: PanelRef;
  commandOverride: boolean;
  providerOptions: Array<{ value: string; label: string; disabled?: boolean }>;
}

const props = defineProps<Props>();
const emit = defineEmits<{
  "update:commandOverride": [value: boolean];
}>();

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

function onProviderChange() {
  // Auto-select suggested model for this role + reset skipPermissions to provider default
  const p = PROVIDER_CHOICES.find((c) => c.id === props.provider.providerId);
  const suggested = p?.models?.find((m) => m.suggestedRole === props.role) || p?.models?.[0];
  if (suggested) props.provider.model = suggested.id;
  if (p) props.provider.skipPermissions = p.defaultSkipPermissions ?? false;
}

function toggleOverride() {
  // When enabling advanced custom command, prefill with current picker state
  if (!props.commandOverride) {
    props.panel.command = buildProviderCommand({
      providerId: props.provider.providerId,
      model: props.provider.model,
      skipPermissions: props.provider.skipPermissions,
    });
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
</style>
