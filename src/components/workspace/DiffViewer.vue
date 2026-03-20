<template>
  <pre class="git-output git-output--preview"><template v-for="(line, index) in lines" :key="index"><template v-if="index > 0">
</template><span v-if="isMeta(line)" class="diff-meta">{{ line }}</span><span v-else-if="isHunk(line)" class="diff-hunk">{{ line }}</span><span v-else-if="isAdd(line)" class="diff-add">{{ line }}</span><span v-else-if="isDel(line)" class="diff-del">{{ line }}</span><template v-else>{{ line }}</template></template></pre>
</template>

<script setup>
import { computed } from "vue";

const props = defineProps({
  diff: { type: String, default: "" },
});

const lines = computed(() => (props.diff || "").split("\n"));

function isMeta(line) {
  return line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff ")
    || line.startsWith("index ") || line.startsWith("new ") || line.startsWith("deleted ")
    || line.startsWith("similarity ") || line.startsWith("rename ");
}
function isHunk(line) { return line.startsWith("@@"); }
function isAdd(line) { return line.startsWith("+"); }
function isDel(line) { return line.startsWith("-"); }
</script>
