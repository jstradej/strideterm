<template>
  <span
    class="jira-person"
    :class="[`jira-person--${size}`, { 'jira-person--empty': !displayName, 'jira-person--me': me }]"
    :title="hideTitle ? undefined : title"
  >
    <span class="jira-person__avatar" :style="avatarStyle" aria-hidden="true">
      <svg v-if="!displayName" viewBox="0 0 16 16" focusable="false">
        <circle cx="8" cy="5.6" r="2.6" />
        <path d="M3.2 13.4a4.8 4.8 0 0 1 9.6 0" />
      </svg>
      <span v-else class="jira-person__initials">{{ initials }}</span>
    </span>
    <span v-if="showName" class="jira-person__text">
      <span class="jira-person__name">{{ displayName ? name : emptyLabel }}</span>
      <small v-if="showOrganization && organization" class="jira-person__org">{{ organization }}</small>
    </span>
  </span>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { jiraPersonHue, jiraPersonInitials, jiraPersonName, jiraPersonOrganization } from "./jiraPeople";

const props = withDefaults(
  defineProps<{
    displayName?: string;
    size?: "sm" | "md" | "lg";
    showName?: boolean;
    showOrganization?: boolean;
    emptyLabel?: string;
    me?: boolean;
    /** For a control that carries its own, more helpful tooltip. */
    hideTitle?: boolean;
  }>(),
  {
    displayName: "",
    size: "md",
    showName: true,
    showOrganization: false,
    emptyLabel: "Unassigned",
    me: false,
    hideTitle: false,
  },
);

const name = computed(() => jiraPersonName(props.displayName));
const organization = computed(() => jiraPersonOrganization(props.displayName));
const initials = computed(() => jiraPersonInitials(props.displayName));
const title = computed(() => (props.displayName ? props.displayName : props.emptyLabel) + (props.me ? " (you)" : ""));
const avatarStyle = computed(() =>
  props.displayName ? { "--jira-person-hue": String(jiraPersonHue(props.displayName)) } : undefined,
);
</script>

<style scoped>
.jira-person {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
  max-width: 100%;
  vertical-align: middle;
}
.jira-person__avatar {
  --jira-person-size: 22px;
  display: inline-grid;
  place-items: center;
  flex: 0 0 var(--jira-person-size);
  width: var(--jira-person-size);
  height: var(--jira-person-size);
  border-radius: 50%;
  background: hsl(var(--jira-person-hue, 220) 52% 30%);
  box-shadow: inset 0 0 0 1px hsl(var(--jira-person-hue, 220) 60% 62% / 0.45);
  color: #fff;
  font-size: calc(var(--jira-person-size) * 0.4);
  font-weight: 650;
  line-height: 1;
  user-select: none;
}
.jira-person__initials {
  display: block;
  /* Centre the capital letters themselves, not the font's ascender/descender box. */
  text-box: trim-both cap alphabetic;
}
.jira-person--sm .jira-person__avatar {
  --jira-person-size: 18px;
}
.jira-person--lg .jira-person__avatar {
  --jira-person-size: 30px;
}
.jira-person--empty .jira-person__avatar {
  background: transparent;
  box-shadow: none;
  border: 1px dashed color-mix(in srgb, var(--muted, #8b93a1) 70%, transparent);
  color: var(--muted, #8b93a1);
}
.jira-person--me .jira-person__avatar {
  box-shadow:
    0 0 0 2px var(--surface-card, #1e1f24),
    0 0 0 3.5px var(--accent, #e7a33e);
}
.jira-person__avatar svg {
  width: 62%;
  height: 62%;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.4;
  stroke-linecap: round;
}
.jira-person__text {
  display: inline-flex;
  flex-direction: column;
  min-width: 0;
  line-height: 1.2;
}
.jira-person__name {
  overflow: hidden;
  color: var(--text);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.jira-person--empty .jira-person__name {
  color: var(--muted);
  font-style: italic;
}
.jira-person__org {
  overflow: hidden;
  color: var(--muted);
  font-size: var(--font-size-caption);
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
