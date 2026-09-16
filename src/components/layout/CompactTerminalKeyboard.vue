<template>
  <div class="compact-terminal-keyboard" aria-label="Compact terminal keyboard">
    <div v-for="(row, index) in rows" :key="index" class="compact-terminal-keyboard__row">
      <button v-for="key in row" :key="key" type="button" @pointerdown.prevent @click="type(key)">{{ key }}</button>
    </div>
    <div class="compact-terminal-keyboard__row">
      <button type="button" :aria-pressed="shift" aria-label="Shift" @pointerdown.prevent @click="shift = !shift">
        ⇧
      </button>
      <button type="button" :aria-pressed="symbols" @pointerdown.prevent @click="symbols = !symbols">
        {{ symbols ? "ABC" : "123" }}
      </button>
      <button
        type="button"
        class="compact-terminal-keyboard__space"
        aria-label="Space"
        @pointerdown.prevent
        @click="$emit('insert', ' ')"
      >
        space
      </button>
      <button type="button" aria-label="Backspace" @pointerdown.prevent @click="$emit('backspace')">⌫</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
const emit = defineEmits<{ insert: [text: string]; backspace: [] }>();
const shift = ref(false);
const symbols = ref(false);
const rows = computed(() => {
  const letters = ["qwertyuiop", "asdfghjkl", "zxcvbnm"];
  const digits = ["1234567890", '-/:;()$&@"', "_.,?!'=[]\\"];
  const extra = ["!@#$%^&*()", "_+{}<>|~`", ":;.,?/=-"];
  return (symbols.value ? (shift.value ? extra : digits) : letters).map((row) =>
    Array.from(!symbols.value && shift.value ? row.toUpperCase() : row),
  );
});
function type(key: string) {
  emit("insert", key);
  shift.value = false;
}
</script>
