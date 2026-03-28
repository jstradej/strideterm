<template>
  <div class="markdown-content" v-html="rendered"></div>
</template>

<script setup>
import { computed } from "vue";

const props = defineProps({
  text: { type: String, default: "" },
});

function escapeHtml(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function renderMarkdownToHtml(text = "") {
  let out = escapeHtml(text);
  // Code blocks: ```...```
  out = out.replace(/```([\s\S]*?)```/g, "<pre><code>$1</code></pre>");
  // Inline code: `...`
  out = out.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  // Bold: **...**
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  // Italic: *...*
  out = out.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "<em>$1</em>");
  // Bullet lists: lines starting with - (after a newline or at start)
  out = out.replace(/(^|\n)- (.+)/g, "$1<li>$2</li>");
  out = out.replace(/(<li>.*<\/li>\n?)+/g, "<ul>$&</ul>");
  // Line breaks (but not inside pre blocks)
  out = out.replace(/\n/g, "<br>");
  // Clean up extra <br> inside pre
  out = out.replace(
    /<pre><code>([\s\S]*?)<\/code><\/pre>/g,
    (_, code) => `<pre><code>${code.replace(/<br>/g, "\n")}</code></pre>`,
  );
  return out;
}

const rendered = computed(() => renderMarkdownToHtml(props.text));
</script>

<style scoped>
.markdown-content {
  white-space: normal;
  word-wrap: break-word;
  line-height: 1.5;
  font-size: 13px;
}

.markdown-content :deep(pre) {
  background: rgba(0, 0, 0, 0.25);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 8px 10px;
  overflow-x: auto;
  font-size: 12px;
  margin: 6px 0;
}

.markdown-content :deep(code) {
  background: rgba(255, 255, 255, 0.08);
  border-radius: 3px;
  padding: 1px 4px;
  font-size: 0.9em;
}

.markdown-content :deep(pre code) {
  background: none;
  padding: 0;
  font-size: inherit;
}

.markdown-content :deep(strong) {
  color: var(--text);
}

.markdown-content :deep(ul) {
  padding-left: 20px;
  margin: 4px 0;
}

.markdown-content :deep(li) {
  margin: 2px 0;
}
</style>
