import { describe, it, expect, vi } from "vitest";
import { mount } from "@vue/test-utils";
import ProfilesDialog from "./ProfilesDialog.vue";

describe("ProfilesDialog", () => {
  it("opts out of dialog auto-focus so opening does not start inline rename", () => {
    const wrapper = mount(ProfilesDialog, {
      props: {
        profiles: [{ id: "default", name: "Default", color: "#fff" }],
        activeProfileId: "default",
        workspaces: [],
        windowSlots: [],
      },
    });

    expect(wrapper.find(".dialog").attributes("data-no-autofocus")).toBe("");
  });

  it("disables Activate button in Electron when profile is open in another window", () => {
    // Two profiles: profile-a (this window, active) and profile-b (in win-2).
    // The Activate button for profile-b must be disabled in Electron mode.
    const wrapper = mount(ProfilesDialog, {
      props: {
        profiles: [
          { id: "profile-a", name: "A", color: "#fff" },
          { id: "profile-b", name: "B", color: "#fff" },
        ],
        activeProfileId: "profile-a",
        workspaces: [],
        // windowSlots indicate that profile-b is open in win-2
        windowSlots: [
          { id: "win-1", profileId: "profile-a" },
          { id: "win-2", profileId: "profile-b" },
        ],
        isRemote: false,
      },
    });

    // profile-b is the second card (index 1). It has an Activate button
    // because it is not active. In Electron mode, that button should be
    // disabled since profile-b is occupied by win-2.
    const cards = wrapper.findAll(".profile-card");
    expect(cards).toHaveLength(2);
    const cardB = cards[1]; // profile-b is second
    // Find the Activate button (first button in the actions area)
    const activateBtn = cardB.findAll("button").find((b) => b.text().includes("Activate"));
    expect(activateBtn?.exists()).toBe(true);
    expect(activateBtn?.attributes("disabled")).toBe("");
  });

  it("does NOT disable Activate button in remote mode even when profile is in desktopOccupancy", () => {
    // In remote mode, profiles open on the desktop should show a badge but
    // the Activate button must remain enabled so the remote user can switch.
    const wrapper = mount(ProfilesDialog, {
      props: {
        profiles: [
          { id: "profile-a", name: "A", color: "#fff" },
          { id: "profile-b", name: "B", color: "#fff" },
        ],
        activeProfileId: "profile-a",
        workspaces: [],
        windowSlots: [],
        isRemote: true,
        // profile-b is open on desktop Window 2
        desktopOccupancy: new Map([["profile-b", 2]]),
      },
    });

    const cards = wrapper.findAll(".profile-card");
    expect(cards).toHaveLength(2);
    const cardB = cards[1]; // profile-b is second

    // Activate button must be present and NOT disabled
    const activateBtn = cardB.findAll("button").find((b) => b.text().includes("Activate"));
    expect(activateBtn?.exists()).toBe(true);
    expect(activateBtn?.attributes("disabled")).toBeUndefined();

    // Badge "Window 2" must appear somewhere in the card
    expect(cardB.html()).toContain("Window 2");
  });

  it("calls remote activation without disabling profiles occupied by desktop windows", async () => {
    const onActivate = vi.fn().mockResolvedValue(undefined);
    const wrapper = mount(ProfilesDialog, {
      props: {
        profiles: [
          { id: "profile-a", name: "A", color: "#fff" },
          { id: "profile-b", name: "B", color: "#fff" },
        ],
        activeProfileId: "profile-a",
        workspaces: [],
        isRemote: true,
        desktopOccupancy: new Map([["profile-b", 2]]),
      },
      attrs: {
        onActivate,
      },
    });

    const cardB = wrapper.findAll(".profile-card")[1];
    const activateBtn = cardB.findAll("button").find((b) => b.text().includes("Activate"));
    expect(activateBtn?.attributes("disabled")).toBeUndefined();

    await activateBtn?.trigger("click");

    expect(onActivate).toHaveBeenCalledWith("profile-b");
  });

  it("hides create edit delete controls in remote mode", () => {
    const wrapper = mount(ProfilesDialog, {
      props: {
        profiles: [
          { id: "profile-a", name: "A", color: "#fff" },
          { id: "profile-b", name: "B", color: "#fff" },
        ],
        activeProfileId: "profile-a",
        workspaces: [],
        isRemote: true,
        desktopOccupancy: new Map([["profile-b", 2]]),
      },
    });

    expect(wrapper.find(".add-profile-row").exists()).toBe(false);
    expect(wrapper.find(".profile-color-input").exists()).toBe(false);
    expect(wrapper.findAll("button").some((button) => button.text().includes("Delete"))).toBe(false);
    expect(wrapper.find(".profile-name-input").exists()).toBe(false);
    expect(wrapper.find(".profile-name-display").text()).toBe("A");
  });
});
