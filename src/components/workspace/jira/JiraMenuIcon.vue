<template>
  <svg class="jira-menu__icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path v-for="d in ICON_PATHS[name]" :key="d" :d="d" />
  </svg>
</template>

<script setup lang="ts">
type JiraMenuIconName =
  | "copy"
  | "link"
  | "attachment"
  | "workspace"
  | "web-link"
  | "clock"
  | "user"
  | "user-remove"
  | "code"
  | "tab"
  | "branch";

defineProps<{ name: JiraMenuIconName }>();

const ICON_PATHS: Record<JiraMenuIconName, string[]> = {
  copy: ["M11 9h7a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-7a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2z", "M5 15V6a2 2 0 0 1 2-2h8"],
  link: [
    "M10 13.5a4 4 0 0 0 5.7.3l3-3a4 4 0 0 0-5.7-5.7l-1.6 1.6",
    "M14 10.5a4 4 0 0 0-5.7-.3l-3 3a4 4 0 0 0 5.7 5.7l1.6-1.6",
  ],
  attachment: [
    "M20 11.5l-7.8 7.8a5 5 0 0 1-7.1-7.1l8.2-8.2a3.3 3.3 0 0 1 4.7 4.7l-8.2 8.2a1.7 1.7 0 0 1-2.4-2.4l7.4-7.4",
  ],
  workspace: ["M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"],
  "web-link": ["M14 4h6v6", "M20 4l-9 9", "M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"],
  clock: ["M3.5 12a8.5 8.5 0 1 0 17 0a8.5 8.5 0 1 0-17 0", "M12 7.5V12l3 2"],
  user: ["M8.5 8a3.5 3.5 0 1 0 7 0a3.5 3.5 0 1 0-7 0", "M5 20a7 7 0 0 1 14 0"],
  "user-remove": ["M6.5 8a3.5 3.5 0 1 0 7 0a3.5 3.5 0 1 0-7 0", "M3.5 20a6.5 6.5 0 0 1 13 0", "M16 11h5"],
  code: ["M8 7l-5 5 5 5", "M16 7l5 5-5 5"],
  branch: [
    "M4 18a2 2 0 1 0 4 0a2 2 0 1 0-4 0",
    "M4 6a2 2 0 1 0 4 0a2 2 0 1 0-4 0",
    "M16 6a2 2 0 1 0 4 0a2 2 0 1 0-4 0",
    "M6 8v8",
    "M18 8a6 6 0 0 1-6 6H8",
  ],
  tab: [
    "M5 5h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z",
    "M3 9h18",
    "M12 12v5",
    "M9.5 14.5h5",
  ],
};
</script>
