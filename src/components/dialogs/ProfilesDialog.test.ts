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

  it("keeps Activate enabled in Electron when profile is open in another window and shows a count badge", () => {
    // Two profiles: profile-a (this window, active) and profile-b (in win-2).
    // Profiles are NOT exclusive to a window — the Activate button for
    // profile-b stays enabled; an informational badge shows the window count.
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

    const cards = wrapper.findAll(".profile-card");
    expect(cards).toHaveLength(2);
    const cardB = cards[1]; // profile-b is second
    const activateBtn = cardB.findAll("button").find((b) => b.text().includes("Activate"));
    expect(activateBtn?.exists()).toBe(true);
    expect(activateBtn?.attributes("disabled")).toBeUndefined();
    // Informational badge with the open-window count
    expect(cardB.html()).toContain("Open in 1 window");
  });

  it("shows a multi-window count badge when a profile is open in several windows", () => {
    const wrapper = mount(ProfilesDialog, {
      props: {
        profiles: [
          { id: "profile-a", name: "A", color: "#fff" },
          { id: "profile-b", name: "B", color: "#fff" },
        ],
        activeProfileId: "profile-a",
        workspaces: [],
        windowSlots: [
          { id: "win-1", profileId: "profile-a" },
          { id: "win-2", profileId: "profile-b" },
          { id: "win-3", profileId: "profile-b" },
        ],
        isRemote: false,
      },
    });

    const cardB = wrapper.findAll(".profile-card")[1];
    expect(cardB.html()).toContain("Open in 2 windows");
    // The current profile's card shows the Current badge, not a count badge.
    const cardA = wrapper.findAll(".profile-card")[0];
    expect(cardA.find(".profile-active-badge").text()).toBe("Current");
    expect(cardA.find(".profile-desktop-badge").exists()).toBe(false);
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

  it("shows Switching… and disables all Activate buttons while activation is in progress", async () => {
    let resolveActivate!: () => void;
    const onActivate = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveActivate = resolve;
        }),
    );
    const wrapper = mount(ProfilesDialog, {
      props: {
        profiles: [
          { id: "profile-a", name: "A", color: "#fff" },
          { id: "profile-b", name: "B", color: "#fff" },
          { id: "profile-c", name: "C", color: "#fff" },
        ],
        activeProfileId: "profile-a",
        workspaces: [],
        windowSlots: [],
        isRemote: false,
      },
      attrs: { onActivate },
    });

    const cards = wrapper.findAll(".profile-card");
    // Click Activate on profile-b (second card)
    const activateBtnB = cards[1].findAll("button").find((b) => b.text().includes("Activate"));
    await activateBtnB?.trigger("click");

    // While activation is pending: the clicked button shows "Switching…"
    // and all Activate buttons are disabled
    const activateBtnBNow = cards[1].findAll("button").find((b) => b.text().includes("Switching"));
    expect(activateBtnBNow?.exists()).toBe(true);
    expect(activateBtnBNow?.attributes("disabled")).toBe("");

    const activateBtnC = cards[2].findAll("button").find((b) => b.text() === "Activate");
    expect(activateBtnC?.attributes("disabled")).toBe("");

    // Resolve activation; buttons return to normal
    resolveActivate();
    await wrapper.vm.$nextTick();
    const activateBtnBAfter = cards[1].findAll("button").find((b) => b.text() === "Activate");
    expect(activateBtnBAfter?.attributes("disabled")).toBeUndefined();
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
