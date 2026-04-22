<template>
  <div class="dialog" style="width: min(460px, 100%)">
    <div class="dialog__header">
      <div>
        <p class="eyebrow">{{ eyebrow }}</p>
        <h2>{{ mode === "new" ? "New tab" : "Edit tab" }}</h2>
      </div>
      <button type="button" class="button button--ghost" @click="emit('cancel')">Close</button>
    </div>
    <form class="form" @submit.prevent="handleSubmit">
      <label>
        <span>Title</span>
        <div class="title-row">
          <button type="button" class="icon-btn" :title="'Pick icon'" @click="showIconPicker = !showIconPicker">
            {{ currentIcon || "\u{1F4BB}" }}
          </button>
          <input ref="titleRef" v-model="titleInput" class="title-input" maxlength="60" required />
        </div>
        <div v-if="showIconPicker" class="icon-picker">
          <button
            v-for="icon in BADGE_ICONS"
            :key="icon"
            type="button"
            class="icon-picker__btn"
            @click="pickIcon(icon)"
          >
            {{ icon }}
          </button>
        </div>
      </label>
      <label>
        <span>Command</span>
        <input v-model="commandInput" placeholder="optional boot command" maxlength="500" />
      </label>
      <footer class="dialog__footer">
        <button type="button" class="button button--ghost" @click="emit('cancel')">Cancel</button>
        <button type="submit" class="button">{{ mode === "new" ? "Create tab" : "Save" }}</button>
      </footer>
    </form>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from "vue";

const BADGE_ICONS = [
  "\u{1F4BB}",
  "\u{2328}",
  "\u{1F527}",
  "\u2699",
  "\u{1F6E0}",
  "\u{1F4E6}",
  "\u{1F528}",
  "\u{1F5A5}",
  "\u{1F4C4}",
  "\u{1F4DD}",
  "\u{270F}",
  "\u{2702}",
  "\u{1F33F}",
  "\u{1F500}",
  "\u{1F4CB}",
  "\u{1F433}",
  "\u{1F3D7}",
  "\u{2601}",
  "\u{1F310}",
  "\u{1F50C}",
  "\u{1F4E1}",
  "\u{1F680}",
  "\u{1F5C4}",
  "\u{1F4BE}",
  "\u{1F4CA}",
  "\u{1F4C8}",
  "\u{1F9EA}",
  "\u2705",
  "\u{1F50D}",
  "\u{1F41B}",
  "\u{1F916}",
  "\u{1F9E0}",
  "\u2728",
  "\u26A1",
  "\u{1F3AF}",
  "\u{1F512}",
  "\u{1F511}",
  "\u{1F4C1}",
  "\u{1F4A1}",
  "\u2B50",
  "\u{1F3A8}",
  "\u{1F525}",
  "\u{1F48E}",
  "\u{2764}",
  "\u{1F4AC}",
  "\u{1F514}",
  "\u{1F6A9}",
  "\u{1F5D1}",
];

const props = defineProps({
  eyebrow: { type: String, default: "Workspace" },
  title: { type: String, default: "" },
  command: { type: String, default: "" },
  mode: { type: String, default: "edit" },
});

const emit = defineEmits(["cancel", "submit"]);

const titleRef = ref(null);
const titleInput = ref(props.title);
const commandInput = ref(props.command);
const showIconPicker = ref(false);

const currentIcon = computed(() => {
  const match = String(titleInput.value || "").match(/^([\p{Emoji}\p{S}])\s*/u);
  return match ? match[1] : "";
});

function pickIcon(icon) {
  const rest = String(titleInput.value || "").replace(/^[\p{Emoji}\p{S}]\s*/u, "");
  titleInput.value = `${icon} ${rest}`.trimEnd();
  showIconPicker.value = false;
}

onMounted(() =>
  requestAnimationFrame(() => {
    titleRef.value?.focus();
    titleRef.value?.select();
  }),
);

function handleSubmit() {
  const nextTitle = titleInput.value.trim();
  if (!nextTitle) return;
  emit("submit", { title: nextTitle, command: commandInput.value.trim() });
}
</script>

<style scoped>
.title-row {
  display: flex;
  gap: 4px;
  align-items: stretch;
}
.icon-btn {
  width: 36px;
  flex-shrink: 0;
  display: grid;
  place-items: center;
  border: 1px solid var(--border);
  border-radius: 3px;
  background: rgba(255, 255, 255, 0.04);
  cursor: pointer;
  font-size: 16px;
  padding: 0;
}
.title-input {
  flex: 1;
  min-width: 0;
}
.icon-picker {
  display: flex;
  flex-wrap: wrap;
  gap: 3px;
  padding: 6px;
  margin-top: 4px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--panel);
  max-height: 160px;
  overflow-y: auto;
}
.icon-picker__btn {
  width: 28px;
  height: 28px;
  display: grid;
  place-items: center;
  border: 1px solid var(--border);
  border-radius: 3px;
  background: rgba(255, 255, 255, 0.04);
  cursor: pointer;
  font-size: 14px;
  padding: 0;
}
</style>
