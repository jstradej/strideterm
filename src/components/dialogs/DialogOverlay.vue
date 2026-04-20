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

<script setup>
import { computed, defineAsyncComponent, watch, nextTick } from "vue";
import { useAppStore } from "../../stores/app.js";

const DIALOGS = {
  TextInputDialog: defineAsyncComponent(() => import("./TextInputDialog.vue")),
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
};

const store = useAppStore();

const dialogComponent = computed(() => DIALOGS[store.overlay] || null);

// When a dialog opens, blur the active terminal so xterm.js releases keyboard capture
watch(
  () => store.overlay,
  (overlay) => {
    if (overlay) {
      // Blur xterm's hidden textarea to release keyboard events
      const xtermTextarea = document.querySelector(".xterm-helper-textarea");
      if (xtermTextarea) xtermTextarea.blur();
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
              focusable.focus();
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
  const cb = store.overlayProps?.onCancel || store.overlayProps?.onClose;
  if (cb) cb();
  else store.closeDialog();
}
</script>
