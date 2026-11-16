<template>
  <section class="registry-tab" data-testid="registry-settings">
    <h3 class="registry-tab__title">Package registries</h3>
    <p class="registry-tab__hint">
      A private Maven, npm, pip or Gradle registry that isolated agents may read. strIDEterm signs in on this machine
      and passes only <strong>GET and HEAD</strong> requests through; the sandbox never receives the token.
      {{ REGISTRY_TOKEN_ADVICE }}
    </p>

    <ul v-if="rows.length" class="registry-tab__list" data-testid="registry-list">
      <li
        v-for="row in rows"
        :key="row.id"
        class="registry-tab__row"
        :class="{ 'registry-tab__row--editing': row.id === editingId }"
        :aria-current="row.id === editingId ? 'true' : undefined"
      >
        <div>
          <strong>{{ row.label }}</strong>
          <small>{{ row.kind }} · {{ row.mode }} · {{ row.url }}</small>
          <small v-if="results[row.id]" :class="{ 'registry-tab__bad': !results[row.id].ok }" role="status">{{
            results[row.id].message
          }}</small>
        </div>
        <div class="registry-tab__actions">
          <button type="button" class="button button--ghost button--small" :disabled="busy" @click="test(row)">
            Test
          </button>
          <button type="button" class="button button--ghost button--small" :disabled="busy" @click="edit(row)">
            Edit
          </button>
          <button type="button" class="button button--ghost button--small" :disabled="busy" @click="remove(row)">
            Delete
          </button>
        </div>
      </li>
    </ul>
    <p v-else class="registry-tab__hint">No registries yet.</p>

    <form class="registry-tab__form" data-testid="registry-form" @submit.prevent="save">
      <h4>{{ editingId ? `Edit registry “${editingLabel}”` : "Add a registry" }}</h4>
      <label>
        <span>Name</span>
        <input v-model="form.label" type="text" maxlength="120" data-testid="registry-label" />
      </label>
      <label>
        <span>Type</span>
        <select v-model="form.kind" data-testid="registry-kind">
          <option v-for="kind in REGISTRY_KINDS" :key="kind" :value="kind">{{ kind }}</option>
        </select>
      </label>
      <label>
        <span>URL</span>
        <input v-model="form.url" type="url" :placeholder="URL_EXAMPLES[form.kind]" data-testid="registry-url" />
      </label>
      <label>
        <span>Use as</span>
        <select v-model="form.mode" data-testid="registry-mode">
          <option value="mirror">Mirror (replaces the default registry)</option>
          <option value="additional">Additional (searched next to it)</option>
        </select>
      </label>
      <label v-if="form.kind === 'npm'">
        <span>{{ form.mode === "additional" ? "npm scope (required)" : "npm scope (optional)" }}</span>
        <input v-model="form.npmScope" type="text" placeholder="@acme" data-testid="registry-scope" />
      </label>
      <label>
        <span>Sign-in</span>
        <select v-model="form.authKind" data-testid="registry-auth">
          <option value="none">None</option>
          <option value="basic">Username and password or token</option>
          <option value="bearer">Bearer token</option>
        </select>
        <small v-if="form.authKind !== 'none'" class="registry-tab__field-hint" data-testid="registry-auth-hint">
          Nexus, Artifactory: your user name and a user or access token. GitHub Packages: your GitHub user name and a
          token with <code>read:packages</code>. Azure Artifacts: any user name and a personal access token with
          Packaging (Read).
        </small>
      </label>
      <label v-if="form.authKind === 'basic'">
        <span>Username</span>
        <input v-model="form.username" type="text" autocomplete="off" data-testid="registry-username" />
      </label>
      <label v-if="form.authKind !== 'none'">
        <span>{{ form.authKind === "basic" ? "Password or token" : "Token" }}</span>
        <input
          v-model="form.secret"
          type="password"
          autocomplete="new-password"
          :placeholder="editingId ? 'Stored — leave empty to keep it' : ''"
          data-testid="registry-secret"
        />
      </label>
      <p v-if="formError" class="registry-tab__bad registry-tab__error" role="alert" data-testid="registry-form-error">
        {{ formError }}
      </p>
      <div class="registry-tab__actions">
        <button type="submit" class="button" :disabled="busy" data-testid="registry-save">Save</button>
        <button v-if="editingId" type="button" class="button button--ghost" :disabled="busy" @click="reset">
          Cancel
        </button>
      </div>
    </form>
  </section>
</template>

<script setup lang="ts">
import { computed, inject, reactive, ref } from "vue";
import { apiKey } from "../../../types/keys.js";
import { useAppStore } from "../../../stores/app.js";
import { useNotificationStore } from "../../../stores/notifications.js";
import { userFacingMessage } from "../../../lib/error-message.js";
import type { Transport } from "../../../transport.js";
import {
  REGISTRY_KINDS,
  REGISTRY_TOKEN_ADVICE,
  type RegistryConnection,
  type RegistryTestResult,
} from "../../../../electron/shared/registry.js";

const props = defineProps<{ connections?: RegistryConnection[] }>();

/** What a repository URL of each kind looks like on a typical private registry (Nexus / Artifactory layout). */
const URL_EXAMPLES: Record<RegistryConnection["kind"], string> = {
  maven: "https://registry.example.com/repository/maven-public/",
  gradle: "https://registry.example.com/repository/maven-public/",
  npm: "https://registry.example.com/repository/npm-group/",
  pip: "https://registry.example.com/repository/pypi-group/simple/",
};
const api = inject<Transport>(apiKey);
const store = useAppStore();

const busy = ref(false);
const formError = ref("");
const editingId = ref("");
const results = reactive<Record<string, RegistryTestResult>>({});

const profileId = computed(() => String(store.myActiveProfileId || "default"));
// The Settings dialog hands its tabs a copy of the settings taken when it opened; a registry saves through its own
// channel at once, so the list follows the live state, or it would not show what was just added.
const connections = computed<RegistryConnection[]>(
  () => store.payload?.appState?.settings?.integrations?.registry?.connections ?? props.connections ?? [],
);
const rows = computed(() =>
  connections.value.filter((connection) => (connection.profileId || "default") === profileId.value),
);
const editingLabel = computed(() => rows.value.find((row) => row.id === editingId.value)?.label ?? "");

function emptyForm() {
  return {
    label: "",
    kind: "maven" as RegistryConnection["kind"],
    url: "",
    mode: "mirror" as RegistryConnection["mode"],
    authKind: "basic" as RegistryConnection["authKind"],
    username: "",
    npmScope: "",
    secret: "",
  };
}
const form = reactive(emptyForm());

function reset() {
  editingId.value = "";
  formError.value = "";
  Object.assign(form, emptyForm());
}

function edit(row: RegistryConnection) {
  editingId.value = row.id;
  Object.assign(form, { ...row, secret: "" });
}

async function run(title: string, action: () => Promise<void>) {
  busy.value = true;
  try {
    await action();
  } catch (error) {
    useNotificationStore().showError(title, error);
  } finally {
    busy.value = false;
  }
}

// A refused save is the form's own answer (a missing URL, a wrong scheme): shown at the form, not as a toast.
// The runtime's IPC wrapper logs the refusal to strideterm.log.
async function save() {
  const save = api?.saveRegistryConnection;
  if (!save) return;
  busy.value = true;
  formError.value = "";
  try {
    const id = editingId.value || `registry-${globalThis.crypto.randomUUID()}`;
    await save({
      id,
      label: form.label.trim() || form.url,
      kind: form.kind,
      url: form.url.trim(),
      mode: form.mode,
      authKind: form.authKind,
      username: form.authKind === "basic" ? form.username.trim() : "",
      npmScope: form.kind === "npm" ? form.npmScope.trim() : "",
      ...(form.secret ? { secret: form.secret } : {}),
    });
    reset();
  } catch (error) {
    formError.value = userFacingMessage(error, "The registry could not be saved.");
  } finally {
    busy.value = false;
  }
}

async function remove(row: RegistryConnection) {
  const deleteRegistry = api?.deleteRegistryConnection;
  if (!deleteRegistry) return;
  await run("Could not delete the registry", async () => {
    await deleteRegistry(row.id);
    delete results[row.id];
    if (editingId.value === row.id) reset();
  });
}

async function test(row: RegistryConnection) {
  const testRegistry = api?.testRegistryConnection;
  if (!testRegistry) return;
  await run("Could not test the registry", async () => {
    results[row.id] = await testRegistry({ connectionId: row.id });
  });
}
</script>

<style scoped>
.registry-tab {
  display: grid;
  gap: 10px;
}
.registry-tab__title,
.registry-tab__form h4 {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
}
.registry-tab__hint {
  margin: 0;
  color: var(--muted);
  font-size: 12px;
  line-height: 1.4;
}
.registry-tab__list {
  display: grid;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.registry-tab__row {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
}
.registry-tab__row--editing {
  border-color: var(--accent);
  background: color-mix(in srgb, var(--accent) 8%, transparent);
  box-shadow: inset 3px 0 0 var(--accent);
}
.registry-tab__row small {
  display: block;
  color: var(--muted);
}
.registry-tab__bad {
  color: var(--danger, var(--text));
}
.registry-tab__field-hint {
  color: var(--muted);
  font-size: 11px;
  line-height: 1.4;
}
.registry-tab__error {
  margin: 0;
  font-size: 12px;
}
.registry-tab__actions {
  display: flex;
  gap: 6px;
  align-items: center;
}
.registry-tab__form {
  display: grid;
  gap: 8px;
  padding-top: 10px;
  border-top: 1px solid var(--border);
}
.registry-tab__form label {
  display: grid;
  gap: 3px;
  font-size: 12px;
  color: var(--muted);
}
</style>
