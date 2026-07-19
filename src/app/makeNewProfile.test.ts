import { describe, expect, it } from "vitest";
import { makeNewProfile } from "./helpers.js";

/**
 * makeNewProfile was duplicated in ProfilesDialog.vue's addProfile() and
 * NewWindowModal.vue's createProfileAndOpen(). This is the shared
 * implementation both were migrated to.
 */
describe("makeNewProfile", () => {
  it("builds a profile with the given name, a unique id, the default color, and no workspaces", () => {
    const profile = makeNewProfile("Work");
    expect(profile.name).toBe("Work");
    expect(profile.id).toMatch(/^profile-/);
    expect(profile.color).toBe("#ffa424");
    expect(profile.workspaceIds).toEqual([]);
  });

  it("generates a distinct id on every call", () => {
    const a = makeNewProfile("A");
    const b = makeNewProfile("B");
    expect(a.id).not.toBe(b.id);
  });
});
