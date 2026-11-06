<template>
  <section class="comment-attribution" data-testid="jira-comment-attribution">
    <h3 class="comment-attribution__title">Comment attribution for technical accounts</h3>
    <label class="comment-attribution__check" :class="{ 'comment-attribution__check--disabled': isRemote }">
      <input
        type="checkbox"
        data-testid="jira-attribution-enabled"
        :checked="draft.enabled"
        :disabled="isRemote || busy"
        @change="onEnabledChange"
      />
      <span>Add a line to comments posted with a technical account</span>
    </label>
    <textarea
      v-model="draft.text"
      class="comment-attribution__text"
      data-testid="jira-attribution-text"
      rows="2"
      maxlength="500"
      aria-label="Attribution text"
      :disabled="isRemote"
      @change="save"
    ></textarea>
    <small class="comment-attribution__hint">
      Placeholders: <code>{user}</code> (your Jira name on that connection, else the profile name) and
      <code>{account}</code> (the technical account). Personal accounts post exactly what you type.
    </small>
    <fieldset
      class="comment-attribution__position"
      :class="{ 'comment-attribution__position--disabled': positionLocked }"
    >
      <legend>Position</legend>
      <label v-for="option in POSITIONS" :key="option.value" class="comment-attribution__radio">
        <input
          type="radio"
          name="jira-attribution-position"
          :value="option.value"
          :checked="draft.position === option.value"
          :disabled="positionLocked"
          :data-testid="`jira-attribution-${option.value}`"
          @change="setPosition(option.value)"
        />
        <span>{{ option.label }}</span>
      </label>
    </fieldset>
    <figure class="comment-attribution__preview">
      <figcaption>Preview of a comment</figcaption>
      <div class="comment-attribution__preview-body" data-testid="jira-attribution-example">
        <template v-if="example">
          <span
            v-for="(line, index) in exampleLines"
            :key="index"
            :class="{ 'comment-attribution__preview-added': line.added }"
            >{{ line.text }}</span
          >
        </template>
        <span v-else class="comment-attribution__preview-added">Nothing is added to comments.</span>
      </div>
    </figure>
    <small v-if="isRemote" class="comment-attribution__hint comment-attribution__hint--warn">
      Desktop only — change this on the machine that runs strIDEterm.
    </small>
    <small
      v-else
      class="comment-attribution__status"
      :class="{ 'comment-attribution__status--failed': status === 'failed' }"
      role="status"
    >
      {{ status === "saved" ? "Saved" : status === "failed" ? "Not saved" : "" }}
    </small>
  </section>
</template>

<script setup lang="ts">
import { computed, inject, reactive, ref, watch } from "vue";
import { apiKey } from "../../../types/keys.js";
import { useNotificationStore } from "../../../stores/notifications.js";
import type { Transport } from "../../../transport.js";
import {
  DEFAULT_JIRA_COMMENT_ATTRIBUTION,
  applyJiraCommentAttribution,
  type JiraCommentAttribution,
} from "../../../../electron/shared/jira-comment-attribution.js";

interface ConnectionLike {
  accountPurpose?: string;
  ownIdentity?: { displayName?: string };
  verifiedIdentity?: { displayName?: string };
}

const props = defineProps<{ value?: Partial<JiraCommentAttribution>; connections?: ConnectionLike[] }>();
const api = inject<Transport>(apiKey);
const POSITIONS = [
  { value: "before", label: "Before the comment" },
  { value: "after", label: "After the comment" },
] as const;

const isRemote = computed(() => Boolean(api?.isRemote));
const draft = reactive<JiraCommentAttribution>({ ...DEFAULT_JIRA_COMMENT_ATTRIBUTION });
const busy = ref(false);
const positionLocked = computed(() => isRemote.value || busy.value || !draft.enabled);
const status = ref<"" | "saved" | "failed">("");

function syncFromProps() {
  const next = { ...DEFAULT_JIRA_COMMENT_ATTRIBUTION, ...(props.value || {}) };
  draft.enabled = next.enabled;
  draft.text = next.text;
  draft.position = next.position;
}
syncFromProps();
watch(() => props.value, syncFromProps, { deep: true });

const SAMPLE_COMMENT = "Deployment completed.";
const example = computed(() => {
  const connections = props.connections || [];
  const user = connections.find((item) => item.ownIdentity?.displayName)?.ownIdentity?.displayName || "Alex";
  const account =
    connections.find((item) => item.accountPurpose === "technical" && item.verifiedIdentity?.displayName)
      ?.verifiedIdentity?.displayName || "Jira Bot";
  const text = applyJiraCommentAttribution(SAMPLE_COMMENT, draft.enabled ? draft : undefined, { user, account });
  return text === SAMPLE_COMMENT ? "" : text;
});
// The sample comment reads as the comment; everything else is what the attribution adds.
const exampleLines = computed(() => {
  const at = example.value.indexOf(SAMPLE_COMMENT);
  if (at < 0) return [{ text: example.value, added: true }];
  return [
    { text: example.value.slice(0, at), added: true },
    { text: SAMPLE_COMMENT, added: false },
    { text: example.value.slice(at + SAMPLE_COMMENT.length), added: true },
  ].filter((line) => line.text);
});

async function save() {
  if (isRemote.value || !api?.setJiraCommentAttribution || busy.value) return;
  busy.value = true;
  status.value = "";
  try {
    await api.setJiraCommentAttribution({ enabled: draft.enabled, text: draft.text, position: draft.position });
    status.value = "saved";
  } catch (error) {
    status.value = "failed";
    syncFromProps();
    useNotificationStore().showError("Failed to save the comment attribution", error);
  } finally {
    busy.value = false;
  }
}

async function onEnabledChange(event: Event) {
  draft.enabled = (event.target as HTMLInputElement).checked;
  await save();
}

async function setPosition(position: "before" | "after") {
  if (draft.position === position) return;
  draft.position = position;
  await save();
}
</script>

<style scoped>
.comment-attribution {
  display: grid;
  gap: 8px;
  margin-bottom: 20px;
  padding-bottom: 16px;
  border-bottom: 1px solid var(--border);
}
.comment-attribution__title {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
}
.comment-attribution__check {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  cursor: pointer;
}
.comment-attribution__check--disabled {
  cursor: not-allowed;
  opacity: 0.6;
}
.comment-attribution__check input[type="checkbox"] {
  width: auto;
  padding: 0;
  margin: 0;
  border: none;
  background: none;
  accent-color: var(--accent);
  flex-shrink: 0;
}
.comment-attribution__text {
  width: 100%;
  resize: vertical;
  font: inherit;
  font-size: 13px;
}
.comment-attribution__hint,
.comment-attribution__status {
  color: var(--muted);
  font-size: 12px;
  line-height: 1.4;
}
.comment-attribution__hint--warn {
  color: var(--warning, var(--muted));
}
.comment-attribution__status {
  min-height: 1.4em;
}
.comment-attribution__status--failed {
  color: var(--danger, var(--text));
}
.comment-attribution__position {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 16px;
  margin: 0;
  padding: 0;
  border: 0;
  font-size: 13px;
}
.comment-attribution__position legend {
  float: left;
  margin-right: 4px;
  padding: 0;
  color: var(--muted);
  font-size: 12px;
}
.comment-attribution__position--disabled {
  opacity: 0.6;
}
.comment-attribution__radio {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
}
.comment-attribution__position--disabled .comment-attribution__radio {
  cursor: not-allowed;
}
.comment-attribution__radio input[type="radio"] {
  width: auto;
  margin: 0;
  padding: 0;
  accent-color: var(--accent);
}
.comment-attribution__preview {
  display: grid;
  gap: 4px;
  margin: 0;
}
.comment-attribution__preview figcaption {
  color: var(--muted);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
.comment-attribution__preview-body {
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-left: 3px solid var(--accent);
  border-radius: 6px;
  background: var(--surface-card, rgba(var(--tint), 0.04));
  color: var(--text);
  font-size: 13px;
  line-height: 1.5;
  white-space: pre-wrap;
}
.comment-attribution__preview-added {
  color: var(--muted);
  font-style: italic;
}
</style>
