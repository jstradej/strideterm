import { describe, expect, test } from "vitest";
import {
  callableUrl,
  identityToolkitUrl,
  isDemoProject,
  MobileFirebaseNotConfiguredError,
  MOBILE_FIREBASE_ENV_VARS,
  resolveMobileFirebaseConfig,
  rtdbUrl,
  secureTokenUrl,
} from "./mobile-firebase-config.js";
import { FUNCTIONS_REGION } from "./mobile-rtdb-paths.js";

const REGION = FUNCTIONS_REGION;

describe("resolveMobileFirebaseConfig", () => {
  test("an empty environment yields no config and names exactly what is missing", () => {
    const { config, missing } = resolveMobileFirebaseConfig({}, REGION);
    expect(config).toBeNull();
    expect(missing).toContain(MOBILE_FIREBASE_ENV_VARS.projectId);
  });

  test("nothing is compiled in — a project id alone is not enough for a real project", () => {
    const { config, missing } = resolveMobileFirebaseConfig(
      { [MOBILE_FIREBASE_ENV_VARS.projectId]: "strideterm-mobile-prod" },
      REGION,
    );
    expect(config).toBeNull();
    expect(missing).toEqual([MOBILE_FIREBASE_ENV_VARS.apiKey]);
  });

  test("a production config derives the RTDB URL from the project and region", () => {
    const { config } = resolveMobileFirebaseConfig(
      {
        [MOBILE_FIREBASE_ENV_VARS.projectId]: "strideterm-mobile-prod",
        [MOBILE_FIREBASE_ENV_VARS.apiKey]: "AIza-not-a-secret",
      },
      REGION,
    );
    expect(config).not.toBeNull();
    expect(config?.emulators).toBeNull();
    expect(config?.databaseUrl).toBe(`https://strideterm-mobile-prod-default-rtdb.${REGION}.firebasedatabase.app`);
    expect(callableUrl(config!, "claimPairing")).toBe(
      `https://${REGION}-strideterm-mobile-prod.cloudfunctions.net/claimPairing`,
    );
    // The whole point of P0.3/P0.2's region work: never us-central1.
    expect(callableUrl(config!, "claimPairing")).not.toContain("us-central1");
  });

  test("a demo project needs no API key — that is the CLI's emulator-only convention", () => {
    const { config, missing } = resolveMobileFirebaseConfig(
      { [MOBILE_FIREBASE_ENV_VARS.projectId]: "demo-strideterm" },
      REGION,
    );
    expect(missing).toEqual([]);
    expect(config?.apiKey).toBe("emulator-api-key");
    expect(isDemoProject("demo-strideterm")).toBe(true);
    expect(isDemoProject("strideterm-mobile-prod")).toBe(false);
  });

  test("emulator hosts are picked up from the Firebase CLI's own variables", () => {
    const { config } = resolveMobileFirebaseConfig(
      {
        [MOBILE_FIREBASE_ENV_VARS.projectId]: "demo-strideterm",
        [MOBILE_FIREBASE_ENV_VARS.authEmulator]: "127.0.0.1:9099",
        [MOBILE_FIREBASE_ENV_VARS.databaseEmulator]: "127.0.0.1:9000",
        [MOBILE_FIREBASE_ENV_VARS.functionsEmulator]: "127.0.0.1:5001",
      },
      REGION,
    );
    expect(config?.emulators).toEqual({
      auth: "127.0.0.1:9099",
      database: "127.0.0.1:9000",
      functions: "127.0.0.1:5001",
    });
    expect(config?.databaseUrl).toBe("http://127.0.0.1:9000?ns=demo-strideterm-default-rtdb");
    expect(callableUrl(config!, "claimPairing")).toBe(`http://127.0.0.1:5001/demo-strideterm/${REGION}/claimPairing`);
    expect(identityToolkitUrl(config!, "signUp")).toBe(
      "http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signUp?key=emulator-api-key",
    );
    expect(secureTokenUrl(config!)).toBe(
      "http://127.0.0.1:9099/securetoken.googleapis.com/v1/token?key=emulator-api-key",
    );
  });

  test("a scheme or trailing slash on an emulator host is tolerated", () => {
    const { config } = resolveMobileFirebaseConfig(
      {
        [MOBILE_FIREBASE_ENV_VARS.projectId]: "demo-strideterm",
        [MOBILE_FIREBASE_ENV_VARS.databaseEmulator]: "http://127.0.0.1:9000/",
      },
      REGION,
    );
    expect(config?.emulators?.database).toBe("127.0.0.1:9000");
  });

  test("an explicit database URL wins over the derived one", () => {
    const { config } = resolveMobileFirebaseConfig(
      {
        [MOBILE_FIREBASE_ENV_VARS.projectId]: "demo-strideterm",
        [MOBILE_FIREBASE_ENV_VARS.databaseUrl]: "https://elsewhere.example/",
      },
      REGION,
    );
    expect(config?.databaseUrl).toBe("https://elsewhere.example/");
  });
});

describe("rtdbUrl", () => {
  const emulator = resolveMobileFirebaseConfig(
    {
      [MOBILE_FIREBASE_ENV_VARS.projectId]: "demo-strideterm",
      [MOBILE_FIREBASE_ENV_VARS.databaseEmulator]: "127.0.0.1:9000",
    },
    REGION,
  ).config!;

  test("keeps the emulator's ?ns= query while adding its own params", () => {
    const url = new URL(rtdbUrl(emulator, "v1/pairs/p1/events", { auth: "token-123" }));
    expect(url.pathname).toBe("/v1/pairs/p1/events.json");
    expect(url.searchParams.get("ns")).toBe("demo-strideterm-default-rtdb");
    expect(url.searchParams.get("auth")).toBe("token-123");
  });

  test("an empty path addresses the database root (multi-location updates PATCH here)", () => {
    const url = new URL(rtdbUrl(emulator, "", {}));
    expect(url.pathname).toBe("/.json");
  });

  test("a leading slash on the path does not produce a doubled separator", () => {
    const url = new URL(rtdbUrl(emulator, "/v1/pairs/p1", {}));
    expect(url.pathname).toBe("/v1/pairs/p1.json");
  });
});

describe("MobileFirebaseNotConfiguredError", () => {
  test("names the variables to set, including the emulator ones", () => {
    const error = new MobileFirebaseNotConfiguredError([MOBILE_FIREBASE_ENV_VARS.projectId]);
    expect(error.missing).toEqual([MOBILE_FIREBASE_ENV_VARS.projectId]);
    expect(error.message).toContain(MOBILE_FIREBASE_ENV_VARS.projectId);
    expect(error.message).toContain(MOBILE_FIREBASE_ENV_VARS.databaseEmulator);
  });
});
