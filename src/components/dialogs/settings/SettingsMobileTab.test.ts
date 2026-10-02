import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, test, vi } from "vitest";
import SettingsMobileTab from "./SettingsMobileTab.vue";
import { useAppStore } from "../../../stores/app.js";
import { useAccountStore } from "../../../stores/account.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyApi = any;

function makePayload(mobile: AnyApi): AnyApi {
  return {
    meta: { appVersion: "0.0.0", platform: "test", repositoryUrl: "", versionCheck: null, recoveryCandidates: [] },
    appState: {
      activeWorkspaceId: "",
      profiles: [],
      workspaces: [],
      windowSlots: [],
      settings: { integrations: { mobile } },
      tabTemplates: [],
      ssh: {
        hosts: [],
        keys: [],
        certificates: [],
        knownHosts: {},
        settings: { defaultAgentMode: "inherit", importedSshConfig: false },
      },
    },
    workspace: null,
    attention: { sessions: {}, alerts: [] },
    docker: {
      available: false,
      backend: null,
      contexts: [],
      containers: [],
      lazydocker: { available: false, backend: null, error: "" },
      error: "",
      lastUpdatedAt: null,
    },
    git: { workspaces: {}, activeWorkspace: null, connections: [] },
    azureDevops: { inboxItems: [], connections: [], lastUpdatedAt: null, error: "" },
    github: { inboxItems: [], connections: [], lastUpdatedAt: null, error: "" },
    reviewBridge: { sessions: {}, enabled: false },
    plugins: [],
    environment: {},
    remoteAccess: { enabled: false, host: "", port: 0, tunnel: { active: false, url: null, error: null } },
    taskRunner: {},
  };
}

function makeTransport(payload: AnyApi, overrides: AnyApi = {}) {
  let stateHandler: ((_payload: AnyApi) => void) | null = null;
  let pairingProgressHandler: ((_payload: AnyApi) => void) | null = null;
  return {
    isRemote: false,
    getState: vi.fn(() => Promise.resolve(payload)),
    onStateUpdated: (fn: (_payload: AnyApi) => void) => {
      stateHandler = fn;
    },
    onConnectionState: vi.fn(),
    onMobileStatus: vi.fn(),
    onMobilePairingProgress: (fn: (_payload: AnyApi) => void) => {
      pairingProgressHandler = fn;
    },
    onMobileDeviceRevoked: vi.fn(),
    createMobilePairingInvitation: vi.fn(async () => ({
      protocolVersion: 1,
      pairingId: "pairing-1",
      secret: "s",
      desktopLabel: "Desktop",
      desktopFingerprint: "AB:CD",
      expiresAt: Date.now() + 120_000,
    })),
    cancelMobilePairingInvitation: vi.fn(async () => {}),
    listMobileDevices: vi.fn(async () => []),
    renameMobileDevice: vi.fn(async () => ({})),
    revokeMobileDevice: vi.fn(async () => ({})),
    approveMobileDevice: vi.fn(async () => ({ ok: true })),
    rejectMobileDevice: vi.fn(async () => ({})),
    listMobileDevicesAwaitingApproval: vi.fn(async () => []),
    updateMobileDeviceAllowlist: vi.fn(async () => ({})),
    setMobileEnabled: vi.fn(async () => payload),
    setMobileRelayEnabled: vi.fn(async () => payload),
    getMobileRelayStatus: vi.fn(async () => ({
      enabled: false,
      state: "off",
      relayOrigin: "",
      internalPort: 0,
      lastError: "",
      stats: null,
    })),
    refreshMobileConnectionHealth: vi.fn(async () => ({
      health: {
        running: true,
        connectionState: "connected",
        lastError: null,
        deviceCount: 0,
        pendingInvitation: null,
      },
      quota: { used: 3, limit: 100, reservedHighPriorityRemaining: 10, resetAt: Date.now() + 3_600_000 },
    })),
    sendMobileTestPush: vi.fn(async () => ({ ok: true })),
    queryMobileAuditLog: vi.fn(async () => ({ entries: [], total: 0 })),
    _push: (p: AnyApi) => stateHandler?.(p),
    /** Replays what the backend emits on `mobile:pairing-progress` after a claim. */
    _pairingProgress: (p: AnyApi) => pairingProgressHandler?.(p),
    ...overrides,
  };
}

const SAMPLE_DEVICE = {
  deviceId: "mobile-1",
  label: "Pixel 8",
  platform: "android",
  fingerprint: "AB:CD",
  capabilities: ["task.control"],
  profileAllowlist: ["default"],
  createdAt: 1000,
  lastSeenAt: 2000,
  revoked: false,
  revokedAt: null,
  verifiedAt: 3000,
  // Review 3 §P0.1: a device is usable when a human approved it, not when it merely exists.
  state: "active",
  activatedAt: 3500,
};

describe("SettingsMobileTab", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  async function mountTab(
    transportOverrides: AnyApi = {},
    mobileSettings: AnyApi = { enabled: true, devices: [] },
    initialView: "overview" | "phones" | "account" = "phones",
  ) {
    const payload = makePayload(mobileSettings);
    const transport = makeTransport(payload, transportOverrides);
    const appStore = useAppStore();
    appStore.init(transport as AnyApi);
    await flushPromises();
    const wrapper = mount(SettingsMobileTab, {
      props: { profiles: [{ id: "default", name: "Default" }], initialView },
    });
    await flushPromises();
    return { wrapper, transport, appStore };
  }

  test("uses accessible tabs with wrapping keyboard navigation", async () => {
    const account = useAccountStore();
    account.attach({ getAccountState: async () => ({ phase: "ready", installationRegistered: true }) } as AnyApi);
    await account.refreshState();
    const { wrapper } = await mountTab({}, { enabled: true, devices: [] }, "overview");
    const tabs = wrapper.findAll('[role="tab"]');

    expect(tabs.map((tab) => tab.attributes("aria-selected"))).toEqual(["true", "false", "false"]);
    await tabs[0]!.trigger("keydown", { key: "ArrowLeft" });

    expect(wrapper.find('[role="tab"][aria-selected="true"]').text()).toBe("Account");
    expect(wrapper.find('[role="tab"][aria-selected="true"]').attributes("tabindex")).toBe("0");
  });

  test("opens Phones by default when the hosted account surface is unavailable", async () => {
    const payload = makePayload({ enabled: true, devices: [] });
    const transport = makeTransport(payload);
    useAppStore().init(transport as AnyApi);
    const wrapper = mount(SettingsMobileTab, { props: { profiles: [{ id: "default", name: "Default" }] } });
    await flushPromises();

    expect(wrapper.find('[role="tabpanel"]').attributes("id")).toContain("phones-panel");
    expect(wrapper.text()).toContain("Connect your first phone");
    expect(wrapper.text()).toContain("Turn on phone pairing");
    expect(wrapper.find(".mobile-tab__testing-notice").exists()).toBe(false);
  });

  test("shows the internal testing access instructions before phone pairing", async () => {
    const account = useAccountStore();
    account.attach({
      getAccountState: async () => ({
        phase: "ready",
        installationRegistered: true,
        entitlement: { state: "trial", source: "trial" },
      }),
    } as AnyApi);
    await account.refreshState();
    const { wrapper } = await mountTab({}, { enabled: true, devices: [] });
    expect(account.available).toBe(true);
    expect(account.entitlement?.source).toBe("trial");
    const notice = wrapper.find(".mobile-tab__testing-notice");

    expect(notice.text()).toContain("Register and verify your email first");
    expect(notice.text()).toContain("request access to the Google Play internal test");
    expect(notice.find("a").attributes("href")).toBe("https://strideterm.com/mobile/#access-request-title");
    expect(wrapper.find(".pairing-section__action").text()).toContain("Pair a phone");

    await wrapper
      .findAll('[role="tab"]')
      .find((tab) => tab.text() === "Overview")!
      .trigger("click");
    expect(wrapper.find(".mobile-tab__testing-notice").text()).toContain("Register and verify your email first");
    expect(wrapper.text()).toContain("Connect first phone");
  });

  test("Connect first phone enables pairing and opens the QR in one click", async () => {
    let finishInvitation!: (invitation: AnyApi) => void;
    const pendingInvitation = new Promise<AnyApi>((resolve) => {
      finishInvitation = resolve;
    });
    const account = useAccountStore();
    const entitlement = { state: "trial", source: "trial", notAfter: Date.now() + 14 * 86_400_000 };
    account.attach({
      getAccountState: async () => ({
        phase: "ready",
        busy: false,
        ownerEmail: "owner@example.test",
        installationRegistered: true,
        signInAvailable: true,
        entitlement,
        overview: {
          entitlement,
          offers: [],
          usage: {
            installations: { used: 1, limit: 5 },
            mobileDevices: { used: 0, limit: 5 },
            activeRelaySessions: { used: 0, limit: 8 },
          },
          installations: [],
          mobileDevices: [],
          notices: [],
        },
      }),
    } as AnyApi);
    await account.refreshState();

    const { wrapper, transport } = await mountTab(
      {
        setMobileEnabled: vi.fn(async () => makePayload({ enabled: true, devices: [] })),
        createMobilePairingInvitation: vi.fn(() => pendingInvitation),
      },
      { enabled: false, devices: [] },
      "overview",
    );
    await wrapper
      .findAll("button")
      .find((button) => button.text() === "Connect first phone")!
      .trigger("click");
    await flushPromises();

    expect(transport.setMobileEnabled).toHaveBeenCalledWith(true);
    expect(transport.createMobilePairingInvitation).toHaveBeenCalledTimes(1);
    expect(wrapper.find('[role="tab"][aria-selected="true"]').text()).toBe("Phones");
    expect(wrapper.find('[role="status"].pairing-progress').text()).toContain("Generating pairing QR code…");
    expect(wrapper.find(".pairing-progress__spinner").exists()).toBe(true);

    finishInvitation({
      protocolVersion: 1,
      pairingId: "pairing-1",
      secret: "s",
      desktopLabel: "Desktop",
      desktopFingerprint: "AB:CD",
      expiresAt: Date.now() + 120_000,
    });
    await flushPromises();

    expect(wrapper.find(".pairing-progress").exists()).toBe(false);
    expect(wrapper.find(".pairing-qr").exists()).toBe(true);
  });

  test("shows an active account confirmation while the Phones panel is selected", async () => {
    const account = useAccountStore();
    account.attach({
      getAccountState: async () => ({
        phase: "signing-in",
        installationRegistered: true,
        auth: {
          phase: "awaiting-confirmation",
          email: "owner@example.test",
          purpose: "reauth",
          expiresAt: Date.now() + 900_000,
          canResendAt: Date.now() - 1,
          manualOnly: false,
          sendsUsed: 1,
          sendOutcome: "sent",
        },
      }),
    } as AnyApi);
    await account.refreshState();

    const { wrapper } = await mountTab();

    expect(wrapper.find('[role="tab"][aria-selected="true"]').text()).toBe("Phones");
    expect(wrapper.text()).toContain("Email confirmed — finish on this computer");
    expect(wrapper.find(".account-auth").isVisible()).toBe(true);
  });

  test("opens Phones immediately when a pairing confirmation already exists at mount", async () => {
    const account = useAccountStore();
    account.attach({ getAccountState: async () => ({ phase: "ready", installationRegistered: true }) } as AnyApi);
    await account.refreshState();
    const payload = makePayload({ enabled: true, devices: [] });
    const transport = makeTransport(payload, {
      listMobileDevicesAwaitingApproval: vi.fn(async () => [
        { deviceId: "phone-1", label: "Pixel", sasReady: true, state: "keyProven" },
      ]),
    });
    const appStore = useAppStore();
    appStore.init(transport as AnyApi);
    appStore.mobilePairingSas = { deviceId: "phone-1", label: "Pixel" };

    const wrapper = mount(SettingsMobileTab, {
      props: { profiles: [{ id: "default", name: "Default" }], initialView: "overview" },
    });
    await flushPromises();

    expect(wrapper.find('[role="tab"][aria-selected="true"]').text()).toBe("Phones");
    expect(wrapper.text()).toContain("Enter the code shown on the phone");
  });

  test("keeps navigation and revoke available while paused but blocks pairing and device mutations", async () => {
    const account = useAccountStore();
    account.attach({ getAccountState: async () => ({ phase: "ready", installationRegistered: true }) } as AnyApi);
    await account.refreshState();
    const { wrapper, appStore } = await mountTab({ listMobileDevices: vi.fn(async () => [SAMPLE_DEVICE]) });
    appStore.payload = {
      ...appStore.payload!,
      appState: {
        ...appStore.payload!.appState,
        settings: { ...appStore.payload!.appState.settings, remoteAccess: { paused: true } },
      },
    } as AnyApi;
    await flushPromises();

    expect(wrapper.find('[role="tab"]').attributes("disabled")).toBeUndefined();
    expect(
      wrapper
        .findAll("button")
        .find((button) => button.text() === "Edit access")!
        .attributes("disabled"),
    ).toBeDefined();
    expect(
      wrapper
        .findAll("button")
        .find((button) => button.text() === "Send test push")!
        .attributes("disabled"),
    ).toBeDefined();
    expect(
      wrapper
        .findAll("button")
        .find((button) => button.text() === "Revoke")!
        .attributes("disabled"),
    ).toBeUndefined();
    expect(wrapper.text()).toContain("Phone access is paused");
  });

  test("renders the device list with platform, fingerprint, last seen, profiles, and capabilities", async () => {
    const { wrapper } = await mountTab({ listMobileDevices: vi.fn(async () => [SAMPLE_DEVICE]) });

    expect(wrapper.text()).toContain("Pixel 8");
    expect(wrapper.text()).toContain("android");
    expect(wrapper.text()).toContain("Control tasks");
    expect(wrapper.text()).toContain("profiles: all, except none");
    // Review 2 §P0.7: the list must name concrete INSTALLATIONS. A label is whatever the phone
    // typed and two phones may share one; the fingerprint is the digest of the key the pairing
    // actually pinned, and is what a user compares against their phone before revoking a row.
    expect(wrapper.text()).toContain("AB:CD");
  });

  test("a device holding a live session shows Connected instead of last seen; the others keep last seen", async () => {
    let statusHandler: ((payload: AnyApi) => void) | null = null;
    const { wrapper } = await mountTab({
      listMobileDevices: vi.fn(async () => [
        SAMPLE_DEVICE,
        { ...SAMPLE_DEVICE, deviceId: "mobile-2", label: "iPhone 15" },
      ]),
      onMobileStatus: (fn: (payload: AnyApi) => void) => {
        statusHandler = fn;
      },
    });
    expect(wrapper.find(".device-item__connected").exists()).toBe(false);
    expect(wrapper.text()).toContain("last seen");

    statusHandler!({
      connectedDevices: [{ deviceId: "mobile-1", name: "Pixel 8", profileId: "default", startedAt: 5000 }],
    });
    await flushPromises();

    const connected = wrapper.findAll(".device-item__connected");
    expect(connected).toHaveLength(1);
    expect(connected[0]!.text()).toBe("Connected");
    // Only the other phone still reports last seen.
    expect(wrapper.text().match(/last seen/g)).toHaveLength(1);
  });

  test("shows paired phones first and reveals the add-phone setup on request", async () => {
    const { wrapper, transport } = await mountTab({ listMobileDevices: vi.fn(async () => [SAMPLE_DEVICE]) });

    expect(wrapper.text()).toContain("Pixel 8");
    expect(wrapper.text()).not.toContain("The new phone gets");
    expect(wrapper.findAll("button").some((button) => button.text() === "Pair a phone")).toBe(false);

    await wrapper
      .findAll("button")
      .find((button) => button.text() === "Add phone")!
      .trigger("click");
    expect(wrapper.text()).toContain("The new phone gets");

    await wrapper
      .findAll("button")
      .find((button) => button.text() === "Pair a phone")!
      .trigger("click");
    await flushPromises();
    expect(transport.createMobilePairingInvitation).toHaveBeenCalledOnce();
  });

  test("Add phone button is primary with no active phones, ghost with active phones", async () => {
    // With a revoked device, mobileDevices.length > 0 so the button shows, but activePhoneCount === 0
    const { wrapper: noActiveWrapper } = await mountTab({
      listMobileDevices: vi.fn(async () => [{ ...SAMPLE_DEVICE, revoked: true }]),
    });
    const noActiveButton = noActiveWrapper.findAll("button").find((b) => b.text() === "Add phone");
    expect(noActiveButton).toBeTruthy();
    expect(noActiveButton!.classes()).toContain("button--primary");
    expect(noActiveButton!.classes()).not.toContain("button--ghost");

    // With one active device, activePhoneCount === 1
    const { wrapper: activeWrapper } = await mountTab({
      listMobileDevices: vi.fn(async () => [SAMPLE_DEVICE]),
    });
    const activeButton = activeWrapper.findAll("button").find((b) => b.text() === "Add phone");
    expect(activeButton).toBeTruthy();
    expect(activeButton!.classes()).toContain("button--ghost");
    expect(activeButton!.classes()).not.toContain("button--primary");
  });

  test("the device row renders an iOS device as ios", async () => {
    // The row prints device.platform verbatim, and the whole suite used to pair only Android
    // fixtures — so nothing held the desktop to being platform-agnostic about a client that is
    // built for both.
    const { wrapper } = await mountTab({
      listMobileDevices: vi.fn(async () => [
        { ...SAMPLE_DEVICE, deviceId: "mobile-2", label: "iPhone 15", platform: "ios" },
      ]),
    });

    expect(wrapper.text()).toContain("iPhone 15");
    expect(wrapper.text()).toContain("ios");
  });

  test("a device waiting for the human decision says WHICH step it is waiting on", async () => {
    // Claimed is not paired, and "proving key" and "awaiting your confirmation" are different states a
    // user can act on differently (review 3 §P0.1). Without this, either one is indistinguishable from
    // "notifications are broken" — the support ticket the badge exists to prevent.
    const proving = await mountTab({
      listMobileDevices: vi.fn(async () => [
        { ...SAMPLE_DEVICE, state: "claimed", verifiedAt: null, activatedAt: null },
      ]),
    });
    expect(proving.wrapper.text()).toContain("proving key");

    const awaiting = await mountTab({
      listMobileDevices: vi.fn(async () => [{ ...SAMPLE_DEVICE, state: "keyProven", activatedAt: null }]),
    });
    expect(awaiting.wrapper.text()).toContain("awaiting your confirmation");
  });

  test("Review pairing opens the code prompt for the selected pending phone", async () => {
    const pendingDevices = [
      { ...SAMPLE_DEVICE, deviceId: "phone-1", label: "First phone", state: "keyProven", activatedAt: null },
      { ...SAMPLE_DEVICE, deviceId: "phone-2", label: "Second phone", state: "keyProven", activatedAt: null },
    ];
    const listPending = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValue([
        { deviceId: "phone-1", label: "First phone", sasReady: true, state: "keyProven" },
        { deviceId: "phone-2", label: "Second phone", sasReady: true, state: "keyProven" },
      ]);
    const { wrapper } = await mountTab({
      listMobileDevices: vi.fn(async () => pendingDevices),
      listMobileDevicesAwaitingApproval: listPending,
    });

    const reviewButtons = wrapper.findAll("button").filter((button) => button.text() === "Review pairing");
    await reviewButtons[1]!.trigger("click");
    await flushPromises();

    const prompt = wrapper.find(".pairing-sas");
    expect(prompt.text()).toContain("Second phone");
    expect(prompt.text()).not.toContain("First phone");
  });

  test("Review pairing on a phone with no derivable code says so instead of opening a prompt", async () => {
    const listPending = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValue([{ deviceId: "phone-1", label: "First phone", sasReady: false, state: "keyProven" }]);
    const { wrapper } = await mountTab({
      listMobileDevices: vi.fn(async () => [
        { ...SAMPLE_DEVICE, deviceId: "phone-1", label: "First phone", state: "keyProven", activatedAt: null },
      ]),
      listMobileDevicesAwaitingApproval: listPending,
    });

    await wrapper
      .findAll("button")
      .find((button) => button.text() === "Review pairing")!
      .trigger("click");
    await flushPromises();

    expect(wrapper.find(".pairing-sas").exists()).toBe(false);
    expect(wrapper.text()).toContain("The pairing code for this phone is no longer available");
  });

  test("an active device carries no pending badge, and a revoked one carries only ", async () => {
    const { wrapper } = await mountTab({
      listMobileDevices: vi.fn(async () => [
        SAMPLE_DEVICE,
        {
          ...SAMPLE_DEVICE,
          deviceId: "mobile-2",
          state: "revoked",
          verifiedAt: null,
          activatedAt: null,
          revoked: true,
          revokedAt: 4000,
        },
      ]),
    });

    // A revoked device's pairing progress is not the interesting fact about it, and stacking two badges
    // would bury the one that matters.
    expect(wrapper.text()).not.toContain("awaiting your confirmation");
    expect(wrapper.text()).not.toContain("proving key");
    expect(wrapper.text()).toContain("revoked");
  });

  // The list only ever grew: nothing anywhere removed a row from it. The cross is housekeeping and
  // says so — it changes no permission, because a missing record is refused by the same predicate
  // that refuses a revoked one.
  test("only a revoked device offers the cross that clears its row", async () => {
    const forgetMobileDevice = vi.fn(async () => ({ ok: true }));
    const { wrapper } = await mountTab({
      forgetMobileDevice,
      listMobileDevices: vi.fn(async () => [
        SAMPLE_DEVICE,
        { ...SAMPLE_DEVICE, deviceId: "mobile-2", state: "revoked", revoked: true, revokedAt: 4000 },
      ]),
    });

    const crosses = wrapper.findAll(".device-item__forget");
    expect(crosses).toHaveLength(1);

    await crosses[0]!.trigger("click");
    await flushPromises();
    expect(forgetMobileDevice).toHaveBeenCalledWith("mobile-2");
  });

  // The gap between the scan and the SAS is real work, and the screen used to show an unchanged QR
  // for all of it — indistinguishable from a scan that did nothing, which is what made people scan
  // again.
  test("a claim in flight covers the QR with a spinner, and the code stays underneath", async () => {
    const { wrapper, appStore } = await mountTab();
    appStore.mobilePairingInvitation = { pairingId: "p-1", expiresAt: Date.now() + 120_000 };
    await flushPromises();
    expect(wrapper.find(".pairing-qr__working").exists()).toBe(false);

    appStore.mobilePairingClaimInFlight = true;
    await flushPromises();
    await flushPromises();

    expect(wrapper.find(".pairing-qr__working").exists()).toBe(true);
    expect(wrapper.text()).toContain("Verifying its key");
    // The code is still rendered: the claim can be REJECTED, and the next thing to do then is scan
    // the same code again.
    await vi.waitFor(() => expect(wrapper.find(".pairing-qr__img").exists()).toBe(true));
    expect(wrapper.text()).not.toContain("Expires in");
  });

  test("a refusal is shown beside the row rather than swallowed", async () => {
    const { wrapper } = await mountTab({
      forgetMobileDevice: vi.fn(async () => ({ ok: false, reason: "cloud-revoke-pending" })),
      listMobileDevices: vi.fn(async () => [
        { ...SAMPLE_DEVICE, deviceId: "mobile-2", state: "revoked", revoked: true, revokedAt: 4000 },
      ]),
    });

    await wrapper.find(".device-item__forget").trigger("click");
    await flushPromises();
    expect(wrapper.text()).toContain("The service is still processing this revoke");
  });

  // Twelve ticked checkboxes in two unlabeled rows — profiles and capabilities in identical boxes —
  // were a question the screen had already answered for itself. Pairing hands out everything; the
  // boxes are behind a disclosure for whoever actually came to restrict something.
  test("pairing grants everything by default, with the pickers behind a disclosure", async () => {
    const { wrapper, transport } = await mountTab({}, { enabled: true, devices: [] });

    // Stated in a sentence, not in a row of boxes.
    expect(wrapper.find(".pairing-section").text()).toContain("all profiles and everything a paired phone can do");
    const limits = wrapper.find("details.pairing-limits");
    expect(limits.exists()).toBe(true);
    expect(limits.attributes("open")).toBeUndefined();
    // The two questions are named, rather than being one flat list.
    expect(limits.text()).toContain("All current and future profiles are included");
    expect(limits.text()).toContain("What it may do");
    // Every picker lives inside it — nothing is asked before the button.
    expect(wrapper.findAll(".pairing-picker").length).toBe(limits.findAll(".pairing-picker").length);

    await wrapper
      .findAll("button")
      .find((b) => b.text().includes("Pair a phone"))!
      .trigger("click");
    await flushPromises();

    const grant = transport.createMobilePairingInvitation.mock.calls[0][0];
    expect(grant.profileAllowlist).toEqual(["default"]);
    expect(grant.capabilities).toEqual([
      "notifications",
      "status.read",
      "task.control",
      "task.destructive",
      "remote.request",
      "remote.webSession",
    ]);
  });

  test("shows useful copy for the Electron-wrapped active-plan pairing refusal", async () => {
    const { wrapper } = await mountTab({
      createMobilePairingInvitation: vi.fn(async () => {
        throw new Error(
          "Error invoking remote method 'mobile:pairing:create': MobileFirebaseCallableError: createPairingInvitation failed (PERMISSION_DENIED: entitlement-required)",
        );
      }),
    });

    await wrapper
      .findAll("button")
      .find((button) => button.text().includes("Pair a phone"))!
      .trigger("click");
    await flushPromises();

    const error = wrapper.find(".mobile-tab__error");
    expect(error.text()).toContain("Pairing a phone requires an active mobile plan");
    expect(error.text()).toContain("Account settings");
    expect(error.text()).toContain("if you are eligible");
    expect(error.text()).not.toContain("PERMISSION_DENIED");
  });

  // The sentence is derived, not hardcoded: somebody who opens the disclosure and unticks must not
  // be told they are handing out everything.
  test("Edit access stores exclusions instead of a fixed list of allowed profiles", async () => {
    const { wrapper, transport } = await mountTab({ listMobileDevices: vi.fn(async () => [SAMPLE_DEVICE]) });
    await wrapper
      .findAll("button")
      .find((b) => b.text() === "Edit access")!
      .trigger("click");
    const form = wrapper.find(".device-item__allowlist-form");
    const profile = form.findAll(".pairing-picker")[0].find("input");
    expect((profile.element as HTMLInputElement).checked).toBe(false);
    await profile.setValue(true);
    await form.find("button").trigger("click");
    await flushPromises();
    expect(transport.updateMobileDeviceAllowlist).toHaveBeenCalledWith({
      deviceId: "mobile-1",
      capabilities: ["task.control"],
      excludedProfileIds: ["default"],
    });
  });

  test("narrowing the grant is reflected in the sentence above the button", async () => {
    const { wrapper } = await mountTab({}, { enabled: true, devices: [] });

    const capabilityBoxes = wrapper.find("details.pairing-limits").findAll(".pairing-picker")[0].findAll("input");
    await capabilityBoxes[0].setValue(false);

    expect(wrapper.find(".pairing-section").text()).toContain("5 of 6 capabilities");
    expect(wrapper.find(".pairing-section").text()).not.toContain("everything a paired phone can do");
  });

  test("shows a QR/countdown section after starting pairing, and returns to the pair button on cancel", async () => {
    const { wrapper } = await mountTab();

    const pairButton = wrapper.findAll("button").find((b) => b.text().includes("Pair a phone"));
    expect(pairButton).toBeTruthy();

    await pairButton!.trigger("click");
    await flushPromises();

    expect(wrapper.text()).toContain("Expires in");
    expect(wrapper.text()).toMatch(/\d+s/);

    const cancelButton = wrapper.findAll("button").find((b) => b.text() === "Cancel");
    await cancelButton!.trigger("click");
    await flushPromises();

    expect(wrapper.text()).not.toContain("Expires in");
    expect(wrapper.findAll("button").some((b) => b.text().includes("Pair a phone"))).toBe(true);
  });

  // Review 2 §P0.4: the key-pinning story leans on a person comparing two values derived from the same
  // transcript. Review 3 §3.6: a desktop that SHOWS its value beside an approve button turns that
  // comparison into a click, so the user types the phone's code instead and the backend compares.
  test("the pairing prompt asks for the phone's code and offers the two decisions it gates", async () => {
    // Review 3 §P0.1. This block used to have one button, "I compared them", which hid the code and did
    // nothing else — the device was already live by then, and a mismatch was answered by prose telling
    // the user to revoke afterwards. The two buttons ARE the gate now.
    const { wrapper, transport } = await mountTab();

    transport._pairingProgress({
      status: "awaiting-approval",
      deviceId: "mobile-1",
      label: "Pixel 8",
      sasReady: true,
      pairingId: "pairing-1",
    });
    await flushPromises();

    expect(wrapper.text()).toContain("Enter the code shown on the phone");
    expect(wrapper.text()).toContain("Pixel 8");
    const input = wrapper.find('[data-testid="pairing-sas-input"]');
    expect(input.exists()).toBe(true);
    expect(input.attributes("inputmode")).toBe("numeric");
    expect(input.attributes("autocomplete")).toBe("off");
    expect(wrapper.findAll("button").some((b) => b.text() === "Activate")).toBe(true);
    expect(wrapper.findAll("button").some((b) => b.text().includes("Mismatch"))).toBe(true);
  });

  // The whole point of §3.6: nothing on this screen is a code to glance at. Even a backend that (wrongly)
  // still sent one must not get it rendered — the store never keeps it.
  test("the expected code is never rendered, even if the event carried one", async () => {
    const { wrapper, transport } = await mountTab();

    transport._pairingProgress({
      status: "awaiting-approval",
      deviceId: "mobile-1",
      label: "Pixel 8",
      sasReady: true,
      sas: "1234 5678",
      pairingId: "pairing-1",
    });
    await flushPromises();

    expect(wrapper.find(".pairing-sas").exists()).toBe(true);
    expect(wrapper.html()).not.toContain("1234 5678");
    expect(wrapper.html()).not.toContain("12345678");
    expect(wrapper.find(".pairing-sas__code").exists()).toBe(false);
    expect((wrapper.find('[data-testid="pairing-sas-input"]').element as HTMLInputElement).value).toBe("");
    expect(useAppStore().mobilePairingSas).toEqual({
      deviceId: "mobile-1",
      label: "Pixel 8",
      state: "awaiting-approval",
    });
  });

  test("Activate stays disabled until all 8 digits are typed, and the field takes only digits and spaces", async () => {
    const { wrapper, transport } = await mountTab();
    transport._pairingProgress({
      status: "awaiting-approval",
      deviceId: "mobile-1",
      label: "Pixel 8",
      sasReady: true,
      pairingId: "pairing-1",
    });
    await flushPromises();
    const input = wrapper.get('[data-testid="pairing-sas-input"]');
    const activate = () => wrapper.findAll("button").find((b) => b.text() === "Activate")!;

    expect(activate().attributes("disabled")).toBeDefined();
    await input.setValue("1234 567");
    expect(activate().attributes("disabled")).toBeDefined();
    await input.setValue("1234 56a7-");
    expect((input.element as HTMLInputElement).value).toBe("1234 567");
    expect(activate().attributes("disabled")).toBeDefined();
    await input.setValue("1234 5678");
    expect(activate().attributes("disabled")).toBeUndefined();

    // Spaces alone are not digits.
    await input.setValue("         ");
    expect(activate().attributes("disabled")).toBeDefined();
    expect(transport.approveMobileDevice).not.toHaveBeenCalled();
  });

  test("the single code input keeps eight grouped positions visible without submitting while typing", async () => {
    const { wrapper, transport } = await mountTab();
    transport._pairingProgress({
      status: "awaiting-approval",
      deviceId: "mobile-1",
      label: "Pixel 8",
      sasReady: true,
      pairingId: "pairing-1",
    });
    await flushPromises();
    const input = wrapper.get('[data-testid="pairing-sas-input"]');
    const slots = wrapper.get('[data-testid="pairing-sas-slots"]');

    expect(wrapper.findAll(".pairing-sas input")).toHaveLength(1);
    expect(input.attributes("inputmode")).toBe("numeric");
    expect(input.attributes("pattern")).toBe("[0-9]{4} [0-9]{4}");
    expect(input.attributes("aria-label")).toContain("8-digit");
    expect(slots.attributes("aria-hidden")).toBe("true");
    expect(slots.element.textContent).toBe("____ ____");
    await input.setValue("82");
    expect((input.element as HTMLInputElement).value).toBe("82");
    expect(slots.element.textContent).toBe("  __ ____");
    await input.setValue("82654321");
    expect((input.element as HTMLInputElement).value).toBe("8265 4321");
    expect(slots.element.textContent).toBe("         ");
    expect(transport.approveMobileDevice).not.toHaveBeenCalled();
    await input.setValue("");
    expect(slots.element.textContent).toBe("____ ____");
  });

  test("pasted code accepts only the first eight digits and normalizes the grouping", async () => {
    const { wrapper, transport } = await mountTab();
    transport._pairingProgress({
      status: "awaiting-approval",
      deviceId: "mobile-1",
      label: "Pixel 8",
      sasReady: true,
      pairingId: "pairing-1",
    });
    await flushPromises();
    const input = wrapper.get('[data-testid="pairing-sas-input"]');
    await input.setValue("a1 b2\n34—5678 90!");
    expect((input.element as HTMLInputElement).value).toBe("1234 5678");
    expect(transport.approveMobileDevice).not.toHaveBeenCalled();
    await input.setValue("letters — !");
    expect((input.element as HTMLInputElement).value).toBe("");
  });

  test("code normalization preserves the native caret while editing and deleting near the group separator", async () => {
    const { wrapper, transport } = await mountTab();
    transport._pairingProgress({
      status: "awaiting-approval",
      deviceId: "mobile-1",
      label: "Pixel 8",
      sasReady: true,
      pairingId: "pairing-1",
    });
    await flushPromises();
    const field = wrapper.get('[data-testid="pairing-sas-input"]');
    const input = field.element as HTMLInputElement;
    await field.setValue("1234 5678");

    input.value = "12a34 5678";
    input.setSelectionRange(3, 3);
    await field.trigger("input");
    expect(input.value).toBe("1234 5678");
    expect(input.selectionStart).toBe(2);

    input.value = "12a34 5678";
    input.setSelectionRange(2, 5, "backward");
    await field.trigger("input");
    expect(input.value).toBe("1234 5678");
    expect(input.selectionStart).toBe(2);
    expect(input.selectionEnd).toBe(4);
    expect(input.selectionDirection).toBe("backward");

    input.value = "12345678";
    input.setSelectionRange(4, 4);
    await field.trigger("input");
    expect(input.value).toBe("1234 5678");
    expect(input.selectionStart).toBe(4);

    input.value = "123 5678";
    input.setSelectionRange(3, 3);
    await field.trigger("input");
    expect(input.value).toBe("1235 678");
    expect(input.selectionStart).toBe(3);
    expect(wrapper.get('[data-testid="pairing-sas-slots"]').element.textContent).toBe("        _");
  });

  test("the claiming phone's label is shown as plain quoted text, never as emphasis or markup", async () => {
    // The label is whatever the device called itself, and a phone somebody else holds chooses it.
    const { wrapper, transport } = await mountTab();
    transport._pairingProgress({
      status: "awaiting-approval",
      deviceId: "mobile-1",
      label: "<b>Your phone</b>",
      sasReady: true,
      pairingId: "pairing-1",
    });
    await flushPromises();

    const hint = wrapper.find(".pairing-sas__hint");
    expect(hint.text()).toContain("“<b>Your phone</b>”");
    expect(hint.text()).toContain("8-digit code");
    expect(hint.find("strong").exists()).toBe(false);
    expect(hint.find("b").exists()).toBe(false);
  });

  test("a code typed for one phone is not carried over to the next pending phone", async () => {
    const { wrapper, transport } = await mountTab();
    transport._pairingProgress({
      status: "awaiting-approval",
      deviceId: "mobile-1",
      label: "Pixel 8",
      sasReady: true,
      pairingId: "pairing-1",
    });
    await flushPromises();
    await wrapper.get('[data-testid="pairing-sas-input"]').setValue("1234 5678");

    transport._pairingProgress({
      status: "awaiting-approval",
      deviceId: "mobile-2",
      label: "Galaxy",
      sasReady: true,
      pairingId: "pairing-2",
    });
    await flushPromises();

    expect((wrapper.get('[data-testid="pairing-sas-input"]').element as HTMLInputElement).value).toBe("");
    expect(wrapper.find(".pairing-sas").text()).toContain("Galaxy");
  });

  test("Decide later clears the typed code", async () => {
    const { wrapper, transport } = await mountTab();
    const progress = {
      status: "awaiting-approval",
      deviceId: "mobile-1",
      label: "Pixel 8",
      sasReady: true,
      pairingId: "pairing-1",
    };
    transport._pairingProgress(progress);
    await flushPromises();
    await wrapper.get('[data-testid="pairing-sas-input"]').setValue("1234 5678");

    await wrapper
      .findAll("button")
      .find((b) => b.text().includes("Decide later"))!
      .trigger("click");
    await flushPromises();
    expect(wrapper.find(".pairing-sas").exists()).toBe(false);

    transport._pairingProgress(progress);
    await flushPromises();
    expect((wrapper.get('[data-testid="pairing-sas-input"]').element as HTMLInputElement).value).toBe("");
  });

  // The code arrives while the user is looking at the QR they have just held a phone up to. It used
  // to appear above a still-rendered QR and a second "+ Pair device" button, on a tab long enough
  // that the one step actually theirs was off-screen — so they scrolled looking for it.
  test("a pending code takes the QR's place and is brought on screen", async () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    const { wrapper, transport } = await mountTab();

    // Start a pairing, so the QR block is what is on screen when the code lands.
    await wrapper
      .findAll("button")
      .find((b) => b.text().includes("Pair a phone"))!
      .trigger("click");
    await flushPromises();
    expect(wrapper.find(".pairing-qr").exists()).toBe(true);

    transport._pairingProgress({
      status: "awaiting-approval",
      deviceId: "mobile-1",
      label: "Pixel 8",
      sasReady: true,
      pairingId: "pairing-1",
    });
    await flushPromises();

    expect(wrapper.find(".pairing-sas").exists()).toBe(true);
    expect(wrapper.find(".pairing-section").exists()).toBe(false);
    expect(scrollIntoView).toHaveBeenCalled();
  });

  test("when the SAS block appears, the input gets keyboard focus", async () => {
    const payload = makePayload({ enabled: true, devices: [] });
    const transport = makeTransport(payload);
    useAppStore().init(transport as AnyApi);
    const wrapper = mount(SettingsMobileTab, {
      props: { profiles: [{ id: "default", name: "Default" }] },
      attachTo: document.body,
    });
    await flushPromises();

    transport._pairingProgress({
      status: "awaiting-approval",
      deviceId: "mobile-1",
      label: "Pixel 8",
      sasReady: true,
      pairingId: "pairing-1",
    });
    await flushPromises();

    const input = wrapper.find('[data-testid="pairing-sas-input"]').element as HTMLInputElement;
    expect(input).toBe(document.activeElement);
    wrapper.unmount();
  });

  // The advanced switches remain available for settings; the overview also exposes the relay's
  // automatic registration state and an immediate manual override.
  test("the settings switches live in Advanced, at the end", async () => {
    const { wrapper } = await mountTab({}, { enabled: true, devices: [], relay: { enabled: false } });

    const advanced = wrapper.find("details.mobile-tab__advanced");
    expect(advanced.exists()).toBe(true);
    expect(advanced.text()).toContain("Enable Mobile");
    expect(advanced.text()).toContain("Managed relay");
    // Nothing above it asks either question.
    expect(wrapper.find(".pairing-section").exists()).toBe(true);
    expect(advanced.find(".pairing-section").exists()).toBe(false);
  });

  // With Mobile off but a phone still paired, Advanced is the ONLY place that can turn it back on —
  // so it must not be gated on the switch it contains.
  test("Advanced still offers the switch when Mobile is off and a device is paired", async () => {
    const { wrapper } = await mountTab(
      { listMobileDevices: vi.fn(async () => [SAMPLE_DEVICE]) },
      { enabled: false, devices: [] },
    );

    const advanced = wrapper.find("details.mobile-tab__advanced");
    expect(advanced.exists()).toBe(true);
    expect(advanced.text()).toContain("Enable Mobile");
    // The relay switch belongs to a running integration; with Mobile off there is nothing to relay.
    expect(advanced.text()).not.toContain("Managed relay");
  });

  test("Activate sends the typed code through the desktop-only IPC call", async () => {
    const { wrapper, transport } = await mountTab();
    transport._pairingProgress({
      status: "awaiting-approval",
      deviceId: "mobile-1",
      label: "Pixel 8",
      sasReady: true,
      pairingId: "pairing-1",
    });
    await flushPromises();
    await wrapper.get('[data-testid="pairing-sas-input"]').setValue("1234 5678");

    await wrapper
      .findAll("button")
      .find((b) => b.text() === "Activate")!
      .trigger("click");
    await flushPromises();

    expect(transport.approveMobileDevice).toHaveBeenCalledWith("mobile-1", "1234 5678");
    expect(wrapper.find(".pairing-sas").exists()).toBe(false);
  });

  test("Mismatch revokes the device and names the reason", async () => {
    const { wrapper, transport } = await mountTab();
    transport._pairingProgress({
      status: "awaiting-approval",
      deviceId: "mobile-1",
      label: "Pixel 8",
      sasReady: true,
      pairingId: "pairing-1",
    });
    await flushPromises();

    await wrapper
      .findAll("button")
      .find((b) => b.text().includes("Mismatch"))!
      .trigger("click");
    await flushPromises();

    expect(transport.rejectMobileDevice).toHaveBeenCalledWith({ deviceId: "mobile-1", reason: "sas-mismatch" });
    expect(wrapper.find(".pairing-sas").exists()).toBe(false);
  });

  test("a failed activation is reported, not silently swallowed", async () => {
    // The device stays inert when the cloud refuses, so a user who pressed the button and saw nothing
    // would reasonably assume pairing had completed — the exact fail-open reading this change removes.
    const { wrapper, transport } = await mountTab({
      approveMobileDevice: vi.fn(async () => ({ ok: false, reason: "key-proof-not-attested" })),
    });
    transport._pairingProgress({
      status: "awaiting-approval",
      deviceId: "mobile-1",
      label: "Pixel 8",
      sasReady: true,
      pairingId: "pairing-1",
    });
    await flushPromises();
    await wrapper.get('[data-testid="pairing-sas-input"]').setValue("1234 5678");

    await wrapper
      .findAll("button")
      .find((b) => b.text() === "Activate")!
      .trigger("click");
    await flushPromises();

    expect(wrapper.text()).toContain("Could not activate this phone. It remains inactive.");
    expect(wrapper.text()).not.toContain("key-proof-not-attested");
  });

  test("a claim whose SAS could not be derived shows no code rather than a placeholder", async () => {
    // MobileManager reports `sasReady: false` when either public key is unusable. There is then no code
    // to type a phone's value against, and a prompt that could never be satisfied — or worse, could be
    // satisfied by anything — is worse than none.
    const { wrapper, transport } = await mountTab();

    transport._pairingProgress({
      status: "awaiting-approval",
      deviceId: "mobile-1",
      label: "Pixel 8",
      sasReady: false,
      pairingId: "pairing-1",
    });
    await flushPromises();

    expect(wrapper.text()).not.toContain("Enter the code shown on the phone");
    expect(wrapper.find('[data-testid="pairing-sas-input"]').exists()).toBe(false);
  });

  test("a code that does not match this desktop's gets its own warning, not the generic failure copy", async () => {
    const { wrapper, transport } = await mountTab({
      approveMobileDevice: vi.fn(async () => ({ ok: false, reason: "sas-mismatch" })),
    });
    transport._pairingProgress({
      status: "awaiting-approval",
      deviceId: "mobile-1",
      label: "Pixel 8",
      sasReady: true,
      pairingId: "pairing-1",
    });
    await flushPromises();
    await wrapper.get('[data-testid="pairing-sas-input"]').setValue("0000 0000");

    await wrapper
      .findAll("button")
      .find((b) => b.text() === "Activate")!
      .trigger("click");
    await flushPromises();

    const error = wrapper.find(".pairing-sas__error");
    expect(error.exists()).toBe(true);
    expect(error.text()).toContain("does not match");
    expect(error.text()).toContain("someone else may have used the invitation");
    expect(error.text()).toContain("Mismatch — revoke");
    expect(error.text()).not.toContain("It remains inactive");
    // Nothing was cleared: the user can retype, or choose Mismatch.
    expect(wrapper.find(".pairing-sas").exists()).toBe(true);
    expect(wrapper.findAll("button").some((b) => b.text().includes("Mismatch"))).toBe(true);
  });

  test("revoke requires confirmation before calling the transport", async () => {
    const { wrapper, transport, appStore } = await mountTab({
      listMobileDevices: vi.fn(async () => [SAMPLE_DEVICE]),
    });

    const confirmSpy = vi.spyOn(appStore, "confirmInApp").mockResolvedValue(false);
    const revokeButton = () => wrapper.findAll("button").find((b) => b.text() === "Revoke");

    await revokeButton()!.trigger("click");
    await flushPromises();

    expect(confirmSpy).toHaveBeenCalled();
    expect(transport.revokeMobileDevice).not.toHaveBeenCalled();

    confirmSpy.mockResolvedValue(true);
    await revokeButton()!.trigger("click");
    await flushPromises();

    expect(transport.revokeMobileDevice).toHaveBeenCalledWith("mobile-1");
  });

  test("renders today's push quota numbers", async () => {
    const { wrapper } = await mountTab();

    expect(wrapper.text()).toContain("3 / 100 pushes today");
    expect(wrapper.text()).toContain("10");
    expect(wrapper.text()).toContain("reserved for high-priority");
  });

  test("toggling Enable Mobile calls the setMobileEnabled transport action", async () => {
    // A paired device, because that is when the CHECKBOX exists: before the first phone the page
    // offers "Turn on phone pairing" instead (see the first-run test below). Same transport call.
    const { wrapper, transport } = await mountTab(
      { listMobileDevices: vi.fn(async () => [SAMPLE_DEVICE]) },
      { enabled: false, devices: [] },
    );

    const checkbox = wrapper.find('input[type="checkbox"]');
    await checkbox.setValue(true);
    await flushPromises();

    expect(transport.setMobileEnabled).toHaveBeenCalledWith(true);
  });

  // Dev-environment finding 6: the flag existed, the runtime read it, and `docs/RELAY-MVP.md` told the
  // user to turn it on in this tab — where there was no control at all. These two tests are what make
  // "the feature is reachable" a thing that cannot silently regress.
  test("the managed relay has its own switch, and toggling it calls setMobileRelayEnabled", async () => {
    const { wrapper, transport } = await mountTab({}, { enabled: true, devices: [], relay: { enabled: false } });

    const relayLabel = wrapper.findAll("label").find((l) => l.text().includes("Managed relay"));
    expect(relayLabel).toBeTruthy();
    await relayLabel!.find('input[type="checkbox"]').setValue(true);
    await flushPromises();

    expect(transport.setMobileRelayEnabled).toHaveBeenCalledWith(true);
  });

  test("the overview exposes relay state and lets the user enable or disable it", async () => {
    const account = useAccountStore();
    account.attach({
      getAccountState: async () => ({ phase: "ready", installationRegistered: true }),
    } as AnyApi);
    await account.refreshState();
    const { wrapper, transport } = await mountTab(
      {
        getMobileRelayStatus: vi.fn(async () => ({
          enabled: true,
          state: "ready",
          relayOrigin: "https://relay.example.test",
          internalPort: 5123,
          lastError: "",
          stats: null,
        })),
      },
      { enabled: true, devices: [], relay: { enabled: true } },
      "overview",
    );

    expect(wrapper.find(".mobile-tab__overview-grid").text()).toContain("Enabled · Connected");
    expect(wrapper.find(".mobile-tab__overview-grid").text()).toContain("Connected and ready for paired phones.");
    await wrapper.find(".mobile-tab__overview-grid").find("button").trigger("click");
    await flushPromises();
    expect(transport.setMobileRelayEnabled).toHaveBeenCalledWith(false);
  });

  test("the overview shows relay toggle failures beside the control", async () => {
    const account = useAccountStore();
    account.attach({
      getAccountState: async () => ({ phase: "ready", installationRegistered: true }),
    } as AnyApi);
    await account.refreshState();
    const { wrapper } = await mountTab(
      { setMobileRelayEnabled: vi.fn(async () => Promise.reject(new Error("Relay could not start"))) },
      { enabled: true, devices: [], relay: { enabled: false } },
      "overview",
    );

    await wrapper.find(".mobile-tab__overview-grid").find("button").trigger("click");
    await flushPromises();
    expect(wrapper.find('.mobile-tab__overview-grid [role="alert"]').text()).toBe(
      "Could not update the remote connection. Please try again.",
    );
  });

  test("a connected transport whose pair no longer recognises this desktop does not read as 'Connected'", async () => {
    // The failure this closes: the desktop's cloud identity was re-minted, so its uid was no longer
    // in the pair's members and every read and write was refused — while this badge said
    // "Connected" and the phone said "Not reachable". Both were reporting the truth they could see.
    const denied = await mountTab(
      {
        refreshMobileConnectionHealth: vi.fn(async () => ({
          health: {
            running: true,
            connectionState: "connected",
            lastError: null,
            deviceCount: 1,
            pendingInvitation: null,
            pairAuthorization: "denied",
          },
          quota: null,
        })),
      },
      { enabled: true, devices: [], relay: { enabled: false } },
    );

    const badge = denied.wrapper.find(".status-row .status-badge");
    expect(badge.text()).toBe("Not authorized");
    expect(badge.classes()).toContain("badge--warn");
    expect(badge.attributes("title")).toContain("Re-pair the phone");
  });

  test("the relay row reports the relay's own state, so 'on' is not mistaken for 'connected'", async () => {
    const connected = await mountTab(
      {
        getMobileRelayStatus: vi.fn(async () => ({
          enabled: true,
          state: "ready",
          relayOrigin: "https://relay.example.test",
          internalPort: 5123,
          lastError: "",
          stats: null,
        })),
      },
      { enabled: true, devices: [], relay: { enabled: true } },
    );
    // Scoped to the relay block: the Firebase health row says "Connected" too, and the point of this
    // test is that the RELAY's own state is what the relay row shows.
    expect(connected.wrapper.find(".relay-block").text()).toContain("Connected");

    const half = await mountTab(
      {
        getMobileRelayStatus: vi.fn(async () => ({
          enabled: true,
          state: "authenticating",
          relayOrigin: "https://relay.example.test",
          internalPort: 0,
          lastError: "",
          stats: null,
        })),
      },
      { enabled: true, devices: [], relay: { enabled: true } },
    );
    // The switch is on in both cases; only one of them means a phone can open a session.
    const halfText = half.wrapper.find(".relay-block").text();
    expect(halfText).toContain("Connecting…");
    expect(halfText).not.toContain("Connected");
  });

  test("a TLS-inspection failure is explained in words, with the raw code kept in the title", async () => {
    const { wrapper } = await mountTab(
      {
        refreshMobileConnectionHealth: vi.fn(async () => ({
          health: {
            running: true,
            connectionState: "disconnected",
            lastError: "network:tls-untrusted",
            deviceCount: 0,
            pendingInvitation: null,
          },
          quota: null,
        })),
        getMobileRelayStatus: vi.fn(async () => ({
          enabled: true,
          state: "idle",
          relayOrigin: "",
          internalPort: 0,
          lastError: "network:tls-untrusted",
          stats: null,
        })),
      },
      { enabled: true, devices: [], relay: { enabled: true } },
    );
    const health = wrapper.find(".mobile-tab__error");
    expect(health.text()).toContain("intercepting encrypted connections");
    expect(health.attributes("title")).toBe("network:tls-untrusted");
    expect(health.text()).not.toContain("TypeError");
    const relay = wrapper.find('[data-testid="relay-network-error"]');
    expect(relay.text()).toContain("intercepting encrypted connections");
    expect(relay.attributes("title")).toBe("network:tls-untrusted");
  });

  test("an unknown error code is shown as before", async () => {
    const { wrapper } = await mountTab(
      {
        refreshMobileConnectionHealth: vi.fn(async () => ({
          health: {
            running: true,
            connectionState: "disconnected",
            lastError: "TypeError",
            deviceCount: 0,
            pendingInvitation: null,
          },
          quota: null,
        })),
        getMobileRelayStatus: vi.fn(async () => ({
          enabled: true,
          state: "idle",
          relayOrigin: "",
          internalPort: 0,
          lastError: "issueRelayConnectorGrant failed (UNAUTHENTICATED)",
          stats: null,
        })),
      },
      { enabled: true, devices: [], relay: { enabled: true } },
    );
    expect(wrapper.find(".mobile-tab__error").text()).toBe("TypeError");
    expect(wrapper.find('[data-testid="relay-network-error"]').exists()).toBe(false);
    expect(wrapper.find(".relay-block .status-badge").attributes("title")).toContain(
      "last error: issueRelayConnectorGrant failed (UNAUTHENTICATED)",
    );
  });

  test("the relay switch says what the relay can read, not only that no port is opened", async () => {
    // "Nothing on this machine is exposed to the internet" is true about INBOUND reachability and
    // silent about confidentiality — and because the notification/command plane genuinely IS
    // end-to-end encrypted, silence there reads as "the relay is end-to-end too". It is not: the
    // relay terminates TLS and forwards decrypted frames.
    //
    // Asserted on the copy rather than left to review because this paragraph is where the user
    // actually consents, and a later edit tightening the wording must not drop the distinction.
    const { wrapper } = await mountTab({}, { enabled: true, devices: [], relay: { enabled: false } });
    const relayText = wrapper.find(".relay-block").text();
    expect(relayText).toContain("end-to-end encrypted between this desktop and the phone");
    // The other half of the sentence matters as much: without it the warning overstates the case
    // and implies push content is readable too.
    expect(relayText).toContain("end-to-end encrypted");
    // Present before the user turns the relay on — the disclosure has to precede the decision.
    expect(wrapper.find(".relay-block .status-row").exists()).toBe(false);
  });

  test("send test push button reports the result and is visibly labeled as a test", async () => {
    const { wrapper, transport } = await mountTab({ listMobileDevices: vi.fn(async () => [SAMPLE_DEVICE]) });

    const testPushButton = wrapper.findAll("button").find((b) => b.text().includes("Send test push"));
    await testPushButton!.trigger("click");
    await flushPromises();

    expect(transport.sendMobileTestPush).toHaveBeenCalledWith("mobile-1");
    expect(wrapper.text()).toContain("Test push sent");
  });

  test("the account-wide caps are pointed at, not repeated here", async () => {
    // Plan §8.3: the pairing half stays about pairing and relay diagnostics; how many phones and
    // desktops the ACCOUNT allows is one account-wide fact with one place that states it. Two
    // places each computing "how many are left" is how they end up disagreeing. The account is now
    // a SECTION of this tab rather than a tab of its own, so the pointer is to a heading above
    // rather than to another tab — but it is still a pointer and not a second computation.
    const account = useAccountStore();
    account.attach({
      getAccountState: async () => ({
        phase: "ready",
        busy: false,
        needsRecentAuth: false,
        // REGISTERED, because that is the only state in which the pairing half renders at all. A
        // phone pairs to an installation, so the controls below — and the usage line this test is
        // about — are not offered to a machine that has no account to pair against.
        installationRegistered: true,
        overview: {
          supportReference: "STR-1-ABCDEFGHJKMN",
          usage: {
            installations: { used: 2, limit: 5 },
            mobileDevices: { used: 3, limit: 5 },
            activeRelaySessions: { used: 0, limit: 8 },
          },
          notices: [],
        },
      }),
    } as AnyApi);
    await account.refreshState();
    const { wrapper } = await mountTab({ listMobileDevices: vi.fn(async () => [SAMPLE_DEVICE]) });

    expect(wrapper.text()).toContain("Phones on this account: 3 / 5");
    expect(wrapper.text()).toContain("View account limits");
    expect(wrapper.findComponent({ name: "SettingsAccountTab" }).exists()).toBe(true);
  });

  test("pairing is not offered until this computer is registered, and says which step comes first", async () => {
    // THE ORDER IS THE PAGE'S SHAPE, NOT SOMETHING TO KNOW. A phone pairs to an INSTALLATION, so an
    // unregistered machine has nothing for it to pair to — and every control below would fail for a
    // reason three steps away from where the person is looking. Worse, enrolment needs the
    // installation session, which turning Mobile on happened to create, so the old order invited
    // exactly the sequence that cannot work: tick Mobile, scan a QR, fail.
    const account = useAccountStore();
    account.attach({
      getAccountState: async () => ({
        phase: "signed-out",
        busy: false,
        needsRecentAuth: true,
        installationRegistered: false,
        signInAvailable: true,
      }),
    } as AnyApi);
    await account.refreshState();
    const { wrapper } = await mountTab({ listMobileDevices: vi.fn(async () => [SAMPLE_DEVICE]) });

    expect(wrapper.text()).toContain("Register this computer first");
    // Not merely disabled: absent. A tick-box that cannot lead anywhere is a question with no answer.
    expect(wrapper.text()).not.toContain("Enable Mobile");
    expect(wrapper.find('input[type="checkbox"]').exists()).toBe(false);
  });

  test("before the first phone the page offers the STEP, not the setting", async () => {
    // Somebody who has just registered this computer and started a trial FOR the hosted features
    // met an unticked checkbox and no stated reason — a second gate in front of the thing they came
    // to do. The switch's real job (silence a paired phone without unpairing it) does not exist yet,
    // so neither does the switch.
    const account = useAccountStore();
    account.attach({
      getAccountState: async () => ({
        phase: "ready",
        busy: false,
        needsRecentAuth: false,
        installationRegistered: true,
      }),
    } as AnyApi);
    await account.refreshState();
    const { wrapper, transport } = await mountTab({}, { enabled: false, devices: [] });

    expect(wrapper.text()).toContain("Turn on phone pairing");
    expect(wrapper.text()).not.toContain("Enable Mobile");

    const turnOn = wrapper.findAll("button").find((b) => b.text().includes("Turn on phone pairing"));
    await turnOn!.trigger("click");
    await flushPromises();
    // The same call the checkbox makes: a different sentence, not a different act.
    expect(transport.setMobileEnabled).toHaveBeenCalledWith(true);
  });

  test("without secure storage phone pairing cannot be turned on, and the screen says why", async () => {
    const withoutKeychain = { ...makePayload({ enabled: false, devices: [] }), secureStorage: { available: false } };
    const { wrapper, transport } = await mountTab(
      { getState: vi.fn(async () => withoutKeychain) },
      {
        enabled: false,
        devices: [],
      },
    );

    const turnOn = wrapper.findAll("button").find((b) => b.text().includes("Turn on phone pairing"))!;
    expect(turnOn.attributes("disabled")).toBeDefined();
    expect(wrapper.text()).toContain("needs secure storage");
    await turnOn.trigger("click");
    expect(transport.setMobileEnabled).not.toHaveBeenCalled();
  });

  test("a row's profile and capability copy states what the boundary is, and what it is not", async () => {
    const { wrapper } = await mountTab({ listMobileDevices: vi.fn(async () => [SAMPLE_DEVICE]) });
    const profiles = wrapper.findAll("span").find((el) => el.text().startsWith("profiles:"))!;
    const title = profiles.attributes("title") || "";
    expect(title).toContain("shell on this computer under your account");
    expect(title).toContain("not at the operating-system level");
  });

  test("a user must turn on phone pairing before seeing the Pair a phone action", async () => {
    const { wrapper } = await mountTab({}, { enabled: false, devices: [] });

    expect(wrapper.text()).toContain("Turn on phone pairing");
    expect(wrapper.find(".pairing-section__action").exists()).toBe(false);
  });

  test("once there is something to silence, the switch is back", async () => {
    const account = useAccountStore();
    account.attach({
      getAccountState: async () => ({
        phase: "ready",
        busy: false,
        needsRecentAuth: false,
        installationRegistered: true,
      }),
    } as AnyApi);
    await account.refreshState();
    const { wrapper } = await mountTab({ listMobileDevices: vi.fn(async () => [SAMPLE_DEVICE]) });

    expect(wrapper.text()).toContain("Enable Mobile");
    expect(wrapper.text()).not.toContain("Turn on phone pairing");
  });

  test("a build with no hosted account keeps its local pairing fallback", async () => {
    const { wrapper } = await mountTab({ listMobileDevices: vi.fn(async () => [SAMPLE_DEVICE]) });
    expect(wrapper.text()).not.toContain("Register this computer first");
    expect(wrapper.text()).toContain("Enable Mobile");
  });

  test("trial users see the tester notice and can add phones", async () => {
    const account = useAccountStore();
    account.attach({
      getAccountState: async () => ({
        phase: "ready",
        installationRegistered: true,
        entitlement: { state: "trial", source: "trial" },
      }),
    } as AnyApi);
    await account.refreshState();
    const { wrapper } = await mountTab(
      { listMobileDevices: vi.fn(async () => [SAMPLE_DEVICE]) },
      { enabled: true, devices: [SAMPLE_DEVICE] },
    );

    expect(wrapper.find(".mobile-tab__testing-notice").exists()).toBe(false);
    expect(wrapper.text()).toContain("Pixel 8");
    expect(wrapper.text()).toContain("Edit access");
    await wrapper
      .findAll("button")
      .find((button) => button.text() === "Add phone")!
      .trigger("click");
    expect(wrapper.find(".pairing-section__action").text()).toContain("Pair a phone");
  });

  test("without a hosted account there is no dangling reference to a page that is not there", async () => {
    const { wrapper } = await mountTab({ listMobileDevices: vi.fn(async () => [SAMPLE_DEVICE]) });
    expect(wrapper.text()).not.toContain("Phones on this account");
  });

  // Security review 3.5: the relay cannot downgrade a session to plaintext, but a phone app can leave the
  // `e2e` block out. This checkbox is the desktop's own switch for refusing that, and it is on by default.
  test("the relay's end-to-end requirement is on by default and unticking it calls setMobileRelayRequireE2e", async () => {
    const { wrapper, transport } = await mountTab(
      { setMobileRelayRequireE2e: vi.fn(async () => null) },
      { enabled: true, devices: [], relay: { enabled: true } },
    );

    const box = wrapper.find('[data-testid="relay-require-e2e"]');
    expect(box.exists()).toBe(true);
    expect((box.element as HTMLInputElement).checked).toBe(true);
    await box.setValue(false);
    await flushPromises();

    expect(transport.setMobileRelayRequireE2e).toHaveBeenCalledWith(false);
  });

  test("an explicit requireE2e=false reads as unticked, and ticking it calls setMobileRelayRequireE2e(true)", async () => {
    const { wrapper, transport } = await mountTab(
      { setMobileRelayRequireE2e: vi.fn(async () => null) },
      { enabled: true, devices: [], relay: { enabled: true, requireE2e: false } },
    );

    const box = wrapper.find('[data-testid="relay-require-e2e"]');
    expect((box.element as HTMLInputElement).checked).toBe(false);
    await box.setValue(true);
    await flushPromises();

    expect(transport.setMobileRelayRequireE2e).toHaveBeenCalledWith(true);
  });
});
