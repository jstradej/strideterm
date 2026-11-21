import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import ProfilesDialog from "./ProfilesDialog.vue";
import { useAppStore } from "../../stores/app.js";
import { useNotificationStore } from "../../stores/notifications.js";
import { setWindowBackend } from "../../window-backend.js";
import {
  PEER_DEFAULT_PORT,
  peerRenameHostSchema,
  peerUpdateAddressSchema,
  type PeerAttachedHost,
} from "../../../electron/shared/peers.js";

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

  it("says so when a new profile's name is already taken, and creates nothing", async () => {
    const logRenderer = vi.fn();
    (window as unknown as { strideterm?: unknown }).strideterm = { logRenderer };
    const onSave = vi.fn();
    try {
      const wrapper = mount(ProfilesDialog, {
        props: {
          profiles: [{ id: "default", name: "MHUB", color: "#fff" }],
          activeProfileId: "default",
          workspaces: [],
          windowSlots: [],
        },
        attrs: { onSave },
      });
      await wrapper.find(".add-profile-input").setValue("  mhub ");
      await wrapper
        .findAll("button")
        .find((button) => button.text() === "+ Add")!
        .trigger("click");
      await flushPromises();
      expect(onSave).not.toHaveBeenCalled();
      expect(wrapper.find('[role="alert"]').text()).toContain("A profile named “MHUB” already exists.");
      expect(logRenderer).toHaveBeenCalledWith("warn", expect.stringContaining("already exists"), {});
      expect(wrapper.findAll(".profile-card")).toHaveLength(1);
    } finally {
      delete (window as unknown as { strideterm?: unknown }).strideterm;
    }
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

describe("ProfilesDialog: attached desktops", () => {
  const HOST_ID = "host-0001";
  const OTHER_HOST_ID = "host-0002";

  function host(overrides: Partial<PeerAttachedHost> = {}): PeerAttachedHost {
    return {
      id: HOST_ID,
      label: "Office",
      address: "192.168.1.5",
      port: PEER_DEFAULT_PORT,
      hostPublicKey: "k",
      pairedAt: 1,
      state: "online",
      hostAppVersion: "1.0.0",
      localAppVersion: "1.0.0",
      profiles: [
        { id: "work", name: "Work", color: "#f00", workspaceCount: 3 },
        { id: "play", name: "Play", color: "#0f0", workspaceCount: 1 },
      ],
      checkedAt: 1,
      ...overrides,
    };
  }

  function installBridge(hosts: PeerAttachedHost[], overrides: Record<string, unknown> = {}) {
    const bridge = {
      listPeerHosts: vi.fn().mockResolvedValue(hosts),
      refreshPeerHost: vi.fn().mockImplementation(async (id: string) => hosts.find((h) => h.id === id) ?? null),
      removePeerHost: vi.fn().mockResolvedValue(true),
      updatePeerHostAddress: vi.fn().mockResolvedValue(true),
      renamePeerHost: vi.fn().mockResolvedValue(true),
      openPeerWindow: vi.fn().mockResolvedValue({ windowId: "w" }),
      activatePeerProfile: vi.fn().mockResolvedValue({ reloaded: true }),
      activateLocalProfile: vi.fn().mockResolvedValue({ reloaded: true }),
      getLocalProfilesOverview: vi.fn().mockResolvedValue([
        { id: "default", name: "Default", color: "#fff", workspaceCount: 4, openWindows: 2 },
        { id: "side", name: "Side", color: "#00f", workspaceCount: 0, openWindows: 0 },
      ]),
      onPeersUpdated: vi.fn(() => vi.fn()),
      ...overrides,
    };
    (window as unknown as { strideterm: unknown }).strideterm = bridge;
    return bridge;
  }

  const localProps = {
    profiles: [{ id: "default", name: "Default", color: "#fff" }],
    activeProfileId: "default",
    workspaces: [],
    windowSlots: [],
  };

  async function mountDialog(props: Record<string, unknown> = {}) {
    const wrapper = mount(ProfilesDialog, { props: { ...localProps, ...props } });
    await flushPromises();
    return wrapper;
  }

  beforeEach(() => {
    setActivePinia(createPinia());
    window.localStorage.clear();
  });

  afterEach(() => {
    delete (window as unknown as { strideterm?: unknown }).strideterm;
    setWindowBackend({ kind: "local" });
    vi.restoreAllMocks();
  });

  describe("web client without the desktop bridge", () => {
    it("shows no connect button and no host groups", async () => {
      const wrapper = await mountDialog({ isRemote: true });
      expect(wrapper.find('[data-testid="peer-connect-open"]').exists()).toBe(false);
      expect(wrapper.find('[data-testid="peer-groups"]').exists()).toBe(false);
      expect(wrapper.find('[data-testid="attached-note"]').exists()).toBe(false);
    });
  });

  describe("local window", () => {
    it("keeps the local section and adds one group per host, loaded and refreshed once without force", async () => {
      const bridge = installBridge([host(), host({ id: OTHER_HOST_ID, label: "Lab" })]);
      const wrapper = await mountDialog();
      expect(wrapper.findAll(".profile-card")).toHaveLength(1);
      expect(wrapper.find(".profile-name-input").exists()).toBe(true);
      expect(wrapper.findAll('[data-testid="peer-host-group"]')).toHaveLength(2);
      expect(bridge.listPeerHosts).toHaveBeenCalledTimes(1);
      expect(bridge.refreshPeerHost).toHaveBeenCalledTimes(2);
      expect(bridge.refreshPeerHost).toHaveBeenCalledWith(HOST_ID, {});
      expect(bridge.getLocalProfilesOverview).not.toHaveBeenCalled();
    });

    it("renders every profile of a host with count, address and no rename, colour, delete or add controls", async () => {
      installBridge([host()]);
      const wrapper = await mountDialog();
      const group = wrapper.find('[data-testid="peer-host-group"]');
      expect(group.text()).toContain("Office");
      expect(group.text()).toContain(`192.168.1.5:${PEER_DEFAULT_PORT}`);
      const rows = group.findAll('[data-testid="peer-profile-row"]');
      expect(rows).toHaveLength(2);
      expect(rows[0].text()).toContain("Work");
      expect(rows[0].text()).toContain("3 workspaces");
      expect(rows[1].text()).toContain("1 workspace");
      expect(group.find("input[type=color]").exists()).toBe(false);
      expect(group.find(".profile-name-input").exists()).toBe(false);
      expect(rows.some((row) => row.findAll("button").some((b) => /Delete|Add|Rename/.test(b.text())))).toBe(false);
      expect(group.findAll("button").some((b) => /Delete|Add/.test(b.text()))).toBe(false);
      expect(rows[0].findAll("button").map((b) => b.text())).toEqual(["Activate", "New Window"]);
      expect(wrapper.find('[data-testid="peer-this-window"]').exists()).toBe(false);
      expect(wrapper.find('[data-testid="peer-current"]').exists()).toBe(false);
    });

    it.each([
      ["online", "Online"],
      ["offline", "Offline"],
      ["not-paired", "Needs pairing"],
      ["version-mismatch", "Different version (host 2.0.0 · this 1.0.0)"],
      ["wrong-host", "Another strIDEterm answers here"],
      ["unknown", "Not checked yet"],
    ] as const)("shows the %s state chip", async (state, text) => {
      installBridge([host({ state, hostAppVersion: "2.0.0" })]);
      const wrapper = await mountDialog();
      expect(wrapper.find('[data-testid="peer-state-chip"]').text()).toBe(text);
    });

    it.each([
      ["offline", /offline/i],
      ["not-paired", /no longer accepts/i],
      ["version-mismatch", /same version/i],
      ["wrong-host", /Another strIDEterm answers/i],
      ["unknown", /Still checking/i],
    ] as const)("disables Activate and New Window with a tooltip when the host is %s", async (state, reason) => {
      installBridge([host({ state })]);
      const wrapper = await mountDialog();
      for (const id of ["peer-activate", "peer-new-window"]) {
        const button = wrapper.find(`[data-testid="${id}"]`);
        expect(button.attributes("disabled")).toBeDefined();
        expect(button.attributes("title")).toMatch(reason);
      }
    });

    it("Activate sends the host and profile; a reload just closes the dialog", async () => {
      const bridge = installBridge([host()]);
      const onActivate = vi.fn();
      const wrapper = await mountDialog({ onActivate });
      await wrapper.find('[data-testid="peer-activate"]').trigger("click");
      await flushPromises();
      expect(bridge.activatePeerProfile).toHaveBeenCalledWith({ hostId: HOST_ID, profileId: "work" });
      expect(onActivate).not.toHaveBeenCalled();
      expect(wrapper.emitted("cancel")).toHaveLength(1);
    });

    it("Activate with reloaded: false switches through the existing activation callback", async () => {
      const bridge = installBridge([host()]);
      bridge.activatePeerProfile.mockResolvedValue({ reloaded: false });
      const onActivate = vi.fn().mockResolvedValue(undefined);
      const wrapper = await mountDialog({ onActivate });
      await wrapper.find('[data-testid="peer-activate"]').trigger("click");
      await flushPromises();
      expect(onActivate).toHaveBeenCalledWith("work");
      expect(wrapper.emitted("cancel")).toBeUndefined();
    });

    it("shows a refused Activate as an error toast and keeps the dialog open", async () => {
      const bridge = installBridge([host()]);
      bridge.activatePeerProfile.mockRejectedValue(new Error("Office is offline."));
      const wrapper = await mountDialog();
      const runWithToast = vi.spyOn(useNotificationStore(), "runWithToast");
      await wrapper.find('[data-testid="peer-activate"]').trigger("click");
      await flushPromises();
      expect(runWithToast).toHaveBeenCalledWith("Could not switch the profile", expect.any(Function));
      expect(useNotificationStore().sessions.length).toBeGreaterThan(0);
      expect(wrapper.emitted("cancel")).toBeUndefined();
      expect(wrapper.find('[data-testid="peer-activate"]').attributes("disabled")).toBeUndefined();
    });

    it("New Window opens a window of that host profile and closes the dialog", async () => {
      const bridge = installBridge([host()]);
      const wrapper = await mountDialog();
      await wrapper.findAll('[data-testid="peer-new-window"]')[1].trigger("click");
      await flushPromises();
      expect(bridge.openPeerWindow).toHaveBeenCalledWith({ hostId: HOST_ID, profileId: "play" });
      expect(wrapper.emitted("cancel")).toHaveLength(1);
    });

    it("Reconnect forces the refresh", async () => {
      const bridge = installBridge([host()]);
      const wrapper = await mountDialog();
      bridge.refreshPeerHost.mockClear();
      await wrapper.find('[data-testid="peer-reconnect"]').trigger("click");
      await flushPromises();
      expect(bridge.refreshPeerHost).toHaveBeenCalledWith(HOST_ID, { force: true });
    });

    it("Edit address validates and sends the new address and port", async () => {
      const bridge = installBridge([host()]);
      const wrapper = await mountDialog();
      await wrapper.find('[data-testid="peer-edit-address"]').trigger("click");
      expect((wrapper.find('[data-testid="peer-edit-address-input"]').element as HTMLInputElement).value).toBe(
        "192.168.1.5",
      );

      await wrapper.find('[data-testid="peer-edit-address-input"]').setValue("bad host");
      expect(wrapper.find('[data-testid="peer-edit-error"]').text()).toBe("Enter a host name or an IP address.");
      expect(wrapper.find('[data-testid="peer-edit-save"]').attributes("disabled")).toBeDefined();

      await wrapper.find('[data-testid="peer-edit-address-input"]').setValue("192.168.1.9");
      await wrapper.find('[data-testid="peer-edit-port-input"]').setValue("0");
      expect(wrapper.find('[data-testid="peer-edit-error"]').text()).toBe("Enter a port between 1 and 65535.");

      await wrapper.find('[data-testid="peer-edit-port-input"]').setValue("43200");
      await wrapper.find('[data-testid="peer-edit-form"]').trigger("submit");
      await flushPromises();
      const sent = bridge.updatePeerHostAddress.mock.calls[0][0];
      expect(sent).toEqual({ hostId: HOST_ID, address: "192.168.1.9", port: 43200 });
      expect(peerUpdateAddressSchema.safeParse(sent).success).toBe(true);
      expect(wrapper.find('[data-testid="peer-edit-form"]').exists()).toBe(false);
    });

    it("Rename sends the trimmed label for the host", async () => {
      const bridge = installBridge([host()]);
      const wrapper = await mountDialog();
      await wrapper.find('[data-testid="peer-rename"]').trigger("click");
      const input = wrapper.find('[data-testid="peer-rename-input"]');
      expect((input.element as HTMLInputElement).value).toBe("Office");
      await input.setValue("  Home PC ");
      await wrapper.find('[data-testid="peer-rename-form"]').trigger("submit");
      await flushPromises();
      const sent = bridge.renamePeerHost.mock.calls[0][0];
      expect(sent).toEqual({ hostId: HOST_ID, label: "Home PC" });
      expect(peerRenameHostSchema.safeParse(sent).success).toBe(true);
      expect(wrapper.find('[data-testid="peer-rename-form"]').exists()).toBe(false);
    });

    it("Disconnect removes the host only after the user confirms", async () => {
      const bridge = installBridge([host()]);
      const wrapper = await mountDialog();
      const confirmInApp = vi.spyOn(useAppStore(), "confirmInApp").mockResolvedValueOnce(false);
      await wrapper.find('[data-testid="peer-disconnect"]').trigger("click");
      await flushPromises();
      expect(confirmInApp).toHaveBeenCalledWith(
        expect.objectContaining({
          message:
            "Office will be removed from this desktop. Windows showing its profiles will close. Nothing is deleted on Office.",
        }),
      );
      expect(bridge.removePeerHost).not.toHaveBeenCalled();

      confirmInApp.mockResolvedValueOnce(true);
      await wrapper.find('[data-testid="peer-disconnect"]').trigger("click");
      await flushPromises();
      expect(bridge.removePeerHost).toHaveBeenCalledWith(HOST_ID);
    });

    it("collapse is remembered per host and survives a throwing localStorage", async () => {
      installBridge([host(), host({ id: OTHER_HOST_ID, label: "Lab" })]);
      const wrapper = await mountDialog();
      await wrapper.findAll('[data-testid="peer-group-toggle"]')[0].trigger("click");
      expect(wrapper.findAll('[data-testid="peer-profile-row"]')).toHaveLength(2);
      expect(JSON.parse(window.localStorage.getItem("strideterm-peer-host-collapsed") || "{}")).toEqual({
        [HOST_ID]: true,
      });

      setActivePinia(createPinia());
      const again = await mountDialog();
      expect(again.findAll('[data-testid="peer-profile-row"]')).toHaveLength(2);

      vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
        throw new Error("denied");
      });
      vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
        throw new Error("denied");
      });
      setActivePinia(createPinia());
      const blocked = await mountDialog();
      expect(blocked.findAll('[data-testid="peer-profile-row"]')).toHaveLength(4);
      await blocked.findAll('[data-testid="peer-group-toggle"]')[0].trigger("click");
      expect(blocked.findAll('[data-testid="peer-profile-row"]')).toHaveLength(2);
    });

    it("the connect button asks the opener to show the connect dialog", async () => {
      installBridge([]);
      const onConnect = vi.fn();
      const wrapper = await mountDialog({ onConnect });
      await wrapper.find('[data-testid="peer-connect-open"]').trigger("click");
      expect(onConnect).toHaveBeenCalledTimes(1);
      expect(wrapper.find(".add-profile-input").exists()).toBe(true);
    });
  });

  describe("window attached to a host", () => {
    function attachTo(hostId: string) {
      setWindowBackend({
        kind: "peer",
        hostId,
        hostLabel: "Lab",
        remoteProfileId: "work",
        clientId: "c",
        terminalFontSize: 13,
      });
    }

    it("feeds the local section from the local overview, without rename, colour, delete or add", async () => {
      attachTo(HOST_ID);
      const bridge = installBridge([host()]);
      const wrapper = await mountDialog({
        isRemote: true,
        profiles: [{ id: "work", name: "Work", color: "#f00" }],
        activeProfileId: "work",
      });
      expect(bridge.getLocalProfilesOverview).toHaveBeenCalledTimes(1);
      const local = wrapper.find('[data-testid="local-profiles-attached"]');
      const cards = local.findAll(".profile-card");
      expect(cards.map((card) => card.find(".profile-name-display").text())).toEqual(["Default", "Side"]);
      expect(cards[0].text()).toContain("4 workspaces");
      expect(cards[0].text()).toContain("Open in 2 windows");
      expect(cards[1].text()).toContain("0 workspaces");
      expect(local.find(".profile-name-input").exists()).toBe(false);
      expect(local.find("input[type=color]").exists()).toBe(false);
      expect(wrapper.find(".add-profile-input").exists()).toBe(false);
      expect(wrapper.findAll("button").some((b) => b.text().includes("Delete"))).toBe(false);
      expect(wrapper.find('[data-testid="attached-note"]').text()).toContain(
        "Local profiles are managed from a local window of this desktop.",
      );
      expect(wrapper.find('[data-testid="peer-connect-open"]').exists()).toBe(true);
    });

    it("Activate on a local profile goes back to it and the window restarts", async () => {
      attachTo(HOST_ID);
      const bridge = installBridge([host()]);
      const onActivate = vi.fn();
      const wrapper = await mountDialog({ isRemote: true, onActivate });
      await wrapper.findAll('[data-testid="local-activate"]')[1].trigger("click");
      await flushPromises();
      expect(bridge.activateLocalProfile).toHaveBeenCalledWith("side");
      expect(onActivate).not.toHaveBeenCalled();
      expect(wrapper.emitted("cancel")).toHaveLength(1);
    });

    it("New Window on a local profile uses the existing callback", async () => {
      attachTo(HOST_ID);
      installBridge([host()]);
      const onOpenWindow = vi.fn().mockResolvedValue(undefined);
      const wrapper = await mountDialog({ isRemote: true, onOpenWindow });
      await wrapper.findAll('[data-testid="local-new-window"]')[0].trigger("click");
      await flushPromises();
      expect(onOpenWindow).toHaveBeenCalledWith("default");
    });

    it("shows this window's own host first, marked, with the current profile", async () => {
      attachTo(OTHER_HOST_ID);
      installBridge([host(), host({ id: OTHER_HOST_ID, label: "Lab" })]);
      const wrapper = await mountDialog({ isRemote: true, activeProfileId: "play" });
      const groups = wrapper.findAll('[data-testid="peer-host-group"]');
      expect(groups[0].attributes("data-host-id")).toBe(OTHER_HOST_ID);
      expect(groups[0].find('[data-testid="peer-this-window"]').text()).toBe("This window");
      expect(groups[1].find('[data-testid="peer-this-window"]').exists()).toBe(false);
      const current = groups[0].findAll('[data-testid="peer-profile-row"]');
      expect(current[1].find('[data-testid="peer-current"]').text()).toBe("Current");
      expect(current[1].find('[data-testid="peer-activate"]').exists()).toBe(false);
      expect(current[0].find('[data-testid="peer-current"]').exists()).toBe(false);
      expect(groups[1].find('[data-testid="peer-current"]').exists()).toBe(false);
    });

    it("Activate on a profile of the same host switches through the activation callback", async () => {
      attachTo(HOST_ID);
      const bridge = installBridge([host()]);
      bridge.activatePeerProfile.mockResolvedValue({ reloaded: false });
      const onActivate = vi.fn().mockResolvedValue(undefined);
      const wrapper = await mountDialog({ isRemote: true, activeProfileId: "work", onActivate });
      await wrapper.find('[data-testid="peer-activate"]').trigger("click");
      await flushPromises();
      expect(bridge.activatePeerProfile).toHaveBeenCalledWith({ hostId: HOST_ID, profileId: "play" });
      expect(onActivate).toHaveBeenCalledWith("play");
    });
  });

  describe("busy indicators", () => {
    function deferred<T = unknown>() {
      let resolve!: (_value: T) => void;
      let reject!: (_reason: unknown) => void;
      const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      return { promise, resolve, reject };
    }
    const pending = (el: { classes: () => string[]; attributes: (name: string) => string | undefined }) =>
      el.classes().includes("button--pending") && el.attributes("aria-busy") === "true";
    const toastTitles = () =>
      useNotificationStore().sessions.flatMap((entry) => entry.events.map((event) => event.title));

    it("shows a looking-for-desktops row only after a short delay, instead of an empty area", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      try {
        const list = deferred<PeerAttachedHost[]>();
        installBridge([], { listPeerHosts: vi.fn().mockReturnValue(list.promise) });
        const wrapper = mount(ProfilesDialog, { props: localProps });
        await flushPromises();
        expect(wrapper.find('[data-testid="peer-hosts-loading"]').exists()).toBe(false);

        await vi.advanceTimersByTimeAsync(250);
        const row = wrapper.find('[data-testid="peer-hosts-loading"]');
        expect(row.attributes("role")).toBe("status");
        expect(row.text()).toContain("Looking for attached desktops");
        expect(row.find(".spinner").exists()).toBe(true);

        list.resolve([host()]);
        await vi.advanceTimersByTimeAsync(400);
        expect(wrapper.find('[data-testid="peer-hosts-loading"]').exists()).toBe(false);
        expect(wrapper.find('[data-testid="peer-host-group"]').exists()).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it.each([["resolves"], ["rejects"]])(
      "the status check keeps the last chip and shows a spinner beside it until it %s",
      async (how) => {
        const check = deferred<PeerAttachedHost | null>();
        installBridge([host()], { refreshPeerHost: vi.fn().mockReturnValue(check.promise) });
        const wrapper = await mountDialog();
        expect(wrapper.find('[data-testid="peer-checking"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="peer-state-chip"]').text()).toBe("Online");

        if (how === "resolves") check.resolve(host({ state: "offline" }));
        else check.reject(new Error("no route"));
        await flushPromises();
        expect(wrapper.find('[data-testid="peer-checking"]').exists()).toBe(false);
        if (how === "rejects") {
          expect(toastTitles()).toContain("Could not check the desktop");
          expect(wrapper.find('[data-testid="peer-state-chip"]').text()).toBe("Online");
        } else expect(wrapper.find('[data-testid="peer-state-chip"]').text()).toBe("Offline");
      },
    );

    it.each([["resolves"], ["rejects"]])("Reconnect is busy, and only it, until the call %s", async (how) => {
      const bridge = installBridge([host()]);
      const wrapper = await mountDialog();
      const call = deferred<PeerAttachedHost | null>();
      bridge.refreshPeerHost.mockReturnValue(call.promise);
      await wrapper.find('[data-testid="peer-reconnect"]').trigger("click");
      expect(pending(wrapper.get('[data-testid="peer-reconnect"]'))).toBe(true);
      expect(pending(wrapper.get('[data-testid="peer-edit-address"]'))).toBe(false);
      expect(wrapper.get('[data-testid="peer-edit-address"]').attributes("disabled")).toBeDefined();
      expect(wrapper.get('[data-testid="peer-disconnect"]').attributes("disabled")).toBeDefined();
      await wrapper.find('[data-testid="peer-reconnect"]').trigger("click");
      expect(bridge.refreshPeerHost).toHaveBeenCalledTimes(2);

      if (how === "resolves") call.resolve(host());
      else call.reject(new Error("still asleep"));
      await flushPromises();
      expect(pending(wrapper.get('[data-testid="peer-reconnect"]'))).toBe(false);
      expect(wrapper.get('[data-testid="peer-edit-address"]').attributes("disabled")).toBeUndefined();
      if (how === "rejects") expect(toastTitles()).toContain("Could not reconnect");
    });

    it.each([["resolves"], ["rejects"]])("saving a new address is busy until the call %s", async (how) => {
      const call = deferred<boolean>();
      const bridge = installBridge([host()], { updatePeerHostAddress: vi.fn().mockReturnValue(call.promise) });
      const wrapper = await mountDialog();
      await wrapper.find('[data-testid="peer-edit-address"]').trigger("click");
      await wrapper.find('[data-testid="peer-edit-address-input"]').setValue("192.168.1.9");
      await wrapper.find('[data-testid="peer-edit-form"]').trigger("submit");
      expect(pending(wrapper.get('[data-testid="peer-edit-save"]'))).toBe(true);
      expect(wrapper.get('[data-testid="peer-edit-save"]').attributes("disabled")).toBeDefined();
      await wrapper.find('[data-testid="peer-edit-form"]').trigger("submit");
      expect(bridge.updatePeerHostAddress).toHaveBeenCalledTimes(1);

      if (how === "resolves") call.resolve(true);
      else call.reject(new Error("refused"));
      await flushPromises();
      if (how === "rejects") {
        expect(pending(wrapper.get('[data-testid="peer-edit-save"]'))).toBe(false);
        expect(toastTitles()).toContain("Could not change the address");
        expect(wrapper.find('[data-testid="peer-edit-form"]').exists()).toBe(true);
      } else expect(wrapper.find('[data-testid="peer-edit-form"]').exists()).toBe(false);
    });

    it.each([["resolves"], ["rejects"]])("Disconnect is busy after the confirmation until the call %s", async (how) => {
      const call = deferred<boolean>();
      installBridge([host()], { removePeerHost: vi.fn().mockReturnValue(call.promise) });
      const wrapper = await mountDialog();
      vi.spyOn(useAppStore(), "confirmInApp").mockResolvedValue(true);
      await wrapper.find('[data-testid="peer-disconnect"]').trigger("click");
      await flushPromises();
      expect(pending(wrapper.get('[data-testid="peer-disconnect"]'))).toBe(true);
      expect(pending(wrapper.get('[data-testid="peer-reconnect"]'))).toBe(false);

      if (how === "resolves") call.resolve(true);
      else call.reject(new Error("refused"));
      await flushPromises();
      if (how === "rejects") {
        expect(pending(wrapper.get('[data-testid="peer-disconnect"]'))).toBe(false);
        expect(toastTitles()).toContain("Could not disconnect the desktop");
      }
    });

    it.each([["resolves"], ["rejects"]])(
      "Activate shows Switching… with a spinner on its own button until it %s",
      async (how) => {
        const call = deferred<{ reloaded: boolean }>();
        installBridge([host()], { activatePeerProfile: vi.fn().mockReturnValue(call.promise) });
        const wrapper = await mountDialog();
        const activate = wrapper.findAll('[data-testid="peer-activate"]')[0];
        const newWindows = wrapper.findAll('[data-testid="peer-new-window"]');
        await activate.trigger("click");
        expect(activate.text()).toContain("Switching…");
        expect(activate.find(".spinner").exists()).toBe(true);
        expect(pending(newWindows[0])).toBe(false);
        expect(activate.attributes("disabled")).toBeDefined();
        expect(newWindows[1].attributes("disabled")).toBeDefined();

        if (how === "resolves") call.resolve({ reloaded: true });
        else call.reject(new Error("host gone"));
        await flushPromises();
        expect(activate.find(".spinner").exists()).toBe(false);
        if (how === "rejects") {
          expect(activate.text()).toBe("Activate");
          expect(toastTitles()).toContain("Could not switch the profile");
        }
      },
    );

    it.each([["resolves"], ["rejects"]])(
      "New Window is busy, and Activate keeps its label, until the call %s",
      async (how) => {
        const call = deferred<{ windowId: string }>();
        installBridge([host()], { openPeerWindow: vi.fn().mockReturnValue(call.promise) });
        const wrapper = await mountDialog();
        const activate = wrapper.findAll('[data-testid="peer-activate"]')[0];
        const newWindow = wrapper.findAll('[data-testid="peer-new-window"]')[0];
        await newWindow.trigger("click");
        expect(pending(newWindow)).toBe(true);
        expect(activate.text()).toBe("Activate");

        if (how === "resolves") call.resolve({ windowId: "w" });
        else call.reject(new Error("no window"));
        await flushPromises();
        expect(pending(newWindow)).toBe(false);
        if (how === "rejects") expect(toastTitles()).toContain("Could not open a window");
      },
    );

    it("an attached window shows a loading row for the local profiles instead of an empty list", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      try {
        setWindowBackend({
          kind: "peer",
          hostId: HOST_ID,
          hostLabel: "Lab",
          remoteProfileId: "work",
          clientId: "c",
          terminalFontSize: 13,
        });
        const overview = deferred<unknown[]>();
        installBridge([host()], { getLocalProfilesOverview: vi.fn().mockReturnValue(overview.promise) });
        const wrapper = mount(ProfilesDialog, { props: { ...localProps, isRemote: true } });
        await flushPromises();
        await vi.advanceTimersByTimeAsync(250);
        const row = wrapper.find('[data-testid="local-profiles-loading"]');
        expect(row.exists()).toBe(true);
        expect(row.find(".spinner").exists()).toBe(true);
        expect(wrapper.find('[data-testid="local-profiles-attached"]').attributes("aria-busy")).toBe("true");

        overview.resolve([{ id: "default", name: "Default", color: "#fff", workspaceCount: 4, openWindows: 0 }]);
        await vi.advanceTimersByTimeAsync(400);
        expect(wrapper.find('[data-testid="local-profiles-loading"]').exists()).toBe(false);
        expect(wrapper.findAll('[data-testid="local-profiles-attached"] .profile-card')).toHaveLength(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("a failed local profile load ends the loading row and is toasted", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      try {
        setWindowBackend({
          kind: "peer",
          hostId: HOST_ID,
          hostLabel: "Lab",
          remoteProfileId: "work",
          clientId: "c",
          terminalFontSize: 13,
        });
        const overview = deferred<unknown[]>();
        installBridge([host()], { getLocalProfilesOverview: vi.fn().mockReturnValue(overview.promise) });
        const wrapper = mount(ProfilesDialog, { props: { ...localProps, isRemote: true } });
        await flushPromises();
        await vi.advanceTimersByTimeAsync(250);
        expect(wrapper.find('[data-testid="local-profiles-loading"]').exists()).toBe(true);

        overview.reject(new Error("ipc closed"));
        await vi.advanceTimersByTimeAsync(400);
        expect(wrapper.find('[data-testid="local-profiles-loading"]').exists()).toBe(false);
        expect(toastTitles()).toContain("Could not load the profiles of this desktop");
      } finally {
        vi.useRealTimers();
      }
    });

    it("the local Activate shows a spinner too", async () => {
      setWindowBackend({
        kind: "peer",
        hostId: HOST_ID,
        hostLabel: "Lab",
        remoteProfileId: "work",
        clientId: "c",
        terminalFontSize: 13,
      });
      const call = deferred<{ reloaded: boolean }>();
      installBridge([host()], { activateLocalProfile: vi.fn().mockReturnValue(call.promise) });
      const wrapper = await mountDialog({ isRemote: true });
      const activate = wrapper.findAll('[data-testid="local-activate"]')[0];
      await activate.trigger("click");
      expect(activate.text()).toContain("Switching…");
      expect(activate.find(".spinner").exists()).toBe(true);
      call.reject(new Error("refused"));
      await flushPromises();
      expect(activate.find(".spinner").exists()).toBe(false);
    });
  });
});
