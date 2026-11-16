import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, test, vi } from "vitest";
import SettingsCredentialsTab from "./SettingsCredentialsTab.vue";
import { apiKey } from "../../../types/keys.js";
import { useAppStore } from "../../../stores/app.js";
import { useNotificationStore } from "../../../stores/notifications.js";
import type { CredentialOverview, CredentialRow } from "../../../../electron/shared/credential-overview.js";

const row = (overrides: Partial<CredentialRow>): CredentialRow => ({
  ref: "cred:ado-1",
  system: "azure",
  kind: "personal-access-token",
  ownerId: "ado-1",
  ownerLabel: "Corp ADO",
  profileId: "default",
  profileName: "Work",
  orphan: false,
  storage: "encrypted",
  manageUrl: "https://dev.azure.com/corp/_usersSettings/tokens",
  ...overrides,
});

const rows: CredentialRow[] = [
  row({}),
  row({
    ref: "ssh:key:k1",
    system: "ssh",
    kind: "ssh-private-key",
    ownerId: "ssh:key:k1",
    ownerLabel: "Laptop key",
    profileId: "",
    profileName: "All profiles",
    storage: "plain",
    manageUrl: undefined,
  }),
  row({
    ref: "cred:gone",
    system: "connection",
    kind: "connection-token",
    ownerId: "",
    ownerLabel: "",
    profileId: "",
    profileName: "",
    orphan: true,
    manageUrl: undefined,
  }),
  row({
    ref: "jira:j2:pat",
    system: "jira",
    ownerId: "j2",
    ownerLabel: "Other Jira",
    profileId: "elsewhere",
    profileName: "Client B",
    manageUrl: undefined,
  }),
];

function mountTab(api: Record<string, unknown>) {
  const confirmInApp = vi.fn(async (_options: { title: string; message: string }) => true);
  (useAppStore() as unknown as { confirmInApp: typeof confirmInApp }).confirmInApp = confirmInApp;
  const listCredentials = vi.fn(async (): Promise<CredentialOverview> => ({
    rows: structuredClone(rows),
    encryptionAvailable: true,
  }));
  const wrapper = mount(SettingsCredentialsTab, {
    global: { provide: { [apiKey]: { listCredentials, ...api } } },
  });
  return { wrapper, confirmInApp, listCredentials };
}

describe("SettingsCredentialsTab", () => {
  beforeEach(() => setActivePinia(createPinia()));

  test("lists metadata grouped by system, with storage, status and only certain provider links", async () => {
    const { wrapper } = mountTab({ openExternal: vi.fn() });
    await flushPromises();
    const text = wrapper.text();
    expect(wrapper.findAll('[data-testid="credential-row"]')).toHaveLength(4);
    expect(wrapper.find('[data-testid="credentials-azure"]').text()).toContain("Corp ADO");
    expect(wrapper.find('[data-testid="credentials-azure"]').text()).toContain("Work");
    expect(wrapper.find('[data-testid="credentials-ssh"]').text()).toContain("Plain text");
    expect(wrapper.find('[data-testid="credentials-azure"]').text()).toContain("Encrypted");
    expect(wrapper.find('[data-testid="credentials-connection"]').text()).toContain("Unused");
    expect(text.match(/Manage at provider/gu)).toHaveLength(1);
  });

  test("an empty store shows the empty state and no bulk action", async () => {
    const { wrapper } = mountTab({
      listCredentials: vi.fn(async () => ({ rows: [], encryptionAvailable: true })),
    });
    await flushPromises();
    expect(wrapper.find('[data-testid="credentials-empty"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="credentials-remove-orphans"]').exists()).toBe(false);
  });

  test("warns when the keychain is unavailable", async () => {
    const { wrapper } = mountTab({
      listCredentials: vi.fn(async () => ({ rows: structuredClone(rows), encryptionAvailable: false })),
    });
    await flushPromises();
    expect(wrapper.text()).toContain("Secure storage is not available");
  });

  test("removal asks first, naming the system and the owner, then deletes that reference and reloads", async () => {
    const removeCredential = vi.fn(async (_ref: string) => ({ removed: 1 }));
    const { wrapper, confirmInApp, listCredentials } = mountTab({ removeCredential });
    await flushPromises();
    await wrapper
      .findAll("button")
      .find((b) => b.text() === "Remove")!
      .trigger("click");
    await flushPromises();
    const asked = confirmInApp.mock.calls[0][0];
    expect(asked.message).toContain("Azure DevOps");
    expect(asked.message).toContain("Corp ADO");
    expect(asked.message).toContain("not revoked at the provider");
    expect(asked.message).not.toContain("recovered");
    expect(removeCredential).toHaveBeenCalledWith("cred:ado-1");
    expect(listCredentials).toHaveBeenCalledTimes(2);
  });

  test("removing an SSH private key adds the warning that it is gone for good", async () => {
    const removeCredential = vi.fn(async (_ref: string) => ({ removed: 1 }));
    const { wrapper, confirmInApp } = mountTab({ removeCredential });
    await flushPromises();
    const sshRow = wrapper.find('[data-testid="credentials-ssh"]');
    await sshRow
      .findAll("button")
      .find((b) => b.text() === "Remove")!
      .trigger("click");
    await flushPromises();
    expect(confirmInApp.mock.calls[0][0].message).toContain("Laptop key");
    expect(confirmInApp.mock.calls[0][0].message).toContain("no other copy");
    expect(removeCredential).toHaveBeenCalledWith("ssh:key:k1");
  });

  test("declining the confirmation removes nothing", async () => {
    const removeCredential = vi.fn(async (_ref: string) => ({ removed: 1 }));
    const { wrapper, confirmInApp } = mountTab({ removeCredential });
    confirmInApp.mockResolvedValue(false);
    await flushPromises();
    await wrapper
      .findAll("button")
      .find((b) => b.text() === "Remove")!
      .trigger("click");
    await flushPromises();
    expect(removeCredential).not.toHaveBeenCalled();
  });

  test("a failed removal shows an error toast instead of vanishing", async () => {
    const showError = vi.spyOn(useNotificationStore(), "showError");
    const removeCredential = vi.fn(async (_ref: string) => {
      throw new Error("disk is full");
    });
    const { wrapper } = mountTab({ removeCredential });
    await flushPromises();
    await wrapper
      .findAll("button")
      .find((b) => b.text() === "Remove")!
      .trigger("click");
    await flushPromises();
    expect(showError).toHaveBeenCalledWith("Could not remove the credential", expect.any(Error));
  });

  test("Remove unused states the count, and only the orphan action is offered in bulk", async () => {
    const removeOrphanCredentials = vi.fn(async () => ({ removed: 1 }));
    const { wrapper, confirmInApp } = mountTab({ removeOrphanCredentials });
    await flushPromises();
    const bulk = wrapper.find('[data-testid="credentials-remove-orphans"]');
    expect(bulk.text()).toContain("(1)");
    expect(wrapper.text()).not.toMatch(/remove all/iu);
    await bulk.trigger("click");
    await flushPromises();
    expect(confirmInApp.mock.calls[0][0].message).toContain("1 stored credential is");
    expect(removeOrphanCredentials).toHaveBeenCalledTimes(1);
  });

  test("a failed bulk removal shows an error toast", async () => {
    const showError = vi.spyOn(useNotificationStore(), "showError");
    const { wrapper } = mountTab({
      removeOrphanCredentials: vi.fn(async () => {
        throw new Error("nope");
      }),
    });
    await flushPromises();
    await wrapper.find('[data-testid="credentials-remove-orphans"]').trigger("click");
    await flushPromises();
    expect(showError).toHaveBeenCalledWith("Could not remove the unused credentials", expect.any(Error));
  });

  test("Change is offered for a used credential, disabled for another profile's, absent for an orphan", async () => {
    const { wrapper } = mountTab({});
    await flushPromises();
    const change = (testid: string) =>
      wrapper
        .find(`[data-testid="${testid}"]`)
        .findAll("button")
        .find((b) => b.text() === "Change");
    expect(change("credentials-ssh")!.attributes("disabled")).toBeUndefined();
    expect(change("credentials-jira")!.attributes("disabled")).toBeDefined();
    expect(change("credentials-connection")).toBeUndefined();
    await change("credentials-ssh")!.trigger("click");
    expect(wrapper.emitted("change")?.[0]?.[0]).toMatchObject({ ref: "ssh:key:k1" });
  });

  test("Manage at provider opens the stored address and reports a failure", async () => {
    const openExternal = vi.fn(async (_url: string) => undefined);
    const { wrapper } = mountTab({ openExternal });
    await flushPromises();
    await wrapper
      .findAll("button")
      .find((b) => b.text() === "Manage at provider")!
      .trigger("click");
    expect(openExternal).toHaveBeenCalledWith("https://dev.azure.com/corp/_usersSettings/tokens");

    const showError = vi.spyOn(useNotificationStore(), "showError");
    openExternal.mockRejectedValueOnce(new Error("blocked"));
    await wrapper
      .findAll("button")
      .find((b) => b.text() === "Manage at provider")!
      .trigger("click");
    await flushPromises();
    expect(showError).toHaveBeenCalledWith("Could not open the provider's page", expect.any(Error));
  });

  test("an unreadable store says so and offers a retry", async () => {
    const showError = vi.spyOn(useNotificationStore(), "showError");
    const { wrapper } = mountTab({
      listCredentials: vi.fn(async () => {
        throw new Error("locked");
      }),
    });
    await flushPromises();
    expect(wrapper.find('[data-testid="credentials-load-failed"]').exists()).toBe(true);
    expect(showError).toHaveBeenCalled();
  });
});
