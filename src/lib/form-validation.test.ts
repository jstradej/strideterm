import { afterEach, describe, expect, it } from "vitest";
import { installFormValidationFeedback } from "./form-validation.js";

describe("installFormValidationFeedback", () => {
  let uninstall: (() => void) | undefined;

  afterEach(() => {
    uninstall?.();
    uninstall = undefined;
    document.body.innerHTML = "";
  });

  it("replaces generic required feedback with specific accessible copy and clears it when corrected", () => {
    document.body.innerHTML = `
      <form>
        <div class="field">
          <label for="host">Server hostname</label>
          <div class="input-group"><input id="host" name="host" required
            data-validation-required="Enter the server hostname or IP address, for example bastion.example.com or 192.168.1.10."
            aria-describedby="host-help"></div>
          <span id="host-help">Used to connect to your server.</span>
        </div>
      </form>`;
    uninstall = installFormValidationFeedback();

    const input = document.querySelector<HTMLInputElement>("#host")!;
    expect(input.checkValidity()).toBe(false);
    const error = document.querySelector<HTMLElement>(".app-form-validation-error")!;
    expect(error.textContent).toBe(
      "Enter the server hostname or IP address, for example bastion.example.com or 192.168.1.10.",
    );
    expect(error.parentElement).toBe(document.querySelector(".field"));
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.getAttribute("aria-describedby")).toBe(`host-help ${error.id}`);

    input.value = "bastion.example.com";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(document.querySelector(".app-form-validation-error")).toBeNull();
    expect(input.hasAttribute("aria-invalid")).toBe(false);
    expect(input.getAttribute("aria-describedby")).toBe("host-help");
    expect(input.checkValidity()).toBe(true);
  });

  it("shows type and range messages and focuses the first invalid control in a sequence", async () => {
    document.body.innerHTML = `
      <form>
        <label>Email address <input id="email" name="email" type="email" value="bad" required></label>
        <label>Port <input id="port" name="port" type="number" min="1" max="65535" value="70000" required></label>
      </form>`;
    uninstall = installFormValidationFeedback();

    const email = document.querySelector<HTMLInputElement>("#email")!;
    const port = document.querySelector<HTMLInputElement>("#port")!;
    expect(document.querySelector("form")!.checkValidity()).toBe(false);
    expect(document.querySelectorAll(".app-form-validation-error")).toHaveLength(2);
    expect(document.querySelectorAll<HTMLElement>(".app-form-validation-error")[0].textContent).toBe(
      "Enter a valid email address for Email address.",
    );
    expect(document.querySelectorAll<HTMLElement>(".app-form-validation-error")[1].textContent).toBe(
      "Enter a value no greater than 65535 for Port.",
    );

    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(document.activeElement).toBe(email);
    expect(port.getAttribute("aria-invalid")).toBe("true");
  });

  it("handles controls mounted after installation and preserves existing invalid state", () => {
    document.body.innerHTML = "<div id='dialog'></div>";
    uninstall = installFormValidationFeedback();
    const dialog = document.querySelector("#dialog")!;
    dialog.innerHTML = `<label for="code">Access code</label><input id="code" name="code" required aria-invalid="grammar" aria-describedby="hint">`;
    const input = dialog.querySelector<HTMLInputElement>("#code")!;

    expect(input.checkValidity()).toBe(false);
    expect(input.getAttribute("aria-invalid")).toBe("true");
    input.value = "123";
    input.dispatchEvent(new Event("change", { bubbles: true }));
    expect(input.getAttribute("aria-invalid")).toBe("grammar");
    expect(input.getAttribute("aria-describedby")).toBe("hint");
  });

  it("keeps feedback out of the middle of multi-column field grids", () => {
    document.body.innerHTML = `
      <form><div class="quick-grid">
        <label class="field"><span>User</span><input id="user" required data-validation-required="Enter the SSH user name."></label>
        <label class="field"><span>Host</span><input id="host" required data-validation-required="Enter the server host name."></label>
        <label class="field"><span>Port</span><input id="port" type="number" min="1" max="65535" value="22"></label>
      </div></form>`;
    uninstall = installFormValidationFeedback();

    document.querySelector("form")!.checkValidity();
    const grid = document.querySelector(".quick-grid")!;
    expect(
      Array.from(grid.children)
        .slice(0, 3)
        .map((child) => child.querySelector("span")?.textContent),
    ).toEqual(["User", "Host", "Port"]);
    expect(grid.querySelectorAll(":scope > .app-form-validation-error")).toHaveLength(2);
  });
});
