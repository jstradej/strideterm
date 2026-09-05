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
  validateLocalDatabaseUrl,
  validateLocalEmulatorHost,
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
    const { config, missing } = resolveMobileFirebaseConfig({ ...LOCAL_SUITE }, REGION);
    expect(missing).toEqual([]);
    expect(config?.apiKey).toBe("emulator-api-key");
    expect(isDemoProject("demo-strideterm")).toBe(true);
    expect(isDemoProject("strideterm-mobile-prod")).toBe(false);
  });

  test("emulator hosts are picked up from the Firebase CLI's own variables", () => {
    const { config } = resolveMobileFirebaseConfig(
      {
        STRIDETERM_ENV: "local",
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
    expect(config?.apiKey).toBe("emulator-api-key");
    expect(callableUrl(config!, "claimPairing")).toBe(`http://127.0.0.1:5001/demo-strideterm/${REGION}/claimPairing`);
    expect(identityToolkitUrl(config!, "signUp")).toBe(
      "http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signUp?key=emulator-api-key",
    );
    expect(secureTokenUrl(config!)).toBe(
      "http://127.0.0.1:9099/securetoken.googleapis.com/v1/token?key=emulator-api-key",
    );
  });

  test("emulator hosts outside a local build are a REFUSAL, not a no-op (F11, R06)", () => {
    // "Zachovat pevné dev/qa/prod originy a local-only pravidla pro HTTP/emulatory." They used
    // to be read whatever the environment was, so `FIREBASE_AUTH_EMULATOR_HOST` could point a real
    // build's identity calls at a plain-HTTP loopback host. The first fix IGNORED them outside dev
    // (now: outside local), and that was still wrong (R06): the explicit database URL the same
    // procedure sets stayed in force, so a qa build kept its database on the emulator while its
    // identity calls and callables went to the cloud. A configuration naming two backends is refused
    // whole.
    const emulatorEnv = {
      [MOBILE_FIREBASE_ENV_VARS.authEmulator]: "127.0.0.1:9099",
      [MOBILE_FIREBASE_ENV_VARS.databaseEmulator]: "127.0.0.1:9000",
      [MOBILE_FIREBASE_ENV_VARS.functionsEmulator]: "127.0.0.1:5001",
    };
    for (const projectId of ["strideterm-mobile-prod", "strideterm-mobile-qa"]) {
      const { config, refusal } = resolveMobileFirebaseConfig(
        {
          [MOBILE_FIREBASE_ENV_VARS.projectId]: projectId,
          [MOBILE_FIREBASE_ENV_VARS.apiKey]: "AIza-the-real-one",
          ...emulatorEnv,
        },
        REGION,
      );
      expect(config, projectId).toBeNull();
      expect(refusal?.reason, projectId).toBe("environment-contradiction");
      // The refusal names the variables that disagree, and no value.
      for (const name of Object.keys(emulatorEnv)) expect(refusal?.detail, projectId).toContain(name);
      expect(refusal?.detail).not.toContain("AIza-the-real-one");
    }
    // The SAME declared as qa by name is refused the same way: the declaration decides, not the
    // project id's spelling.
    const declaredQa = resolveMobileFirebaseConfig(
      {
        [MOBILE_FIREBASE_ENV_VARS.projectId]: "some-restored-project",
        [MOBILE_FIREBASE_ENV_VARS.apiKey]: "AIza-the-real-one",
        STRIDETERM_ENV: "qa",
        [MOBILE_FIREBASE_ENV_VARS.authEmulator]: "127.0.0.1:9099",
      } as NodeJS.ProcessEnv,
      REGION,
    );
    expect(declaredQa.config).toBeNull();
    expect(declaredQa.refusal?.reason).toBe("environment-contradiction");
    // A DECLARED local environment brings them back, PROVIDED the project id is a demo- one — which
    // is the whole point of the declaration being explicit, and of local + a real project also being
    // a contradiction (the other half of the same rule, tested below).
    const declaredLocal = resolveMobileFirebaseConfig(
      {
        [MOBILE_FIREBASE_ENV_VARS.projectId]: "demo-strideterm",
        STRIDETERM_ENV: "local",
        ...emulatorEnv,
      } as NodeJS.ProcessEnv,
      REGION,
    ).config;
    expect(declaredLocal?.emulators?.auth).toBe("127.0.0.1:9099");
  });

  test("local declared over a real (non-demo) project id is ALSO a contradiction", () => {
    // The other half of "local s reálným projektem ... je chyba" (plan §3.1): emulators pointed at a
    // real project is refused above; a `local` declaration pointed at a real project is refused here.
    const { config, refusal } = resolveMobileFirebaseConfig(
      {
        [MOBILE_FIREBASE_ENV_VARS.projectId]: "strideterm-mobile-qa",
        [MOBILE_FIREBASE_ENV_VARS.apiKey]: "AIza-the-real-one",
        STRIDETERM_ENV: "local",
      } as NodeJS.ProcessEnv,
      REGION,
    );
    expect(config).toBeNull();
    expect(refusal?.reason).toBe("environment-contradiction");
    expect(refusal?.detail).toContain("demo-");
  });

  test("a scheme or trailing slash on an emulator host is tolerated", () => {
    const { config } = resolveMobileFirebaseConfig(
      { ...LOCAL_SUITE, [MOBILE_FIREBASE_ENV_VARS.databaseEmulator]: "http://127.0.0.1:9000/" },
      REGION,
    );
    expect(config?.emulators?.database).toBe("127.0.0.1:9000");
  });

  test("an explicit database URL wins over the derived one", () => {
    const { config } = resolveMobileFirebaseConfig(
      {
        STRIDETERM_ENV: "qa",
        [MOBILE_FIREBASE_ENV_VARS.projectId]: "strideterm-mobile-qa",
        [MOBILE_FIREBASE_ENV_VARS.apiKey]: "AIza-qa",
        [MOBILE_FIREBASE_ENV_VARS.databaseUrl]: "https://elsewhere.example/",
      },
      REGION,
    );
    expect(config?.databaseUrl).toBe("https://elsewhere.example/");
  });
});

/**
 * The complete local configuration (follow-up 2026-09-11, item 1): a demo project, `local` declared,
 * and every one of the three emulators on a loopback host. Every local scenario below starts here and
 * removes or bends exactly one thing.
 */
const LOCAL_SUITE = {
  STRIDETERM_ENV: "local",
  [MOBILE_FIREBASE_ENV_VARS.projectId]: "demo-strideterm",
  [MOBILE_FIREBASE_ENV_VARS.authEmulator]: "127.0.0.1:9099",
  [MOBILE_FIREBASE_ENV_VARS.databaseEmulator]: "127.0.0.1:9000",
  [MOBILE_FIREBASE_ENV_VARS.functionsEmulator]: "127.0.0.1:5001",
} as const;

describe("local: the whole Emulator Suite on this machine, or no configuration (follow-up item 1)", () => {
  const EMULATOR_VARS = [
    MOBILE_FIREBASE_ENV_VARS.authEmulator,
    MOBILE_FIREBASE_ENV_VARS.databaseEmulator,
    MOBILE_FIREBASE_ENV_VARS.functionsEmulator,
  ];

  test("the complete configuration resolves, and every endpoint is a plain-HTTP loopback URL", () => {
    const { config, missing, refusal } = resolveMobileFirebaseConfig({ ...LOCAL_SUITE }, REGION);
    expect(missing).toEqual([]);
    expect(refusal).toBeNull();
    expect(config?.emulators).toEqual({
      auth: "127.0.0.1:9099",
      database: "127.0.0.1:9000",
      functions: "127.0.0.1:5001",
    });
    for (const url of [
      callableUrl(config!, "claimPairing"),
      identityToolkitUrl(config!, "signUp"),
      secureTokenUrl(config!),
      rtdbUrl(config!, "v1/x"),
    ]) {
      // The HOST is the emulator's; the Google service name may appear in the PATH, which is how
      // the Auth emulator multiplexes (`/identitytoolkit.googleapis.com/v1/...` on a loopback port).
      expect(new URL(url).hostname).toBe("127.0.0.1");
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:(9099|9000|5001)\//);
    }
  });

  test("each emulator is REQUIRED: a missing one is named in `missing`, and no config is built — no cloud fallback", () => {
    // The scenario the follow-up names: two of three set, the third (Auth) absent, and the old code
    // silently sent the identity calls to identitytoolkit.googleapis.com.
    for (const absent of EMULATOR_VARS) {
      const env: Record<string, string> = { ...LOCAL_SUITE };
      delete env[absent];
      const { config, missing, refusal } = resolveMobileFirebaseConfig(env, REGION);
      expect(config, absent).toBeNull();
      expect(refusal, absent).toBeNull();
      expect(missing, absent).toEqual([absent]);
      // And the transport's error names it, so the fix is one line.
      expect(new MobileFirebaseNotConfiguredError(missing).message).toContain(absent);
    }
    // A project id alone — the old "cloud fallback" input — is missing all three.
    const bare = resolveMobileFirebaseConfig(
      { STRIDETERM_ENV: "local", [MOBILE_FIREBASE_ENV_VARS.projectId]: "demo-strideterm" },
      REGION,
    );
    expect(bare.config).toBeNull();
    expect(bare.missing).toEqual(EMULATOR_VARS);
  });

  test("a LAN address is not this machine: refused, naming the variable and never the value", () => {
    for (const name of EMULATOR_VARS) {
      const { config, refusal } = resolveMobileFirebaseConfig({ ...LOCAL_SUITE, [name]: "192.168.1.20:9099" }, REGION);
      expect(config, name).toBeNull();
      expect(refusal?.reason, name).toBe("local-endpoint-invalid");
      expect(refusal?.detail, name).toContain(name);
      expect(refusal?.detail, name).not.toContain("192.168");
    }
  });

  test("lookalike hostnames, other schemes, credentials, paths and bad ports are refused; real loopback spellings are not", () => {
    const refused = [
      "127.0.0.1.evil.example:9099",
      "localhost.example:9099",
      "https://127.0.0.1:9099",
      "ftp://127.0.0.1:9099",
      "user:secret@127.0.0.1:9099",
      "127.0.0.1:9099/identitytoolkit.googleapis.com",
      "127.0.0.1:9099?x=1",
      "127.0.0.1",
      "127.0.0.1:70000",
      "127.0.0.1:0",
      "not a host",
      "identitytoolkit.googleapis.com:443",
    ];
    for (const value of refused) {
      const { config, refusal } = resolveMobileFirebaseConfig(
        { ...LOCAL_SUITE, [MOBILE_FIREBASE_ENV_VARS.authEmulator]: value },
        REGION,
      );
      expect(config, value).toBeNull();
      expect(refusal?.reason, value).toBe("local-endpoint-invalid");
      expect(refusal?.detail, value).toContain(MOBILE_FIREBASE_ENV_VARS.authEmulator);
    }
    for (const [value, expected] of [
      ["localhost:9099", "localhost:9099"],
      ["[::1]:9099", "[::1]:9099"],
      ["http://127.0.0.1:9099/", "127.0.0.1:9099"],
      ["127.1:9099", "127.0.0.1:9099"], // the URL parser normalises the shorthand to the real loopback address
    ]) {
      const { config, refusal } = resolveMobileFirebaseConfig(
        { ...LOCAL_SUITE, [MOBILE_FIREBASE_ENV_VARS.authEmulator]: value },
        REGION,
      );
      expect(refusal, value).toBeNull();
      expect(config?.emulators?.auth, value).toBe(expected);
    }
  });

  test("an explicit database URL must be the database emulator's own URL for the declared demo project", () => {
    const ok = resolveMobileFirebaseConfig(
      {
        ...LOCAL_SUITE,
        [MOBILE_FIREBASE_ENV_VARS.databaseUrl]: "http://127.0.0.1:9000?ns=demo-strideterm-default-rtdb",
      },
      REGION,
    );
    expect(ok.refusal).toBeNull();
    expect(ok.config?.databaseUrl).toBe("http://127.0.0.1:9000?ns=demo-strideterm-default-rtdb");
    // The trailing slash the browser form carries is the same address.
    expect(
      resolveMobileFirebaseConfig(
        {
          ...LOCAL_SUITE,
          [MOBILE_FIREBASE_ENV_VARS.databaseUrl]: "http://127.0.0.1:9000/?ns=demo-strideterm-default-rtdb",
        },
        REGION,
      ).refusal,
    ).toBeNull();

    const refused = [
      // The inherited cloud URL the follow-up names.
      "https://demo-strideterm-default-rtdb.europe-west1.firebasedatabase.app",
      // Another project's namespace on the right emulator.
      "http://127.0.0.1:9000?ns=strideterm-mobile-qa-default-rtdb",
      // The right namespace on a different host / port.
      "http://192.168.1.20:9000?ns=demo-strideterm-default-rtdb",
      "http://127.0.0.1:9001?ns=demo-strideterm-default-rtdb",
      // No namespace, an extra query, a path, credentials, a fragment.
      "http://127.0.0.1:9000",
      "http://127.0.0.1:9000?ns=demo-strideterm-default-rtdb&auth=x",
      "http://127.0.0.1:9000/v2?ns=demo-strideterm-default-rtdb",
      "http://u:p@127.0.0.1:9000?ns=demo-strideterm-default-rtdb",
      "http://127.0.0.1:9000?ns=demo-strideterm-default-rtdb#frag",
      "not a url",
    ];
    for (const value of refused) {
      const { config, refusal } = resolveMobileFirebaseConfig(
        { ...LOCAL_SUITE, [MOBILE_FIREBASE_ENV_VARS.databaseUrl]: value },
        REGION,
      );
      expect(config, value).toBeNull();
      expect(refusal?.reason, value).toBe("local-endpoint-invalid");
      expect(refusal?.detail, value).toContain(MOBILE_FIREBASE_ENV_VARS.databaseUrl);
      expect(refusal?.detail, value).not.toContain("192.168");
    }
  });

  test("a demo- project outside local is a contradiction — it exists in no cloud", () => {
    for (const declared of ["qa", "dev", "prod", undefined, "stage"]) {
      const env: Record<string, string> = {
        [MOBILE_FIREBASE_ENV_VARS.projectId]: "demo-strideterm",
        [MOBILE_FIREBASE_ENV_VARS.apiKey]: "AIza-whatever",
      };
      if (declared) env.STRIDETERM_ENV = declared;
      const { config, refusal } = resolveMobileFirebaseConfig(env, REGION);
      expect(config, String(declared)).toBeNull();
      expect(refusal?.reason, String(declared)).toBe("environment-contradiction");
      expect(refusal?.detail, String(declared)).toContain(MOBILE_FIREBASE_ENV_VARS.projectId);
    }
  });

  test("the URL helpers have no cloud branch for a demo project: a hand-built config without emulators throws", () => {
    const handBuilt = {
      projectId: "demo-strideterm",
      apiKey: "emulator-api-key",
      functionsRegion: REGION,
      emulators: null,
      databaseUrl: "http://127.0.0.1:9000?ns=demo-strideterm-default-rtdb",
    };
    expect(() => callableUrl(handBuilt, "claimPairing")).toThrow(/demo project/);
    expect(() => identityToolkitUrl(handBuilt, "signUp")).toThrow(/demo project/);
    expect(() => secureTokenUrl(handBuilt)).toThrow(/demo project/);
  });

  test("validateLocalEmulatorHost and validateLocalDatabaseUrl are the rules, stated on their own", () => {
    expect(validateLocalEmulatorHost("127.0.0.1:9099")).toEqual({ host: "127.0.0.1:9099" });
    expect(validateLocalEmulatorHost("10.0.2.2:9099").problem).toMatch(/not loopback/);
    expect(validateLocalEmulatorHost("").problem).toBe("is empty");
    expect(
      validateLocalDatabaseUrl("http://127.0.0.1:9000?ns=demo-x-default-rtdb", "127.0.0.1:9000", "demo-x"),
    ).toBeNull();
    expect(
      validateLocalDatabaseUrl("http://127.0.0.1:9000?ns=demo-y-default-rtdb", "127.0.0.1:9000", "demo-x")?.problem,
    ).toMatch(/namespace/);
  });
});

describe("rtdbUrl", () => {
  const emulator = resolveMobileFirebaseConfig({ ...LOCAL_SUITE }, REGION).config!;

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

describe("a contradictory configuration is refused whole (R06)", () => {
  const QA = {
    STRIDETERM_ENV: "qa",
    [MOBILE_FIREBASE_ENV_VARS.projectId]: "strideterm-mobile-qa",
    [MOBILE_FIREBASE_ENV_VARS.apiKey]: "AIza-qa",
  } as NodeJS.ProcessEnv;

  test("a clean qa configuration resolves, to HTTPS endpoints only", () => {
    const { config, refusal } = resolveMobileFirebaseConfig(QA, REGION);
    expect(refusal).toBeNull();
    expect(config?.emulators).toBeNull();
    expect(identityToolkitUrl(config!, "lookup")).toMatch(/^https:\/\/identitytoolkit\.googleapis\.com/);
    expect(callableUrl(config!, "getAccountOverview")).toMatch(/^https:\/\//);
    expect(config?.databaseUrl).toMatch(/^https:\/\//);
  });

  test("qa plus an explicit plain-HTTP database URL is refused, and the refusal names the variable", () => {
    // The mixed target R06 describes: RTDB on the emulator, Auth and the callables in the cloud.
    const { config, refusal } = resolveMobileFirebaseConfig(
      {
        ...QA,
        [MOBILE_FIREBASE_ENV_VARS.databaseUrl]: "http://127.0.0.1:9000?ns=strideterm-mobile-qa-default-rtdb",
      },
      REGION,
    );
    expect(config).toBeNull();
    expect(refusal?.reason).toBe("environment-contradiction");
    expect(refusal?.detail).toContain(MOBILE_FIREBASE_ENV_VARS.databaseUrl);
    expect(refusal?.detail).not.toContain("127.0.0.1");
  });

  test("qa plus an explicit HTTPS database URL is not a contradiction", () => {
    const { config, refusal } = resolveMobileFirebaseConfig(
      {
        ...QA,
        [MOBILE_FIREBASE_ENV_VARS.databaseUrl]: "https://restored-instance.europe-west1.firebasedatabase.app",
      },
      REGION,
    );
    expect(refusal).toBeNull();
    expect(config?.databaseUrl).toBe("https://restored-instance.europe-west1.firebasedatabase.app");
  });

  test("an UNRESOLVED declaration with emulator hosts is refused too — it does not fall through to local", () => {
    const { config, refusal } = resolveMobileFirebaseConfig(
      {
        ...QA,
        STRIDETERM_ENV: "stage",
        [MOBILE_FIREBASE_ENV_VARS.authEmulator]: "127.0.0.1:9099",
      } as NodeJS.ProcessEnv,
      REGION,
    );
    expect(config).toBeNull();
    expect(refusal?.reason).toBe("environment-contradiction");
  });

  test("the refusal surfaces as the transport's own error, naming the contradiction rather than a missing variable", () => {
    const { refusal } = resolveMobileFirebaseConfig(
      { ...QA, [MOBILE_FIREBASE_ENV_VARS.authEmulator]: "127.0.0.1:9099" },
      REGION,
    );
    const error = new MobileFirebaseNotConfiguredError([], refusal);
    expect(error.message).toContain("refused");
    expect(error.message).toContain(MOBILE_FIREBASE_ENV_VARS.authEmulator);
    expect(error.refusal?.reason).toBe("environment-contradiction");
  });
});
