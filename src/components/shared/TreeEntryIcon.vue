<template>
  <span
    class="tree-entry-icon__chevron"
    :class="{
      'tree-entry-icon__chevron--expanded': kind === 'directory' && expanded,
      'tree-entry-icon__chevron--leaf': kind !== 'directory',
    }"
    aria-hidden="true"
  >
    <svg v-if="kind === 'directory'" viewBox="0 0 12 12">
      <path d="m4 2.5 3.5 3.5L4 9.5" />
    </svg>
  </span>
  <slot />
  <span
    v-if="kind === 'file' || showDirectoryIcon"
    class="tree-entry-icon__glyph"
    :class="`tree-entry-icon__glyph--${glyphKind}`"
    aria-hidden="true"
  >
    <svg v-if="kind === 'directory'" viewBox="0 0 18 16">
      <path d="M1.5 3.25h5l1.5 1.5h8.5v8.75H1.5z" />
      <path d="M1.5 4.75V2.5h5l1.5 1.5" />
    </svg>
    <svg v-else-if="extension === 'html'" viewBox="0 0 16 16">
      <path d="m5.5 4-3 4 3 4M10.5 4l3 4-3 4" />
    </svg>
    <svg v-else-if="['css', 'scss'].includes(extension)" viewBox="0 0 16 16">
      <path d="M8 2.25 13 5v6l-5 2.75L3 11V5z" />
      <path d="M6 6.25h4M6 8h4M6 9.75h2.5" />
    </svg>
    <svg v-else-if="fileGlyph === 'file'" viewBox="0 0 16 16">
      <path d="M4 1.75h5l3 3v9.5H4z" />
      <path d="M9 1.75v3h3" />
    </svg>
    <template v-else>{{ fileGlyph }}</template>
  </span>
</template>

<script setup lang="ts">
import { computed } from "vue";

const props = withDefaults(
  defineProps<{
    kind: "directory" | "file";
    expanded?: boolean;
    extension?: string;
    showDirectoryIcon?: boolean;
  }>(),
  { expanded: false, extension: "", showDirectoryIcon: true },
);

const extension = computed(() => props.extension.toLowerCase().replace(/^\./, ""));
const glyphKind = computed(() => (props.kind === "directory" ? "folder" : extension.value || "plain"));
const fileGlyph = computed(() => {
  if (["ts", "tsx", "js", "jsx", "mjs", "cjs", "vue"].includes(extension.value)) return "◈";
  if (["json", "yml", "yaml", "toml"].includes(extension.value)) return "{}";
  if (["md", "txt"].includes(extension.value)) return "≡";
  return "file";
});
</script>

<style scoped>
.tree-entry-icon__chevron {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 12px;
  height: 14px;
  color: var(--muted);
}

.tree-entry-icon__chevron svg {
  width: 11px;
  height: 11px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.4;
  stroke-linecap: round;
  stroke-linejoin: round;
  transition: transform 120ms ease;
}

.tree-entry-icon__chevron--expanded svg {
  transform: rotate(90deg);
}

.tree-entry-icon__glyph {
  display: inline-flex;
  justify-content: center;
  align-items: center;
  width: 14px;
  height: 16px;
  flex: 0 0 14px;
  font-size: 12px;
  line-height: 1;
  color: var(--muted);
}

.tree-entry-icon__glyph > svg {
  width: 14px;
  height: 14px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.35;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.tree-entry-icon__glyph--folder svg {
  width: 15px;
  height: 14px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.25;
  stroke-linejoin: round;
  stroke-linecap: round;
}

.tree-entry-icon__glyph--folder {
  color: #d3a95f;
  font-size: 17px;
}

.tree-entry-icon__glyph--ts,
.tree-entry-icon__glyph--tsx,
.tree-entry-icon__glyph--js,
.tree-entry-icon__glyph--mjs,
.tree-entry-icon__glyph--cjs,
.tree-entry-icon__glyph--jsx,
.tree-entry-icon__glyph--vue {
  color: #69a7dd;
}

.tree-entry-icon__glyph--json,
.tree-entry-icon__glyph--yml,
.tree-entry-icon__glyph--yaml,
.tree-entry-icon__glyph--toml {
  color: #d8a14b;
}

.tree-entry-icon__glyph--md,
.tree-entry-icon__glyph--txt {
  color: #8da4bd;
}

.tree-entry-icon__glyph--css,
.tree-entry-icon__glyph--scss,
.tree-entry-icon__glyph--html {
  color: #c87ac2;
}
</style>
