import { describe, expect, test } from "vitest";
import { mount } from "@vue/test-utils";
import GitStrategySplitButton from "./GitStrategySplitButton.vue";
import type { StrategyOption } from "./update-strategy.js";

const OPTIONS: StrategyOption[] = [
  { value: "rebase", label: "Rebase onto origin/main", title: "rewrites hashes", testid: "strategy-rebase" },
  { value: "merge", label: "Merge origin/main in", title: "adds a merge commit", testid: "strategy-merge" },
];

function mountButton(props: Record<string, unknown> = {}) {
  return mount(GitStrategySplitButton, {
    attachTo: document.body,
    props: {
      strategy: "rebase",
      mainLabel: "Rebase onto origin/main",
      mainTitle: "main tooltip",
      options: OPTIONS,
      mainTestid: "update-from-base",
      caretTestid: "update-strategy-caret",
      ...props,
    },
  });
}

describe("GitStrategySplitButton", () => {
  test("renders the main button under the caller's testid and label", () => {
    const wrapper = mountButton();
    const main = wrapper.get('[data-testid="update-from-base"]');
    expect(main.text()).toBe("Rebase onto origin/main");
    expect(main.attributes("title")).toBe("main tooltip");
  });

  test("the menu is closed until the caret is clicked", async () => {
    const wrapper = mountButton();
    expect(wrapper.find('[data-testid="strategy-rebase"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="update-strategy-caret"]').attributes("aria-expanded")).toBe("false");

    await wrapper.get('[data-testid="update-strategy-caret"]').trigger("click");
    expect(wrapper.find('[data-testid="strategy-rebase"]').exists()).toBe(true);
    expect(wrapper.get('[data-testid="update-strategy-caret"]').attributes("aria-expanded")).toBe("true");
  });

  test("marks the active strategy as the checked radio", async () => {
    const wrapper = mountButton({ strategy: "merge" });
    await wrapper.get('[data-testid="update-strategy-caret"]').trigger("click");
    expect(wrapper.get('[data-testid="strategy-merge"]').attributes("aria-checked")).toBe("true");
    expect(wrapper.get('[data-testid="strategy-rebase"]').attributes("aria-checked")).toBe("false");
    expect(wrapper.get('[data-testid="strategy-merge"]').text()).toContain("✓");
  });

  test("picking a strategy emits it and closes the menu WITHOUT running", async () => {
    // The caret only selects. Running takes a second, deliberate click on the
    // main button — the strategy can rewrite commit hashes, so one gesture
    // must never both choose and execute it.
    const wrapper = mountButton();
    await wrapper.get('[data-testid="update-strategy-caret"]').trigger("click");
    await wrapper.get('[data-testid="strategy-merge"]').trigger("click");

    expect(wrapper.emitted("update:strategy")).toEqual([["merge"]]);
    expect(wrapper.emitted("run")).toBeUndefined();
    expect(wrapper.find('[data-testid="strategy-merge"]').exists()).toBe(false);
  });

  test("re-picking the active strategy closes the menu without an update", async () => {
    const wrapper = mountButton({ strategy: "rebase" });
    await wrapper.get('[data-testid="update-strategy-caret"]').trigger("click");
    await wrapper.get('[data-testid="strategy-rebase"]').trigger("click");

    expect(wrapper.emitted("update:strategy")).toBeUndefined();
    expect(wrapper.find('[data-testid="strategy-rebase"]').exists()).toBe(false);
  });

  test("the main button emits run", async () => {
    const wrapper = mountButton();
    await wrapper.get('[data-testid="update-from-base"]').trigger("click");
    expect(wrapper.emitted("run")).toHaveLength(1);
  });

  test("disabled blocks both halves", () => {
    const wrapper = mountButton({ disabled: true });
    expect(wrapper.get('[data-testid="update-from-base"]').attributes("disabled")).toBeDefined();
    expect(wrapper.get('[data-testid="update-strategy-caret"]').attributes("disabled")).toBeDefined();
  });

  test("Escape closes the menu", async () => {
    const wrapper = mountButton();
    await wrapper.get('[data-testid="update-strategy-caret"]').trigger("click");
    expect(wrapper.find('[data-testid="strategy-rebase"]').exists()).toBe(true);

    await wrapper.get(".git-split-button").trigger("keydown.esc");
    expect(wrapper.find('[data-testid="strategy-rebase"]').exists()).toBe(false);
  });

  test("an outside mousedown closes the menu", async () => {
    const wrapper = mountButton();
    await wrapper.get('[data-testid="update-strategy-caret"]').trigger("click");
    expect(wrapper.find('[data-testid="strategy-rebase"]').exists()).toBe(true);

    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    await wrapper.vm.$nextTick();
    expect(wrapper.find('[data-testid="strategy-rebase"]').exists()).toBe(false);
  });

  test("primary drops the ghost class, non-primary keeps it", () => {
    // The toolbar passes `primary` from primaryAction so exactly one button in
    // the row is highlighted; the card always owns its row and is always
    // primary. Getting this backwards would put two primaries on screen.
    expect(mountButton({ primary: true }).get('[data-testid="update-from-base"]').classes()).not.toContain(
      "button--ghost",
    );
    expect(mountButton({ primary: false }).get('[data-testid="update-from-base"]').classes()).toContain(
      "button--ghost",
    );
  });

  test("busy adds the busy class", () => {
    expect(mountButton({ busy: true }).get('[data-testid="update-from-base"]').classes()).toContain("button--busy");
  });

  test("the caret follows the main half's variant, so the two look like one control", () => {
    // Regression: the caret was hardcoded to the plain `.button` class, which
    // is the orange accent gradient. In the card that passed unnoticed because
    // its main half is always primary, but in the Git toolbar a non-primary or
    // disabled Pull rendered a grey main half glued to a bright orange caret —
    // and `.button:disabled` only lowers opacity, so disabling it did not hide
    // the mismatch, it just faded it.
    const ghost = mountButton({ primary: false });
    expect(ghost.get('[data-testid="update-strategy-caret"]').classes()).toContain("button--ghost");
    expect(ghost.get('[data-testid="update-from-base"]').classes()).toContain("button--ghost");

    const accent = mountButton({ primary: true });
    expect(accent.get('[data-testid="update-strategy-caret"]').classes()).not.toContain("button--ghost");
    expect(accent.get('[data-testid="update-from-base"]').classes()).not.toContain("button--ghost");
  });

  test("both halves always carry the same variant, disabled or not", () => {
    for (const primary of [true, false]) {
      for (const disabled of [true, false]) {
        const wrapper = mountButton({ primary, disabled });
        const main = wrapper.get('[data-testid="update-from-base"]').classes().includes("button--ghost");
        const caret = wrapper.get('[data-testid="update-strategy-caret"]').classes().includes("button--ghost");
        expect(caret).toBe(main);
      }
    }
  });
});
