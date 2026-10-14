import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import App from "./App.vue";
import SettingsDialog from "./components/dialogs/SettingsDialog.vue";
import { useAppStore } from "./stores/app.js";
import { useNotificationStore } from "./stores/notifications.js";
import { apiKey } from "./types/keys.js";
import { APP_CONFIG } from "../config/app-config.js";
import { createUpdateCheckerForDistribution } from "../electron/backend/version-checker.js";
import type { AppDistribution } from "../electron/shared/app-distribution.js";
import type { MetaState } from "../electron/shared/types/state.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyApi = any;

const tempDirs: string[] = [];

/**
 * The update checker runtime.ts builds for `distribution`, the real one, answering a GitHub releases
 * API that lists v3.0.8 and v3.0.7 (or, for `upToDate`, only the running v3.0.6). Its cached result
 * is what getPayload() puts in `meta.versionCheck`; its manual result is what `app:check-for-updates`
 * returns.
 */
async function realUpdateChecker(distribution: AppDistribution, { upToDate = false } = {}) {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-distribution-ui-"));
  tempDirs.push(userDataPath);
  const tags = upToDate ? ["v3.0.6"] : ["v3.0.8", "v3.0.7", "v3.0.6"];
  const githubRequests: string[] = [];
  const checker = createUpdateCheckerForDistribution({
    distribution,
    microsoftStoreUrl: APP_CONFIG.app.microsoftStoreUrl,
    currentVersion: "3.0.6",
    repositoryUrl: APP_CONFIG.app.repositoryUrl,
    userDataPath,
    fetchImpl: async (url: string) => {
      githubRequests.push(url);
      return {
        ok: true,
        status: 200,
        headers: { get: (name: string) => (name === "etag" ? 'W/"releases"' : null) },
        json: async () =>
          tags.map((tag) => ({
            tag_name: tag,
            html_url: `${APP_CONFIG.app.repositoryUrl}/releases/tag/${tag}`,
            published_at: "2026-10-01T10:00:00Z",
            prerelease: false,
            draft: false,
          })),
      };
    },
  });
  await checker.checkForUpdates();
  return { checker, githubRequests };
}

/** `meta` with the keys and sources runtime.ts getPayload() uses. */
function payloadMeta(distribution: AppDistribution, versionCheck: MetaState["versionCheck"]): MetaState {
  return {
    appVersion: "3.0.6",
    repositoryUrl: APP_CONFIG.app.repositoryUrl,
    distribution,
    microsoftStoreUrl: APP_CONFIG.app.microsoftStoreUrl,
    versionCheck,
    platform: "win32",
    recoveryCandidates: [],
  };
}

const APP_STATE = {
  workspaces: [{ id: "ws-A", name: "Alpha", cwd: "/a", panels: [], icon: "A", color: "#fff", profileId: "default" }],
  activeWorkspaceId: "ws-A",
  activeProfileId: "default",
  profiles: [{ id: "default", name: "Default" }],
  workspaceGrid: null,
  windowSlots: [{ id: "win-test", profileId: "default", activeWorkspaceId: "ws-A" }],
  settings: {},
  tabTemplates: [],
};

beforeEach(() => {
  setActivePinia(createPinia());
  (window as AnyApi).strideterm = { startupFlags: { windowId: "win-test" } };
});

afterEach(async () => {
  delete (window as AnyApi).strideterm;
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("sidebar footer — the distribution and where its updates come from", () => {
  function stubApi(openExternal: ReturnType<typeof vi.fn>): AnyApi {
    return new Proxy({ isRemote: false, openExternal } as AnyApi, {
      get(target, prop) {
        if (prop in target) return target[prop as keyof typeof target];
        return () => undefined;
      },
      has: () => true,
    });
  }

  /** Mount on the bootstrap payload (no version check yet), then deliver the runtime's payload. */
  async function mountFooter(meta: MetaState) {
    const openExternal = vi.fn();
    const store = useAppStore();
    // main.ts loadBootstrapPayload()'s meta: everything but the version check.
    const bootstrapMeta = {
      appVersion: meta.appVersion,
      repositoryUrl: meta.repositoryUrl,
      distribution: meta.distribution,
      microsoftStoreUrl: meta.microsoftStoreUrl,
      bootstrap: true,
      platform: meta.platform,
    };
    store.payload = { meta: bootstrapMeta, appState: APP_STATE } as AnyApi;
    const wrapper = mount(App, { shallow: true, global: { provide: { [apiKey as symbol]: stubApi(openExternal) } } });
    store.payload = { meta, appState: APP_STATE } as AnyApi;
    await flushPromises();
    const footer = wrapper.get("[data-role='sidebar-footer']");
    const button = (label: string) => footer.findAll("button").find((b) => b.text() === label);
    return { wrapper, footer, button, openExternal, toast: useNotificationStore().latestToast };
  }

  test("Microsoft Store: labelled, a Store button, and no GitHub update count or toast", async () => {
    const { checker, githubRequests } = await realUpdateChecker("microsoft-store");
    const { footer, button, openExternal, toast } = await mountFooter(
      payloadMeta("microsoft-store", checker.getCachedResult()),
    );

    expect(githubRequests).toEqual([]);
    expect(footer.get(".sidebar-footer__version").text().replace(/\s+/g, " ")).toBe("v3.0.6 · Microsoft Store");
    expect(footer.get(".sidebar-footer__version").attributes("title")).toContain("Microsoft Store");
    expect(footer.find(".sidebar-footer__update-hint").exists()).toBe(false);
    expect(toast).toBeNull();

    await button("Microsoft Store")!.trigger("click");
    expect(openExternal).toHaveBeenCalledWith("https://apps.microsoft.com/detail/9PBP826FCHF7");
    expect(button("GitHub repo")).toBeDefined();
  });

  test("Installer: labelled, GitHub's update count and toast, no Store button", async () => {
    const { checker } = await realUpdateChecker("windows-installer");
    const { footer, button, openExternal, toast } = await mountFooter(
      payloadMeta("windows-installer", checker.getCachedResult()),
    );

    expect(footer.get(".sidebar-footer__version").text().replace(/\s+/g, " ")).toBe("v3.0.6 · Installer");
    const hint = footer.get(".sidebar-footer__update-hint");
    expect(hint.text()).toBe("2 updates behind");
    expect(toast).toMatchObject({ title: "Update available", body: "You are 2 versions behind (latest: v3.0.8)." });
    expect(button("Microsoft Store")).toBeUndefined();

    await hint.trigger("click");
    expect(openExternal).toHaveBeenCalledWith(`${APP_CONFIG.app.repositoryUrl}/releases/latest`);
  });

  test("Portable: labelled, and nothing announced when GitHub has nothing newer", async () => {
    const { checker } = await realUpdateChecker("portable", { upToDate: true });
    const { footer, button, toast } = await mountFooter(payloadMeta("portable", checker.getCachedResult()));

    expect(footer.get(".sidebar-footer__version").text().replace(/\s+/g, " ")).toBe("v3.0.6 · Portable");
    expect(footer.find(".sidebar-footer__update-hint").exists()).toBe(false);
    expect(toast).toBeNull();
    expect(button("Microsoft Store")).toBeUndefined();
    expect(button("GitHub repo")).toBeDefined();
  });
});

describe("Settings → About — update status by distribution", () => {
  /** SettingsDialog with the props openSettingsDialog() builds from the payload, on the About tab. */
  async function mountAbout(meta: MetaState, checkForUpdates: () => Promise<unknown>) {
    const store = useAppStore();
    store.payload = { meta, appState: APP_STATE } as AnyApi;
    store.openSettingsDialog({ initialTab: "about" });
    const props = store.dialogLayers[0].props;
    const openExternal = vi.fn();
    const wrapper = mount(SettingsDialog, {
      props,
      global: {
        provide: {
          [apiKey as symbol]: {
            getAgentNotifyHookStatus: async () => ({}),
            getAgentNotifyHookMetrics: async () => null,
            openExternal,
            checkForUpdates,
          },
        },
        stubs: { SettingsHookProviderSection: true, CustomSelect: true },
      },
    });
    await flushPromises();
    const banner = () => wrapper.find(".update-banner");
    const checkButton = () => wrapper.findAll("button").find((b) => b.text() === "Check for updates")!;
    return { wrapper, banner, checkButton, openExternal };
  }

  test("Microsoft Store: the Store delivers updates, with its link; a manual check never asks GitHub", async () => {
    const { checker, githubRequests } = await realUpdateChecker("microsoft-store");
    const { banner, checkButton, openExternal } = await mountAbout(
      payloadMeta("microsoft-store", checker.getCachedResult()),
      () => checker.checkForUpdates(true),
    );

    const storeText =
      "Updates are delivered through the Microsoft Store, automatically unless app updates are turned off in the Store's settings.";
    expect(banner().get(".update-banner__text").text()).toBe(storeText);
    await banner().get("a").trigger("click");
    expect(openExternal).toHaveBeenCalledWith("https://apps.microsoft.com/detail/9PBP826FCHF7");
    expect(banner().get("a").text()).toBe("Open in Microsoft Store");

    await checkButton().trigger("click");
    await flushPromises();
    expect(banner().get(".update-banner__text").text()).toBe(storeText);
    expect(githubRequests).toEqual([]);
  });

  test("Installer: how far behind GitHub's latest release, with the release link", async () => {
    const { checker } = await realUpdateChecker("windows-installer");
    const { banner } = await mountAbout(payloadMeta("windows-installer", checker.getCachedResult()), () =>
      checker.checkForUpdates(true),
    );

    expect(banner().get(".update-banner__text").text()).toBe("You are 2 versions behind. Latest: v3.0.8");
    expect(banner().get("a").text()).toBe("View release");
    expect(banner().text()).not.toContain("Microsoft Store");
  });

  test("Portable: up to date with GitHub, and a manual check asks GitHub again", async () => {
    const { checker, githubRequests } = await realUpdateChecker("portable", { upToDate: true });
    const { banner, checkButton } = await mountAbout(payloadMeta("portable", checker.getCachedResult()), () =>
      checker.checkForUpdates(true),
    );

    expect(banner().get(".update-banner__text").text()).toBe("You are on the latest version.");
    await checkButton().trigger("click");
    await flushPromises();
    expect(githubRequests).toHaveLength(2);
    expect(banner().get(".update-banner__text").text()).toBe("You are on the latest version.");
  });
});
