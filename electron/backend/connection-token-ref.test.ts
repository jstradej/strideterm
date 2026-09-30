import net from "node:net";
import { describe, expect, test, vi } from "vitest";
import { createAzureHandlers } from "./runtime-azure-handlers.js";
import { createGitHubHandlers } from "./runtime-github-handlers.js";
import { startRemoteServer } from "./remote-server.js";
import { findOwnedConnection, storedSecretOfSavedConnection } from "./shared/connection-secret.js";

const DESKTOP_KEY_REF = "mobile:desktop-device-private-key";
const VERIFIED = new Error("verifyConnection reached");

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function makeCredentialStore(secrets: Record<string, string>) {
  return {
    getSecret: vi.fn((ref: string) => secrets[ref] ?? null),
    setSecret: vi.fn(async () => undefined),
  };
}

const quietLog = { debug: () => undefined, info: () => undefined, warn: () => undefined };

function makeAzure(connections: Array<Record<string, unknown>>, callerProfile = "profile-a") {
  const credentialStore = makeCredentialStore({ [DESKTOP_KEY_REF]: "PRIVATE-KEY-PEM", "cred:ado-1": "stored-pat" });
  const verifyConnection = vi.fn(async () => {
    throw VERIFIED;
  });
  const handlers = createAzureHandlers({
    log: quietLog,
    getState: () => ({}),
    credentialStore,
    azure: { verifyConnection },
    getAzureConnections: () => connections,
    getViewerProfileId: () => callerProfile,
  } as unknown as Parameters<typeof createAzureHandlers>[0]);
  return { handlers, credentialStore, verifyConnection };
}

function makeGitHub(connections: Array<Record<string, unknown>>, callerProfile = "profile-a") {
  const credentialStore = makeCredentialStore({ [DESKTOP_KEY_REF]: "PRIVATE-KEY-PEM", "cred:gh-1": "stored-pat" });
  const verifyConnection = vi.fn(async () => {
    throw VERIFIED;
  });
  const handlers = createGitHubHandlers({
    log: quietLog,
    getState: () => ({}),
    credentialStore,
    github: { verifyConnection },
    getGitHubConnections: () => connections,
    getViewerProfileId: () => callerProfile,
  } as unknown as Parameters<typeof createGitHubHandlers>[0]);
  return { handlers, credentialStore, verifyConnection };
}

const azureConn = { id: "ado-1", orgUrl: "https://dev.azure.com/acme", login: "me", profileId: "profile-a" };
const githubConn = {
  id: "gh-1",
  hostUrl: "https://github.com",
  apiBaseUrl: "https://api.github.com",
  profileId: "profile-a",
};

describe("connection secret refs are never taken from a request", () => {
  test("azure: a hostile tokenRef with a foreign host reads nothing and sends nothing", async () => {
    const { handlers, credentialStore, verifyConnection } = makeAzure([]);
    await expect(
      handlers.saveAzureConnection(
        { label: "x", orgUrl: "https://attacker.example", login: "me", tokenRef: DESKTOP_KEY_REF },
        "viewer",
      ),
    ).rejects.toThrow(/PAT is required/);
    expect(credentialStore.getSecret).not.toHaveBeenCalled();
    expect(verifyConnection).not.toHaveBeenCalled();
  });

  test("azure: an edit that moves the organization URL does not reuse the stored PAT", async () => {
    const { handlers, credentialStore, verifyConnection } = makeAzure([azureConn]);
    await expect(
      handlers.saveAzureConnection(
        { ...azureConn, orgUrl: "https://attacker.example", tokenRef: DESKTOP_KEY_REF },
        "viewer",
      ),
    ).rejects.toThrow(/enter the PAT again/);
    expect(credentialStore.getSecret).not.toHaveBeenCalled();
    expect(verifyConnection).not.toHaveBeenCalled();
  });

  test("azure: an edit that keeps the URL reuses the secret derived from the id, ignoring tokenRef", async () => {
    const { handlers, credentialStore, verifyConnection } = makeAzure([azureConn]);
    await expect(
      handlers.saveAzureConnection(
        { ...azureConn, orgUrl: "https://dev.azure.com/acme/", tokenRef: DESKTOP_KEY_REF },
        "viewer",
      ),
    ).rejects.toBe(VERIFIED);
    expect(credentialStore.getSecret).toHaveBeenCalledTimes(1);
    expect(credentialStore.getSecret).toHaveBeenCalledWith("cred:ado-1");
    expect(verifyConnection).toHaveBeenCalledWith(expect.objectContaining({ pat: "stored-pat" }));
  });

  test("azure: a connection of another profile cannot be edited, even with its own URL", async () => {
    const { handlers, credentialStore, verifyConnection } = makeAzure([{ ...azureConn, profileId: "profile-b" }]);
    await expect(handlers.saveAzureConnection({ ...azureConn }, "viewer")).rejects.toThrow(/another profile/);
    expect(credentialStore.getSecret).not.toHaveBeenCalled();
    expect(verifyConnection).not.toHaveBeenCalled();
  });

  test("github: a hostile tokenRef with a foreign host reads nothing and sends nothing", async () => {
    const { handlers, credentialStore, verifyConnection } = makeGitHub([]);
    await expect(
      handlers.saveGitHubConnection({ hostUrl: "https://ghe.attacker.example", tokenRef: DESKTOP_KEY_REF }, "viewer"),
    ).rejects.toThrow(/PAT is required/);
    expect(credentialStore.getSecret).not.toHaveBeenCalled();
    expect(verifyConnection).not.toHaveBeenCalled();
  });

  test("github: moving only apiBaseUrl also refuses the stored PAT", async () => {
    const { handlers, credentialStore, verifyConnection } = makeGitHub([githubConn]);
    await expect(
      handlers.saveGitHubConnection({ ...githubConn, apiBaseUrl: "https://api.attacker.example" }, "viewer"),
    ).rejects.toThrow(/enter the PAT again/);
    expect(credentialStore.getSecret).not.toHaveBeenCalled();
    expect(verifyConnection).not.toHaveBeenCalled();
  });

  test("github: an edit that keeps both hosts reuses the secret derived from the id", async () => {
    const { handlers, credentialStore, verifyConnection } = makeGitHub([githubConn]);
    await expect(handlers.saveGitHubConnection({ ...githubConn, tokenRef: DESKTOP_KEY_REF }, "viewer")).rejects.toBe(
      VERIFIED,
    );
    expect(credentialStore.getSecret).toHaveBeenCalledWith("cred:gh-1");
    expect(credentialStore.getSecret).not.toHaveBeenCalledWith(DESKTOP_KEY_REF);
    expect(verifyConnection).toHaveBeenCalledWith(expect.objectContaining({ pat: "stored-pat" }));
  });

  test("telegram: only a saved connection's derived secret is readable", () => {
    const store = makeCredentialStore({ "cred:tg-1": "bot", [DESKTOP_KEY_REF]: "PRIVATE-KEY-PEM" });
    expect(storedSecretOfSavedConnection([{ id: "tg-1" }], "tg-1", store)).toBe("bot");
    expect(storedSecretOfSavedConnection([{ id: "tg-1" }], "tg-2", store)).toBe("");
    expect(storedSecretOfSavedConnection([], undefined, store)).toBe("");
    expect(store.getSecret).toHaveBeenCalledTimes(1);
    expect(store.getSecret).not.toHaveBeenCalledWith(DESKTOP_KEY_REF);
  });

  test("telegram: a saved connection of another profile is refused, the caller's own is readable", () => {
    const store = makeCredentialStore({ "cred:tg-1": "bot" });
    const saved = [{ id: "tg-1", profileId: "profile-b" }];
    expect(() => storedSecretOfSavedConnection(saved, "tg-1", store, "profile-a")).toThrow(/another profile/);
    expect(store.getSecret).not.toHaveBeenCalled();
    expect(storedSecretOfSavedConnection(saved, "tg-1", store, "profile-b")).toBe("bot");
    expect(storedSecretOfSavedConnection(saved, "tg-1", store)).toBe("bot");
  });

  test("telegram: a global connection (empty profileId) is readable and editable from any profile", () => {
    const store = makeCredentialStore({ "cred:tg-1": "bot" });
    const saved = [{ id: "tg-1", profileId: "" }, { id: "tg-2" }];
    expect(storedSecretOfSavedConnection(saved, "tg-1", store, "work", true)).toBe("bot");
    expect(findOwnedConnection(saved, "tg-2", "work", true)).toBe(saved[1]);
    expect(findOwnedConnection(saved, "tg-1", "default", true)).toBe(saved[0]);
    // A bound connection is still refused, and other integrations keep "empty = default".
    expect(() => findOwnedConnection([{ id: "tg-3", profileId: "a" }], "tg-3", "work", true)).toThrow(
      /another profile/,
    );
    expect(() => findOwnedConnection(saved, "tg-1", "work")).toThrow(/another profile/);
  });

  test("POST /api/azure/save-connection with a hostile tokenRef and a foreign host answers 400 and sends nothing", async () => {
    const { handlers, credentialStore, verifyConnection } = makeAzure([]);
    const port = await getFreePort();
    const auth = "test-token-tokenref";
    const payload = {
      appState: {
        settings: { remoteAccess: { enabled: true, host: "127.0.0.1", port, token: auth } },
        profiles: [{ id: "profile-a", name: "A" }],
        workspaces: [],
        windowSlots: [{ id: "win-1", profileId: "profile-a" }],
      },
    };
    const runtime = {
      getPayload: () => payload,
      getInitialState: async () => payload,
      setRemoteInfo: () => undefined,
      listRemoteUrls: () => [],
      on: () => () => undefined,
      writeToSession: () => undefined,
      resizeSession: () => undefined,
      setRemoteClientRegistry: () => undefined,
      saveAzureConnection: handlers.saveAzureConnection,
    };
    const server = await startRemoteServer({
      runtime: runtime as unknown as Parameters<typeof startRemoteServer>[0]["runtime"],
      staticRoot: process.cwd(),
    });
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/azure/save-connection`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${auth}`,
          "Content-Type": "application/json",
          "X-Strideterm-Client-Id": "test-client",
        },
        body: JSON.stringify({
          connection: { label: "x", orgUrl: "https://attacker.example", login: "me", tokenRef: DESKTOP_KEY_REF },
        }),
      });
      expect(res.status).toBe(400);
      expect(credentialStore.getSecret).not.toHaveBeenCalled();
      expect(verifyConnection).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });
});
