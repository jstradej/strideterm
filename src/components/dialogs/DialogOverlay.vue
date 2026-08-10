<template>
  <Teleport to="body">
    <div
      v-if="store.overlay"
      ref="overlayRef"
      class="overlay"
      tabindex="-1"
      @focusin.capture="releaseTerminalKeyboardCapture"
      @mousedown.capture="handleOverlayPointerDown"
      @pointerdown.capture="releaseTerminalKeyboardCapture"
    >
      <component :is="dialogComponent" v-if="dialogComponent" v-bind="store.overlayProps" />
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, defineAsyncComponent, watch, nextTick, onBeforeUnmount, ref } from "vue";
import { useAppStore } from "../../stores/app.js";

const DIALOGS = {
  TextInputDialog: defineAsyncComponent(() => import("./TextInputDialog.vue")),
  WorktreeDialog: defineAsyncComponent(() => import("./WorktreeDialog.vue")),
  TextAreaDialog: defineAsyncComponent(() => import("./TextAreaDialog.vue")),
  EditTabDialog: defineAsyncComponent(() => import("./EditTabDialog.vue")),
  HelpDialog: defineAsyncComponent(() => import("./HelpDialog.vue")),
  NewWorkspacePicker: defineAsyncComponent(() => import("./NewWorkspacePicker.vue")),
  WorkspaceDialog: defineAsyncComponent(() => import("./WorkspaceDialog.vue")),
  CompanionAgentDialog: defineAsyncComponent(() => import("./CompanionAgentDialog.vue")),
  SettingsDialog: defineAsyncComponent(() => import("./SettingsDialog.vue")),
  ProfilesDialog: defineAsyncComponent(() => import("./ProfilesDialog.vue")),
  ConnectionDialog: defineAsyncComponent(() => import("./ConnectionDialog.vue")),
  AzurePipelineRunDialog: defineAsyncComponent(() => import("./AzurePipelineRunDialog.vue")),
  QuickFixWizardDialog: defineAsyncComponent(() => import("./QuickFixWizardDialog.vue")),
  BusyOverlay: defineAsyncComponent(() => import("./BusyOverlay.vue")),
  TaskHookCheckDialog: defineAsyncComponent(() => import("./TaskHookCheckDialog.vue")),
  TaskRecoveryDialog: defineAsyncComponent(() => import("./TaskRecoveryDialog.vue")),
  GitCommitInfoDialog: defineAsyncComponent(() => import("./GitCommitInfoDialog.vue")),
  RemoteAccessDialog: defineAsyncComponent(() => import("./RemoteAccessDialog.vue")),
  NewWindowModal: defineAsyncComponent(() => import("./NewWindowModal.vue")),
  ConfirmDialog: defineAsyncComponent(() => import("./ConfirmDialog.vue")),
  PromptDialog: defineAsyncComponent(() => import("./PromptDialog.vue")),
  CreatePullRequestDialog: defineAsyncComponent(() => import("./CreatePullRequestDialog.vue")),
  SshHostsDialog: defineAsyncComponent(() => import("../ssh/SshHostsDialog.vue")),
  SshHostEditor: defineAsyncComponent(() => import("../ssh/SshHostEditor.vue")),
  SshKeyManager: defineAsyncComponent(() => import("../ssh/SshKeyManager.vue")),
  SshKeyGenerateDialog: defineAsyncComponent(() => import("../ssh/SshKeyGenerateDialog.vue")),
  SshKeyImportDialog: defineAsyncComponent(() => import("../ssh/SshKeyImportDialog.vue")),
  SshCertImportDialog: defineAsyncComponent(() => import("../ssh/SshCertImportDialog.vue")),
  // SshAuthPrompt and SshHostKeyWarning are rendered directly from App.vue
  // (driven by backend events, not openDialog), so they aren't in this map.
};

const store = useAppStore();
const overlayRef = ref<HTMLElement | null>(null);

const dialogComponent = computed(() =>
  store.overlay
    ? ((DIALOGS as Record<string, ReturnType<typeof defineAsyncComponent> | undefined>)[store.overlay] ?? null)
    : null,
);

function releaseTerminalKeyboardCapture() {
  for (const textarea of document.querySelectorAll(".xterm-helper-textarea")) {
    (textarea as HTMLElement).blur();
  }
}

function requestHostWindowFocus() {
  window.focus();
  const api = (window as unknown as { strideterm?: { focusWindow?: () => Promise<unknown> } }).strideterm;
  void api?.focusWindow?.().catch(() => {});
}

function findEditableTarget(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof HTMLElement)) return null;
  return target.closest("input, textarea, select, button, [contenteditable='true']");
}

function handleOverlayPointerDown(event: MouseEvent) {
  requestHostWindowFocus();
  releaseTerminalKeyboardCapture();
  const editable = findEditableTarget(event.target);
  if (!editable || editable.hasAttribute("disabled")) return;
  requestAnimationFrame(() => {
    requestHostWindowFocus();
    releaseTerminalKeyboardCapture();
    if (document.activeElement !== editable) {
      editable.focus({ preventScroll: true });
    }
  });
}

// When a dialog opens, blur the active terminal so xterm.js releases keyboard capture
watch(
  () => store.overlay,
  (overlay) => {
    if (overlay) {
      releaseTerminalKeyboardCapture();
      requestHostWindowFocus();
      // After the dialog component mounts, focus the first visible input/textarea.
      // Use a rAF retry loop instead of a fixed timeout — works reliably on slow machines
      // where async dialog components take variable time to mount.
      nextTick(() => {
        let attempts = 0;
        const tryFocus = () => {
          const dialog = overlayRef.value?.querySelector(".dialog");
          if (dialog) {
            // Dialogs whose first input is a rename-in-place (e.g. ProfilesDialog)
            // opt out via data-no-autofocus so opening doesn't look like a rename.
            if ((dialog as HTMLElement).dataset.noAutofocus !== undefined) return;
            const focusable = dialog.querySelector(
              [
                "[autofocus]",
                "input:not([type=hidden]):not(:disabled)",
                "textarea:not(:disabled)",
                "select:not(:disabled)",
                "button:not(:disabled)",
              ].join(", "),
            );
            if (focusable) {
              (focusable as HTMLElement).focus({ preventScroll: true });
              if (document.activeElement === focusable || dialog.contains(document.activeElement)) return;
            }
          }
          overlayRef.value?.focus({ preventScroll: true });
          if (++attempts < 30) requestAnimationFrame(tryFocus);
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

// Esc must close the dialog regardless of where focus is. Vue's `.window`
// modifier is not real, so we attach a window-level listener manually.
function handleEsc(e: KeyboardEvent) {
  if (e.key !== "Escape") return;
  if (!store.overlay) return;
  e.preventDefault();
  e.stopPropagation();
  handleBackdropClick();
}

window.addEventListener("keydown", handleEsc);
onBeforeUnmount(() => window.removeEventListener("keydown", handleEsc));
</script>
