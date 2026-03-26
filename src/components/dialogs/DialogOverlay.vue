<template>
  <Teleport to="body">
    <div
      v-if="store.overlay"
      class="overlay"
      @click.self="handleBackdropClick"
      @keydown.esc.window="handleBackdropClick"
    >
      <component
        v-if="dialogComponent"
        :is="dialogComponent"
        v-bind="store.overlayProps"
      />
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
  QuickFixWizardDialog: defineAsyncComponent(() => import("./QuickFixWizardDialog.vue")),
};

const store = useAppStore();

const dialogComponent = computed(() => DIALOGS[store.overlay] || null);

function handleBackdropClick() {
  const cb = store.overlayProps?.onCancel || store.overlayProps?.onClose;
  if (cb) cb();
  else store.closeDialog();
}
</script>
