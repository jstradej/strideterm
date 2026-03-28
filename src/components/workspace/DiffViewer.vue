<template>
  <pre
    class="git-output git-output--preview"
  ><template v-for="(line, index) in visibleLines" :key="index"><template v-if="index > 0">
</template><span v-if="isMeta(line)" class="diff-meta">{{ line }}</span><span v-else-if="isHunk(line)" class="diff-hunk">{{ line }}</span><span v-else-if="isAdd(line)" class="diff-add">{{ line }}</span><span v-else-if="isDel(line)" class="diff-del">{{ line }}</span><template v-else>{{ line }}</template></template><template v-if="isTruncated">
<span class="diff-meta">… {{ lines.length - MAX_LINES }} more lines ({{ lines.length }} total)</span></template></pre>
  <button
    v-if="isTruncated && !showAll"
    type="button"
    class="button button--ghost"
    style="margin: 6px 0; font-size: 12px"
    @click="showAll = true"
  >
    Show all {{ lines.length }} lines
  </button>
</template>

<script setup>
import { computed, ref, watch } from "vue";

const MAX_LINES = 800;

const props = defineProps({
  diff: { type: String, default: "" },
});

const showAll = ref(false);
// Reset expansion when a different diff is loaded
watch(
  () => props.diff,
  () => {
    showAll.value = false;
  },
);
const lines = computed(() => (props.diff || "").split("\n"));
const isTruncated = computed(() => !showAll.value && lines.value.length > MAX_LINES);
const visibleLines = computed(() => (isTruncated.value ? lines.value.slice(0, MAX_LINES) : lines.value));

function isMeta(line) {
  return (
    line.startsWith("+++") ||
    line.startsWith("---") ||
    line.startsWith("diff ") ||
    line.startsWith("index ") ||
    line.startsWith("new ") ||
    line.startsWith("deleted ") ||
    line.startsWith("similarity ") ||
    line.startsWith("rename ")
  );
}
function isHunk(line) {
  return line.startsWith("@@");
}
function isAdd(line) {
  return line.startsWith("+");
}
function isDel(line) {
  return line.startsWith("-");
}
</script>
