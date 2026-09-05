import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, test, vi } from "vitest";
import SettingsTelegramTab from "./SettingsTelegramTab.vue";
import { apiKey } from "../../../types/keys.js";

describe("SettingsTelegramTab", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  test("saves the selected profile id with a Telegram connection", async () => {
    const saveTelegramConnection = vi.fn(async () => ({
      payload: {
        appState: {
          settings: {
            integrations: {
              telegram: {
                connections: [],
              },
            },
          },
        },
      },
    }));

    const wrapper = mount(SettingsTelegramTab, {
      props: {
        profiles: [
          { id: "personal", name: "Personal" },
          { id: "work", name: "Work" },
        ],
        telegramSettings: {
          defaultPollSeconds: 5,
          connections: [
            {
              id: "tg-1",
              label: "Bot",
              botTokenRef: "cred:tg-1",
              chatId: "12345",
              enabled: true,
              pollSeconds: 5,
              profileId: "",
              forwardKinds: [],
            },
          ],
        },
      },
      global: {
        provide: {
          [apiKey]: {
            saveTelegramConnection,
            refreshTelegram: vi.fn(),
          },
        },
      },
    });

    await wrapper.find(".connection-item__header").trigger("click");
    await wrapper.find("select").setValue("work");
    await wrapper
      .findAll("button")
      .find((button) => button.text() === "Save connection")!
      .trigger("click");

    expect(saveTelegramConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "tg-1",
        profileId: "work",
      }),
    );
  });

  // openAddForm/addDraft/editDraft all built their blank shape independently
  // (3 copies) before being unified onto one makeBlankDraft() factory.
  // Reopening the add form after cancelling a partially-filled one must still
  // come back blank.
  test("re-opening the add form after cancel discards the previous draft", async () => {
    const wrapper = mount(SettingsTelegramTab, {
      props: {
        profiles: [],
        telegramSettings: { defaultPollSeconds: 5, connections: [] },
      },
      global: {
        provide: {
          [apiKey]: { saveTelegramConnection: vi.fn(), refreshTelegram: vi.fn() },
        },
      },
    });

    await wrapper.find("button.button--ghost").trigger("click");
    const labelInput = () => wrapper.find('input[placeholder="My Telegram bot"]');
    await labelInput().setValue("temp label");
    expect((labelInput().element as HTMLInputElement).value).toBe("temp label");

    await wrapper
      .findAll("button")
      .find((button) => button.text() === "Cancel")!
      .trigger("click");
    await wrapper.find("button.button--ghost").trigger("click");

    expect((labelInput().element as HTMLInputElement).value).toBe("");
  });

  test("the forward filter is editable and round-trips through save", async () => {
    // The form always carried `forwardKinds` through save but rendered no
    // control for it, so `question` and `auto_approved` were backend
    // capabilities with no way to reach them — while the connection tooltip
    // claimed expanding a row let you edit the "forward filter".
    const saveTelegramConnection = vi.fn(async () => ({
      payload: { appState: { settings: { integrations: { telegram: { connections: [] } } } } },
    }));

    const wrapper = mount(SettingsTelegramTab, {
      props: {
        profiles: [],
        telegramSettings: {
          defaultPollSeconds: 5,
          connections: [
            {
              id: "tg-1",
              label: "Bot",
              botTokenRef: "cred:tg-1",
              chatId: "12345",
              enabled: true,
              pollSeconds: 5,
              profileId: "",
              forwardKinds: ["waiting"],
            },
          ],
        },
      },
      global: {
        provide: { [apiKey]: { saveTelegramConnection, refreshTelegram: vi.fn() } },
      },
    });

    await wrapper.find(".connection-item__header").trigger("click");

    const kindBox = (label: string) => {
      const found = wrapper.findAll(".forward-kinds__item").find((item) => item.text().includes(label));
      if (!found) throw new Error(`forward-kind checkbox "${label}" not found`);
      return found.find("input[type='checkbox']");
    };

    // The saved filter is reflected.
    expect((kindBox("Waiting").element as HTMLInputElement).checked).toBe(true);
    expect((kindBox("Question").element as HTMLInputElement).checked).toBe(false);
    // Both kinds the review flagged as unreachable are offered.
    expect(kindBox("Question").exists()).toBe(true);
    expect(kindBox("Approval sent").exists()).toBe(true);

    await kindBox("Question").setValue(true);
    await wrapper
      .findAll("button")
      .find((button) => button.text() === "Save connection")!
      .trigger("click");

    expect(saveTelegramConnection).toHaveBeenCalledWith(
      expect.objectContaining({ id: "tg-1", forwardKinds: ["waiting", "question"] }),
    );
  });

  test("unticking a kind removes it, so a filter can be narrowed as well as widened", async () => {
    const saveTelegramConnection = vi.fn(async () => ({
      payload: { appState: { settings: { integrations: { telegram: { connections: [] } } } } },
    }));

    const wrapper = mount(SettingsTelegramTab, {
      props: {
        profiles: [],
        telegramSettings: {
          defaultPollSeconds: 5,
          connections: [
            {
              id: "tg-1",
              label: "Bot",
              botTokenRef: "cred:tg-1",
              chatId: "12345",
              enabled: true,
              pollSeconds: 5,
              profileId: "",
              forwardKinds: ["waiting", "question"],
            },
          ],
        },
      },
      global: {
        provide: { [apiKey]: { saveTelegramConnection, refreshTelegram: vi.fn() } },
      },
    });

    await wrapper.find(".connection-item__header").trigger("click");
    const questionBox = wrapper
      .findAll(".forward-kinds__item")
      .find((item) => item.text().includes("Question"))!
      .find("input[type='checkbox']");
    await questionBox.setValue(false);
    await wrapper
      .findAll("button")
      .find((button) => button.text() === "Save connection")!
      .trigger("click");

    expect(saveTelegramConnection).toHaveBeenCalledWith(
      expect.objectContaining({ id: "tg-1", forwardKinds: ["waiting"] }),
    );
  });
});
