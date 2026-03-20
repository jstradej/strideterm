<template>
  <div class="review-panel">
    <div style="display:flex;gap:4px;padding:0 0 8px;">
      <button type="button" :class="['button', 'button--ghost', reviewUi.agentSubTab !== 'connect' && 'button--active']" :style="reviewUi.agentSubTab !== 'connect' ? 'font-size:12px;padding:4px 12px;background:var(--accent);color:var(--bg);' : 'font-size:12px;padding:4px 12px;'" @click="gitUiStore.reviewSetAgentSubtab(workspaceId, 'prompts')">Prompts</button>
      <button type="button" :class="['button', 'button--ghost', reviewUi.agentSubTab === 'connect' && 'button--active']" :style="reviewUi.agentSubTab === 'connect' ? 'font-size:12px;padding:4px 12px;background:var(--accent);color:var(--bg);' : 'font-size:12px;padding:4px 12px;'" @click="gitUiStore.reviewSetAgentSubtab(workspaceId, 'connect')">Connect your agent</button>
    </div>
    <article v-if="reviewUi.agentSubTab !== 'connect'" class="git-card review-card review-card--stack">
      <div class="section-head"><div><p class="eyebrow">Review Prompts</p><h3>Ready-to-use prompts for AI agents</h3></div></div>
      <p class="git-card__hint">Copy a prompt and paste it into Claude Code, Codex, or any MCP-capable agent.</p>
      <div class="docker-list review-card__list review-card__list--dense review-agent-prompts">
        <template v-if="agentPrompts.length">
          <article v-for="prompt in agentPrompts" :key="prompt.promptId" class="docker-card review-agent-card">
            <div class="docker-card__head">
              <div><h4>{{ prompt.title }}</h4><p v-if="prompt.description" class="docker-card__meta">{{ prompt.description }}</p></div>
              <div style="display:flex;gap:4px;align-items:center;">
                <button type="button" class="button button--ghost review-copy-btn" :title="'Copy to clipboard'" @click="appStore.copyText(renderPrompt(prompt))">📋</button>
                <button type="button" class="button button--ghost review-copy-btn" title="Edit this prompt" @click="editAgentPrompt(prompt)">✎</button>
                <button v-if="!prompt.isDefault" type="button" :class="['button', 'button--ghost', 'review-copy-btn', 'danger', busyAction === `delete-${prompt.promptId}` && 'button--busy']" :disabled="!!busyAction" title="Delete this prompt" @click="handleDeletePrompt(prompt.promptId)">🗑</button>
              </div>
            </div>
            <pre class="git-output review-agent-prompt">{{ renderPrompt(prompt) }}</pre>
          </article>
        </template>
        <p v-else class="git-card__hint">No prompts configured.</p>
      </div>
    </article>
    <article v-else class="git-card review-card">
      <div class="section-head"><div><p class="eyebrow">Connect Any MCP Agent</p><h3>Use the review bridge with your own agent</h3></div></div>
      <p class="git-card__hint">Claude Code and Codex get MCP tools auto-attached when launched in this workspace. For other agents, configure the MCP server manually.</p>
      <div style="margin-top:12px;">
        <p class="eyebrow" style="margin-bottom:4px;">MCP Server Command</p>
        <pre class="git-output review-agent-prompt" style="font-size:11px;padding:8px;margin:0;">{{ mcpCommandLine }}</pre>
      </div>
    </article>
  </div>
</template>

<script setup>
import { ref } from "vue";
import { useAppStore } from "../../../stores/app.js";
import { useGitUiStore } from "../../../stores/git-ui.js";

const props = defineProps({
  prKey: { type: String, required: true },
  workspaceId: { type: String, required: true },
  pullRequest: { type: Object, required: true },
  agentPrompts: { type: Array, required: true },
  mcpCommandLine: { type: String, required: true },
  reviewUi: { type: Object, required: true },
});

const appStore = useAppStore();
const gitUiStore = useGitUiStore();

const busyAction = ref("");

async function handleDeletePrompt(promptId) {
  busyAction.value = `delete-${promptId}`;
  try { await appStore.deleteAgentPrompt(promptId); }
  finally { busyAction.value = ""; }
}

function renderPrompt(prompt) {
  const prId = String(props.pullRequest.id || "?");
  const prTitle = props.pullRequest.title || "";
  return (prompt.template || "").replace(/\{prId\}/g, prId).replace(/\{prTitle\}/g, prTitle);
}

function editAgentPrompt(prompt) {
  appStore.openDialog("TextAreaDialog", {
    eyebrow: "Agent Prompt",
    title: `Edit: ${prompt.title}`,
    label: "Prompt template",
    value: prompt.template || "",
    placeholder: "Enter the prompt template...",
    submitLabel: "Save prompt",
    onCancel: () => appStore.closeDialog(),
    onSubmit: (content) => { appStore.saveAgentPrompt({ promptId: prompt.promptId, title: prompt.title, description: prompt.description, template: content }); appStore.closeDialog(); },
  });
}
</script>
