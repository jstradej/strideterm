/**
 * ConnectionDialog.vue merges AzureConnectionDialog.vue and
 * GitHubConnectionDialog.vue into one component parametrized by a `provider`
 * prop (review 2026-07 §3.1 point 6). These tests cover both the shared
 * picker-rejection regression (previously duplicated per-dialog) and the
 * provider-specific field set / verification panel / save payload shape.
 */
import { describe, expect, test, beforeEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import ConnectionDialog from "./ConnectionDialog.vue";
import { apiKey } from "../../types/keys.js";
import { useNotificationStore } from "../../stores/notifications.js";

beforeEach(() => {
  setActivePinia(createPinia());
});

describe("ConnectionDialog — browseReviewRoot", () => {
  test.each(["azure", "github"] as const)(
    "provider=%s: a rejecting browseDirectory shows an error notification instead of throwing",
    async (provider) => {
      const browseDirectory = vi.fn().mockRejectedValueOnce(new Error("picker crashed"));
      const wrapper = mount(ConnectionDialog, {
        props: { provider },
        global: { provide: { [apiKey]: { browseDirectory } } },
      });

      const browseBtn = wrapper.findAll("button").find((b) => b.text() === "Browse")!;
      await browseBtn.trigger("click");
      await flushPromises();

      expect(browseDirectory).toHaveBeenCalled();
      const notifications = useNotificationStore();
      expect(notifications.sessions).toHaveLength(1);
      expect(notifications.sessions[0].events[0].title).toBe("Failed to open picker");
    },
  );
});

describe("ConnectionDialog — provider defaults to azure", () => {
  test("renders the Azure DevOps header, Organization URL, Login/UPN, and Project filters", () => {
    const wrapper = mount(ConnectionDialog);
    expect(wrapper.find(".eyebrow").text()).toBe("Azure DevOps");
    expect(wrapper.text()).toContain("Organization URL");
    expect(wrapper.text()).toContain("Login / UPN");
    expect(wrapper.text()).toContain("Project filters");
    expect(wrapper.text()).not.toContain("Host URL");
    expect(wrapper.text()).not.toContain("Owner filters");
  });

  test("Label/PollSeconds and filter rows use the two-col grid class", () => {
    const wrapper = mount(ConnectionDialog);
    expect(wrapper.find(".grid.grid--two-col").exists()).toBe(true);
  });

  test("Test connection calls verifyAzureConnection and renders the project-chip verification panel", async () => {
    const verifyAzureConnection = vi.fn().mockResolvedValue({ projectCount: 2, projects: [{ name: "Alpha" }] });
    const wrapper = mount(ConnectionDialog, {
      global: { provide: { [apiKey]: { verifyAzureConnection } } },
    });

    await wrapper.find('input[placeholder="https://dev.azure.com/your-org"]').setValue("https://dev.azure.com/org");
    await wrapper.find('input[placeholder="me@company.com"]').setValue("me@company.com");
    await wrapper
      .findAll("button")
      .find((b) => b.text().includes("Test connection"))!
      .trigger("click");
    await flushPromises();

    expect(verifyAzureConnection).toHaveBeenCalled();
    expect(wrapper.text()).toContain("2 projects available");
    expect(wrapper.text()).toContain("Alpha");
  });

  test("submitting builds the Azure-shaped payload (orgUrl/login/projectFilters, no hostUrl/ownerFilters)", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const wrapper = mount(ConnectionDialog, { props: { onSave } });

    await wrapper.find('input[placeholder="https://dev.azure.com/your-org"]').setValue("https://dev.azure.com/org");
    await wrapper.find('input[placeholder="me@company.com"]').setValue("me@company.com");
    await wrapper.find('input[placeholder="Platform, Mobile"]').setValue("Platform, Mobile");
    await wrapper.find("form").trigger("submit");
    await flushPromises();

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        orgUrl: "https://dev.azure.com/org",
        login: "me@company.com",
        projectFilters: ["Platform", "Mobile"],
      }),
    );
    const payload = onSave.mock.calls[0][0];
    expect(payload).not.toHaveProperty("hostUrl");
    expect(payload).not.toHaveProperty("ownerFilters");
  });
});

describe("ConnectionDialog — provider=github", () => {
  function mountGitHub(props: Record<string, unknown> = {}, provide: Record<string, unknown> = {}) {
    return mount(ConnectionDialog, {
      props: { provider: "github", ...props },
      global: { provide },
    });
  }

  test("renders the GitHub header, Host URL (defaulted), Owner filters, and no Login/Organization fields", () => {
    const wrapper = mountGitHub();
    expect(wrapper.find(".eyebrow").text()).toBe("GitHub");
    expect(wrapper.text()).toContain("Host URL");
    expect(wrapper.text()).toContain("Owner filters");
    expect(wrapper.text()).not.toContain("Organization URL");
    expect(wrapper.text()).not.toContain("Login / UPN");
    expect(wrapper.text()).not.toContain("Project filters");
    expect((wrapper.find('input[placeholder="https://github.com"]').element as HTMLInputElement).value).toBe(
      "https://github.com",
    );
  });

  test("Label/PollSeconds and filter rows use the plain (non-two-col) grid class", () => {
    const wrapper = mountGitHub();
    expect(wrapper.findAll(".grid").every((el) => !el.classes().includes("grid--two-col"))).toBe(true);
  });

  test("does not render Azure-only tooltips on shared fields", () => {
    const wrapper = mountGitHub();
    const labelInput = wrapper.find('input[maxlength="60"]');
    expect(labelInput.attributes("title")).toBeUndefined();
  });

  test("shows GitHub-only reviewer-count-style inline reviewer badges are not applicable here — verification panel renders an identity sentence instead", async () => {
    const verifyGitHubConnection = vi.fn().mockResolvedValue({ login: "octocat", name: "The Octocat" });
    const wrapper = mountGitHub({}, { [apiKey]: { verifyGitHubConnection } });

    await wrapper
      .findAll("button")
      .find((b) => b.text().includes("Test connection"))!
      .trigger("click");
    await flushPromises();

    expect(verifyGitHubConnection).toHaveBeenCalled();
    expect(wrapper.text()).toContain("Authenticated as");
    expect(wrapper.text()).toContain("octocat");
    expect(wrapper.text()).toContain("The Octocat");
    expect(wrapper.text()).not.toContain("projects available");
  });

  test("submitting builds the GitHub-shaped payload (hostUrl/ownerFilters, no orgUrl/login/projectFilters)", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const wrapper = mountGitHub({ onSave });

    await wrapper.find('input[placeholder="my-org, my-user"]').setValue("my-org, my-user");
    await wrapper.find("form").trigger("submit");
    await flushPromises();

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        hostUrl: "https://github.com",
        ownerFilters: ["my-org", "my-user"],
      }),
    );
    const payload = onSave.mock.calls[0][0];
    expect(payload).not.toHaveProperty("orgUrl");
    expect(payload).not.toHaveProperty("login");
    expect(payload).not.toHaveProperty("projectFilters");
  });
});
