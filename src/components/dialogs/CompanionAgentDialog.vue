<template>
  <div class="dialog companion-dialog" style="width: min(620px, 100%)">
    <div class="dialog__header">
      <div>
        <p class="eyebrow">Turn this conversation into an agent loop</p>
        <h2>Add companion agent</h2>
      </div>
      <button type="button" class="button button--ghost" :disabled="submitting" @click="emit('cancel')">Close</button>
    </div>

    <form class="form" @submit.prevent="handleSubmit">
      <section class="companion-dialog__section">
        <span class="companion-dialog__section-label">Current conversation</span>
        <p class="companion-dialog__source">
          <strong>{{ sourceProviderLabel }}</strong> · {{ sourceWorkspaceName }} · <code>{{ sourceCwd }}</code>
        </p>
        <label v-if="needsPrimaryConfirm" class="companion-dialog__confirm-primary">
          <span
            >Current agent
            <small class="companion-dialog__hint"
              >This tab's command doesn't look like a known agent CLI — confirm which one is actually running so
              timeouts and prompt delivery work correctly. We never guess Claude by default.</small
            ></span
          >
          <CustomSelect v-model="primaryProviderConfirmedId" :options="primaryProviderOptions" />
        </label>
      </section>

      <section class="companion-dialog__section">
        <span class="companion-dialog__section-label">How should the evaluator judge the work?</span>
        <div class="companion-dialog__role-grid">
          <button
            v-for="role in ROLES"
            :key="role.id"
            type="button"
            class="companion-dialog__role-card"
            :class="{ 'companion-dialog__role-card--selected': selectedRole === role.id }"
            @click="selectedRole = role.id"
          >
            <span class="companion-dialog__role-title">
              {{ role.label }}
              <span v-if="role.id === 'planner' && plannerRecommended" class="companion-dialog__role-badge"
                >recommended</span
              >
            </span>
            <span class="companion-dialog__role-blurb">{{ role.blurb }}</span>
          </button>
        </div>
        <p class="companion-dialog__hint">
          Judge role — applies only to the new evaluator. The current agent remains the Primary/Worker.
        </p>
      </section>

      <section class="companion-dialog__section">
        <span class="companion-dialog__section-label">Judge / evaluator agent</span>
        <AgentProviderConfig
          v-model:panel-command="companionCommand"
          v-model:command-override="companionCommandOverride"
          role="judge"
          :provider="companionProvider"
          :provider-options="companionProviderOptions"
          @update:provider="onUpdateCompanionProvider"
        />
      </section>

      <section class="companion-dialog__section">
        <label>
          <span>Optional focus</span>
          <textarea
            v-model="focus"
            rows="3"
            maxlength="5000"
            placeholder="Pay special attention to runtime/session safety…"
          />
        </label>
      </section>

      <details class="companion-dialog__advanced">
        <summary>Advanced</summary>
        <label class="companion-dialog__max-rounds">
          <span>Max rounds</span>
          <input v-model.number="maxRounds" type="number" min="1" max="100" />
        </label>
      </details>

      <div v-if="errorMessage" class="dialog__error" role="alert">
        <span class="dialog__error-icon" aria-hidden="true">⚠</span>
        <span class="dialog__error-text">{{ errorMessage }}</span>
      </div>

      <footer class="dialog__footer">
        <button type="button" class="button button--ghost" :disabled="submitting" @click="emit('cancel')">
          Cancel
        </button>
        <button type="submit" class="button" :disabled="!canSubmit || submitting">
          {{ submitting ? "Creating…" : "Create & capture context" }}
        </button>
      </footer>
    </form>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive, ref, useAttrs } from "vue";
import { useAppStore } from "../../stores/app.js";
import CustomSelect from "../common/CustomSelect.vue";
import AgentProviderConfig from "./AgentProviderConfig.vue";
import { PROVIDER_CHOICES, type ProviderConfig } from "../../lib/agent-providers.js";

interface Props {
  sourceSessionId: string;
}
const props = defineProps<Props>();
const emit = defineEmits<{ cancel: [] }>();
const attrs = useAttrs();
// Without this, Vue's automatic attrs fallthrough binds the undeclared
// `onSubmit` prop as a NATIVE "submit" listener on the root div too — the
// inner <form>'s submit event bubbles up to it, firing onSubmit a second
// time with the raw DOM Event instead of our payload. See WorkspaceDialog.vue
// for the same precedent.
defineOptions({ inheritAttrs: false });
const store = useAppStore();

type CompanionRole = "reviewer" | "planner" | "consultant" | "critic";

const ROLES: Array<{ id: CompanionRole; label: string; blurb: string }> = [
  {
    id: "reviewer",
    label: "Reviewer",
    blurb: "Verifies the explicit requirements are actually implemented — correctness, tests, and regression risk.",
  },
  {
    id: "planner",
    label: "Planner",
    blurb: "Pushes an unfinished plan as far as it can go on its own and documents the rest instead of stopping on it.",
  },
  {
    id: "consultant",
    label: "Consultant",
    blurb: "Compares trade-offs, recommends a concrete next step, and knows when the call belongs to you.",
  },
  {
    id: "critic",
    label: "Critic",
    blurb: "Actively hunts hidden assumptions, edge cases, and reasons the current solution might not hold up.",
  },
];

const selectedRole = ref<CompanionRole>("reviewer");
const focus = ref("");
// Plan §3.2: Planner may only be *recommended* (a badge), never silently
// pre-selected — the default stays Reviewer regardless of this signal.
const plannerRecommended = computed(() => /\b(plan|design)\b/i.test(focus.value));

const maxRounds = ref(10);
const submitting = ref(false);
const errorMessage = ref("");

// --- Source conversation -------------------------------------------------

const sourceWorkspaceId = computed(() => props.sourceSessionId.split(":")[0] || "");
const sourcePanelId = computed(() => props.sourceSessionId.split(":").slice(1).join(":"));

const sourceWorkspace = computed(
  () => (store.payload?.appState?.workspaces || []).find((w) => w.id === sourceWorkspaceId.value) || null,
);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sourcePanel = computed<any>(
  () =>
    (sourceWorkspace.value?.panels as unknown as { id: string }[] | undefined)?.find(
      (p) => p.id === sourcePanelId.value,
    ) || null,
);

const sourceWorkspaceName = computed(() => sourceWorkspace.value?.name || "Unknown workspace");
const sourceCwd = computed(() => sourcePanel.value?.cwd || sourceWorkspace.value?.cwd || "");

function extractModelFromCommand(cmd: string): string {
  const m = cmd.match(/(?:--model|-m)\s+(\S+)/);
  return m?.[1] || "";
}

// Mirrors electron/backend/providers/provider-registry.ts:parseProviderFromCommand
// for the *detection* half only — unlike that backend helper (which always
// falls back to Claude for legacy-command migration), this returns null for
// an unrecognized command so the dialog is forced to ask rather than guess.
function detectProviderFromCommand(command: string): ProviderConfig | null {
  const trimmed = (command || "").trim();
  if (!trimmed) return null;
  if (/^claude(\s|$)/.test(trimmed))
    return { providerId: "claude", model: extractModelFromCommand(trimmed) || "sonnet" };
  if (/^codex(\s|$)/.test(trimmed))
    // gpt-5.4-mini until 2026-08-11 — it retires from Codex on 2026-08-31.
    return { providerId: "codex", model: extractModelFromCommand(trimmed) || "gpt-5.6-luna" };
  if (/^gemini(\s|$)/.test(trimmed))
    return { providerId: "gemini", model: extractModelFromCommand(trimmed) || "gemini-2.5-flash" };
  if (/^copilot(\s|$)/.test(trimmed))
    return { providerId: "copilot", model: extractModelFromCommand(trimmed) || "claude-sonnet-4.6" };
  if (/^opencode(\s|$)/.test(trimmed))
    return { providerId: "opencode", model: extractModelFromCommand(trimmed) || "default" };
  return null;
}

const detectedPrimaryProvider = computed(() => detectProviderFromCommand(sourcePanel.value?.command || ""));
const needsPrimaryConfirm = computed(() => !detectedPrimaryProvider.value);

const primaryProviderOptions = PROVIDER_CHOICES.map((c) => ({ value: c.id, label: c.name }));
const primaryProviderConfirmedId = ref("");

const effectivePrimaryProvider = computed<ProviderConfig | null>(() => {
  if (detectedPrimaryProvider.value) return detectedPrimaryProvider.value;
  if (!primaryProviderConfirmedId.value) return null;
  return { providerId: primaryProviderConfirmedId.value, model: "" };
});

const sourceProviderLabel = computed(() => {
  const provider = effectivePrimaryProvider.value || detectedPrimaryProvider.value;
  if (provider) {
    const known = PROVIDER_CHOICES.find((c) => c.id === provider.providerId);
    return known?.name || provider.providerId;
  }
  return "Unknown agent (confirm below)";
});

// --- Companion (Judge/evaluator) provider --------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const taskDefaults = computed<any>(() => store.payload?.appState?.settings?.taskDefaults || {});
// Whether the companion bypasses permission prompts is the user's call, like
// it is for a standard task's worker and judge. An evaluator that stops to ask
// whether it may read a file can't run a loop unattended, so the provider's own
// default (or the stored task default) applies here rather than a forced false.
function defaultSkipPermissionsFor(providerId: string): boolean {
  return PROVIDER_CHOICES.find((c) => c.id === providerId)?.defaultSkipPermissions ?? false;
}

const companionProvider = reactive<ProviderConfig>({
  providerId: taskDefaults.value.judgeProvider?.providerId || "codex",
  model: taskDefaults.value.judgeProvider?.model || "gpt-5.6-sol",
  skipPermissions:
    taskDefaults.value.judgeProvider?.skipPermissions ??
    defaultSkipPermissionsFor(taskDefaults.value.judgeProvider?.providerId || "codex"),
});
const companionProviderOptions = PROVIDER_CHOICES.map((c) => ({ value: c.id, label: c.name }));

// Custom-command escape hatch, same as a standard task's worker/judge: while
// the override is on, this raw string is launched verbatim and the provider
// picker above only labels the panel.
const companionCommand = ref("");
const companionCommandOverride = ref(false);

function onUpdateCompanionProvider(next: ProviderConfig) {
  companionProvider.providerId = next.providerId;
  companionProvider.model = next.model;
  companionProvider.skipPermissions = next.skipPermissions ?? false;
}

// --- Submit ---------------------------------------------------------------

const canSubmit = computed(() => {
  if (!sourceWorkspace.value || !sourcePanel.value) return false;
  if (!effectivePrimaryProvider.value) return false;
  if (!companionProvider.providerId) return false;
  if (!maxRounds.value || maxRounds.value < 1) return false;
  return true;
});

async function handleSubmit() {
  if (!canSubmit.value || submitting.value) return;
  submitting.value = true;
  errorMessage.value = "";
  try {
    await (
      attrs.onSubmit as
        | ((payload: {
            sourceSessionId: string;
            primaryProvider: ProviderConfig | null;
            companionRole: CompanionRole;
            companionProvider: ProviderConfig;
            companionCommand: string | undefined;
            focus: string;
            maxRounds: number;
          }) => Promise<void>)
        | undefined
    )?.({
      sourceSessionId: props.sourceSessionId,
      primaryProvider: effectivePrimaryProvider.value,
      companionRole: selectedRole.value,
      companionProvider: { ...companionProvider },
      companionCommand: companionCommandOverride.value ? companionCommand.value.trim() : undefined,
      focus: focus.value.trim(),
      maxRounds: maxRounds.value,
    });
  } catch (err) {
    errorMessage.value = extractErrorMessage(err);
  } finally {
    submitting.value = false;
  }
}

function extractErrorMessage(err: unknown): string {
  const raw = (err as Error)?.message || String(err || "Unknown error");
  return raw.replace(/^Error invoking remote method '[^']+':\s*/, "").replace(/^Error:\s*/, "");
}
</script>

<style scoped>
.companion-dialog__section {
  margin-bottom: 16px;
}
.companion-dialog__section-label {
  display: block;
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  opacity: 0.7;
  margin-bottom: 6px;
}
.companion-dialog__source {
  margin: 0;
  font-size: 13px;
}
.companion-dialog__source code {
  font-size: 12px;
  opacity: 0.8;
}
.companion-dialog__confirm-primary {
  display: block;
  margin-top: 10px;
}
.companion-dialog__hint {
  display: block;
  font-size: 11px;
  opacity: 0.7;
  margin-top: 4px;
  font-weight: 400;
  text-transform: none;
  letter-spacing: normal;
}
.companion-dialog__role-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}
@media (max-width: 560px) {
  .companion-dialog__role-grid {
    grid-template-columns: 1fr;
  }
}
.companion-dialog__role-card {
  text-align: left;
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 10px 12px;
  background: transparent;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.companion-dialog__role-card:hover {
  border-color: var(--accent, #7c4dff);
}
.companion-dialog__role-card--selected {
  border-color: var(--accent, #7c4dff);
  background: rgba(124, 77, 255, 0.08);
}
.companion-dialog__role-title {
  font-weight: 600;
  font-size: 13px;
  display: flex;
  align-items: center;
  gap: 6px;
}
.companion-dialog__role-badge {
  font-size: 10px;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  padding: 1px 6px;
  border-radius: 3px;
  background: rgba(124, 77, 255, 0.24);
}
.companion-dialog__role-blurb {
  font-size: 11px;
  opacity: 0.75;
  line-height: 1.4;
}
.companion-dialog__advanced {
  margin-bottom: 16px;
}
.companion-dialog__advanced summary {
  cursor: pointer;
  font-size: 12px;
  font-weight: 600;
  opacity: 0.8;
  margin-bottom: 8px;
}
.companion-dialog__max-rounds {
  display: flex;
  align-items: center;
  gap: 8px;
  max-width: 160px;
}
</style>
