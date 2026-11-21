<template>
  <div class="peer-failure-help" data-testid="peer-failure-help">
    <template v-if="reason === 'timeout' || reason === 'unreachable'">
      <p v-if="isMac" class="peer-failure-help__note" data-testid="peer-failure-local-network">
        On this Mac, also check System Settings → Privacy &amp; Security → Local Network: strIDEterm must be allowed to
        reach devices on the local network.
      </p>
      <details class="peer-failure-help__details" data-testid="peer-failure-firewall">
        <summary>How to allow the connection on the other desktop</summary>
        <PeerFirewallHelp :port="target.port" />
      </details>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import type { PeerFailureReason } from "../../../electron/shared/peers.js";
import { detectDesktopOs } from "../../lib/desktop-os.js";
import PeerFirewallHelp from "./PeerFirewallHelp.vue";

const props = defineProps<{ reason: PeerFailureReason; target: { address: string; port: number } }>();

const isMac = computed(
  () => (props.reason === "timeout" || props.reason === "unreachable") && detectDesktopOs() === "macos",
);
</script>

<style scoped>
.peer-failure-help {
  display: grid;
  gap: 8px;
  font-size: 12.5px;
  line-height: 1.5;
}
.peer-failure-help__note {
  margin: 0;
  color: var(--muted);
}
.peer-failure-help__details summary {
  cursor: pointer;
}
.peer-failure-help__details[open] summary {
  margin-bottom: 6px;
}
</style>
