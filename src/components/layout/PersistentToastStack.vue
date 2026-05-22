<template>
  <div class="persistent-toast-stack" role="region" aria-label="Background errors">
    <TransitionGroup name="ptoast">
      <div
        v-for="t in notifStore.persistentToasts"
        :key="t.id"
        class="persistent-toast"
        :class="`persistent-toast--${t.kind}`"
      >
        <div class="persistent-toast__icon">{{ iconFor(t.kind) }}</div>
        <div class="persistent-toast__content">
          <strong class="persistent-toast__title">{{ t.title }}</strong>
          <p class="persistent-toast__body">{{ t.body }}</p>
          <p v-if="t.copyPath" class="persistent-toast__path" :title="t.copyPath">{{ t.copyPath }}</p>
          <div v-if="t.copyPath" class="persistent-toast__actions">
            <button type="button" class="persistent-toast__copy" :data-copied="copiedId === t.id" @click="copyPath(t)">
              {{ copiedId === t.id ? "Copied" : "Copy path" }}
            </button>
          </div>
        </div>
        <button
          type="button"
          class="persistent-toast__close"
          aria-label="Dismiss"
          @click="notifStore.dismissPersistentToast(t.id)"
        >
          &times;
        </button>
      </div>
    </TransitionGroup>
  </div>
</template>

<script setup lang="ts">
import { ref } from "vue";
import { useNotificationStore, type PersistentToast } from "../../stores/notifications.js";

const notifStore = useNotificationStore();
const copiedId = ref<string | null>(null);

function iconFor(kind: string): string {
  if (kind === "error") return "✕";
  if (kind === "warning") return "!";
  // Info is used for transient success confirmations (e.g. git action toasts) —
  // a checkmark reads as "done", which is what the user just did.
  return "✓";
}

async function copyPath(t: PersistentToast): Promise<void> {
  if (!t.copyPath) return;
  try {
    await navigator.clipboard.writeText(t.copyPath);
    copiedId.value = t.id;
    setTimeout(() => {
      if (copiedId.value === t.id) copiedId.value = null;
    }, 1500);
  } catch {
    // Clipboard may be blocked by the OS; fall back to a transient hint.
    copiedId.value = null;
  }
}
</script>

<style scoped>
.persistent-toast-stack {
  position: fixed;
  right: 16px;
  bottom: 16px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  z-index: 1100;
  pointer-events: none;
  max-width: min(420px, calc(100vw - 32px));
}

.persistent-toast {
  pointer-events: auto;
  display: grid;
  grid-template-columns: auto 1fr auto;
  align-items: center;
  gap: 10px;
  background: var(--surface, #1e2128);
  color: var(--text, #e8e8e8);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-left: 3px solid rgba(255, 255, 255, 0.25);
  border-radius: 6px;
  padding: 8px 10px 8px 11px;
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.35);
  font-size: 12.5px;
}

/* Error (default for pushPersistentToast) — loud, must be noticed. */
.persistent-toast--error {
  border-color: color-mix(in srgb, #ff5959 70%, transparent);
  border-left-color: #ff5959;
}

.persistent-toast--warning {
  border-color: color-mix(in srgb, #ffb43c 65%, transparent);
  border-left-color: #ffb43c;
}

/* Info — transient success confirmations (git toasts, etc.). Subtle, won't
   masquerade as a warning the way a red border did before. */
.persistent-toast--info {
  border-left-color: #7fbcec;
}

.persistent-toast__icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  font-size: 11px;
  font-weight: 700;
  line-height: 1;
  background: rgba(255, 255, 255, 0.06);
  color: rgba(255, 255, 255, 0.7);
}

.persistent-toast--error .persistent-toast__icon {
  background: rgba(255, 89, 89, 0.18);
  color: #ff8a8a;
}

.persistent-toast--warning .persistent-toast__icon {
  background: rgba(255, 180, 60, 0.18);
  color: #ffc870;
}

.persistent-toast--info .persistent-toast__icon {
  background: rgba(127, 188, 236, 0.18);
  color: #9ecdf3;
}

.persistent-toast__title {
  display: block;
  font-weight: 600;
  margin-bottom: 2px;
}

.persistent-toast__body {
  margin: 0;
  white-space: pre-wrap;
  line-height: 1.4;
  color: var(--text-muted, #c2c2c2);
}

.persistent-toast__path {
  margin: 6px 0 0;
  padding: 4px 6px;
  font-family: var(--font-mono, ui-monospace, "Cascadia Code", Consolas, monospace);
  font-size: 11.5px;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 4px;
  word-break: break-all;
}

.persistent-toast__actions {
  margin-top: 8px;
  display: flex;
  gap: 6px;
}

.persistent-toast__copy {
  background: transparent;
  border: 1px solid rgba(255, 255, 255, 0.18);
  color: inherit;
  border-radius: 4px;
  padding: 4px 10px;
  font-size: 12px;
  cursor: pointer;
  transition: background 0.1s;
}

.persistent-toast__copy:hover {
  background: rgba(255, 255, 255, 0.06);
}

.persistent-toast__copy[data-copied="true"] {
  background: rgba(80, 200, 120, 0.18);
  border-color: rgba(80, 200, 120, 0.4);
}

.persistent-toast__close {
  background: transparent;
  border: 0;
  color: inherit;
  font-size: 18px;
  line-height: 1;
  cursor: pointer;
  padding: 2px 4px;
  align-self: flex-start;
  opacity: 0.7;
}

.persistent-toast__close:hover {
  opacity: 1;
}

.ptoast-enter-active,
.ptoast-leave-active {
  transition:
    opacity 0.18s ease,
    transform 0.18s ease;
}

.ptoast-enter-from,
.ptoast-leave-to {
  opacity: 0;
  transform: translateY(8px);
}
</style>
