<template>
  <div class="peer-firewall" data-testid="peer-firewall-help">
    <section v-if="shown('windows')" data-testid="peer-firewall-windows">
      <h4 v-if="!os">Windows</h4>
      <ul>
        <li>When Windows asks whether strIDEterm may communicate on networks, allow Private networks.</li>
        <li>
          If that was dismissed: Windows Security → Firewall &amp; network protection → Allow an app through firewall →
          Change settings → tick strIDEterm for Private.
        </li>
        <li>
          The network must be Private: Settings → Network &amp; internet → your Wi-Fi or Ethernet connection → Network
          profile type → Private.
        </li>
        <li>
          Or in PowerShell as administrator:
          <span class="peer-firewall__command">
            <code>{{ windowsCommand }}</code>
            <button type="button" class="button button--ghost" @click="copy(windowsCommand)">Copy</button>
          </span>
        </li>
      </ul>
    </section>
    <section v-if="shown('macos')" data-testid="peer-firewall-macos">
      <h4 v-if="!os">macOS</h4>
      <ul>
        <li>System Settings → Network → Firewall → Options… → strIDEterm → Allow incoming connections.</li>
      </ul>
    </section>
    <section v-if="shown('linux')" data-testid="peer-firewall-linux">
      <h4 v-if="!os">Linux</h4>
      <ul>
        <li>
          ufw:
          <span class="peer-firewall__command">
            <code>{{ ufwCommand }}</code>
            <button type="button" class="button button--ghost" @click="copy(ufwCommand)">Copy</button>
          </span>
        </li>
        <li>
          firewalld:
          <span class="peer-firewall__command">
            <code>{{ firewalldCommand }}</code>
            <button type="button" class="button button--ghost" @click="copy(firewalldCommand)">Copy</button>
          </span>
        </li>
      </ul>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import type { DesktopOs } from "../../lib/desktop-os.js";
import { useAppStore } from "../../stores/app.js";

const props = defineProps<{ port: number; os?: DesktopOs }>();

const app = useAppStore();

const windowsCommand = computed(
  () =>
    `New-NetFirewallRule -DisplayName "strIDEterm desktops" -Direction Inbound -Protocol TCP -LocalPort ${props.port} -Action Allow -Profile Private`,
);
const ufwCommand = computed(() => `sudo ufw allow ${props.port}/tcp`);
const firewalldCommand = computed(
  () => `sudo firewall-cmd --permanent --add-port=${props.port}/tcp && sudo firewall-cmd --reload`,
);

const shown = (os: DesktopOs) => !props.os || props.os === os;

function copy(text: string): void {
  void app.copyText(text);
}
</script>

<style scoped>
.peer-firewall {
  display: grid;
  gap: 8px;
  font-size: 12.5px;
  line-height: 1.5;
}
.peer-firewall h4 {
  margin: 0 0 2px;
  font-size: 12.5px;
}
.peer-firewall ul {
  margin: 0;
  padding-left: 18px;
  display: grid;
  gap: 4px;
}
.peer-firewall__command {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 2px;
}
.peer-firewall__command code {
  flex: 1 1 auto;
  min-width: 0;
  overflow-wrap: anywhere;
  user-select: all;
  font-family: var(--mono, ui-monospace, monospace);
}
</style>
