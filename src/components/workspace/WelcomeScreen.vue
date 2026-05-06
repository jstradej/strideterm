<template>
  <div class="welcome-screen">
    <div class="welcome-screen__card">
      <h1 class="welcome-screen__title">Welcome to str<em>IDE</em>term</h1>
      <p class="welcome-screen__subtitle">Multi-workspace terminal hub for developers</p>
      <div class="welcome-screen__steps">
        <div class="welcome-screen__step">
          <span class="welcome-screen__step-num">1</span>
          <div>
            <strong>Review settings &amp; configure hooks</strong>
            <small
              >Set your theme, notification timings and agent hooks in
              <button
                type="button"
                class="welcome-screen__link"
                title="Open the Settings dialog — theme, notifications, agent hooks, SSH, tab templates, and more."
                @click="$emit('open-settings')"
              >
                Settings ⚙
              </button></small
            >
          </div>
        </div>
        <div class="welcome-screen__step">
          <span class="welcome-screen__step-num">2</span>
          <div>
            <strong>Create a workspace</strong>
            <small>Click <strong>+</strong> in the sidebar or press <strong>Ctrl+N</strong></small>
          </div>
        </div>
        <div class="welcome-screen__step">
          <span class="welcome-screen__step-num">3</span>
          <div>
            <strong>Pick a working directory</strong>
            <small>Browse to your project folder</small>
          </div>
        </div>
        <div class="welcome-screen__step">
          <span class="welcome-screen__step-num">4</span>
          <div>
            <strong>Add terminal tabs</strong>
            <small>Shell, Claude Code, Codex, Gemini, Dev Server, Browser...</small>
          </div>
        </div>
      </div>
      <div class="welcome-screen__actions">
        <button
          type="button"
          class="button button--ghost"
          title="Open the Settings dialog to configure theme, notifications, agent hooks, SSH defaults, and tab templates before creating a workspace."
          @click="$emit('open-settings')"
        >
          ⚙ Open Settings
        </button>
        <button
          type="button"
          class="button"
          title="Open the New Workspace picker — choose a kind (terminal, Docker, Azure DevOps, GitHub, plugin) and a working directory to create your first workspace."
          @click="$emit('new-workspace')"
        >
          + Create your first workspace
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
defineEmits<{
  (e: "new-workspace"): void;
  (e: "open-settings"): void;
}>();
</script>
