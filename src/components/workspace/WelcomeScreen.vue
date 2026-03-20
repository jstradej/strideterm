<template>
  <div class="welcome-screen">
    <div class="welcome-screen__card">
      <h1 class="welcome-screen__title">Welcome to str<em>IDE</em>term</h1>
      <p class="welcome-screen__subtitle">Multi-workspace terminal hub for developers</p>
      <div class="welcome-screen__steps">
        <div class="welcome-screen__step">
          <span class="welcome-screen__step-num">1</span>
          <div>
            <strong>Create a workspace</strong>
            <small>Click <strong>+</strong> in the sidebar or press <strong>Ctrl+N</strong></small>
          </div>
        </div>
        <div class="welcome-screen__step">
          <span class="welcome-screen__step-num">2</span>
          <div>
            <strong>Pick a working directory</strong>
            <small>Browse to your project folder</small>
          </div>
        </div>
        <div class="welcome-screen__step">
          <span class="welcome-screen__step-num">3</span>
          <div>
            <strong>Add terminal tabs</strong>
            <small>Shell, Claude Code, Codex, Gemini, Dev Server, Browser...</small>
          </div>
        </div>
      </div>
      <button type="button" class="button" style="margin-top:16px;padding:10px 24px;font-size:14px;" @click="$emit('new-workspace')">
        + Create your first workspace
      </button>
    </div>
  </div>
</template>

<script setup>
defineEmits(["new-workspace"]);
</script>
