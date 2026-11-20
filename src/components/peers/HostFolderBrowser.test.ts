import { beforeEach, describe, expect, test, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import HostFolderBrowser from "./HostFolderBrowser.vue";
import { apiKey } from "../../types/keys.js";
import type { PeerDirectoryListing } from "../../../electron/shared/peers.js";

type Listing = PeerDirectoryListing;

function posix(path: string, names: string[], extra: Partial<Listing> = {}): Listing {
  return {
    path,
    parent: path === "/" ? null : path.replace(/\/[^/]+$/, "") || "/",
    separator: "/",
    entries: names.map((name) => ({ name })),
    roots: ["/home/me", "/"],
    truncated: false,
    ...extra,
  };
}

function windows(path: string, names: string[]): Listing {
  return {
    path,
    parent: path === "C:\\" ? null : "C:\\",
    separator: "\\",
    entries: names.map((name) => ({ name })),
    roots: ["C:\\Users\\x", "C:\\", "D:\\"],
    truncated: false,
  };
}

function mountBrowser(listHostDirectories: unknown, props: Record<string, unknown> = {}) {
  return mount(HostFolderBrowser, {
    props: { hostLabel: "Office", ...props },
    global: { provide: { [apiKey]: { listHostDirectories } } },
  });
}

const rows = (w: ReturnType<typeof mount>) => w.findAll(".host-folders__name").map((r) => r.text());
const pathValue = (w: ReturnType<typeof mount>) =>
  (w.get('[data-testid="host-folders-path"]').element as HTMLInputElement).value;

beforeEach(() => {
  setActivePinia(createPinia());
});

describe("HostFolderBrowser", () => {
  test("starts at home when no path is given and names the host", async () => {
    const list = vi.fn().mockResolvedValue(posix("/home/me", ["a", "b"]));
    const w = mountBrowser(list);
    await flushPromises();
    expect(list).toHaveBeenCalledWith({ path: "" });
    expect(w.get('[data-testid="host-folders-title"]').text()).toBe("Choose a folder on Office");
    expect(rows(w)).toEqual(["a", "b"]);
    expect(pathValue(w)).toBe("/home/me");
  });

  test("shows Loading… until the first listing arrives", async () => {
    let resolve!: (l: Listing) => void;
    const w = mountBrowser(() => new Promise<Listing>((r) => (resolve = r)));
    expect(w.find('[data-testid="host-folders-loading"]').exists()).toBe(true);
    resolve(posix("/home/me", []));
    await flushPromises();
    expect(w.find('[data-testid="host-folders-loading"]').exists()).toBe(false);
    expect(w.get('[data-testid="host-folders-empty"]').text()).toBe("No folders here.");
  });

  test("starts at the initial path when it can be listed", async () => {
    const list = vi.fn().mockResolvedValue(posix("/srv/app", ["x"]));
    const w = mountBrowser(list, { initialPath: "/srv/app" });
    await flushPromises();
    expect(list).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledWith({ path: "/srv/app" });
    expect(pathValue(w)).toBe("/srv/app");
  });

  test("falls back to home silently when the initial path fails", async () => {
    const list = vi.fn(async ({ path }: { path: string }) => {
      if (path) throw new Error("Error invoking remote method 'x': Error: That folder was not found.");
      return posix("/home/me", ["a"]);
    });
    const w = mountBrowser(list, { initialPath: "/gone" });
    await flushPromises();
    expect(list.mock.calls.map((c) => c[0].path)).toEqual(["/gone", ""]);
    expect(pathValue(w)).toBe("/home/me");
    expect(w.find('[data-testid="host-folders-error"]').exists()).toBe(false);
  });

  test("shows the error when the initial path and home both fail", async () => {
    const list = vi.fn(async ({ path }: { path: string }) => {
      throw new Error(path ? "That folder was not found." : "Home is not readable.");
    });
    const w = mountBrowser(list, { initialPath: "/gone" });
    await flushPromises();
    expect(list.mock.calls.map((c) => c[0].path)).toEqual(["/gone", ""]);
    expect(w.get('[data-testid="host-folders-error"]').text()).toBe("Home is not readable.");
  });

  test("double click opens, Up goes to the parent, Backspace goes up too", async () => {
    const list = vi.fn(async ({ path }: { path: string }) =>
      path === "/home/me/a" ? posix("/home/me/a", ["deep"]) : posix(path || "/home/me", ["a"]),
    );
    const w = mountBrowser(list);
    await flushPromises();
    await w.get('[data-testid="host-folders-row"]').trigger("dblclick");
    await flushPromises();
    expect(list).toHaveBeenLastCalledWith({ path: "/home/me/a" });
    expect(rows(w)).toHaveLength(1);

    await w.get('[data-testid="host-folders-up"]').trigger("click");
    await flushPromises();
    expect(list).toHaveBeenLastCalledWith({ path: "/home/me" });

    await w.get('[data-testid="host-folders-row"]').trigger("dblclick");
    await flushPromises();
    await w.get('[data-testid="host-folders-list"]').trigger("keydown", { key: "Backspace" });
    await flushPromises();
    expect(list).toHaveBeenLastCalledWith({ path: "/home/me" });
  });

  test("Up is disabled at a filesystem root", async () => {
    const w = mountBrowser(vi.fn().mockResolvedValue(posix("/", ["etc"])));
    await flushPromises();
    expect(w.get('[data-testid="host-folders-up"]').attributes("disabled")).toBeDefined();
  });

  test("arrow keys move the selection and Enter opens it", async () => {
    const list = vi.fn(async ({ path }: { path: string }) => posix(path || "/home/me", ["a", "b", "c"]));
    const w = mountBrowser(list);
    await flushPromises();
    const listbox = w.get('[data-testid="host-folders-list"]');
    await listbox.trigger("keydown", { key: "ArrowDown" });
    await listbox.trigger("keydown", { key: "ArrowDown" });
    expect(w.get(".host-folders__row--selected").text()).toContain("b");
    await listbox.trigger("keydown", { key: "ArrowUp" });
    expect(w.get(".host-folders__row--selected").text()).toContain("a");
    await listbox.trigger("keydown", { key: "ArrowDown" });
    await listbox.trigger("keydown", { key: "Enter" });
    await flushPromises();
    expect(list).toHaveBeenLastCalledWith({ path: "/home/me/b" });
  });

  test("root shortcuts list Home first, then the other roots", async () => {
    const list = vi.fn(async ({ path }: { path: string }) => windows(path || "C:\\Users\\x", ["Users"]));
    const w = mountBrowser(list);
    await flushPromises();
    const roots = w.findAll('[data-testid="host-folders-root"]');
    expect(roots.map((r) => r.text())).toEqual(["Home", "C:\\", "D:\\"]);
    await roots[2]!.trigger("click");
    await flushPromises();
    expect(list).toHaveBeenLastCalledWith({ path: "D:\\" });
  });

  test("a typed path navigates on Enter", async () => {
    const list = vi.fn(async ({ path }: { path: string }) => posix(path || "/home/me", []));
    const w = mountBrowser(list);
    await flushPromises();
    await w.get('[data-testid="host-folders-path"]').setValue("/var/www");
    await w.get("form").trigger("submit");
    await flushPromises();
    expect(list).toHaveBeenLastCalledWith({ path: "/var/www" });
    expect(pathValue(w)).toBe("/var/www");
  });

  test("a refusal shows its sentence inline and keeps the previous listing", async () => {
    const list = vi.fn(async ({ path }: { path: string }) => {
      if (path === "/nope") throw new Error("That is not a folder.");
      return posix("/home/me", ["a"]);
    });
    const w = mountBrowser(list);
    await flushPromises();
    await w.get('[data-testid="host-folders-path"]').setValue("/nope");
    await w.get("form").trigger("submit");
    await flushPromises();
    expect(w.get('[data-testid="host-folders-error"]').text()).toBe("That is not a folder.");
    expect(rows(w)).toHaveLength(1);
    expect(pathValue(w)).toBe("/home/me");
    await w.get('[data-testid="host-folders-use"]').trigger("click");
    expect(w.emitted("select")![0]).toEqual(["/home/me"]);
  });

  test("the filter narrows the visible names case-insensitively", async () => {
    const w = mountBrowser(vi.fn().mockResolvedValue(posix("/home/me", ["Alpha", "beta", "Gamma"])));
    await flushPromises();
    await w.get('[data-testid="host-folders-filter"]').setValue("A");
    expect(rows(w)).toHaveLength(3);
    await w.get('[data-testid="host-folders-filter"]').setValue("mm");
    expect(rows(w)).toHaveLength(1);
    await w.get('[data-testid="host-folders-filter"]').setValue("zzz");
    expect(w.get('[data-testid="host-folders-empty"]').text()).toBe("No folders match.");
  });

  test("typing on the list filters it", async () => {
    const w = mountBrowser(vi.fn().mockResolvedValue(posix("/home/me", ["alpha", "beta"])));
    await flushPromises();
    await w.get('[data-testid="host-folders-list"]').trigger("keydown", { key: "b" });
    expect(rows(w)).toHaveLength(1);
  });

  test("notes when the listing was truncated", async () => {
    const w = mountBrowser(vi.fn().mockResolvedValue(posix("/home/me", ["a"], { truncated: true })));
    await flushPromises();
    expect(w.get('[data-testid="host-folders-truncated"]').text()).toBe(
      "Showing the first 2000 folders — type a path to go deeper.",
    );
  });

  test("an older response that arrives late does not overwrite a newer listing", async () => {
    const pending: Record<string, (l: Listing) => void> = {};
    const list = vi.fn(({ path }: { path: string }) => {
      if (path === "") return Promise.resolve(posix("/home/me", ["start"]));
      return new Promise<Listing>((r) => (pending[path] = r));
    });
    const w = mountBrowser(list);
    await flushPromises();
    await w.get('[data-testid="host-folders-path"]').setValue("/slow");
    await w.get("form").trigger("submit");
    await w.get('[data-testid="host-folders-path"]').setValue("/fast");
    await w.get("form").trigger("submit");
    pending["/fast"]!(posix("/fast", ["new"]));
    await flushPromises();
    pending["/slow"]!(posix("/slow", ["old"]));
    await flushPromises();
    expect(pathValue(w)).toBe("/fast");
    expect(rows(w)[0]).toContain("new");
  });

  test("returns the current folder, or the selected sub-folder with the host's separator", async () => {
    const list = vi.fn().mockResolvedValue(windows("C:\\Users\\x", ["Work"]));
    const w = mountBrowser(list);
    await flushPromises();
    expect(w.get('[data-testid="host-folders-use"]').text()).toBe("Use this folder");
    await w.get('[data-testid="host-folders-use"]').trigger("click");
    expect(w.emitted("select")![0]).toEqual(["C:\\Users\\x"]);

    await w.get('[data-testid="host-folders-row"]').trigger("click");
    expect(w.get('[data-testid="host-folders-use"]').text()).toBe("Use Work");
    await w.get('[data-testid="host-folders-use"]').trigger("click");
    expect(w.emitted("select")![1]).toEqual(["C:\\Users\\x\\Work"]);
  });

  test("a root path is not given a doubled separator", async () => {
    const w = mountBrowser(vi.fn().mockResolvedValue(windows("C:\\", ["Users"])));
    await flushPromises();
    await w.get('[data-testid="host-folders-row"]').trigger("click");
    await w.get('[data-testid="host-folders-use"]').trigger("click");
    expect(w.emitted("select")![0]).toEqual(["C:\\Users"]);
  });

  test("POSIX paths are joined with a slash", async () => {
    const w = mountBrowser(vi.fn().mockResolvedValue(posix("/home/me", ["proj"])));
    await flushPromises();
    await w.get('[data-testid="host-folders-row"]').trigger("click");
    await w.get('[data-testid="host-folders-use"]').trigger("click");
    expect(w.emitted("select")![0]).toEqual(["/home/me/proj"]);
  });

  test("Cancel returns nothing", async () => {
    const w = mountBrowser(vi.fn().mockResolvedValue(posix("/home/me", [])));
    await flushPromises();
    await w.get('[data-testid="host-folders-cancel"]').trigger("click");
    expect(w.emitted("cancel")).toHaveLength(1);
    expect(w.emitted("select")).toBeUndefined();
  });
});

describe("HostFolderBrowser — busy indicators", () => {
  test("the first listing shows a spinner, an error ends it", async () => {
    let reject!: (_reason: unknown) => void;
    const w = mountBrowser(() => new Promise<Listing>((_, rej) => (reject = rej)));
    expect(w.find('[data-testid="host-folders-loading"] .spinner').exists()).toBe(true);
    expect(w.get('[data-testid="host-folders-list"]').attributes("aria-busy")).toBe("true");

    reject(new Error("Office is not answering."));
    await flushPromises();
    expect(w.find('[data-testid="host-folders-loading"]').exists()).toBe(false);
    expect(w.find(".spinner").exists()).toBe(false);
    expect(w.get('[data-testid="host-folders-error"]').text()).toContain("Office is not answering.");
    expect(w.get('[data-testid="host-folders-list"]').attributes("aria-busy")).toBeUndefined();
  });

  test.each([["resolves"], ["rejects"]])(
    "a later listing keeps the old folders and shows a spinner until it %s",
    async (how) => {
      let resolve!: (l: Listing) => void;
      let reject!: (_reason: unknown) => void;
      const list = vi
        .fn()
        .mockResolvedValueOnce(posix("/home/me", ["a", "b"]))
        .mockReturnValueOnce(
          new Promise<Listing>((res, rej) => {
            resolve = res;
            reject = rej;
          }),
        );
      const w = mountBrowser(list);
      await flushPromises();
      expect(w.find(".spinner").exists()).toBe(false);

      await w.get('[data-testid="host-folders-path"]').setValue("/srv");
      await w.get("form").trigger("submit");
      expect(w.find('[data-testid="host-folders-loading"] .spinner').exists()).toBe(true);
      expect(w.get('[data-testid="host-folders-list"]').attributes("aria-busy")).toBe("true");
      expect(rows(w)).toEqual(["a", "b"]);

      if (how === "resolves") resolve(posix("/srv", ["x"]));
      else reject(new Error("No such folder."));
      await flushPromises();
      expect(w.find(".spinner").exists()).toBe(false);
      expect(w.get('[data-testid="host-folders-list"]').attributes("aria-busy")).toBeUndefined();
      if (how === "rejects") expect(w.get('[data-testid="host-folders-error"]').text()).toContain("No such folder.");
      else expect(rows(w)).toEqual(["x"]);
    },
  );
});
