<template>
  <div class="telegram-tab">
    <p class="telegram-tab__intro">
      Forward strIDEterm alerts to a Telegram bot and handle replies to trigger actions (start a task, open a PR
      review). No public URL needed — the bot uses long-polling.
    </p>
    <ol
      class="telegram-tab__steps"
      title="Three-step setup. Send /start to your bot in Telegram, paste the bot token here, click Detect."
    >
      <li>Talk to <strong>@BotFather</strong> in Telegram → <code>/newbot</code> → copy the token.</li>
      <li>Send <code>/start</code> (or any message) to your new bot from your Telegram account.</li>
      <li>Paste the token below and click <strong>🔍 Detect chat</strong>. The chat ID is filled in automatically.</li>
    </ol>

    <!-- Connection list -->
    <div v-if="connections.length > 0" class="connection-list">
      <div
        v-for="conn in connections"
        :key="conn.id"
        class="connection-item"
        :class="{ 'connection-item--active': editingId === conn.id }"
      >
        <div
          class="connection-item__header"
          :title="`Click to expand and edit Telegram connection “${conn.label || conn.chatId}”. Polling status: ${
            conn.enabled ? 'enabled' : 'disabled'
          }.`"
          @click="toggleEdit(conn.id)"
        >
          <span
            class="connection-item__label"
            :title="
              conn.label ? `Connection label: ${conn.label}` : 'No label set — using chat ID as the display name.'
            "
            >{{ conn.label || conn.chatId }}</span
          >
          <span
            class="connection-item__meta"
            title="Telegram chat ID this bot delivers notifications to. Negative values denote group chats."
            >chat&nbsp;{{ conn.chatId }}</span
          >
          <span
            class="connection-item__badge"
            :class="conn.enabled ? 'badge--ok' : 'badge--off'"
            :title="
              conn.enabled
                ? 'Long-polling is active for this connection — alerts will be forwarded to Telegram.'
                : 'Polling is paused for this connection — saved but not delivering messages.'
            "
            >{{ conn.enabled ? "enabled" : "disabled" }}</span
          >
          <span
            v-if="(props.profiles || []).length > 1 && !conn.profileId"
            class="connection-item__badge badge--global"
            title="Global delivery — this connection receives alerts from every profile. The profile name is included in each Telegram message so you can tell at a glance where the alert came from. Bind to a specific profile to filter."
            >global</span
          >
          <span
            class="connection-item__chevron"
            :title="
              editingId === conn.id
                ? 'Collapse this connection — close the inline editor and return to the connection list view.'
                : 'Expand this connection to edit its bot token, chat ID, poll interval, forward filter, and enabled flag inline.'
            "
            >{{ editingId === conn.id ? "▲" : "▼" }}</span
          >
        </div>
        <div v-if="editingId === conn.id" class="connection-form">
          <ConnectionForm
            :draft="editDraft"
            :busy="busy"
            :error="errorMessage"
            :verification="verification || undefined"
            :detected-chats="detectedChats"
            :detect-info="detectInfoMessage"
            :is-edit="true"
            :profile-options="profileOptions"
            @test="testConnection(editDraft)"
            @detect="detectChats(editDraft)"
            @pick-chat="(c: DetectedChat) => pickDetectedChat(editDraft, c)"
            @save="saveConnection(editDraft)"
            @delete="deleteConnection(conn.id)"
          />
        </div>
      </div>
    </div>

    <div v-if="!showAddForm" class="telegram-tab__actions">
      <button
        type="button"
        class="button button--ghost"
        title="Add a new Telegram bot connection. You will need a bot token from @BotFather and the target chat ID."
        @click="openAddForm"
      >
        + Add connection
      </button>
    </div>

    <!-- Add form -->
    <div v-if="showAddForm" class="connection-form connection-form--add">
      <h4 class="connection-form__title">New Telegram connection</h4>
      <ConnectionForm
        :draft="addDraft"
        :busy="busy"
        :error="errorMessage"
        :verification="verification || undefined"
        :detected-chats="detectedChats"
        :detect-info="detectInfoMessage"
        :is-edit="false"
        :profile-options="profileOptions"
        @test="testConnection(addDraft)"
        @detect="detectChats(addDraft)"
        @pick-chat="(c: DetectedChat) => pickDetectedChat(addDraft, c)"
        @save="saveConnection(addDraft)"
        @cancel="cancelAdd"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, inject, watch } from "vue";
import type { Transport } from "../../../transport.js";
import { useAppStore } from "../../../stores/app.js";

interface TelegramConnection {
  id: string;
  label: string;
  botTokenRef: string;
  chatId: string;
  enabled: boolean;
  pollSeconds: number;
  profileId?: string;
  forwardKinds: string[];
}

interface ProfileOption {
  id: string;
  name: string;
  color?: string;
}

interface TelegramSettings {
  enabled?: boolean;
  defaultPollSeconds?: number;
  connections?: TelegramConnection[];
}

interface Props {
  telegramSettings?: TelegramSettings | null;
  profiles?: ProfileOption[];
}

const props = withDefaults(defineProps<Props>(), {
  telegramSettings: null,
  profiles: () => [],
});

const api = inject<Transport>("api");
const appStore = useAppStore();

const connections = ref<TelegramConnection[]>([...(props.telegramSettings?.connections || [])]);
const profileOptions = ref<ProfileOption[]>([...(props.profiles || [])]);
const editingId = ref<string | null>(null);
const showAddForm = ref(false);
const busy = ref(false);
const errorMessage = ref("");
const verification = ref<{ ok: boolean; botName?: string; chatTitle?: string } | null>(null);

interface DetectedChat {
  chatId: string;
  title: string;
  type: string;
  lastFromUser: string;
  lastText: string;
}
const detectedChats = ref<DetectedChat[]>([]);
const detectInfoMessage = ref<string>("");

function makeBlankDraft() {
  return reactive({
    id: "",
    label: "",
    botToken: "",
    chatId: "",
    enabled: true,
    pollSeconds: props.telegramSettings?.defaultPollSeconds ?? 5,
    profileId: "",
    forwardKinds: [] as string[],
  });
}

const addDraft = makeBlankDraft();
const editDraft = makeBlankDraft();

watch(
  () => props.telegramSettings?.connections,
  (val) => {
    connections.value = [...(val || [])];
  },
);

watch(
  () => props.profiles,
  (val) => {
    profileOptions.value = [...(val || [])];
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
  editDraft.profileId = conn.profileId || "";
  editDraft.forwardKinds = [...conn.forwardKinds];
  editingId.value = id;
}

function openAddForm() {
  editingId.value = null;
  errorMessage.value = "";
  verification.value = null;
  detectedChats.value = [];
  detectInfoMessage.value = "";
  Object.assign(addDraft, makeBlankDraft());
  showAddForm.value = true;
}

function cancelAdd() {
  showAddForm.value = false;
  errorMessage.value = "";
  verification.value = null;
  detectedChats.value = [];
  detectInfoMessage.value = "";
}

type Draft = {
  id: string;
  label: string;
  botToken: string;
  chatId: string;
  enabled: boolean;
  pollSeconds: number;
  profileId?: string;
  forwardKinds: string[];
};

async function detectChats(draft: Draft) {
  busy.value = true;
  errorMessage.value = "";
  verification.value = null;
  detectedChats.value = [];
  detectInfoMessage.value = "";
  try {
    // Plain primitives only — defensive against Vue reactive proxies.
    const raw = (await api?.detectTelegramChats?.({
      id: String(draft.id || ""),
      botToken: String(draft.botToken || ""),
    })) as { botUsername?: string; chats?: DetectedChat[] } | null;
    if (!raw) {
      throw new Error("Empty response from runtime.");
    }
    const chats = Array.isArray(raw.chats) ? raw.chats : [];
    if (chats.length === 0) {
      detectInfoMessage.value = `Bot @${
        raw.botUsername || "?"
      } is reachable, but I don't see any messages yet. In Telegram, open @${
        raw.botUsername || "your bot"
      } and send /start (or any message), then click Detect again.`;
      return;
    }
    if (chats.length === 1) {
      const c = chats[0];
      draft.chatId = c.chatId;
      if (!draft.label) {
        draft.label = c.title || `@${raw.botUsername || ""}`.trim();
      }
      detectInfoMessage.value = `Found chat “${c.title}” (id ${c.chatId}). Click Test or Save to finish.`;
      return;
    }
    // Multiple chats — show selector
    detectedChats.value = chats;
    detectInfoMessage.value = `Found ${chats.length} chats with recent messages. Pick the one you want.`;
  } catch (err) {
    errorMessage.value = (err as Error)?.message || "Detect failed.";
  } finally {
    busy.value = false;
  }
}

function pickDetectedChat(draft: Draft, chat: DetectedChat) {
  draft.chatId = chat.chatId;
  if (!draft.label) draft.label = chat.title;
  detectedChats.value = [];
  detectInfoMessage.value = `Picked chat “${chat.title}” (id ${chat.chatId}).`;
}

async function testConnection(draft: Draft) {
  busy.value = true;
  errorMessage.value = "";
  verification.value = null;
  try {
    // Backend may return either { ok, botName, chatTitle } (current) or the
    // older { botUsername, chatTitle } shape — normalise here so the UI does
    // not silently render a successful verification as "✗ Failed".
    // Pass primitives only (avoid Vue reactive proxies tripping IPC clone).
    const raw = (await api?.verifyTelegramConnection?.({
      id: String(draft.id || ""),
      label: String(draft.label || ""),
      botToken: String(draft.botToken || ""),
      chatId: String(draft.chatId || ""),
    })) as Record<string, unknown> | null;
    if (!raw) {
      throw new Error("Empty response from runtime.");
    }
    const botName = (raw.botName as string) || (raw.botUsername as string) || "";
    const chatTitle = (raw.chatTitle as string) || draft.chatId;
    // The backend throws on failure, so reaching here means success unless
    // the payload explicitly says ok:false.
    const ok = raw.ok !== false;
    verification.value = { ok, botName, chatTitle };
  } catch (err) {
    errorMessage.value = (err as Error)?.message || "Telegram connection test failed.";
    verification.value = { ok: false };
  } finally {
    busy.value = false;
  }
}

function extractConnectionsFromPayload(payload: unknown): TelegramConnection[] | null {
  if (!payload || typeof payload !== "object") return null;
  // Backend returns the full payload after save/delete/refresh. The list is
  // under appState.settings.integrations.telegram.connections.
  const p = payload as { appState?: { settings?: { integrations?: { telegram?: { connections?: unknown } } } } };
  const list = p.appState?.settings?.integrations?.telegram?.connections;
  if (!Array.isArray(list)) return null;
  return list as TelegramConnection[];
}

async function saveConnection(draft: Draft) {
  busy.value = true;
  errorMessage.value = "";
  try {
    // Unwrap reactive Proxies before crossing the IPC boundary. Electron's
    // structured-clone (v8) refuses Vue's reactive() proxy and rejects with
    // "An object could not be cloned" — taking a fresh copy here makes the
    // payload plain JS.
    const result = (await api?.saveTelegramConnection?.({
      id: draft.id || undefined,
      label: draft.label || undefined,
      botToken: draft.botToken || undefined,
      chatId: draft.chatId || undefined,
      enabled: Boolean(draft.enabled),
      pollSeconds: Number(draft.pollSeconds),
      profileId: draft.profileId || undefined,
      forwardKinds: Array.isArray(draft.forwardKinds) ? [...draft.forwardKinds] : [],
    })) as { payload?: unknown } | undefined;

    // The dialog received its `settings` prop as a static snapshot at open
    // time, so it doesn't auto-update. Pull the new list from the save
    // response (or, as a fallback, from refreshTelegram).
    const fresh =
      extractConnectionsFromPayload(result?.payload) ?? extractConnectionsFromPayload(await api?.refreshTelegram?.());
    if (fresh) {
      connections.value = fresh;
    }

    showAddForm.value = false;
    editingId.value = null;
    verification.value = null;
    detectedChats.value = [];
    detectInfoMessage.value = "";
  } catch (err) {
    errorMessage.value = (err as Error)?.message || "Failed to save Telegram connection.";
  } finally {
    busy.value = false;
  }
}

async function deleteConnection(id: string) {
  const confirmed = await appStore.confirmInApp({
    title: "Delete Telegram connection?",
    message: "This Telegram connection will be removed.",
    confirmLabel: "Delete",
    danger: true,
  });
  if (!confirmed) return;
  busy.value = true;
  errorMessage.value = "";
  try {
    const result = await api?.deleteTelegramConnection?.(id);
    editingId.value = null;
    // Local optimistic update first, then reconcile with backend payload.
    connections.value = connections.value.filter((c) => c.id !== id);
    const fresh =
      extractConnectionsFromPayload(result) ?? extractConnectionsFromPayload(await api?.refreshTelegram?.());
    if (fresh) {
      connections.value = fresh;
    }
  } catch (err) {
    errorMessage.value = (err as Error)?.message || "Failed to delete Telegram connection.";
  } finally {
    busy.value = false;
  }
}
</script>

<!-- Inline sub-component to avoid repetition between add / edit forms -->
<script lang="ts">
import { defineComponent, h } from "vue";

export const ConnectionForm = defineComponent({
  name: "ConnectionForm",
  props: {
    draft: { type: Object, required: true },
    busy: { type: Boolean, default: false },
    error: { type: String, default: "" },
    verification: { type: Object, default: null },
    detectedChats: { type: Array as () => Array<Record<string, string>>, default: () => [] },
    detectInfo: { type: String, default: "" },
    isEdit: { type: Boolean, default: false },
    profileOptions: { type: Array as () => Array<{ id: string; name: string; color?: string }>, default: () => [] },
  },
  emits: ["test", "save", "cancel", "delete", "detect", "pickChat"],
  setup(props, { emit }) {
    return () => {
      const d = props.draft as Record<string, unknown>;
      return h("div", { class: "connection-form__fields" }, [
        h("div", { class: "form-row-2" }, [
          h(
            "label",
            {
              class: "form-label",
              title:
                "Friendly name shown in the connection list and the Notifications panel. Purely cosmetic — does not affect delivery.",
            },
            [
              h("span", "Label"),
              h("input", {
                value: d.label,
                class: "settings-input",
                placeholder: "My Telegram bot",
                maxlength: 60,
                title: "Friendly name for this Telegram connection (e.g. “Personal bot”, “Team alerts”).",
                onInput: (e: Event) => {
                  d.label = (e.target as HTMLInputElement).value;
                },
              }),
            ],
          ),
          h(
            "label",
            {
              class: "form-label",
              title:
                "How often the bot long-polls Telegram for replies and button presses. Lower = faster reaction; higher = fewer requests. Range 1–3600 s, default 5 s.",
            },
            [
              h("span", "Poll (seconds)"),
              h("input", {
                value: d.pollSeconds,
                type: "number",
                min: 1,
                max: 3600,
                class: "settings-input",
                title: "Polling interval in seconds. Telegram still uses long-polling internally; this gates the loop.",
                onInput: (e: Event) => {
                  d.pollSeconds = Number((e.target as HTMLInputElement).value);
                },
              }),
            ],
          ),
          h(
            "label",
            {
              class: "form-label",
              title:
                "Which profile's alerts this bot delivers. Leave on 'All profiles' for one global bot that sees everything (profile name appears in each message). Bind to a specific profile only if you run multiple separate bots.",
            },
            [
              h("span", "Profile"),
              h(
                "select",
                {
                  value: d.profileId || "",
                  class: "settings-input",
                  title:
                    "Global = receive alerts from every profile (default, recommended for one bot). Specific profile = strict isolation, alerts from other profiles never reach this chat.",
                  onChange: (e: Event) => {
                    d.profileId = (e.target as HTMLSelectElement).value;
                  },
                },
                [
                  h("option", { value: "" }, "All profiles (global)"),
                  ...props.profileOptions.map((profile) =>
                    h("option", { value: profile.id }, profile.name || profile.id),
                  ),
                ],
              ),
            ],
          ),
        ]),
        h(
          "label",
          {
            class: "form-label",
            title:
              "Bot token from @BotFather (format: 12345:ABC-DEF…). Stored encrypted in the OS credential store. Leave empty when editing to keep the current token.",
          },
          [
            h("span", props.isEdit ? "Bot token (leave empty to keep current)" : "Bot token"),
            h("input", {
              value: d.botToken,
              type: "password",
              class: "settings-input",
              placeholder: "1234567890:ABC-...",
              maxlength: 200,
              title: "Paste the bot token from @BotFather here. Hidden after save; never written to disk in plaintext.",
              onInput: (e: Event) => {
                d.botToken = (e.target as HTMLInputElement).value;
              },
            }),
            h("small", { class: "help-text" }, "Get it from @BotFather on Telegram."),
          ],
        ),
        h(
          "label",
          {
            class: "form-label",
            title:
              "Telegram chat ID where notifications are delivered. Personal chat IDs are positive numbers; group/channel IDs start with -100. Click “Detect chat” to auto-fill from your bot's recent messages.",
          },
          [
            h("span", "Chat ID"),
            h("div", { class: "form-row-with-button" }, [
              h("input", {
                value: d.chatId,
                class: "settings-input",
                placeholder: "Auto-fill via Detect, or type manually",
                maxlength: 40,
                title: "Numeric chat ID (positive for DMs, -100… for groups/channels). Required.",
                onInput: (e: Event) => {
                  d.chatId = (e.target as HTMLInputElement).value;
                },
              }),
              h(
                "button",
                {
                  type: "button",
                  class: ["button", "button--ghost", "form-detect-btn", props.busy && "button--busy"],
                  disabled: props.busy || !d.botToken,
                  title: !d.botToken
                    ? "Enter the bot token first; Detect needs it to query Telegram."
                    : "Ask Telegram for chats where the bot has recent messages and auto-fill the chat ID. In Telegram, send /start to your bot first if no chat is detected.",
                  onClick: () => emit("detect"),
                },
                props.busy ? "Detecting…" : "🔍 Detect chat",
              ),
            ]),
            h(
              "small",
              { class: "help-text" },
              "Easiest path: enter the token above, send /start to your bot in Telegram, then click Detect.",
            ),
            // Detection info / multi-chat picker
            props.detectInfo ? h("p", { class: "detect-info" }, props.detectInfo) : null,
            props.detectedChats && props.detectedChats.length > 1
              ? h(
                  "div",
                  { class: "detect-list" },
                  props.detectedChats.map((c) =>
                    h(
                      "button",
                      {
                        type: "button",
                        class: "detect-list__item",
                        title: `Pick this chat — chat ID ${c.chatId}, type ${c.type}.`,
                        onClick: () => emit("pickChat", c),
                      },
                      [
                        h("strong", { class: "detect-list__title" }, String(c.title || c.chatId)),
                        h("span", { class: "detect-list__meta" }, ` · ${c.type} · ${c.chatId}`),
                        c.lastText ? h("p", { class: "detect-list__msg" }, `"${c.lastText}"`) : null,
                      ],
                    ),
                  ),
                )
              : null,
          ],
        ),
        h(
          "label",
          {
            class: "form-label form-label--inline",
            title:
              "When checked, the bot polls Telegram for messages and forwards alerts here. Uncheck to keep the saved configuration but pause delivery.",
          },
          [
            h("input", {
              checked: d.enabled,
              type: "checkbox",
              title: "Toggle polling for this connection without losing its settings.",
              onChange: (e: Event) => {
                d.enabled = (e.target as HTMLInputElement).checked;
              },
            }),
            h("span", "Enable polling for this connection"),
          ],
        ),
        props.error ? h("p", { class: "form-error" }, props.error) : null,
        props.verification
          ? h(
              "div",
              {
                class: "form-verify",
                title: props.verification.ok
                  ? "Telegram bot reachable and able to send to the configured chat. Look for the test message in your Telegram client."
                  : "Verification failed — check the bot token, chat ID, and that you have sent /start to the bot at least once.",
              },
              [
                h("strong", props.verification.ok ? "✓ Connected" : "✗ Failed"),
                props.verification.botName
                  ? h("span", { class: "form-verify__name" }, ` — @${props.verification.botName}`)
                  : null,
                props.verification.ok && props.verification.chatTitle
                  ? h("span", { class: "form-verify__name" }, ` · chat ${props.verification.chatTitle}`)
                  : null,
              ],
            )
          : null,
        h("div", { class: "form-actions" }, [
          !props.isEdit
            ? h(
                "button",
                {
                  type: "button",
                  class: "button button--ghost",
                  title: "Discard the new connection — nothing is saved.",
                  onClick: () => emit("cancel"),
                },
                "Cancel",
              )
            : null,
          h(
            "button",
            {
              type: "button",
              class: ["button", "button--ghost", props.busy && "button--busy"],
              disabled: props.busy,
              title:
                "Verify the bot token and that the bot can post into the configured chat. Sends one test message on success.",
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
                  title:
                    "Permanently remove this connection. The encrypted bot token is wiped from the credential store.",
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
              title:
                "Verify the connection, persist it, and start (or restart) polling. Test message is sent during verification.",
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

.telegram-tab__steps {
  margin: 0;
  padding: 10px 12px 10px 28px;
  background: rgba(255, 255, 255, 0.04);
  border-left: 3px solid var(--accent);
  border-radius: 4px;
  font-size: 12px;
  color: var(--muted);
  line-height: 1.6;
}

.telegram-tab__steps code {
  background: rgba(255, 255, 255, 0.08);
  padding: 1px 5px;
  border-radius: 3px;
  font-size: 11px;
}

.telegram-tab__steps strong {
  color: inherit;
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

.badge--warn {
  background: rgba(255, 180, 0, 0.18);
  color: #b07a00;
}

.badge--global {
  background: rgba(100, 160, 255, 0.16);
  color: #4a90e2;
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

.form-row-with-button {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 6px;
  align-items: stretch;
}

.form-detect-btn {
  white-space: nowrap;
}

.detect-info {
  font-size: 12px;
  color: var(--muted);
  margin: 0;
  padding: 6px 8px;
  background: rgba(255, 255, 255, 0.04);
  border-radius: 4px;
}

.detect-list {
  display: grid;
  gap: 4px;
  margin-top: 4px;
}

.detect-list__item {
  display: block;
  text-align: left;
  width: 100%;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: transparent;
  color: inherit;
  cursor: pointer;
  font-size: 13px;
}

.detect-list__item:hover {
  border-color: var(--accent);
  background: rgba(255, 255, 255, 0.04);
}

.detect-list__title {
  font-weight: 600;
}

.detect-list__meta {
  font-size: 11px;
  color: var(--muted);
}

.detect-list__msg {
  margin: 4px 0 0;
  font-size: 12px;
  color: var(--muted);
  font-style: italic;
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
