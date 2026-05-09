<template>
  <!-- Tiny preview swatch of a workspace-grid / tab-split arrangement.
       Drawn once here so LayoutPicker (popover) and WorkspaceLayoutChip
       (hero strip) share the same shape vocabulary — duplicating the
       inline SVG in two places drifted in size and corner radius and made
       it harder to add a new layout key in one place. The viewBox is
       drawn at 40×30; CSS sizes the rendered <svg> via the consumer's
       class. -->
  <svg viewBox="0 0 40 30" :class="className" aria-hidden="true">
    <template v-if="layout === 'cols'">
      <rect x="1" y="1" width="18" height="28" rx="1.5" fill="currentColor" :opacity="primaryOpacity" />
      <rect x="21" y="1" width="18" height="28" rx="1.5" fill="currentColor" :opacity="secondaryOpacity" />
    </template>
    <template v-else-if="layout === 'rows'">
      <rect x="1" y="1" width="38" height="13" rx="1.5" fill="currentColor" :opacity="primaryOpacity" />
      <rect x="1" y="16" width="38" height="13" rx="1.5" fill="currentColor" :opacity="secondaryOpacity" />
    </template>
    <template v-else-if="layout === 'top-split'">
      <rect x="1" y="1" width="38" height="13" rx="1.5" fill="currentColor" :opacity="primaryOpacity" />
      <rect x="1" y="16" width="18" height="13" rx="1.5" fill="currentColor" :opacity="secondaryOpacity" />
      <rect x="21" y="16" width="18" height="13" rx="1.5" fill="currentColor" :opacity="secondaryOpacity" />
    </template>
    <template v-else-if="layout === 'left-split'">
      <rect x="1" y="1" width="18" height="28" rx="1.5" fill="currentColor" :opacity="primaryOpacity" />
      <rect x="21" y="1" width="18" height="13" rx="1.5" fill="currentColor" :opacity="secondaryOpacity" />
      <rect x="21" y="16" width="18" height="13" rx="1.5" fill="currentColor" :opacity="secondaryOpacity" />
    </template>
    <template v-else-if="layout === 'grid'">
      <rect x="1" y="1" width="18" height="13" rx="1.5" fill="currentColor" :opacity="primaryOpacity" />
      <rect x="21" y="1" width="18" height="13" rx="1.5" fill="currentColor" :opacity="secondaryOpacity" />
      <rect x="1" y="16" width="18" height="13" rx="1.5" fill="currentColor" :opacity="secondaryOpacity" />
      <rect x="21" y="16" width="18" height="13" rx="1.5" fill="currentColor" :opacity="secondaryOpacity" />
    </template>
    <template v-else>
      <rect x="1" y="1" width="38" height="28" rx="1.5" fill="currentColor" :opacity="primaryOpacity" />
    </template>
  </svg>
</template>

<script setup lang="ts">
withDefaults(
  defineProps<{
    layout: string;
    className?: string;
    /** Opacity of the "primary" (focused / first) cell. */
    primaryOpacity?: number;
    /** Opacity of the "secondary" cells. */
    secondaryOpacity?: number;
  }>(),
  {
    className: "layout-thumb",
    primaryOpacity: 0.5,
    secondaryOpacity: 0.3,
  },
);
</script>
