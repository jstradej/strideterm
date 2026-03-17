import { describe, expect, test } from "vitest";
import {
  getActiveRemoteShareUrl,
  getRemoteQrTarget,
  renderRemoteAccessCard,
} from "./remote-access.js";
import { renderRemoteAccessMarkup } from "../ui/remote-access-view.js";

function createPayload(overrides = {}) {
  return {
    appState: {
      settings: {
        remoteAccess: {
          enabled: true,
          token: "secret-token",
          customPublicUrl: "",
          cloudflaredPath: "",
        },
      },
    },
    remoteAccess: {
      host: "192.168.1.50",
      port: 4173,
      urls: [
        "http://192.168.1.50:4173",
        "http://10.0.0.15:4173",
      ],
      tunnel: {
        available: true,
        status: "connected",
        publicUrl: "https://demo.trycloudflare.com",
        error: "",
      },
      error: "",
    },
    ...overrides,
  };
}

function renderCard(options) {
  const container = document.createElement("div");
  renderRemoteAccessMarkup(container, renderRemoteAccessCard(options));
  return container;
}

describe("remote access helpers", () => {
  test("prefers cloudflare URL in collapsed mode when a tunnel exists", () => {
    const url = getActiveRemoteShareUrl({
      payload: createPayload(),
      remoteAccessExpanded: false,
      remoteAccessMode: "lan",
    });

    expect(url).toBe("https://demo.trycloudflare.com/?token=secret-token");
  });

  test("returns LAN QR target for expanded LAN mode", () => {
    const url = getRemoteQrTarget({
      payload: createPayload(),
      remoteAccessExpanded: true,
      remoteAccessMode: "lan",
    });

    expect(url).toBe("http://192.168.1.50:4173/?token=secret-token");
  });
});

describe("renderRemoteAccessCard", () => {
  test("renders compact card with public status", () => {
    const container = renderCard({
      payload: createPayload(),
      remoteAccessExpanded: false,
      remoteQrUrl: "data:image/png;base64,abc",
      isRemote: false,
    });

    expect(container.querySelector(".remote-card--compact")).not.toBeNull();
    expect(container.querySelector(".remote-pill--ok")?.textContent).toContain("public");
    expect(container.querySelector('[data-action="toggle-remote-panel"]')?.getAttribute("type")).toBe("button");
    expect(container.querySelector(".remote-compact__qr")).not.toBeNull();
  });

  test("renders expanded VPS mode with editable public URL field", () => {
    const container = renderCard({
      payload: createPayload({
        appState: {
          settings: {
            remoteAccess: {
              enabled: true,
              token: "secret-token",
              customPublicUrl: "https://strideterm.example.com",
              cloudflaredPath: "C:/tools/cloudflared.exe",
            },
          },
        },
      }),
      remoteAccessExpanded: true,
      remoteAccessMode: "vps",
      remoteQrUrl: "",
      isRemote: false,
    });

    expect(container.querySelector(".remote-mode-panel--active")).not.toBeNull();
    expect(container.querySelector('[data-role="custom-public-url"]')).not.toBeNull();
    expect(container.querySelector('[data-action="save-custom-public-url"]')?.getAttribute("type")).toBe("button");
    expect(container.querySelector('[data-action="clear-custom-public-url"]')?.hasAttribute("disabled")).toBe(false);
  });
});
