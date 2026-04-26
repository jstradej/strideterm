<template>
  <div class="telegram-tab">
    <p class="telegram-tab__intro">
      Forward strIDEterm alerts to a Telegram bot and handle replies to trigger actions (start a task, open a PR
      review). No public URL needed — the bot uses long-polling.
    </p>

    <!-- Connection list -->
    <div v-if="connections.length > 0" class="connection-list">
      <div
        v-for="conn in connections"
        :key="conn.id"
        class="connection-item"
        :class="{ 'connection-item--active': editingId === conn.id }"
      >
        <div class="connection-item__header" @click="toggleEdit(conn.id)">
          <span class="connection-item__label">{{ conn.label || conn.chatId }}</span>
          <span class="connection-item__meta">chat&nbsp;{{ conn.chatId }}</span>
          <span class="connection-item__badge" :class="conn.enabled ? 'badge--ok' : 'badge--off'">{{
            conn.enabled ? "enabled" : "disabled"
          }}</span>
          <span class="connection-item__chevron">{{ editingId === conn.id ? "▲" : "▼" }}</span>
        </div>
        <div v-if="editingId === conn.id" class="connection-form">
          <ConnectionForm
            :draft="editDraft"
            :busy="busy"
            :error="errorMessage"
            :verification="verification || undefined"
            :is-edit="true"
            @test="testConnection(editDraft)"
            @save="saveConnection(editDraft)"
            @delete="deleteConnection(conn.id)"
          />
        </div>
      </div>
    </div>

    <div v-if="!showAddForm" class="telegram-tab__actions">
      <button type="button" class="button button--ghost" @click="openAddForm">+ Add connection</button>
    </div>

    <!-- Add form -->
    <div v-if="showAddForm" class="connection-form connection-form--add">
      <h4 class="connection-form__title">New Telegram connection</h4>
      <ConnectionForm
        :draft="addDraft"
        :busy="busy"
        :error="errorMessage"
        :verification="verification || undefined"
        :is-edit="false"
        @test="testConnection(addDraft)"
        @save="saveConnection(addDraft)"
        @cancel="cancelAdd"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, inject, watch } from "vue";
import type { Transport } from "../../../transport.js";

interface TelegramConnection {
  id: string;
  label: string;
  botTokenRef: string;
  chatId: string;
  enabled: boolean;
  pollSeconds: number;
  forwardKinds: string[];
  agentCommand?: string;
}

interface TelegramSettings {
  enabled?: boolean;
  defaultPollSeconds?: number;
  connections?: TelegramConnection[];
}

interface Props {
  telegramSettings?: TelegramSettings | null;
}

const props = withDefaults(defineProps<Props>(), {
  telegramSettings: null,
});

const api = inject<Transport>("api");

const connections = ref<TelegramConnection[]>([...(props.telegramSettings?.connections || [])]);
const editingId = ref<string | null>(null);
const showAddForm = ref(false);
const busy = ref(false);
const errorMessage = ref("");
const verification = ref<{ ok: boolean; botName?: string } | null>(null);

function makeBlankDraft() {
  return reactive({
    id: "",
    label: "",
    botToken: "",
    chatId: "",
    enabled: true,
    pollSeconds: props.telegramSettings?.defaultPollSeconds ?? 5,
    forwardKinds: [] as string[],
    agentCommand: "",
  });
}

const addDraft = makeBlankDraft();
const editDraft = reactive({
  id: "",
  label: "",
  botToken: "",
  chatId: "",
  enabled: true,
  pollSeconds: 5,
  forwardKinds: [] as string[],
  agentCommand: "",
});

watch(
  () => props.telegramSettings?.connections,
  (val) => {
    connections.value = [...(val || [])];
  },
);

function toggleEdit(id: string) {
  if (editingId.value === id) {
    editingId.value = null;
    return;
  }
  showAddForm.value = false;
  errorMessage.value = "";
  verification.value = null;
  const conn = connections.value.find((c) => c.id === id);
  if (!conn) return;
  editDraft.id = conn.id;
  editDraft.label = conn.label;
  editDraft.botToken = "";
  editDraft.chatId = conn.chatId;
  editDraft.enabled = conn.enabled;
  editDraft.pollSeconds = conn.pollSeconds;
  editDraft.forwardKinds = [...conn.forwardKinds];
  editDraft.agentCommand = conn.agentCommand || "";
  editingId.value = id;
}

function openAddForm() {
  editingId.value = null;
  errorMessage.value = "";
  verification.value = null;
  addDraft.id = "";
  addDraft.label = "";
  addDraft.botToken = "";
  addDraft.chatId = "";
  addDraft.enabled = true;
  addDraft.pollSeconds = props.telegramSettings?.defaultPollSeconds ?? 5;
  addDraft.forwardKinds = [];
  showAddForm.value = true;
}

function cancelAdd() {
  showAddForm.value = false;
  errorMessage.value = "";
  verification.value = null;
}

type Draft = {
  id: string;
  label: string;
  botToken: string;
  chatId: string;
  enabled: boolean;
  pollSeconds: number;
  forwardKinds: string[];
  agentCommand?: string;
};

async function testConnection(draft: Draft) {
  busy.value = true;
  errorMessage.value = "";
  verification.value = null;
  try {
    const result = (await api?.verifyTelegramConnection?.({
      id: draft.id || undefined,
      label: draft.label || undefined,
      botToken: draft.botToken || undefined,
      chatId: draft.chatId || undefined,
    })) as { ok: boolean; botName?: string } | null;
    verification.value = result;
  } catch (err) {
    errorMessage.value = (err as Error)?.message || "Telegram connection test failed.";
  } finally {
    busy.value = false;
  }
}

async function saveConnection(draft: Draft) {
  busy.value = true;
  errorMessage.value = "";
  try {
    await api?.saveTelegramConnection?.({
      id: draft.id || undefined,
      label: draft.label || undefined,
      botToken: draft.botToken || undefined,
      chatId: draft.chatId || undefined,
      enabled: draft.enabled,
      pollSeconds: draft.pollSeconds,
      forwardKinds: draft.forwardKinds,
      agentCommand: draft.agentCommand || undefined,
    });
    showAddForm.value = false;
    editingId.value = null;
    verification.value = null;
    await api?.refreshTelegram?.();
  } catch (err) {
    errorMessage.value = (err as Error)?.message || "Failed to save Telegram connection.";
  } finally {
    busy.value = false;
  }
}

async function deleteConnection(id: string) {
  if (!confirm("Delete this Telegram connection?")) return;
  busy.value = true;
  errorMessage.value = "";
  try {
    await api?.deleteTelegramConnection?.(id);
    editingId.value = null;
    connections.value = connections.value.filter((c) => c.id !== id);
    await api?.refreshTelegram?.();
  } catch (err) {
    errorMessage.value = (err as Error)?.message || "Failed to delete Telegram connection.";
  } finally {
    busy.value = false;
  }
}
</script>

<!-- Inline sub-component to avoid repetition between add / edit forms -->
<script lang="ts">
import { defineComponent, h, resolveComponent } from "vue";

export const ConnectionForm = defineComponent({
  name: "ConnectionForm",
  props: {
    draft: { type: Object, required: true },
    busy: { type: Boolean, default: false },
    error: { type: String, default: "" },
    verification: { type: Object, default: null },
    isEdit: { type: Boolean, default: false },
  },
  emits: ["test", "save", "cancel", "delete"],
  setup(props, { emit }) {
    return () => {
      const d = props.draft as Record<string, unknown>;
      return h("div", { class: "connection-form__fields" }, [
        h("div", { class: "form-row-2" }, [
          h("label", { class: "form-label" }, [
            h("span", "Label"),
            h("input", {
              value: d.label,
              class: "settings-input",
              placeholder: "My Telegram bot",
              maxlength: 60,
              onInput: (e: Event) => {
                d.label = (e.target as HTMLInputElement).value;
              },
            }),
          ]),
          h("label", { class: "form-label" }, [
            h("span", "Poll (seconds)"),
            h("input", {
              value: d.pollSeconds,
              type: "number",
              min: 1,
              max: 3600,
              class: "settings-input",
              onInput: (e: Event) => {
                d.pollSeconds = Number((e.target as HTMLInputElement).value);
              },
            }),
          ]),
        ]),
        h("label", { class: "form-label" }, [
          h("span", props.isEdit ? "Bot token (leave empty to keep current)" : "Bot token"),
          h("input", {
            value: d.botToken,
            type: "password",
            class: "settings-input",
            placeholder: "1234567890:ABC-...",
            maxlength: 200,
            onInput: (e: Event) => {
              d.botToken = (e.target as HTMLInputElement).value;
            },
          }),
          h("small", { class: "help-text" }, "Get it from @BotFather on Telegram."),
        ]),
        h("label", { class: "form-label" }, [
          h("span", "Chat ID"),
          h("input", {
            value: d.chatId,
            class: "settings-input",
            placeholder: "-100123456789 or 123456789",
            maxlength: 40,
            onInput: (e: Event) => {
              d.chatId = (e.target as HTMLInputElement).value;
            },
          }),
          h("small", { class: "help-text" }, "Your personal or group chat ID. Send /start to your bot to find it."),
        ]),
        h("label", { class: "form-label" }, [
          h("span", "Agent command (optional)"),
          h("input", {
            value: d.agentCommand,
            class: "settings-input",
            placeholder: "claude --non-interactive -p",
            maxlength: 500,
            onInput: (e: Event) => {
              d.agentCommand = (e.target as HTMLInputElement).value;
            },
          }),
          h(
            "small",
            { class: "help-text" },
            "CLI command to run in non-interactive mode. Use {task} for the task text. Leave empty to use the built-in task runner.",
          ),
        ]),
        h("label", { class: "form-label form-label--inline" }, [
          h("input", {
            checked: d.enabled,
            type: "checkbox",
            onChange: (e: Event) => {
              d.enabled = (e.target as HTMLInputElement).checked;
            },
          }),
          h("span", "Enable polling for this connection"),
        ]),
        props.error ? h("p", { class: "form-error" }, props.error) : null,
        props.verification
          ? h("div", { class: "form-verify" }, [
              h("strong", props.verification.ok ? "✓ Connected" : "✗ Failed"),
              props.verification.botName
                ? h("span", { class: "form-verify__name" }, ` — @${props.verification.botName}`)
                : null,
            ])
          : null,
        h("div", { class: "form-actions" }, [
          !props.isEdit
            ? h("button", { type: "button", class: "button button--ghost", onClick: () => emit("cancel") }, "Cancel")
            : null,
          h(
            "button",
            {
              type: "button",
              class: ["button", "button--ghost", props.busy && "button--busy"],
              disabled: props.busy,
              onClick: () => emit("test"),
            },
            props.busy ? "Testing…" : "Test connection",
          ),
          props.isEdit
            ? h(
                "button",
                {
                  type: "button",
                  class: "button button--ghost button--danger",
                  disabled: props.busy,
                  onClick: () => emit("delete"),
                },
                "Delete",
              )
            : null,
          h(
            "button",
            {
              type: "button",
              class: ["button", props.busy && "button--busy"],
              disabled: props.busy,
              onClick: () => emit("save"),
            },
            props.busy ? "Saving…" : "Save connection",
          ),
        ]),
      ]);
    };
  },
});
</script>

<style scoped>
.telegram-tab {
  display: grid;
  gap: 16px;
}

.telegram-tab__intro {
  color: var(--muted);
  font-size: 13px;
  line-height: 1.5;
  margin: 0;
}

.telegram-tab__actions {
  display: flex;
  gap: 8px;
}

.connection-list {
  display: grid;
  gap: 6px;
}

.connection-item {
  border: 1px solid var(--border);
  border-radius: 6px;
  overflow: hidden;
}

.connection-item--active {
  border-color: var(--accent);
}

.connection-item__header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  cursor: pointer;
  user-select: none;
  background: rgba(255, 255, 255, 0.02);
}

.connection-item__header:hover {
  background: rgba(255, 255, 255, 0.05);
}

.connection-item__label {
  font-weight: 600;
  font-size: 13px;
  flex: 1;
}

.connection-item__meta {
  font-size: 12px;
  color: var(--muted);
  font-family: monospace;
}

.connection-item__chevron {
  font-size: 10px;
  color: var(--muted);
}

.connection-item__badge {
  font-size: 11px;
  padding: 2px 6px;
  border-radius: 10px;
}

.badge--ok {
  background: rgba(0, 200, 100, 0.15);
  color: #0c6;
}

.badge--off {
  background: rgba(255, 255, 255, 0.06);
  color: var(--muted);
}

.connection-form {
  padding: 12px;
  border-top: 1px solid var(--border);
}

.connection-form--add {
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 14px;
}

.connection-form__title {
  margin: 0 0 12px;
  font-size: 13px;
  font-weight: 600;
}
</style>

<style>
/* Unscoped — used by the render-function ConnectionForm sub-component */
.connection-form__fields {
  display: grid;
  gap: 10px;
}

.form-row-2 {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 10px;
}

.form-label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 13px;
}

.form-label > span:first-child {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--muted);
}

.form-label--inline {
  flex-direction: row;
  align-items: center;
  gap: 8px;
  cursor: pointer;
}

.form-label--inline input[type="checkbox"] {
  width: auto;
  padding: 0;
  border: none;
  background: none;
  accent-color: var(--accent);
  margin: 0;
}

.form-error {
  color: var(--danger);
  font-size: 13px;
  margin: 0;
}

.form-verify {
  font-size: 13px;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: rgba(0, 200, 100, 0.05);
}

.form-verify__name {
  color: var(--muted);
}

.form-actions {
  display: flex;
  gap: 6px;
  justify-content: flex-end;
  flex-wrap: wrap;
}

.button--danger {
  color: var(--danger);
  border-color: var(--danger);
}

.button--danger:hover {
  background: rgba(255, 60, 60, 0.1);
}
</style>
