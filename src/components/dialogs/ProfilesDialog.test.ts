import { describe, it, expect } from "vitest";
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
});
