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

  it("uses the supplied count map when workspaces is profile-scoped (remote)", () => {
    // Remote slim-core sends every profile but scopes `workspaces` to the viewer's
    // one profile (here empty). The count must come from the map — counting the
    // scoped array would read 0 for every profile (the reported bug).
    const wrapper = mount(ProfilesDialog, {
      props: {
        profiles: [
          { id: "default", name: "Default 2", color: "#fff" },
          { id: "asdf", name: "asdf", color: "#fff" },
          { id: "xxxxx", name: "XXXXX", color: "#fff" },
        ],
        activeProfileId: "asdf",
        workspaces: [],
        windowSlots: [],
        isRemote: true,
        profileWorkspaceCounts: { default: 8, asdf: 15, xxxxx: 0 },
      },
    });

    const cards = wrapper.findAll(".profile-card");
    expect(cards[0].text()).toContain("8 workspaces");
    expect(cards[1].text()).toContain("15 workspaces");
    expect(cards[2].text()).toContain("0 workspaces");
  });

  it("counts the full workspaces array when no count map is supplied (desktop)", () => {
    const wrapper = mount(ProfilesDialog, {
      props: {
        profiles: [
          { id: "default", name: "Default", color: "#fff" },
          { id: "asdf", name: "asdf", color: "#fff" },
        ],
        activeProfileId: "default",
        workspaces: [{ id: "w1", profileId: "asdf" }, { id: "w2", profileId: "asdf" }, { id: "w3" }],
        windowSlots: [],
        isRemote: false,
      },
    });

    const cards = wrapper.findAll(".profile-card");
    expect(cards[0].text()).toContain("1 workspace"); // default: w3 (no profileId)
    expect(cards[1].text()).toContain("2 workspaces"); // asdf: w1, w2
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
        // profile-b is open in 2 desktop windows
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

    // Badge with the desktop window count must appear somewhere in the card
    expect(cardB.html()).toContain("Open on desktop: 2 windows");
  });

  it("remote mode shows profiles without any desktop window as plainly activatable (no badge)", () => {
    // A remote viewer can open any existing profile — a profile with no
    // desktop window has no badge and an enabled Activate button.
    const wrapper = mount(ProfilesDialog, {
      props: {
        profiles: [
          { id: "profile-a", name: "A", color: "#fff" },
          { id: "profile-desktopless", name: "Headless", color: "#fff" },
        ],
        activeProfileId: "profile-a",
        workspaces: [],
        windowSlots: [],
        isRemote: true,
        desktopOccupancy: new Map([["profile-a", 1]]),
      },
    });

    const cardB = wrapper.findAll(".profile-card")[1];
    expect(cardB.find(".profile-desktop-badge").exists()).toBe(false);
    const activateBtn = cardB.findAll("button").find((b) => b.text().includes("Activate"));
    expect(activateBtn?.exists()).toBe(true);
    expect(activateBtn?.attributes("disabled")).toBeUndefined();
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

  it("shows New Window on every card in Electron — including the current profile — and calls onOpenWindow", async () => {
    const onOpenWindow = vi.fn().mockResolvedValue(undefined);
    const wrapper = mount(ProfilesDialog, {
      props: {
        profiles: [
          { id: "profile-a", name: "A", color: "#fff" },
          { id: "profile-b", name: "B", color: "#fff" },
        ],
        activeProfileId: "profile-a",
        workspaces: [],
        windowSlots: [{ id: "win-1", profileId: "profile-a" }],
        isRemote: false,
      },
      attrs: { onOpenWindow },
    });

    const cards = wrapper.findAll(".profile-card");
    // The current profile's card gets the button too — the same profile may
    // be open in any number of windows.
    const newWindowBtnA = cards[0].findAll("button").find((b) => b.text() === "New Window");
    expect(newWindowBtnA?.exists()).toBe(true);
    const newWindowBtnB = cards[1].findAll("button").find((b) => b.text() === "New Window");
    expect(newWindowBtnB?.exists()).toBe(true);

    await newWindowBtnA?.trigger("click");
    expect(onOpenWindow).toHaveBeenCalledWith("profile-a");
  });

  it("hides New Window in remote mode (no desktop window to spawn from)", () => {
    const wrapper = mount(ProfilesDialog, {
      props: {
        profiles: [
          { id: "profile-a", name: "A", color: "#fff" },
          { id: "profile-b", name: "B", color: "#fff" },
        ],
        activeProfileId: "profile-a",
        workspaces: [],
        isRemote: true,
      },
    });

    expect(wrapper.findAll("button").some((b) => b.text() === "New Window")).toBe(false);
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
