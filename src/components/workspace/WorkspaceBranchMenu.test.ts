import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mount, flushPromises, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { reactive } from "vue";
import WorkspaceBranchMenu from "./WorkspaceBranchMenu.vue";
import { useAppStore } from "../../stores/app.js";
import { useGitUiStore } from "../../stores/git-ui.js";
import type { StatePayload } from "../../../electron/shared/types/state.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let wrapper: VueWrapper<any> | null = null;

function localBranch(name: string, extra: Record<string, unknown> = {}) {
  return {
    name,
    isCurrent: false,
    upstream: "",
    ahead: 0,
    behind: 0,
    lastCommitTimestamp: 0,
    merged: true,
    ...extra,
  };
}

function setup({ dirty = false } = {}) {
  setActivePinia(createPinia());
  const appStore = useAppStore();
  const snapshot = {
    available: true,
    branch: "main",
    dirty,
    dirtyCount: dirty ? 2 : 0,
    upstream: "origin/main",
    aheadCount: 0,
    behindCount: 1,
    remotes: { origin: "git@example.invalid:repo.git" },
  };
  appStore.payload = {
    appState: { workspaces: [{ id: "ws", name: "Repo", kind: "terminal", cwd: "/repo" }] },
    git: { workspaces: { ws: { primaryRoot: "/repo", roots: { "/repo": snapshot } } } },
  } as unknown as StatePayload;
  const activateView = vi.spyOn(appStore, "activateView").mockResolvedValue(undefined);

  const gitUiStore = useGitUiStore();
  const ui = reactive<Record<string, unknown>>({
    branchList: {
      current: "main",
      upstream: "origin/main",
      local: [
        localBranch("main", { isCurrent: true, upstream: "origin/main", behind: 1 }),
        localBranch("feature/login"),
      ],
      remotes: [
        { name: "origin/main", remote: "origin", lastCommitTimestamp: 0 },
        { name: "origin/release", remote: "origin", lastCommitTimestamp: 0 },
      ],
      defaultBranch: "main",
      defaultRemote: "origin",
    },
  });
  vi.spyOn(gitUiStore, "get").mockReturnValue(ui);
  vi.spyOn(gitUiStore, "getActiveRoot").mockReturnValue("");
  const listBranches = vi.spyOn(gitUiStore, "gitListBranches").mockResolvedValue(undefined);
  const checkout = vi.spyOn(gitUiStore, "gitCheckoutBranch").mockResolvedValue(undefined);
  const pull = vi.spyOn(gitUiStore, "gitPull").mockResolvedValue(undefined);
  const merge = vi.spyOn(gitUiStore, "gitMergeBase").mockImplementation(async () => {
    ui.pendingAction = { type: "merge" };
  });

  wrapper = mount(WorkspaceBranchMenu, {
    attachTo: document.body,
    props: { workspaceId: "ws", summary: { branch: "main", dirty, dirtyCount: dirty ? 2 : 0 }, title: "" },
  });
  return { activateView, listBranches, checkout, pull, merge };
}

function rowByLabel(label: string): HTMLElement {
  const row = Array.from(document.body.querySelectorAll<HTMLElement>(".branch-menu__row")).find(
    (el) => el.querySelector(".branch-menu__label")?.textContent?.trim() === label,
  );
  if (!row) throw new Error(`row "${label}" not found`);
  return row;
}

function labels(): string[] {
  return Array.from(document.body.querySelectorAll(".branch-menu__list .branch-menu__label")).map(
    (el) => el.textContent?.trim() || "",
  );
}

async function openMenu(): Promise<void> {
  await wrapper!.find("[data-role='workspace-branch-chip']").trigger("click");
  await flushPromises();
}

beforeEach(() => {
  document.body.innerHTML = "";
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  vi.restoreAllMocks();
});

describe("WorkspaceBranchMenu", () => {
  it("opens from the branch chip with the Git actions and the branch tree", async () => {
    const { listBranches } = setup();
    await openMenu();

    expect(listBranches).toHaveBeenCalledWith("ws");
    expect(labels()).toEqual(expect.arrayContaining(["Update", "Commit…", "Push", "Fetch", "New Branch…"]));
    expect(labels()).toEqual(expect.arrayContaining(["Local", "main", "feature", "Remote"]));
    expect(labels()).not.toContain("login");

    rowByLabel("feature").click();
    await flushPromises();
    expect(labels()).toContain("login");
    expect(rowByLabel("main").classList).toContain("branch-menu__row--current");
  });

  it("checks out another local branch from its submenu", async () => {
    const { checkout } = setup();
    await openMenu();

    rowByLabel("feature").click();
    await flushPromises();
    rowByLabel("login").click();
    await flushPromises();
    rowByLabel("Checkout").click();
    await flushPromises();

    expect(checkout).toHaveBeenCalledWith("ws", "feature/login");
    expect(document.body.querySelector(".branch-menu")).toBeNull();
  });

  it("does not check out over uncommitted changes", async () => {
    const { checkout } = setup({ dirty: true });
    await openMenu();

    rowByLabel("feature").click();
    await flushPromises();
    rowByLabel("login").click();
    await flushPromises();
    const item = rowByLabel("Checkout");
    expect(item.getAttribute("aria-disabled")).toBe("true");
    item.click();
    await flushPromises();

    expect(checkout).not.toHaveBeenCalled();
  });

  it("opens the Git tab when an action waits for confirmation there", async () => {
    const { merge, activateView } = setup();
    await openMenu();

    rowByLabel("feature").click();
    await flushPromises();
    rowByLabel("login").click();
    await flushPromises();
    rowByLabel("Merge 'feature/login' into 'main'").click();
    await flushPromises();

    expect(merge).toHaveBeenCalledWith("ws", "feature/login", { fetchFirst: false });
    expect(activateView).toHaveBeenCalledWith("git:ws");
  });

  it("Update pulls and stashes uncommitted changes around it", async () => {
    const { pull } = setup({ dirty: true });
    await openMenu();

    rowByLabel("Update").click();
    await flushPromises();

    expect(pull).toHaveBeenCalledWith("ws", { stashDirty: true });
  });

  it("Fetch keeps the menu open and shows a spinner on its row while it runs", async () => {
    const { listBranches } = setup();
    const ui = useGitUiStore().get("ws");
    let finish!: () => void;
    const fetch = vi.spyOn(useGitUiStore(), "gitFetch").mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          ui.busyAction = "fetch";
          finish = () => {
            ui.busyAction = "";
            resolve();
          };
        }),
    );
    await openMenu();

    rowByLabel("Fetch").click();
    await flushPromises();
    expect(fetch).toHaveBeenCalledWith("ws");
    expect(rowByLabel("Fetch").querySelector(".spinner")).not.toBeNull();
    expect(document.body.querySelector(".branch-menu__status")).toBeNull();

    finish();
    await flushPromises();
    expect(document.body.querySelector(".branch-menu")).not.toBeNull();
    expect(rowByLabel("Fetch").querySelector(".spinner")).toBeNull();
    expect(listBranches).toHaveBeenLastCalledWith("ws", { force: true });
  });

  it("highlights the branch submenu item under the mouse", async () => {
    setup();
    await openMenu();

    rowByLabel("feature").click();
    await flushPromises();
    rowByLabel("login").click();
    await flushPromises();
    const rename = rowByLabel("Rename…");
    rename.dispatchEvent(new MouseEvent("mouseenter"));
    await flushPromises();

    expect(rename.classList).toContain("branch-menu__row--active");
    expect(rowByLabel("Checkout").classList).not.toContain("branch-menu__row--active");
  });

  it("search filters branches and actions", async () => {
    setup();
    await openMenu();

    const input = document.body.querySelector<HTMLInputElement>(".branch-menu__search")!;
    input.value = "rel";
    input.dispatchEvent(new Event("input"));
    await flushPromises();

    expect(labels()).toEqual(["Remote", "origin/release"]);
  });
});
