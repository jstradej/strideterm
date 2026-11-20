import { computed } from "vue";
import type { Transport } from "../transport.js";
import { pickPath } from "../lib/pick-path.js";
import { useAppStore } from "../stores/app.js";
import { isPeerWindow, windowBackend } from "../window-backend.js";

/**
 * Folder picking for a folder that must exist on the machine running the backend: the native dialog in a local
 * desktop window, the in-app host browser in a window attached to another desktop, nothing on the web client.
 */
export function useDirectoryPicker(api: Transport | undefined) {
  const app = useAppStore();

  const hostLabel = computed(() => {
    const backend = windowBackend.value;
    return backend.kind === "peer" && typeof api?.listHostDirectories === "function" ? backend.hostLabel : "";
  });
  const browsingHost = computed(() => hostLabel.value !== "");
  const canBrowse = computed(
    () => browsingHost.value || (!isPeerWindow() && typeof api?.browseDirectory === "function"),
  );

  function browseHost(initialPath: string): Promise<string | null> {
    return new Promise((resolve) => {
      const finish = (path: string | null) => {
        app.backDialog();
        resolve(path);
      };
      app.openSubDialog("HostFolderBrowser", {
        hostLabel: hostLabel.value,
        initialPath,
        onSelect: (path: string) => finish(path),
        onCancel: () => finish(null),
      });
    });
  }

  /** Resolves the chosen folder, or null when cancelled or when the picker failed (the failure is toasted and logged). */
  async function pickDirectory(initialPath = ""): Promise<string | null> {
    if (browsingHost.value) return browseHost(initialPath);
    const browse = api?.browseDirectory;
    if (!browse || isPeerWindow()) return null;
    return pickPath(() => browse(initialPath));
  }

  return { canBrowse, browsingHost, hostLabel, pickDirectory };
}
