<template>
  <div class="dialog" style="width: min(460px, 100%)">
    <div class="dialog__header">
      <div>
        <p class="eyebrow">Agent Task Runner</p>
        <h2>Agent hooks not configured</h2>
      </div>
      <button type="button" class="button button--ghost" @click="emit('cancel')">Close</button>
    </div>
    <div class="form">
      <p class="info-box info-box--warning">
        The task runner relies on agent hooks to detect when the Worker and Judge finish their work. Without hooks, idle
        detection falls back to a
        <strong>{{ needsSettingEnable ? "12-20 second" : "2 minute" }}</strong> silence timeout on every round, which
        slows down the entire task significantly.
      </p>
      <p v-if="needsSettingEnable" style="font-size: 13px; color: var(--text-muted); margin: 0">
        The agent hook setting is currently disabled. Configuring will enable it and install the notification hook into
        {{ providerDisplayName }}.
      </p>
      <p v-else style="font-size: 13px; color: var(--text-muted); margin: 0">
        The hook notification script needs to be registered in {{ providerDisplayName }}'s settings. This is a one-time
        setup.
      </p>
      <footer class="dialog__footer" style="gap: 8px">
        <button
          type="button"
          class="button button--ghost"
          title="Don't start the task — close this dialog and return to the Dashboard so you can configure hooks manually first."
          @click="emit('cancel')"
        >
          Cancel
        </button>
        <button
          type="button"
          class="button button--ghost"
          title="Start the task anyway with hooks disabled — the runner will fall back to a silence-based heuristic, which adds delay between rounds."
          @click="emit('skip')"
        >
          Start without hooks
        </button>
        <button
          type="button"
          class="button"
          :title="`Install the strIDEterm notification hook into ${providerDisplayName}'s settings file (one-time setup) and immediately start the task. Recommended.`"
          @click="emit('configure')"
        >
          Configure &amp; start
        </button>
      </footer>
    </div>
  </div>
</template>

<script setup lang="ts">
interface Props {
  needsSettingEnable?: boolean;
  providerDisplayName?: string;
}

withDefaults(defineProps<Props>(), {
  needsSettingEnable: false,
  providerDisplayName: "Claude Code",
});

const emit = defineEmits<{
  cancel: [];
  skip: [];
  configure: [];
}>();
</script>

<style scoped>
.info-box--warning {
  color: var(--text);
  font-size: 13px;
  line-height: 1.5;
  border: 1px solid rgba(255, 180, 50, 0.35);
  border-radius: 4px;
  padding: 10px 12px;
  background: rgba(255, 180, 50, 0.08);
}
</style>
