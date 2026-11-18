<template>
  <span
    v-if="isolation"
    class="tab__isolated"
    :class="{ 'tab__isolated--pending': isolation === 'restart to isolate' }"
    :title="isolation === 'isolated' ? ISOLATED_TOOLTIP : RESTART_TOOLTIP"
    :data-testid="isolation === 'isolated' ? 'tab-isolated' : 'tab-restart-to-isolate'"
    >{{ isolation }}</span
  >
</template>

<script setup lang="ts">
import type { TabIsolation } from "../../app/selectors.js";

defineProps<{ isolation?: TabIsolation }>();

const ISOLATED_TOOLTIP =
  "This agent runs in a sandbox: it cannot read your home folder or reach the network except through strIDEterm. It does not protect the workspace contents, the agent's own sign-in, or traffic to its model.";

const RESTART_TOOLTIP =
  "This workspace works in isolation, but this agent was started before that and still runs outside the sandbox. Restart the tab to isolate it.";
</script>
