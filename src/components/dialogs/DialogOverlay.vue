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
import { computed } from "vue";
import { useAppStore } from "../../stores/app.js";
import TextInputDialog from "./TextInputDialog.vue";
import TextAreaDialog from "./TextAreaDialog.vue";
import HelpDialog from "./HelpDialog.vue";
import NewWorkspacePicker from "./NewWorkspacePicker.vue";
import WorkspaceDialog from "./WorkspaceDialog.vue";
import SettingsDialog from "./SettingsDialog.vue";
import ProfilesDialog from "./ProfilesDialog.vue";
import AzureConnectionDialog from "./AzureConnectionDialog.vue";

const DIALOGS = {
  TextInputDialog,
  TextAreaDialog,
  HelpDialog,
  NewWorkspacePicker,
  WorkspaceDialog,
  SettingsDialog,
  ProfilesDialog,
  AzureConnectionDialog,
};

const store = useAppStore();

const dialogComponent = computed(() => DIALOGS[store.overlay] || null);

function handleBackdropClick() {
  const cb = store.overlayProps?.onCancel || store.overlayProps?.onClose;
  if (cb) cb();
  else store.closeDialog();
}
</script>
