/**
 * Regression coverage for the file/directory picker call sites (WorkspaceDialog,
 * SettingsGeneralTab, ConnectionDialog, RemoteAccessDialog) that used to call
 * api.browseDirectory/browseFile
 * directly inside a click handler with no try/catch. A rejection (rare — an
 * IPC-layer failure) was an unhandled rejection with zero user feedback.
 * pickPath() centralizes the try/catch and error-toast behavior.
 */
import { describe, expect, test, beforeEach } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { pickPath } from "./pick-path.js";
import { useNotificationStore } from "../stores/notifications.js";

beforeEach(() => {
  setActivePinia(createPinia());
});

describe("pickPath", () => {
  test("returns the picked path on success", async () => {
    const result = await pickPath(async () => "/tmp/chosen");
    expect(result).toBe("/tmp/chosen");
  });

  test("returns null when the picker resolves null (user cancelled)", async () => {
    const result = await pickPath(async () => null);
    expect(result).toBeNull();
  });

  test("returns null when the picker resolves undefined (user cancelled)", async () => {
    const result = await pickPath(async () => undefined);
    expect(result).toBeNull();
  });

  test("a rejecting picker returns null and triggers an error notification", async () => {
    const result = await pickPath(async () => {
      throw new Error("IPC channel closed");
    });
    expect(result).toBeNull();

    const notifications = useNotificationStore();
    expect(notifications.sessions).toHaveLength(1);
    expect(notifications.sessions[0].events[0].title).toBe("Failed to open picker");
    expect(notifications.sessions[0].events[0].body).toBe("IPC channel closed");
  });

  test("a rejection without a message falls back to a generic body", async () => {
    const result = await pickPath(async () => {
      // eslint-disable-next-line @typescript-eslint/no-throw-literal
      throw "boom";
    });
    expect(result).toBeNull();

    const notifications = useNotificationStore();
    expect(notifications.sessions[0].events[0].body).toBe("Action failed");
  });
});
