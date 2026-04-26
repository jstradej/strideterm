<template>
  <div
    class="settings-check"
    title="When enabled, the Git tab shows all actions regardless of the current repository state (no context-based hiding). Useful for power users who prefer the raw unfiltered view."
  >
    <label class="settings-check__row">
      <input v-model="form.git.ui.showAllActions" type="checkbox" />
      <span>Show all actions</span>
    </label>
    <small class="settings-check__help">
      When off (default), actions that don't apply to the current state are hidden (e.g. Pull is hidden when there's no
      upstream, Push is hidden when in detached HEAD). Turn on to show all actions at all times — only structural
      impossibilities are still hidden (e.g. Push when there's no remote at all).
    </small>
  </div>
</template>

<script setup lang="ts">
import { inject } from "vue";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const form = inject<Record<string, any>>("settingsForm")!
</script>

<style scoped>
.settings-check__row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  cursor: pointer;
}

.settings-check__row input[type="checkbox"] {
  width: auto;
  padding: 0;
  border: none;
  background: none;
  accent-color: var(--accent);
  flex-shrink: 0;
  margin: 0;
}

.settings-check__row span {
  font-size: 13px;
  text-transform: none;
  letter-spacing: normal;
  color: var(--text);
}

.settings-check__help {
  display: block;
  margin-top: 4px;
  padding-left: 24px;
  color: var(--muted);
  font-size: 12px;
  line-height: 1.4;
}
</style>
