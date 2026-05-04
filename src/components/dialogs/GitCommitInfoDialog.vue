<template>
  <div class="dialog git-commit-dialog">
    <div class="dialog__header">
      <div>
        <p class="eyebrow">Git history</p>
        <h2>Commit details</h2>
      </div>
      <button type="button" class="button button--ghost" @click="emit('close')">Close</button>
    </div>

    <div class="git-commit-dialog__body">
      <!-- Loading state: show what we already have from the row, fetch rest -->
      <p v-if="loading && !info" class="git-commit-dialog__placeholder">Loading commit details…</p>

      <!-- Subject — pulled from snapshot when available so the dialog renders
           something useful even before the full message arrives. -->
      <header v-if="effective.subject" class="git-commit-dialog__subject">
        <h3>{{ effective.subject }}</h3>
      </header>

      <!-- Refs / decoration (e.g. HEAD -> main, origin/main, tag: v1.2) -->
      <div v-if="effective.refs" class="git-commit-dialog__refs">
        <span v-for="(ref, i) in refList" :key="i" class="workspace-chip">{{ ref }}</span>
      </div>

      <!-- Two-column metadata grid: copyable fields on the left, value
           on the right with a per-field copy button. -->
      <dl class="git-commit-dialog__meta">
        <template v-if="effective.hash || effective.shortHash">
          <dt>Hash</dt>
          <dd>
            <code class="git-commit-dialog__mono">{{ effective.hash || effective.shortHash }}</code>
            <button
              type="button"
              class="button button--ghost button--small"
              :title="copyState.hash ? 'Copied!' : 'Copy full hash'"
              @click="copyValue('hash', effective.hash || effective.shortHash)"
            >
              {{ copyState.hash ? "✓" : "📋" }}
            </button>
          </dd>
        </template>
        <template v-if="effective.shortHash && effective.hash && effective.shortHash !== effective.hash">
          <dt>Short</dt>
          <dd>
            <code class="git-commit-dialog__mono">{{ effective.shortHash }}</code>
            <button
              type="button"
              class="button button--ghost button--small"
              :title="copyState.short ? 'Copied!' : 'Copy short hash'"
              @click="copyValue('short', effective.shortHash)"
            >
              {{ copyState.short ? "✓" : "📋" }}
            </button>
          </dd>
        </template>
        <template v-if="effective.author">
          <dt>Author</dt>
          <dd>
            <span>{{ effective.author }}<span v-if="effective.authorEmail"> &lt;{{ effective.authorEmail }}&gt;</span></span>
          </dd>
        </template>
        <template v-if="effective.committer && effective.committer !== effective.author">
          <dt>Committer</dt>
          <dd>
            <span
              >{{ effective.committer
              }}<span v-if="effective.committerEmail"> &lt;{{ effective.committerEmail }}&gt;</span></span
            >
          </dd>
        </template>
        <template v-if="formattedDate">
          <dt>Date</dt>
          <dd>
            <span>{{ formattedDate }}</span>
            <span v-if="effective.relativeDate" class="git-commit-dialog__muted"
              >&nbsp;&middot;&nbsp;{{ effective.relativeDate }}</span
            >
          </dd>
        </template>
        <template v-if="parentHashes.length">
          <dt>Parents</dt>
          <dd>
            <code v-for="p in parentHashes" :key="p" class="git-commit-dialog__mono git-commit-dialog__parent"
              >{{ p }}</code
            >
          </dd>
        </template>
        <template v-if="effective.stat">
          <dt>Stat</dt>
          <dd>{{ effective.stat }}</dd>
        </template>
      </dl>

      <!-- Full body: the whole point of this dialog. Renders in a real
           scrollable textarea so the user can select / copy a long commit
           message rather than fight with the truncated tooltip. -->
      <section class="git-commit-dialog__message">
        <div class="git-commit-dialog__message-head">
          <p class="eyebrow" style="margin: 0">Commit message</p>
          <button
            type="button"
            class="button button--ghost button--small"
            :title="copyState.message ? 'Copied!' : 'Copy full commit message'"
            @click="copyValue('message', fullMessageText)"
          >
            {{ copyState.message ? "✓ Copied" : "📋 Copy message" }}
          </button>
        </div>
        <pre class="git-commit-dialog__body-text">{{ fullMessageText }}</pre>
      </section>

      <p v-if="error" class="git-commit-dialog__error">{{ error }}</p>
    </div>

    <footer class="dialog__footer">
      <button type="button" class="button" @click="emit('close')">Done</button>
    </footer>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import { useAppStore } from "../../stores/app.js";

interface CommitSeed {
  shortHash?: string;
  hash?: string;
  subject?: string;
  author?: string;
  authorEmail?: string;
  authorDate?: string;
  committer?: string;
  committerEmail?: string;
  committerDate?: string;
  relativeDate?: string;
  refs?: string;
  body?: string;
  parents?: string;
  stat?: string;
}

interface Props {
  /** Workspace id used to resolve the git repo (for IPC). */
  workspaceId?: string;
  /** Specific git root path (multi-root workspaces). */
  rootPath?: string;
  /** The commit this dialog represents. Required to fetch full details. */
  hash: string;
  /** Optional pre-known fields from the row click — used as fallback while
   *  the full info loads, and as the final value if IPC fails. */
  seed?: CommitSeed;
  /** Optional callback so the parent can clean up (closeDialog) when the
   *  user dismisses via Esc / backdrop. */
  onClose?: () => void;
}

const props = withDefaults(defineProps<Props>(), {
  workspaceId: "",
  rootPath: "",
  seed: () => ({}),
  onClose: undefined,
});

const emit = defineEmits<{ close: [] }>();

const appStore = useAppStore();
const info = ref<CommitSeed | null>(null);
const loading = ref(false);
const error = ref("");
const copyState = reactive<Record<string, boolean>>({});

const effective = computed<CommitSeed>(() => ({ ...props.seed, ...(info.value || {}) }));

const refList = computed(() => {
  const refs = (effective.value.refs || "").trim();
  if (!refs) return [];
  return refs
    .split(/[\s,]+/)
    .map((r) => r.replace(/^\(|\)$/g, "").trim())
    .filter(Boolean);
});

const parentHashes = computed(() => {
  const parents = (effective.value.parents || "").trim();
  if (!parents) return [];
  return parents.split(/\s+/).filter(Boolean);
});

const fullMessageText = computed(() => {
  const subject = (effective.value.subject || "").trim();
  const body = (effective.value.body || "").trim();
  if (subject && body) {
    // The body returned by `git show --format=%B` may already start with the
    // subject (depending on git version) — strip the leading duplicate so
    // the user doesn't see the subject twice.
    if (body.startsWith(subject)) {
      const remainder = body.slice(subject.length).replace(/^\n+/, "");
      return remainder ? `${subject}\n\n${remainder}` : subject;
    }
    return `${subject}\n\n${body}`;
  }
  return body || subject || "(no commit message)";
});

const formattedDate = computed(() => {
  const iso = effective.value.committerDate || effective.value.authorDate || "";
  if (!iso) return "";
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString();
  } catch {
    return iso;
  }
});

async function fetchDetails() {
  if (!props.hash) return;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const api = appStore.getApi() as any;
  if (!api?.gitCommitInfo) return;
  loading.value = true;
  try {
    const result = await api.gitCommitInfo({
      workspaceId: props.workspaceId,
      rootPath: props.rootPath,
      hash: props.hash,
    });
    if (result && result.ok !== false) {
      info.value = result;
    } else if (result?.error) {
      error.value = result.error;
    }
  } catch (err) {
    error.value = (err as Error)?.message || "Failed to load commit info.";
  } finally {
    loading.value = false;
  }
}

async function copyValue(key: string, value: string | undefined) {
  if (!value) return;
  try {
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(String(value));
    } else {
      // Fallback for older / restricted contexts (no Clipboard API)
      const ta = document.createElement("textarea");
      ta.value = String(value);
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    copyState[key] = true;
    setTimeout(() => {
      copyState[key] = false;
    }, 1500);
  } catch {
    // Silent — copy is a nice-to-have. The text is selectable in the
    // pre/code blocks regardless.
  }
}

onMounted(fetchDetails);
</script>

<style scoped>
.git-commit-dialog {
  width: min(720px, 100%);
  max-height: min(90vh, 720px);
  display: flex;
  flex-direction: column;
}

.git-commit-dialog__body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 4px 0 8px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.git-commit-dialog__placeholder {
  color: var(--muted);
  font-style: italic;
  margin: 12px 0;
}

.git-commit-dialog__subject {
  border: 1px solid var(--border);
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.03);
  padding: 10px 12px;
}

.git-commit-dialog__subject h3 {
  margin: 0;
  font-size: 14px;
  line-height: 1.4;
  word-break: break-word;
  white-space: pre-wrap;
}

.git-commit-dialog__refs {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.git-commit-dialog__meta {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 6px 12px;
  font-size: 12px;
  margin: 0;
}

.git-commit-dialog__meta dt {
  font-weight: 600;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  font-size: 10px;
  align-self: center;
}

.git-commit-dialog__meta dd {
  margin: 0;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  word-break: break-word;
  min-width: 0;
}

.git-commit-dialog__mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  background: rgba(255, 255, 255, 0.05);
  padding: 1px 6px;
  border-radius: 3px;
}

.git-commit-dialog__parent {
  margin-right: 4px;
}

.git-commit-dialog__muted {
  color: var(--muted);
}

.git-commit-dialog__message {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-height: 0;
}

.git-commit-dialog__message-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.git-commit-dialog__body-text {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12.5px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 10px 12px;
  margin: 0;
  max-height: 360px;
  overflow: auto;
  user-select: text;
}

.git-commit-dialog__error {
  color: var(--danger, #e53935);
  font-size: 12px;
  margin: 0;
}

@media (max-width: 540px) {
  .git-commit-dialog__meta {
    grid-template-columns: 1fr;
    gap: 2px 0;
  }
  .git-commit-dialog__meta dt {
    margin-top: 6px;
  }
  .git-commit-dialog__body-text {
    max-height: 240px;
  }
}
</style>
