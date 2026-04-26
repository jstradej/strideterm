<template>
  <div class="dialog">
    <div class="dialog__header">
      <div>
        <p class="eyebrow">strIDEterm</p>
        <h2>Help &amp; Keyboard Shortcuts</h2>
      </div>
      <button type="button" class="button button--ghost" @click="emit('close')">Close</button>
    </div>
    <div class="form" style="margin-top: 14px">
      <article
        style="
          border: 1px solid var(--border);
          border-radius: 4px;
          padding: 12px;
          background: rgba(255, 255, 255, 0.03);
        "
      >
        <h3 style="margin-bottom: 8px">Getting Started</h3>
        <p style="color: var(--muted); font-size: 13px; line-height: 1.6">
          <strong>strIDEterm</strong> is a multi-workspace terminal hub. Add workspaces via the
          <strong>+</strong> button in the sidebar, organize them with <strong>Profiles</strong>, and use split layouts
          to view multiple terminals side by side.
        </p>
      </article>
      <article
        style="
          border: 1px solid var(--border);
          border-radius: 4px;
          padding: 12px;
          background: rgba(255, 255, 255, 0.03);
        "
      >
        <h3 style="margin-bottom: 8px">Keyboard Shortcuts</h3>
        <dl style="display: grid; grid-template-columns: auto 1fr; gap: 6px 16px; font-size: 13px">
          <dt style="color: var(--accent); font-weight: 700">Ctrl/Cmd + N</dt>
          <dd style="color: var(--muted)">New workspace</dd>
          <dt style="color: var(--accent); font-weight: 700">Ctrl/Cmd + R</dt>
          <dd style="color: var(--muted)">Restart active terminal</dd>
          <dt style="color: var(--accent); font-weight: 700">Ctrl + 1-9</dt>
          <dd style="color: var(--muted)">Switch to workspace 1-9</dd>
          <dt style="color: var(--accent); font-weight: 700">Ctrl + PageDown/PageUp</dt>
          <dd style="color: var(--muted)">Next / previous tab</dd>
        </dl>
      </article>
      <article
        style="
          border: 1px solid var(--border);
          border-radius: 4px;
          padding: 12px;
          background: rgba(255, 255, 255, 0.03);
        "
      >
        <h3 style="margin-bottom: 8px">Features</h3>
        <ul style="color: var(--muted); font-size: 13px; line-height: 1.8; padding-left: 18px; margin: 0">
          <li>
            <strong>Workspaces</strong> &mdash; Each workspace has its own terminal tabs, working directory, and
            Git/Docker integration.
          </li>
          <li>
            <strong>Profiles</strong> &mdash; Group workspaces into profiles to quickly switch between different setups.
          </li>
          <li>
            <strong>Split Layouts</strong> &mdash; View multiple terminals side by side (right-click tab or use Split
            button).
          </li>
          <li>
            <strong>Docker Manager</strong> &mdash; Manage containers, attach shells, stream logs from Docker
            workspaces.
          </li>
          <li><strong>Git Integration</strong> &mdash; Branch info, dirty count, commit log, and Lazygit support.</li>
          <li>
            <strong>Remote Access</strong> &mdash; Access your workspace from any device on the LAN or via Cloudflare
            tunnel.
          </li>
          <li>
            <strong>Plugins</strong> &mdash; Extend functionality with plugins in the <code>plugins/</code> directory.
          </li>
          <li>
            <strong>Drag &amp; Drop</strong> &mdash; Reorder tabs by dragging, move workspaces up/down with arrow
            buttons.
          </li>
        </ul>
      </article>
      <article
        style="
          border: 1px solid var(--border);
          border-radius: 4px;
          padding: 12px;
          background: rgba(255, 255, 255, 0.03);
        "
      >
        <h3 style="margin-bottom: 8px">Configuration</h3>
        <p style="color: var(--muted); font-size: 13px; line-height: 1.6">
          All configuration is stored in <code>~/.strideterm/</code>. The main state file is
          <code>strideterm-state.json</code>. Plugins are loaded from the <code>plugins/</code> subdirectory within your
          config folder.
        </p>
      </article>
    </div>
  </div>
</template>

<script setup lang="ts">
const emit = defineEmits<{
  close: [];
}>();
</script>
