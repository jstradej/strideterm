<template>
  <Teleport to="body">
    <div
      v-for="(layer, index) in layers"
      v-show="index === layers.length - 1"
      :key="layer.id"
      :ref="index === layers.length - 1 ? setOverlayRef : undefined"
      class="overlay"
      :class="{ 'overlay--inactive': index !== layers.length - 1 }"
      :aria-hidden="index !== layers.length - 1 || hasDecision"
      :inert="index !== layers.length - 1 || hasDecision"
      :tabindex="index === layers.length - 1 ? -1 : undefined"
      @focusin.capture="handleOverlayFocusIn"
      @mousedown.capture="index === layers.length - 1 && handleOverlayPointerDown($event)"
      @pointerdown.capture="
        index === layers.length - 1 && releaseTerminalKeyboardCapture(testTerminalAt($event.target))
      "
      @click.self="index === layers.length - 1 && handleBackdropClick()"
    >
      <component
        :is="dialogFor(layer.name)"
        v-if="dialogFor(layer.name)"
        :ref="index === layers.length - 1 ? setActiveDialogRef : undefined"
        v-bind="layer.props"
      />
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, defineAsyncComponent, watch, nextTick, onBeforeUnmount, ref } from "vue";
import { useAppStore } from "../../stores/app.js";
import { useSshStore } from "../../stores/ssh.js";

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
  TerminalTextSelectionDialog: defineAsyncComponent(() => import("./TerminalTextSelectionDialog.vue")),
  SshHostsDialog: defineAsyncComponent(() => import("../ssh/SshHostsDialog.vue")),
  SshHostEditor: defineAsyncComponent(() => import("../ssh/SshHostEditor.vue")),
  SshKeyManager: defineAsyncComponent(() => import("../ssh/SshKeyManager.vue")),
  SshKeyTransferDialog: defineAsyncComponent(() => import("../ssh/SshKeyTransferDialog.vue")),
  SshKeyGenerateDialog: defineAsyncComponent(() => import("../ssh/SshKeyGenerateDialog.vue")),
  SshKeyImportDialog: defineAsyncComponent(() => import("../ssh/SshKeyImportDialog.vue")),
  SshCertImportDialog: defineAsyncComponent(() => import("../ssh/SshCertImportDialog.vue")),
  SshConnectionTestDialog: defineAsyncComponent(() => import("../ssh/SshConnectionTestDialog.vue")),
  // SshAuthPrompt and SshHostKeyWarning are rendered directly from App.vue
  // (driven by backend events, not openDialog), so they aren't in this map.
};

const store = useAppStore();
const sshStore = useSshStore();
const overlayRef = ref<HTMLElement | null>(null);
const activeDialogRef = ref<{ requestClose?: () => void } | null>(null);
const hasDecision = computed(() => Boolean(sshStore.authPrompt || sshStore.hostKeyWarning));
let previousStackLength = store.dialogLayers.length;

const layers = computed(() => {
  if (!store.overlay) return [];
  const stack = store.dialogLayers;
  if (!stack.length) return [{ id: -1, name: store.overlay, props: store.overlayProps }];
  const top = stack.at(-1)!;
  if (store.overlay !== top.name) {
    return [...stack, { id: -1_000_000 - top.id, name: store.overlay, props: store.overlayProps }];
  }
  return [...stack.slice(0, -1), { ...top, props: store.overlayProps }];
});

function dialogFor(name: string) {
  return (DIALOGS as Record<string, ReturnType<typeof defineAsyncComponent> | undefined>)[name] ?? null;
}

function setOverlayRef(element: unknown) {
  overlayRef.value = element instanceof HTMLElement ? element : null;
}

function setActiveDialogRef(component: unknown) {
  activeDialogRef.value =
    component && typeof component === "object" && "$el" in component
      ? (component as { requestClose?: () => void })
      : null;
}

function releaseTerminalKeyboardCapture(preserve?: Element | null) {
  for (const textarea of document.querySelectorAll(".xterm-helper-textarea")) {
    if (!preserve?.contains(textarea)) (textarea as HTMLElement).blur();
  }
}

function testTerminalAt(target: EventTarget | null): Element | null {
  if (hasDecision.value || !(target instanceof Node)) return null;
  const activeTest = overlayRef.value?.querySelector(".ssh-connection-test");
  const terminal = activeTest?.querySelector(".ssh-connection-test__terminal");
  return terminal?.contains(target) ? terminal : null;
}

function handleOverlayFocusIn(event: FocusEvent) {
  releaseTerminalKeyboardCapture(testTerminalAt(event.target));
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
  const preserveTerminal = testTerminalAt(event.target);
  const editable = findEditableTarget(event.target);
  // A NATIVE <select> POPUP IS NOT PART OF THIS DOCUMENT, and both halves of the routine below close
  // it. The list is an OS-level window owned by the BrowserWindow, so `window:focus-current` --
  // `show()` + `focus()` on the owner, arriving over async IPC once the popup is already up -- and the
  // rAF re-focus of the element both dismiss it. It opens and disappears in the same frame, which
  // reads as a dropdown that does not open at all. Chromium focuses the select itself on mousedown,
  // so neither step is wanted here; releasing the terminal's keyboard capture is synchronous DOM and
  // does not touch the popup.
  if (editable instanceof HTMLSelectElement) {
    releaseTerminalKeyboardCapture(preserveTerminal);
    return;
  }
  requestHostWindowFocus();
  releaseTerminalKeyboardCapture(preserveTerminal);
  if (!editable || editable.hasAttribute("disabled")) return;
  requestAnimationFrame(() => {
    requestHostWindowFocus();
    releaseTerminalKeyboardCapture(preserveTerminal);
    if (document.activeElement !== editable) {
      editable.focus({ preventScroll: true });
    }
  });
}

// When a dialog opens, blur the active terminal so xterm.js releases keyboard capture
watch(
  () => layers.value.at(-1)?.id,
  (id) => {
    const overlay = Boolean(id);
    const returning = store.dialogLayers.length < previousStackLength;
    previousStackLength = store.dialogLayers.length;
    if (overlay) {
      releaseTerminalKeyboardCapture();
      requestHostWindowFocus();
      // After the dialog component mounts, focus the first visible input/textarea.
      // Use a rAF retry loop instead of a fixed timeout — works reliably on slow machines
      // where async dialog components take variable time to mount.
      nextTick(() => {
        if (returning || sshStore.authPrompt || sshStore.hostKeyWarning) return;
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
                "button:not(:disabled):not([data-no-dialog-autofocus])",
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

function requestActiveClose(back = false) {
  if (activeDialogRef.value?.requestClose) {
    activeDialogRef.value.requestClose();
    return;
  }
  const props = store.overlayProps as Record<string, unknown> | undefined;
  const cb = (
    back ? props?.["onBack"] || props?.["onCancel"] || props?.["onClose"] : props?.["onCancel"] || props?.["onClose"]
  ) as (() => void) | undefined;
  if (cb) cb();
  else if (back) store.backDialog();
  else store.closeDialog();
}

function handleBackdropClick() {
  if (store.overlay === "BusyOverlay") return; // busy overlay cannot be dismissed
  if (store.overlay === "SettingsDialog") return;
  requestActiveClose();
}

// Esc must close the dialog regardless of where focus is. Vue's `.window`
// modifier is not real, so we attach a window-level listener manually.
function handleEsc(e: KeyboardEvent) {
  if (e.key !== "Escape" || e.defaultPrevented) return;
  if (!store.overlay) return;
  if (store.overlay === "BusyOverlay") return;
  if (sshStore.authPrompt || sshStore.hostKeyWarning) return;
  const activeLayer = overlayRef.value?.querySelector(".dialog");
  const help = activeLayer?.querySelector('[role="tooltip"][data-open="true"]');
  if (help) return;
  e.preventDefault();
  e.stopPropagation();
  if (store.dialogLayers.length > 1) {
    requestActiveClose(true);
    return;
  }
  requestActiveClose();
}

window.addEventListener("keydown", handleEsc);
onBeforeUnmount(() => window.removeEventListener("keydown", handleEsc));
</script>
