import { inject, provide } from "vue";

export type SshPanelDialog =
  | "SshHostEditor"
  | "SshKeyImportDialog"
  | "SshKeyGenerateDialog"
  | "SshCertImportDialog"
  | "SshConnectionTestDialog"
  | "SshKeyTransferDialog";

export interface SshPanelNavigation {
  open: (_name: SshPanelDialog, _props?: Record<string, unknown>) => void;
  back: () => void;
}

const sshPanelNavigationKey = Symbol("sshPanelNavigation");

export function provideSshPanelNavigation(navigation: SshPanelNavigation): void {
  provide(sshPanelNavigationKey, navigation);
}

export function useSshPanelNavigation(): SshPanelNavigation | undefined {
  return inject<SshPanelNavigation | undefined>(sshPanelNavigationKey, undefined);
}
