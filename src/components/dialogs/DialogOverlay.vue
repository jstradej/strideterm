<template>
  <Teleport to="body">
    <div
      v-if="store.overlay"
      class="overlay"
      @click.self="handleBackdropClick"
      @keydown.esc.window="handleBackdropClick"
    >
      <component :is="dialogComponent" v-if="dialogComponent" v-bind="store.overlayProps" />
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, defineAsyncComponent, watch, nextTick } from "vue";
import { useAppStore } from "../../stores/app.js";

const DIALOGS = {
  TextInputDialog: defineAsyncComponent(() => import("./TextInputDialog.vue")),
  WorktreeDialog: defineAsyncComponent(() => import("./WorktreeDialog.vue")),
  TextAreaDialog: defineAsyncComponent(() => import("./TextAreaDialog.vue")),
  EditTabDialog: defineAsyncComponent(() => import("./EditTabDialog.vue")),
  HelpDialog: defineAsyncComponent(() => import("./HelpDialog.vue")),
  NewWorkspacePicker: defineAsyncComponent(() => import("./NewWorkspacePicker.vue")),
  WorkspaceDialog: defineAsyncComponent(() => import("./WorkspaceDialog.vue")),
  SettingsDialog: defineAsyncComponent(() => import("./SettingsDialog.vue")),
  ProfilesDialog: defineAsyncComponent(() => import("./ProfilesDialog.vue")),
  AzureConnectionDialog: defineAsyncComponent(() => import("./AzureConnectionDialog.vue")),
  GitHubConnectionDialog: defineAsyncComponent(() => import("./GitHubConnectionDialog.vue")),
  QuickFixWizardDialog: defineAsyncComponent(() => import("./QuickFixWizardDialog.vue")),
  BusyOverlay: defineAsyncComponent(() => import("./BusyOverlay.vue")),
  TaskHookCheckDialog: defineAsyncComponent(() => import("./TaskHookCheckDialog.vue")),
  TaskRecoveryDialog: defineAsyncComponent(() => import("./TaskRecoveryDialog.vue")),
  GitCommitInfoDialog: defineAsyncComponent(() => import("./GitCommitInfoDialog.vue")),
  RemoteAccessDialog: defineAsyncComponent(() => import("./RemoteAccessDialog.vue")),
  SshHostsDialog: defineAsyncComponent(() => import("../ssh/SshHostsDialog.vue")),
  SshHostEditor: defineAsyncComponent(() => import("../ssh/SshHostEditor.vue")),
  SshKeyManager: defineAsyncComponent(() => import("../ssh/SshKeyManager.vue")),
  SshKeyGenerateDialog: defineAsyncComponent(() => import("../ssh/SshKeyGenerateDialog.vue")),
  // SshAuthPrompt and SshHostKeyWarning are rendered directly from App.vue
  // (driven by backend events, not openDialog), so they aren't in this map.
};

const store = useAppStore();

const dialogComponent = computed(() =>
  store.overlay
    ? ((DIALOGS as Record<string, ReturnType<typeof defineAsyncComponent> | undefined>)[store.overlay] ?? null)
    : null,
);

// When a dialog opens, blur the active terminal so xterm.js releases keyboard capture
watch(
  () => store.overlay,
  (overlay) => {
    if (overlay) {
      // Blur xterm's hidden textarea to release keyboard events
      const xtermTextarea = document.querySelector(".xterm-helper-textarea");
      if (xtermTextarea) (xtermTextarea as HTMLElement).blur();
      // After the dialog component mounts, focus the first visible input/textarea.
      // Use a rAF retry loop instead of a fixed timeout — works reliably on slow machines
      // where async dialog components take variable time to mount.
      nextTick(() => {
        let attempts = 0;
        const tryFocus = () => {
          const dialog = document.querySelector(".overlay .dialog");
          if (dialog) {
            const focusable = dialog.querySelector("input:not([type=hidden]), textarea, select, [autofocus]");
            if (focusable) {
              (focusable as HTMLElement).focus();
              return;
            }
          }
          if (++attempts < 10) requestAnimationFrame(tryFocus);
        };
        requestAnimationFrame(tryFocus);
      });
    }
  },
);

function handleBackdropClick() {
  if (store.overlay === "BusyOverlay") return; // busy overlay cannot be dismissed
  const props = store.overlayProps as Record<string, unknown> | undefined;
  const cb = (props?.["onCancel"] || props?.["onClose"]) as (() => void) | undefined;
  if (cb) cb();
  else store.closeDialog();
}
</script>
