import { mount } from "@vue/test-utils";
import { describe, expect, test, vi } from "vitest";
import SettingsTelegramTab from "./SettingsTelegramTab.vue";

describe("SettingsTelegramTab", () => {
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
          api: {
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
});
