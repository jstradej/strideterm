import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createApp, defineComponent, h, nextTick } from "vue";
import { installVueErrorHandler } from "./vue-error-handler.js";

// A click handler that rejects with nothing catching it used to end in a
// console.error only: the button looked ignored and strideterm.log had
// nothing. The handler turns it into a toast plus a log line.

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

let logRenderer: ReturnType<typeof vi.fn>;
let host: HTMLElement;

beforeEach(() => {
  logRenderer = vi.fn();
  (window as unknown as { strideterm?: unknown }).strideterm = { logRenderer };
  host = document.createElement("div");
  document.body.appendChild(host);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  delete (window as unknown as { strideterm?: unknown }).strideterm;
  host.remove();
  vi.restoreAllMocks();
});

function mountWithHandler(component: ReturnType<typeof defineComponent>) {
  const showError = vi.fn();
  const app = createApp(component);
  installVueErrorHandler(app, showError);
  app.mount(host);
  return { app, showError };
}

describe("installVueErrorHandler", () => {
  test("a rejecting @click handler is shown to the user and logged with its stack", async () => {
    const { app, showError } = mountWithHandler(
      defineComponent({
        setup: () => () => h("button", { onClick: () => Promise.reject(new Error("Task is not running")) }, "Stop"),
      }),
    );

    host.querySelector("button")!.click();
    await flush();

    expect(showError).toHaveBeenCalledWith("Action failed", "Task is not running");
    expect(logRenderer).toHaveBeenCalledWith(
      "error",
      "[renderer] unhandled Vue error",
      expect.objectContaining({ message: "Task is not running", stack: expect.stringContaining("Error") }),
    );
    app.unmount();
  });

  test("a rejecting handler of an emitted component event is shown too", async () => {
    const Child = defineComponent({
      emits: ["save"],
      setup:
        (_props, { emit }) =>
        () =>
          h("button", { onClick: () => emit("save") }, "Save"),
    });
    const { app, showError } = mountWithHandler(
      defineComponent({
        setup: () => () => h(Child, { onSave: () => Promise.reject(new Error("disk full")) }),
      }),
    );

    host.querySelector("button")!.click();
    await flush();

    expect(showError).toHaveBeenCalledWith("Action failed", "disk full");
    app.unmount();
  });

  test("an error outside an event handler is logged but raises no toast", async () => {
    const { app, showError } = mountWithHandler(
      defineComponent({
        setup: () => () => {
          throw new Error("render broke");
        },
      }),
    );
    await nextTick();

    expect(logRenderer).toHaveBeenCalledWith(
      "error",
      "[renderer] unhandled Vue error",
      expect.objectContaining({ message: "render broke" }),
    );
    expect(showError).not.toHaveBeenCalled();
    app.unmount();
  });

  test("recognises the production `info` (an error-reference URL) as well as the dev label", () => {
    const showError = vi.fn();
    const app = createApp({ render: () => null });
    installVueErrorHandler(app, showError);
    const handler = app.config.errorHandler!;

    handler(new Error("a"), null, "https://vuejs.org/error-reference/#runtime-5");
    handler(new Error("b"), null, "https://vuejs.org/error-reference/#runtime-6");
    handler(new Error("c"), null, "https://vuejs.org/error-reference/#runtime-1");
    handler(new Error("d"), null, "component event handler");

    expect(showError.mock.calls.map((call) => call[1])).toEqual(["a", "b", "d"]);
  });
});
