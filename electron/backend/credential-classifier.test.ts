import { describe, expect, test } from "vitest";
import { classifyCredentials, type CredentialOwnerState } from "./credential-classifier.js";

const state: CredentialOwnerState = {
  profiles: [
    { id: "default", name: "Work" },
    { id: "p2", name: "Client B" },
  ],
  workspaces: [
    {
      panels: [
        { launch: { sshInline: { auth: { passwordRef: "ssh:password:inline" } } } },
        { launch: null, sftp: null },
      ],
    },
  ],
  ssh: {
    hosts: [
      { id: "h1", name: "build box", auth: { keyRef: "ssh:key:k1", passwordRef: "ssh:password:h1" } },
      { id: "h2", host: "example.test", auth: { keyRef: "ssh:key:held-only", passphraseRef: "ssh:passphrase:custom" } },
    ],
    keys: [{ id: "ssh:key:k1", label: "Laptop key" }],
    certificates: [{ id: "ssh:cert:c1", keyIdString: "alice@corp" }],
  },
  settings: {
    integrations: {
      azureDevops: {
        connections: [
          {
            id: "ado-1",
            label: "Corp ADO",
            orgUrl: "https://dev.azure.com/corp",
            tokenRef: "cred:ado-1",
            profileId: "p2",
          },
          { id: "ado-2", label: "Legacy ADO", orgUrl: "https://corp.visualstudio.com", tokenRef: "cred:ado-2" },
        ],
      },
      github: {
        connections: [
          { id: "gh-1", label: "GitHub", hostUrl: "https://github.com", tokenRef: "cred:gh-1", profileId: "default" },
          { id: "gh-2", label: "GHE", hostUrl: "https://ghe.corp.test", tokenRef: "cred:gh-2", profileId: "default" },
        ],
      },
      telegram: {
        connections: [{ id: "tg-1", label: "Alerts", botTokenRef: "cred:tg-1", profileId: "" }],
      },
      jira: {
        connections: [
          {
            id: "jira-cloud",
            label: "Cloud Jira",
            profileId: "default",
            deployment: "cloud",
            auth: { kind: "cloud-api-token", secretRef: "jira:jira-cloud:api-token" },
          },
          {
            id: "jira-dc",
            label: "DC Jira",
            profileId: "p2",
            deployment: "data-center",
            auth: {
              kind: "dc-apim",
              secretRef: "jira:jira-dc:apim-key",
              passphraseRef: "jira:jira-dc:apim-passphrase",
            },
          },
        ],
      },
      registry: {
        connections: [
          { id: "reg-1", label: "Corp Maven", profileId: "default", authKind: "basic" },
          { id: "reg-open", label: "Open mirror", profileId: "default", authKind: "none" },
        ],
      },
    },
  },
};

const TEMP = "jira:jira-dc:test-pat:123e4567-e89b-12d3-a456-426614174000";

function classify(...refs: string[]) {
  return classifyCredentials(state, refs);
}
function one(ref: string) {
  const [entry] = classify(ref);
  return entry;
}

describe("classifyCredentials", () => {
  test("Azure DevOps and GitHub tokens resolve their connection, profile and provider page", () => {
    expect(one("cred:ado-1")).toMatchObject({
      system: "azure",
      kind: "personal-access-token",
      ownerId: "ado-1",
      ownerLabel: "Corp ADO",
      profileName: "Client B",
      orphan: false,
      manageUrl: "https://dev.azure.com/corp/_usersSettings/tokens",
    });
    expect(one("cred:ado-2")).toMatchObject({ profileName: "Work", orphan: false });
    expect(one("cred:ado-2").manageUrl).toBeUndefined();
    expect(one("cred:gh-1")).toMatchObject({ system: "github", manageUrl: "https://github.com/settings/tokens" });
    expect(one("cred:gh-2").manageUrl).toBeUndefined();
  });

  test("a Telegram bot token with no profile belongs to all profiles and has no provider page", () => {
    expect(one("cred:tg-1")).toMatchObject({
      system: "telegram",
      kind: "bot-token",
      ownerLabel: "Alerts",
      profileName: "All profiles",
      orphan: false,
    });
    expect(one("cred:tg-1").manageUrl).toBeUndefined();
  });

  test("a cred: secret no connection references is an orphan of a removed connection", () => {
    expect(one("cred:gone")).toMatchObject({ system: "connection", orphan: true, ownerLabel: "", profileName: "" });
  });

  test("Jira secrets are owned only while the connection's auth references them", () => {
    expect(one("jira:jira-cloud:api-token")).toMatchObject({
      system: "jira",
      kind: "api-token",
      orphan: false,
      profileName: "Work",
      manageUrl: "https://id.atlassian.com/manage-profile/security/api-tokens",
    });
    expect(one("jira:jira-dc:apim-key")).toMatchObject({ kind: "gateway-key", orphan: false });
    expect(one("jira:jira-dc:apim-passphrase")).toMatchObject({ kind: "gateway-key-passphrase", orphan: false });
    expect(one("jira:jira-dc:apim-key").manageUrl).toBeUndefined();
    expect(one("jira:jira-dc:pat")).toMatchObject({ kind: "personal-access-token", orphan: true });
    expect(one("jira:deleted:pat")).toMatchObject({ orphan: true });
    expect(one(TEMP)).toMatchObject({ system: "jira", kind: "temporary", orphan: true });
  });

  test("a registry secret belongs to a connection that signs in", () => {
    expect(one("registry:reg-1:secret")).toMatchObject({
      system: "registry",
      kind: "registry-secret",
      ownerLabel: "Corp Maven",
      orphan: false,
    });
    expect(one("registry:reg-open:secret").orphan).toBe(true);
    expect(one("registry:nope:secret").orphan).toBe(true);
  });

  test("SSH secrets: library entries and hosts own them, a held-only key still counts as used", () => {
    expect(one("ssh:key:k1")).toMatchObject({ kind: "ssh-private-key", ownerLabel: "Laptop key", orphan: false });
    expect(one("ssh:key:held-only")).toMatchObject({ ownerLabel: "example.test", ownerId: "h2", orphan: false });
    expect(one("ssh:key:stray").orphan).toBe(true);
    expect(one("ssh:passphrase:ssh:key:k1")).toMatchObject({
      kind: "ssh-key-passphrase",
      ownerLabel: "Laptop key",
      orphan: false,
    });
    expect(one("ssh:passphrase:custom")).toMatchObject({ ownerId: "h2", orphan: false });
    expect(one("ssh:passphrase:ssh:key:stray").orphan).toBe(true);
    expect(one("ssh:cert:c1")).toMatchObject({ kind: "ssh-certificate", ownerLabel: "alice@corp", orphan: false });
    expect(one("ssh:cert:stray").orphan).toBe(true);
    expect(one("ssh:password:h1")).toMatchObject({ kind: "ssh-password", ownerLabel: "build box", orphan: false });
    expect(one("ssh:password:inline")).toMatchObject({ ownerLabel: "An SSH tab", orphan: false });
    expect(one("ssh:password:stray").orphan).toBe(true);
    expect(one("ssh:key:k1").profileName).toBe("All profiles");
  });

  test("anything outside the allowlist is not listed", () => {
    const outOfScope = [
      "mobile:desktop-device-private-key",
      "mobile:firebase-refresh-token",
      "remote:access-token",
      "account:owner-email",
      "installation:token",
      "cred",
      "ssh:known-hosts",
      "jira:jira-cloud:unknown",
      "registry:reg-1:other",
      "something-else",
      "",
    ];
    expect(classify(...outOfScope)).toEqual([]);
  });

  test("an empty state still classifies shapes, as orphans, and lists each ref once", () => {
    const result = classifyCredentials({}, ["cred:a", "cred:a", "registry:r:secret"]);
    expect(result.map((entry) => entry.ref).sort()).toEqual(["cred:a", "registry:r:secret"]);
    expect(result.every((entry) => entry.orphan)).toBe(true);
  });

  test("the result carries references and labels only, never anything that could be a value", () => {
    const text = JSON.stringify(classify("cred:ado-1", "ssh:key:k1", "registry:reg-1:secret"));
    expect(Object.keys(JSON.parse(text)[0]).sort()).toEqual(
      ["kind", "manageUrl", "orphan", "ownerId", "ownerLabel", "profileId", "profileName", "ref", "system"].sort(),
    );
  });
});
