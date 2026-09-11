<template>
  <div ref="rootRef" class="git-split-button" @keydown.esc="menuOpen = false">
    <button
      type="button"
      :data-testid="mainTestid"
      :class="['button', primary ? '' : 'button--ghost', busy && 'button--busy', 'git-split-button__main']"
      :disabled="disabled"
      :title="mainTitle"
      @click="emit('run')"
    >
      {{ mainLabel }}
    </button>
    <button
      type="button"
      :data-testid="caretTestid"
      :class="['button', primary ? '' : 'button--ghost', 'git-split-button__caret']"
      :disabled="disabled"
      aria-haspopup="menu"
      :aria-expanded="menuOpen ? 'true' : 'false'"
      :title="caretTitle"
      @click="menuOpen = !menuOpen"
    >
      ▾
    </button>
    <div v-if="menuOpen" class="git-split-button__menu" role="menu">
      <button
        v-for="option in options"
        :key="option.value"
        type="button"
        :data-testid="option.testid"
        class="git-split-button__option"
        role="menuitemradio"
        :aria-checked="strategy === option.value"
        :title="option.title"
        @click="select(option.value)"
      >
        <span class="git-split-button__check">{{ strategy === option.value ? "✓" : "" }}</span>
        {{ option.label }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * The rebase/merge split button, shared by the "Update Current Branch" card
 * (which targets the BASE branch) and the Git toolbar's Pull button (which
 * targets the UPSTREAM). Both name their ref in the labels, so the two are
 * distinguishable on screen even though the control looks the same.
 *
 * The caret only SELECTS — it emits `update:strategy`, relabels the main
 * button and closes. Running still takes a second click on the main button:
 * one deliberate step for a history-rewriting op. Extracted verbatim from
 * GitBranchTab.vue, testids included, so the card's existing tests keep
 * addressing the same elements.
 */
import { ref } from "vue";
import { useDismissable } from "../../../composables/useDismissable.js";
import type { StrategyOption, UpdateStrategy } from "./update-strategy.js";

const props = withDefaults(
  defineProps<{
    strategy: UpdateStrategy;
    mainLabel: string;
    mainTitle: string;
    options: StrategyOption[];
    mainTestid: string;
    caretTestid: string;
    disabled?: boolean;
    busy?: boolean;
    primary?: boolean;
    caretTitle?: string;
  }>(),
  {
    disabled: false,
    busy: false,
    primary: false,
    caretTitle: "Choose update strategy (rebase or merge)",
  },
);

const emit = defineEmits<{ run: []; "update:strategy": [UpdateStrategy] }>();

const menuOpen = ref(false);
const rootRef = ref<HTMLElement | null>(null);

function select(strategy: UpdateStrategy): void {
  if (strategy !== props.strategy) emit("update:strategy", strategy);
  menuOpen.value = false;
}

useDismissable(menuOpen, rootRef, {
  onDismiss: () => {
    menuOpen.value = false;
  },
  eventName: "mousedown",
  capture: true,
});
</script>
