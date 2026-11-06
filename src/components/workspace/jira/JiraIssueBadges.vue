<template>
  <span class="jira-badges" :class="{ 'jira-badges--compact': compact, 'jira-badges--minimal': minimal }">
    <span
      v-if="only !== 'priority'"
      class="jira-badge jira-badge--type"
      :class="`jira-badge--${kind}`"
      :title="`Issue type: ${issueType}`"
      :aria-label="`Issue type: ${issueType}`"
    >
      <svg class="jira-badge__icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <template v-if="kind === 'bug'">
          <path d="M6 4.2 4.8 2.8M10 4.2l1.2-1.4M3 6h10M2.5 9h11M4 12h8M4 5.3h8v5.1a4 4 0 0 1-8 0z" />
        </template>
        <template v-else-if="kind === 'story'">
          <path d="M4 2.5h8v11l-4-2.5-4 2.5z" />
        </template>
        <template v-else-if="kind === 'subtask'">
          <path d="M3 3h4v4H3zM9 9h4v4H9zM7 5h2a2 2 0 0 1 2 2v2" />
        </template>
        <template v-else-if="kind === 'task'">
          <path d="M3 3h10v10H3zM5 8l2 2 4-4" />
        </template>
        <template v-else-if="kind === 'epic'">
          <path d="M9 2 4 9h4l-1 5 5-7H8z" />
        </template>
        <template v-else>
          <circle cx="8" cy="8" r="5" />
          <path d="M8 7v3M8 5.2h.01" />
        </template>
      </svg>
      <span v-if="!minimal">{{ issueType }}</span>
    </span>
    <span
      v-if="only !== 'type'"
      class="jira-badge jira-badge--priority"
      :class="priorityClass"
      :title="`Priority: ${priority}`"
      :aria-label="`Priority: ${priority}`"
    >
      <svg class="jira-badge__icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <template v-if="priorityLevel">
          <rect
            v-for="bar in 5"
            :key="bar"
            class="jira-badge__bar"
            :class="{ 'jira-badge__bar--off': bar > priorityLevel }"
            :x="bar * 2.8 - 2"
            :y="14 - (1.6 + bar * 2.2)"
            width="2"
            :height="1.6 + bar * 2.2"
            rx="0.6"
          />
        </template>
        <path v-else d="M3 13V3m0 1h8l-2 2 2 2H3" />
      </svg>
      <span class="jira-badge__label">{{ priority }}</span>
    </span>
  </span>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { classifyJiraIssueType, jiraPriorityLevel } from "./jiraIssueBadges";

const props = withDefaults(
  defineProps<{
    issueType?: string;
    priority?: string;
    compact?: boolean;
    minimal?: boolean;
    only?: "type" | "priority";
  }>(),
  { issueType: "Unknown type", priority: "Unspecified", compact: false, minimal: false, only: undefined },
);

const kind = computed(() => classifyJiraIssueType(props.issueType));
/** Signal-strength bars, one per Jira priority step: five for the highest, one for the lowest. */
const priorityLevel = computed(() => jiraPriorityLevel(props.priority) ?? 0);
const PRIORITY_CLASSES = ["unknown", "lowest", "low", "medium", "high", "highest"];
const priorityClass = computed(() => `jira-badge--${PRIORITY_CLASSES[priorityLevel.value]}`);
</script>

<style scoped>
.jira-badges {
  display: inline-flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 5px;
  min-width: 0;
}

.jira-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  max-width: 100%;
  min-height: 22px;
  padding: 2px 8px;
  border: 1px solid color-mix(in srgb, currentColor 38%, transparent);
  border-radius: 6px;
  font-size: var(--font-size-caption);
  font-weight: 650;
  line-height: 1.2;
  white-space: nowrap;
}

.jira-badge__icon {
  width: 12px;
  height: 12px;
  flex: 0 0 auto;
  fill: none;
  stroke: currentColor;
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-width: 1.6;
}

.jira-badge__bar {
  fill: currentColor;
  stroke: none;
}
.jira-badge__bar--off {
  opacity: 0.28;
}

.jira-badge--bug {
  color: color-mix(in srgb, var(--status-failed) 70%, var(--text) 30%);
  background: color-mix(in srgb, var(--status-failed) 15%, transparent);
}
.jira-badge--story {
  color: color-mix(in srgb, var(--status-success) 70%, var(--text) 30%);
  background: color-mix(in srgb, var(--status-success) 15%, transparent);
}
.jira-badge--task {
  color: color-mix(in srgb, var(--status-review) 70%, var(--text) 30%);
  background: color-mix(in srgb, var(--status-review) 15%, transparent);
}
.jira-badge--subtask {
  color: color-mix(in srgb, var(--status-paused) 70%, var(--text) 30%);
  background: color-mix(in srgb, var(--status-paused) 15%, transparent);
}
.jira-badge--epic {
  color: color-mix(in srgb, var(--status-merged) 70%, var(--text) 30%);
  background: color-mix(in srgb, var(--status-merged) 15%, transparent);
}
.jira-badge--unknown {
  color: var(--muted);
  background: color-mix(in srgb, var(--muted) 12%, transparent);
}
.jira-badge--highest {
  color: color-mix(in srgb, var(--status-failed) 70%, var(--text) 30%);
  background: color-mix(in srgb, var(--status-failed) 18%, transparent);
}
.jira-badge--high {
  color: color-mix(in srgb, var(--status-running) 70%, var(--text) 30%);
  background: color-mix(in srgb, var(--status-running) 15%, transparent);
}
.jira-badge--medium {
  color: color-mix(in srgb, var(--status-paused) 70%, var(--text) 30%);
  background: color-mix(in srgb, var(--status-paused) 14%, transparent);
}
.jira-badge--low {
  color: color-mix(in srgb, var(--status-review) 70%, var(--text) 30%);
  background: color-mix(in srgb, var(--status-review) 15%, transparent);
}
.jira-badge--lowest {
  color: color-mix(in srgb, var(--status-muted) 70%, var(--text) 30%);
  background: color-mix(in srgb, var(--status-muted) 15%, transparent);
}
.jira-badge__label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.jira-badges--compact {
  gap: 3px;
}
.jira-badges--compact .jira-badge {
  min-height: 19px;
  padding: 1px 6px;
  font-size: var(--font-size-caption);
}

.jira-badges--minimal {
  gap: 4px;
  flex-wrap: nowrap;
}
.jira-badges--minimal .jira-badge {
  min-height: 20px;
  padding: 1px 5px;
  border-radius: 5px;
  font-size: var(--font-size-caption);
}
.jira-badges--minimal .jira-badge--type {
  width: 20px;
  padding: 0;
  justify-content: center;
}
.jira-badges--minimal .jira-badge__icon {
  width: 13px;
  height: 13px;
}
</style>
