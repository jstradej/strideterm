import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, test, vi } from "vitest";
import SettingsRegistryTab from "./SettingsRegistryTab.vue";
import CustomSelect from "../../common/CustomSelect.vue";
import { apiKey } from "../../../types/keys.js";
import { useNotificationStore } from "../../../stores/notifications.js";
import { useAppStore } from "../../../stores/app.js";
import { registrySaveSchema } from "../../../../electron/backend/ipc-schemas.js";
import type { RegistryConnection } from "../../../../electron/shared/registry.js";

const connection: RegistryConnection = {
  id: "r1",
  profileId: "default",
  label: "Corp Maven",
  kind: "maven",
  url: "https://repo.corp.example/maven",
  mode: "mirror",
  authKind: "basic",
  username: "svc",
  npmScope: "",
};

function pick(wrapper: ReturnType<typeof mountTab>, testId: string, value: string) {
  const select = wrapper.findAllComponents(CustomSelect).find((c) => c.attributes("data-testid") === testId);
  if (!select) throw new Error(`select ${testId} not found`);
  return select.setValue(value);
}

function mountTab(api: Record<string, unknown>, connections: RegistryConnection[] = [connection]) {
  return mount(SettingsRegistryTab, {
    props: { connections } as never,
    global: { provide: { [apiKey]: api } },
  });
}

describe("SettingsRegistryTab", () => {
  beforeEach(() => setActivePinia(createPinia()));

  test("lists the profile's registries, never a secret, and recommends the narrowest token", () => {
    const wrapper = mountTab({}, [
      connection,
      { ...connection, id: "other", profileId: "elsewhere", label: "Other profile" },
    ]);
    expect(wrapper.get('[data-testid="registry-list"]').text()).toContain("Corp Maven");
    expect(wrapper.text()).not.toContain("Other profile");
    expect(wrapper.text()).toContain("read-only");
    expect(wrapper.text()).toContain("GET and HEAD");
  });

  test("follows the live state, not the copy the Settings dialog took when it opened", async () => {
    const wrapper = mountTab({}, []);
    expect(wrapper.find('[data-testid="registry-list"]').exists()).toBe(false);
    useAppStore().payload = {
      appState: { settings: { integrations: { registry: { connections: [connection] } } } },
    } as never;
    await flushPromises();
    expect(wrapper.get('[data-testid="registry-list"]').text()).toContain("Corp Maven");
  });

  test("shows a URL example for the chosen kind and sign-in advice only when a sign-in is used", async () => {
    const wrapper = mountTab({}, []);
    const url = () => wrapper.get('[data-testid="registry-url"]').attributes("placeholder");
    expect(url()).toContain("maven");
    await pick(wrapper, "registry-kind", "pip");
    expect(url()).toMatch(/pypi.*\/simple\/$/u);
    await pick(wrapper, "registry-kind", "npm");
    expect(url()).toContain("npm");
    expect(wrapper.find('[data-testid="registry-auth-hint"]').text()).toContain("read:packages");
    await pick(wrapper, "registry-auth", "none");
    expect(wrapper.find('[data-testid="registry-auth-hint"]').exists()).toBe(false);
  });

  test("marks the registry being edited and names it above the form", async () => {
    const wrapper = mountTab({}, [connection, { ...connection, id: "r2", label: "Second" }]);
    await wrapper
      .findAll("button")
      .find((button) => button.text() === "Edit")!
      .trigger("click");
    const rows = wrapper.findAll(".registry-tab__row");
    expect(rows[0].classes()).toContain("registry-tab__row--editing");
    expect(rows[0].attributes("aria-current")).toBe("true");
    expect(rows[1].classes()).not.toContain("registry-tab__row--editing");
    expect(wrapper.get('[data-testid="registry-form"] h4').text()).toBe("Edit registry “Corp Maven”");
  });

  test("saves a payload the real schema accepts, with the secret only when one was typed", async () => {
    const saveRegistryConnection = vi.fn(async (_payload: unknown) => ({ ok: true }));
    const wrapper = mountTab({ saveRegistryConnection }, []);
    await wrapper.get('[data-testid="registry-label"]').setValue("Corp");
    await wrapper.get('[data-testid="registry-url"]').setValue("https://repo.corp.example/maven");
    await wrapper.get('[data-testid="registry-username"]').setValue("svc");
    await wrapper.get('[data-testid="registry-secret"]').setValue("s3cret");
    await wrapper.get('[data-testid="registry-form"]').trigger("submit");
    await flushPromises();
    const payload = saveRegistryConnection.mock.calls[0][0] as Record<string, unknown>;
    expect(registrySaveSchema.safeParse(payload).success).toBe(true);
    expect(payload).toMatchObject({
      kind: "maven",
      mode: "mirror",
      authKind: "basic",
      username: "svc",
      secret: "s3cret",
    });
    expect(String(payload.id)).toMatch(/^registry-/u);
    expect((wrapper.get('[data-testid="registry-secret"]').element as HTMLInputElement).value).toBe("");
  });

  test("editing keeps the stored secret: nothing is sent unless a new one is typed", async () => {
    const saveRegistryConnection = vi.fn(async (_payload: unknown) => ({ ok: true }));
    const wrapper = mountTab({ saveRegistryConnection });
    await wrapper
      .findAll("button")
      .find((button) => button.text() === "Edit")!
      .trigger("click");
    expect((wrapper.get('[data-testid="registry-secret"]').element as HTMLInputElement).placeholder).toContain(
      "leave empty",
    );
    await wrapper.get('[data-testid="registry-form"]').trigger("submit");
    await flushPromises();
    const payload = saveRegistryConnection.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.id).toBe("r1");
    expect(payload).not.toHaveProperty("secret");
    expect(registrySaveSchema.safeParse(payload).success).toBe(true);
  });

  test("a refused save is shown at the form, not as a toast, and the form keeps what was typed", async () => {
    const wrapper = mountTab({
      saveRegistryConnection: vi.fn(async () => {
        throw new Error("Error invoking remote method 'registry:save': Error: Enter the registry URL.");
      }),
    });
    const showError = vi.spyOn(useNotificationStore(), "showError");
    await wrapper.get('[data-testid="registry-label"]').setValue("asdf");
    await wrapper.get('[data-testid="registry-form"]').trigger("submit");
    await flushPromises();

    expect(wrapper.get('[data-testid="registry-form-error"]').text()).toBe("Enter the registry URL.");
    expect(showError).not.toHaveBeenCalled();
    expect((wrapper.get('[data-testid="registry-label"]').element as HTMLInputElement).value).toBe("asdf");
  });

  test("a failed save, test or delete reaches the user", async () => {
    const boom = vi.fn(async () => {
      throw new Error("refused");
    });
    const wrapper = mountTab({
      saveRegistryConnection: boom,
      testRegistryConnection: boom,
      deleteRegistryConnection: boom,
    });
    const showError = vi.spyOn(useNotificationStore(), "showError");
    await wrapper.get('[data-testid="registry-form"]').trigger("submit");
    for (const label of ["Test", "Delete"]) {
      await wrapper
        .findAll("button")
        .find((button) => button.text() === label)!
        .trigger("click");
    }
    await flushPromises();
    expect(wrapper.get('[data-testid="registry-form-error"]').text()).toBe("refused");
    expect(showError).toHaveBeenCalledTimes(2);
  });

  test("shows what a test found, in words", async () => {
    const wrapper = mountTab({
      testRegistryConnection: vi.fn(async () => ({
        ok: false,
        status: 401,
        message: "The registry refused the stored sign-in (401).",
      })),
    });
    await wrapper
      .findAll("button")
      .find((button) => button.text() === "Test")!
      .trigger("click");
    await flushPromises();
    expect(wrapper.get("[role=status]").text()).toContain("refused the stored sign-in");
  });
});
