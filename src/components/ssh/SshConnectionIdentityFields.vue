<template>
  <div class="ssh-identity-fields">
    <label class="field">
      <span>Host or SSH alias <HelpTooltip :text="hostHelp" label="Host or SSH alias help" /></span>
      <input
        :value="host"
        class="input"
        :placeholder="hostPlaceholder"
        required
        @input="
          emit('update:host', ($event.target as HTMLInputElement).value);
          emit('host-input');
        "
      />
    </label>
    <label class="field">
      <span>Username <HelpTooltip :text="usernameHelp" label="Username help" /></span>
      <input
        :value="username"
        class="input"
        placeholder="alice"
        :required="requireUsername"
        autocomplete="off"
        @input="emit('update:username', ($event.target as HTMLInputElement).value)"
      />
    </label>
  </div>
</template>

<script setup lang="ts">
import HelpTooltip from "../common/HelpTooltip.vue";

withDefaults(
  defineProps<{
    host: string;
    username: string;
    requireUsername?: boolean;
    hostPlaceholder?: string;
    hostHelp?: string;
    usernameHelp?: string;
  }>(),
  {
    requireUsername: false,
    hostPlaceholder: "server.example.com or prod",
    hostHelp:
      "Enter a server address. With SSH on this computer or SSH in WSL, you can also use an alias from that environment's SSH config. Built-in SSH needs a server address.",
    usernameHelp:
      "This is the account on the remote server. Built-in SSH requires it. With SSH on this computer or in WSL, leave it empty to let that environment's SSH config choose the account.",
  },
);

const emit = defineEmits<{
  "update:host": [value: string];
  "update:username": [value: string];
  "host-input": [];
}>();
</script>

<style scoped>
.ssh-identity-fields {
  display: contents;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.field > span {
  font-size: 13px;
  font-weight: 600;
}
.input {
  width: 100%;
  padding: 8px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.05);
  color: var(--text);
  font: inherit;
}
</style>
