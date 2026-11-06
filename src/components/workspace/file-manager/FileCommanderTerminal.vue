<template>
  <section class="fct">
    <div class="fct__title">
      <div class="fct__tabs" role="tablist" aria-label="Terminals">
        <div
          v-for="tab in tabs"
          :key="tab.id"
          class="fct__tab"
          :class="{ 'fct__tab--active': tab.id === selectedId }"
          :title="tab.cwd || tab.title"
          @mousedown.middle.prevent
          @auxclick.middle.prevent="$emit('close', tab.id)"
        >
          <button
            type="button"
            class="fct__tab-label"
            role="tab"
            :aria-selected="tab.id === selectedId"
            @click="$emit('select', tab.id)"
          >
            {{ tab.title }}
          </button>
          <button
            type="button"
            class="fct__btn fct__btn--close"
            :aria-label="`Close ${tab.title}`"
            title="Close this terminal (Ctrl+O hides the area)"
            @click="$emit('close', tab.id)"
          >
            ×
          </button>
        </div>
      </div>
      <button
        type="button"
        class="fct__btn"
        aria-label="Move to a tab"
        title="Move the selected terminal to a tab"
        @click="$emit('move-to-tab')"
      >
        ⧉
      </button>
    </div>
    <div class="fct__body">
      <TerminalPane :session-id="sessionId" />
    </div>
  </section>
</template>

<script setup lang="ts">
import TerminalPane from "../TerminalPane.vue";

defineProps<{ sessionId: string; tabs: { id: string; title: string; cwd?: string }[]; selectedId: string }>();
defineEmits<{ (e: "select", id: string): void; (e: "close", id: string): void; (e: "move-to-tab"): void }>();
</script>

<style scoped>
.fct {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-width: 0;
  background: var(--surface-term);
  color: var(--text);
  font-size: 12px;
}

.fct__title {
  display: flex;
  flex: 0 0 auto;
  align-items: stretch;
  gap: 4px;
  padding: 0 4px 0 0;
  background: var(--base-fill);
  box-shadow: inset 0 -1px 0 var(--tab-line);
  color: var(--muted);
}

.fct__tabs {
  display: flex;
  flex: 1 1 auto;
  min-width: 0;
  overflow-x: auto;
  scrollbar-width: none;
}

.fct__tabs::-webkit-scrollbar {
  display: none;
}

.fct__tab {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  position: relative;
  max-width: 200px;
  padding: 3px 2px 3px;
  border-top: 1px solid transparent;
  border-right: 1px solid rgba(var(--tint), 0.08);
  background: transparent;
  color: var(--muted);
}

.fct__tab:hover {
  background: rgba(var(--tint), 0.05);
  color: var(--text);
}

.fct__tab--active,
.fct__tab--active:hover {
  z-index: 1;
  border-top-color: var(--accent);
  border-right-color: var(--tab-line);
  background: var(--surface-term);
  box-shadow: -1px 0 0 var(--tab-line);
  color: var(--text);
}

.fct__tab--active:first-child {
  box-shadow: none;
}

.fct__tab:not(.fct__tab--active) .fct__btn--close {
  opacity: 0;
}

.fct__tab:hover .fct__btn--close,
.fct__tab .fct__btn--close:focus-visible {
  opacity: 1;
}

.fct__tab-label {
  min-width: 0;
  padding: 0 4px 0 8px;
  overflow: hidden;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  line-height: 22px;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
}

.fct__btn {
  flex: 0 0 auto;
  align-self: center;
  min-width: 22px;
  padding: 0 6px;
  border: 0;
  border-radius: 3px;
  background: transparent;
  color: inherit;
  font-size: 14px;
  line-height: 18px;
  cursor: pointer;
}

.fct__btn--close {
  font-size: 15px;
}

.fct__tab .fct__btn {
  min-width: 18px;
  padding: 0 4px;
}

.fct__btn:hover {
  background: var(--border);
  color: var(--text);
}

.fct__body {
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden;
}

.fct__body,
.fct__body :deep(.terminal-host) {
  background: var(--surface-term);
}

.fct__body > :deep(.workspace-pane__body--terminal) {
  height: 100%;
}

@media (pointer: coarse) {
  .fct__tab:not(.fct__tab--active) .fct__btn--close {
    opacity: 1;
  }

  .fct__btn {
    min-width: 36px;
    min-height: 32px;
  }

  .fct__tab-label {
    min-height: 32px;
  }
}
</style>
