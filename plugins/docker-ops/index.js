/**
 * Docker Ops Plugin for strIDEterm
 *
 * This is the first example plugin demonstrating the strIDEterm plugin API.
 * It provides Docker container management directly within the terminal workspace.
 *
 * Plugins can:
 * - Define workspace templates (via plugin.json workspaceDefaults)
 * - Register custom capabilities
 * - Hook into the runtime lifecycle
 *
 * Security: Plugins run in the same Node.js process but are restricted to
 * their declared capabilities. The plugin loader validates the manifest
 * before loading.
 */

export const id = "docker-ops";

export function activate({ runtime }) {
  // Plugin activation hook — called when the plugin is loaded.
  // The Docker manager is already built into the core runtime,
  // so this plugin primarily serves as a workspace template provider.
  return {
    deactivate() {
      // Cleanup hook — called when the plugin is unloaded.
    },
  };
}
