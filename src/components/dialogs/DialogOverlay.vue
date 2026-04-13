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
import { computed, defineAsyncComponent } from "vue";
import { useAppStore } from "../../stores/app.js";

const DIALOGS = {
  TextInputDialog: defineAsyncComponent(() => import("./TextInputDialog.vue")),
  TextAreaDialog: defineAsyncComponent(() => import("./TextAreaDialog.vue")),
  HelpDialog: defineAsyncComponent(() => import("./HelpDialog.vue")),
  NewWorkspacePicker: defineAsyncComponent(() => import("./NewWorkspacePicker.vue")),
  WorkspaceDialog: defineAsyncComponent(() => import("./WorkspaceDialog.vue")),
  SettingsDialog: defineAsyncComponent(() => import("./SettingsDialog.vue")),
  ProfilesDialog: defineAsyncComponent(() => import("./ProfilesDialog.vue")),
  AzureConnectionDialog: defineAsyncComponent(() => import("./AzureConnectionDialog.vue")),
  GitHubConnectionDialog: defineAsyncComponent(() => import("./GitHubConnectionDialog.vue")),
  GitHubQuickFixWizardDialog: defineAsyncComponent(() => import("./GitHubQuickFixWizardDialog.vue")),
  QuickFixWizardDialog: defineAsyncComponent(() => import("./QuickFixWizardDialog.vue")),
  BusyOverlay: defineAsyncComponent(() => import("./BusyOverlay.vue")),
  TaskWorkspaceDialog: defineAsyncComponent(() => import("./TaskWorkspaceDialog.vue")),
  TaskHookCheckDialog: defineAsyncComponent(() => import("./TaskHookCheckDialog.vue")),
};

const store = useAppStore();

const dialogComponent = computed(() => DIALOGS[store.overlay] || null);

function handleBackdropClick() {
  if (store.overlay === "BusyOverlay") return; // busy overlay cannot be dismissed
  const cb = store.overlayProps?.onCancel || store.overlayProps?.onClose;
  if (cb) cb();
  else store.closeDialog();
}
</script>
