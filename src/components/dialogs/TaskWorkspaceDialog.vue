<template>
  <div class="dialog">
    <div class="dialog__header">
      <div>
        <p class="eyebrow">Agent Task Runner</p>
        <h2>Create task workspace</h2>
      </div>
      <button type="button" class="button button--ghost" @click="emit('cancel')">Close</button>
    </div>
    <form class="form" @submit.prevent="handleSubmit">
      <label>
        <span>Project directory <em class="required">*</em></span>
        <div class="input-with-action">
          <input v-model="draft.cwd" name="cwd" placeholder="Path to project root" required maxlength="500" />
          <button
            v-if="api?.browseDirectory"
            type="button"
            class="button button--ghost input-with-action__btn"
            @click="browseCwd"
          >
            Browse
          </button>
        </div>
      </label>

      <label
        title="This text will be written to TASK.md and sent as the initial prompt to the Worker agent. If left empty, the workspace opens without a task — you can write TASK.md manually or instruct the Worker directly in the terminal."
      >
        <span>Task assignment</span>
        <textarea
          v-model="draft.description"
          name="description"
          rows="5"
          placeholder='e.g. "Add pagination to the /api/users endpoint with 25 items per page. Include tests." — written to TASK.md and sent to the Worker. Leave empty to instruct the Worker manually.'
          maxlength="5000"
        />
      </label>

      <p v-if="!claudeAvailable" class="warning-box">
        Claude Code CLI (claude) was not found on your PATH. The Worker and Judge panels require it to run.
      </p>

      <p class="info-box">
        Control files (TASK.md, TODO.md, FINISH_CRITERIA.md, WORK_LOCK) are created automatically. Verification commands
        are auto-detected from your project. You can edit everything in the Dashboard after creation.
      </p>

      <div class="grid">
        <label>
          <span>Max rounds</span>
          <input v-model.number="draft.maxRounds" name="maxRounds" type="number" min="1" max="100" />
        </label>
      </div>

      <footer class="dialog__footer">
        <button type="button" class="button button--ghost" :disabled="submitting" @click="emit('cancel')">
          Cancel
        </button>
        <button type="submit" class="button" :disabled="!canSubmit || submitting">
          {{ submitting ? "Creating\u2026" : "Create workspace" }}
        </button>
      </footer>
    </form>
  </div>
</template>

<script setup>
import { reactive, computed, inject, ref } from "vue";
import { useAppStore } from "../../stores/app.js";

const props = defineProps({
  initialCwd: { type: String, default: "" },
});

const emit = defineEmits(["cancel", "submit"]);

const api = inject("api");
const store = useAppStore();

const draft = reactive({
  cwd: props.initialCwd || "",
  description: "",
  maxRounds: 10,
});

const submitting = ref(false);

// Claude availability is checked once at runtime startup and cached in payload
const claudeAvailable = computed(() => store.payload?.environment?.claudeAvailable !== false);

const canSubmit = computed(() => draft.cwd.trim());

async function browseCwd() {
  if (!api?.browseDirectory) return;
  const selected = await api.browseDirectory(draft.cwd || "");
  if (selected) draft.cwd = selected;
}

function handleSubmit() {
  submitting.value = true;
  emit("submit", {
    cwd: draft.cwd.trim(),
    description: draft.description.trim() || "",
    maxRounds: draft.maxRounds,
  });
}
</script>

<style scoped>
.required {
  color: #e57373;
  font-style: normal;
}
.warning-box {
  background: rgba(255, 152, 0, 0.12);
  border: 1px solid rgba(255, 152, 0, 0.3);
  color: #ffcc80;
  padding: 8px 12px;
  border-radius: 4px;
  font-size: 12px;
  line-height: 1.5;
}
</style>
