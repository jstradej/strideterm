/**
 * `dev.ps1`'s `Import-MobileFirebaseDevConfig`, run for real, against the resolver it feeds.
 *
 * WHY THIS EXISTS. Follow-up F10 asks that each documented local configuration "unify the project,
 * the API key and the exact auth origin between the desktop and the Worker". The desktop's half of
 * those three values does not come from a source file — it comes from this launcher, which imports
 * them from the dev `google-services.json`. It used to import them ONE AT A TIME, so the
 * emulator-only procedure (which overrides the project id) kept the real dev project's Web API key
 * and RTDB instance: the desktop addressed a `demo-` project with the live project's key, the
 * sign-in link carried that key, and the local broker refused it as another environment's. A
 * string-existence check on the script would not have caught that; what follows runs the function.
 *
 * HOW. The function is extracted from `dev.ps1` by brace matching and dot-sourced into a harness
 * script, because `dev.ps1` itself starts a build watcher and Electron. It is the real body from the
 * real file — if the function is renamed the extraction fails loudly rather than passing vacuously.
 * The test is skipped where `pwsh` is absent (PowerShell 7 is cross-platform, but not universal).
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { bootstrapEnvironmentFor } from "./bootstrap-trust.js";
import { MOBILE_FIREBASE_ENV_VARS, resolveMobileFirebaseConfig } from "./mobile-firebase-config.js";
import { FUNCTIONS_REGION } from "./mobile-rtdb-paths.js";

const FUNCTION_NAME = "Import-MobileFirebaseDevConfig";

/** The three variables the function owns, and the only ones the harness reports back. */
const IMPORTED_VARS = [
  MOBILE_FIREBASE_ENV_VARS.projectId,
  MOBILE_FIREBASE_ENV_VARS.apiKey,
  MOBILE_FIREBASE_ENV_VARS.databaseUrl,
] as const;

/** The fixture project, deliberately none of the real ones. */
const FIXTURE = {
  project_info: {
    project_id: "fixture-project",
    firebase_url: "https://fixture-project-default-rtdb.europe-west1.firebasedatabase.app",
  },
  client: [{ api_key: [{ current_key: "AIza-fixture-key" }] }],
};

const pwshAvailable = spawnSync("pwsh", ["-NoProfile", "-Command", "exit 0"], { shell: false }).status === 0;

function stringValues(vars: Record<string, string | null>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(vars).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

/** The body of one `function <name> { … }` from a PowerShell script, by matching braces. */
function extractFunction(script: string, name: string): string {
  const header = `function ${name} {`;
  const start = script.indexOf(header);
  if (start < 0) throw new Error(`dev.ps1 no longer defines ${name}`);
  let depth = 0;
  for (let index = start + header.length - 1; index < script.length; index += 1) {
    const char = script[index];
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return script.slice(start, index + 1);
    }
  }
  throw new Error(`unbalanced braces in ${name}`);
}

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/**
 * Runs the extracted function with `env` pre-set, and reports the three variables afterwards.
 *
 * `Write-Warn`/`Write-Ok` are the script's own host-writing helpers; they are stubbed to a prefix so
 * the harness's own result line stays distinguishable from them. `configPath` is the launcher's
 * `-MobileFirebaseConfigPath`: the fixture file by default, `null` for a console that named none.
 *
 * A function that THROWS — which is what a refused configuration does (R06) — ends the harness with a
 * non-zero status and no result line; `vars` is then null and `output` carries the error text.
 */
function runImport(
  env: Record<string, string>,
  options: {
    configPath?: string | null;
    fixture?: { project_info: { project_id: string; firebase_url?: string }; client: typeof FIXTURE.client };
  } = {},
): { vars: Record<string, string | null> | null; output: string; status: number | null } {
  const root = mkdtempSync(join(tmpdir(), "dev-ps1-firebase-"));
  roots.push(root);
  const fixturePath = join(root, "google-services.json");
  writeFileSync(fixturePath, JSON.stringify(options.fixture ?? FIXTURE), "utf8");
  const configPath = options.configPath === undefined ? fixturePath : options.configPath;

  const body = extractFunction(readFileSync(resolve(process.cwd(), "dev.ps1"), "utf8"), FUNCTION_NAME);
  const preset = Object.entries(env)
    .map(([name, value]) => `$env:${name} = ${JSON.stringify(value)}`)
    .join("\n");
  const harness = [
    "$ErrorActionPreference = 'Stop'",
    "Set-StrictMode -Version Latest",
    'function Write-Ok($msg) { Write-Host "LOG $msg" }',
    'function Write-Warn($msg) { Write-Host "LOG $msg" }',
    // The launcher's own defaults for the variables the function reads: none of them leaks in from
    // the machine running the tests.
    "Remove-Item Env:STRIDETERM_ENV -ErrorAction SilentlyContinue",
    "Remove-Item Env:STRIDETERM_BOOTSTRAP_URL -ErrorAction SilentlyContinue",
    "Remove-Item Env:STRIDETERM_BOOTSTRAP_TRUST_KEYS -ErrorAction SilentlyContinue",
    ...IMPORTED_VARS.map((name) => `Remove-Item Env:${name} -ErrorAction SilentlyContinue`),
    `$MobileFirebaseConfigPath = ${configPath === null ? "$null" : JSON.stringify(configPath)}`,
    preset,
    body,
    FUNCTION_NAME,
    // A variable the function left unset must read back as null rather than as the empty string, so
    // "not imported" and "imported as empty" cannot look the same.
    "$result = [ordered]@{",
    ...IMPORTED_VARS.map((name) => `  '${name}' = [Environment]::GetEnvironmentVariable('${name}', 'Process')`),
    "}",
    "Write-Host ('RESULT ' + ($result | ConvertTo-Json -Compress))",
  ].join("\n");
  const harnessPath = join(root, "harness.ps1");
  writeFileSync(harnessPath, harness, "utf8");

  const run = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-File", harnessPath], {
    encoding: "utf8",
    cwd: root,
  });
  const output = `${run.stdout ?? ""}\n${run.stderr ?? ""}`;
  const line = output.split(/\r?\n/).find((candidate) => candidate.startsWith("RESULT "));
  if (!line) {
    if (run.status === 0) throw new Error(`harness produced no result line:\n${output}`);
    return { vars: null, output, status: run.status };
  }
  return {
    vars: JSON.parse(line.slice("RESULT ".length)) as Record<string, string | null>,
    output,
    status: run.status,
  };
}

/** The `env` a documented PowerShell block assigns, plus whether it names the config file. */
function documentedBlock(
  markdown: string,
  heading: string,
  environment: string,
): { env: Record<string, string>; namesConfigFile: boolean } {
  const section = markdown.slice(markdown.indexOf(heading));
  const fence = [...section.matchAll(/```powershell\r?\n([\s\S]*?)```/g)].find((match) =>
    match[1]?.includes(`$env:STRIDETERM_ENV = "${environment}"`),
  );
  if (!fence) throw new Error(`${heading}: no powershell block for ${environment}`);
  const env: Record<string, string> = {};
  for (const match of fence[1]!.matchAll(/\$env:([A-Z_0-9]+)\s*=\s*"([^"]*)"/g)) env[match[1]!] = match[2]!;
  return { env, namesConfigFile: /-MobileFirebaseConfigPath\s+"/.test(fence[1]!) };
}

describe.skipIf(!pwshAvailable)("dev.ps1 imports one Firebase project, or none of it", () => {
  test("with nothing pre-set, all three values come from the file", () => {
    const { vars } = runImport({});
    expect(vars![MOBILE_FIREBASE_ENV_VARS.projectId]).toBe("fixture-project");
    expect(vars![MOBILE_FIREBASE_ENV_VARS.apiKey]).toBe("AIza-fixture-key");
    expect(vars![MOBILE_FIREBASE_ENV_VARS.databaseUrl]).toBe(FIXTURE.project_info.firebase_url);
  });

  test("a QA Android config without firebase_url derives the default database instance", () => {
    const { vars, status } = runImport(
      { STRIDETERM_ENV: "qa" },
      { fixture: { ...FIXTURE, project_info: { project_id: "fixture-project" } } },
    );
    expect(status).toBe(0);
    expect(vars).toMatchObject({
      [MOBILE_FIREBASE_ENV_VARS.projectId]: "fixture-project",
      [MOBILE_FIREBASE_ENV_VARS.apiKey]: "AIza-fixture-key",
      [MOBILE_FIREBASE_ENV_VARS.databaseUrl]: null,
    });
    const { config } = resolveMobileFirebaseConfig({ STRIDETERM_ENV: "qa", ...stringValues(vars!) }, FUNCTIONS_REGION);
    expect(config?.databaseUrl).toBe("https://fixture-project-default-rtdb.europe-west1.firebasedatabase.app");
  });

  test("a malformed named QA config stops before Electron starts", () => {
    const { status, vars, output } = runImport(
      { STRIDETERM_ENV: "qa" },
      { fixture: { ...FIXTURE, client: [{ api_key: [{ current_key: "" }] }] } },
    );
    expect(status).not.toBe(0);
    expect(vars).toBeNull();
    expect(output).toContain("client api_key is missing");
  });

  test("a DIFFERENT project id imports neither the key nor the database URL", () => {
    // The regression F10 was filed for. The emulator-only procedure names a `demo-` project; the
    // file beside the repository describes the live dev one.
    const { vars, output } = runImport({ [MOBILE_FIREBASE_ENV_VARS.projectId]: "demo-strideterm-mobile-local" });
    expect(vars![MOBILE_FIREBASE_ENV_VARS.projectId]).toBe("demo-strideterm-mobile-local");
    expect(vars![MOBILE_FIREBASE_ENV_VARS.apiKey]).toBeNull();
    expect(vars![MOBILE_FIREBASE_ENV_VARS.databaseUrl]).toBeNull();
    // And it says so, naming both variables the caller now has to set itself.
    expect(output).toContain(MOBILE_FIREBASE_ENV_VARS.apiKey);
    expect(output).toContain(MOBILE_FIREBASE_ENV_VARS.databaseUrl);
  });

  test("DEV with a signed bootstrap starts without importing Firebase credentials", () => {
    const result = runImport(
      {
        STRIDETERM_ENV: "dev",
        STRIDETERM_BOOTSTRAP_URL: "https://bootstrap.example.test/dev.json",
        STRIDETERM_BOOTSTRAP_TRUST_KEYS: "dev-test=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      },
      { configPath: null },
    );
    expect(result.status).toBe(0);
    for (const name of IMPORTED_VARS) expect(result.vars?.[name]).toBeNull();
  });

  test("the effective configuration is then the demo project's, never the live project's key", () => {
    // The point of the previous case, carried through to the value that actually goes on the wire:
    // `identityToolkitUrl` puts this key in the `sendOobCode` request, Firebase echoes it into the
    // link, and the broker compares it. A live key here is what `GET /c` refuses.
    const { vars } = runImport({ [MOBILE_FIREBASE_ENV_VARS.projectId]: "demo-strideterm-mobile-local" });
    const env = Object.fromEntries(
      Object.entries(vars!).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    );
    const { config } = resolveMobileFirebaseConfig(
      {
        ...env,
        STRIDETERM_ENV: "local",
        [MOBILE_FIREBASE_ENV_VARS.authEmulator]: "127.0.0.1:9099",
        [MOBILE_FIREBASE_ENV_VARS.databaseEmulator]: "127.0.0.1:9000",
        [MOBILE_FIREBASE_ENV_VARS.functionsEmulator]: "127.0.0.1:5001",
      },
      FUNCTIONS_REGION,
    );
    expect(config?.projectId).toBe("demo-strideterm-mobile-local");
    expect(config?.apiKey).not.toBe("AIza-fixture-key");
    expect(config?.apiKey).toBe("emulator-api-key");
  });

  test("the SAME project id still has its key and database URL filled in", () => {
    // Not a blanket refusal to import: one project's file describing that project is exactly what
    // this function is for.
    const { vars } = runImport({ [MOBILE_FIREBASE_ENV_VARS.projectId]: "fixture-project" });
    expect(vars![MOBILE_FIREBASE_ENV_VARS.apiKey]).toBe("AIza-fixture-key");
    expect(vars![MOBILE_FIREBASE_ENV_VARS.databaseUrl]).toBe(FIXTURE.project_info.firebase_url);
  });

  test("a complete environment is left exactly as it was", () => {
    const supplied = {
      [MOBILE_FIREBASE_ENV_VARS.projectId]: "demo-strideterm-mobile-local",
      [MOBILE_FIREBASE_ENV_VARS.apiKey]: "local-api-key",
      [MOBILE_FIREBASE_ENV_VARS.databaseUrl]: "http://127.0.0.1:9000?ns=demo-strideterm-mobile-local-default-rtdb",
    };
    expect(runImport(supplied).vars).toMatchObject(supplied);
  });
});

/**
 * The qa procedure `docs/development.md` documents, run against the launcher and the resolver (R06).
 * "Testovat výslednou konfiguraci launcheru/resolveru podle skutečných dokumentovaných příkazů: čistý
 * staging [now: qa], A → B [B no longer exists, see below], staging + emulator hosts, staging +
 * explicitní HTTP DB." The environment-naming migration (plan §2.1) removed configuration B — the
 * real dev project reached through a locally-run Worker — as a supported diagnostic mode, so the
 * "A → B" case this section used to cover no longer has a B to switch to.
 */
describe.skipIf(!pwshAvailable)("switching environments is unambiguous (R06)", () => {
  const documentation = readFileSync(resolve(process.cwd(), "docs/development.md"), "utf8");
  const qa = documentedBlock(documentation, "#### Running against dev, qa or prod", "qa");

  test("the document declares qa and names the config file, and nothing else", () => {
    expect(qa.env).toEqual({ STRIDETERM_ENV: "qa" });
    expect(qa.namesConfigFile).toBe(true);
  });

  test("a CLEAN qa console with no file named is refused before Electron starts, naming the three variables", () => {
    // `STRIDETERM_ENV=qa` alone used to import the DEV project's file under the old vocabulary: a qa
    // broker, dev Firebase. Now nothing is imported and the launcher stops.
    const { vars, status, output } = runImport({ STRIDETERM_ENV: "qa" }, { configPath: null });
    expect(status).not.toBe(0);
    expect(vars).toBeNull();
    for (const name of IMPORTED_VARS) expect(output).toContain(name);
    expect(output).toContain("MobileFirebaseConfigPath");
  });

  test("the documented qa command imports the NAMED file, and the resolver then reaches HTTPS endpoints only", () => {
    const { vars, status } = runImport(qa.env);
    expect(status).toBe(0);
    expect(vars).toMatchObject({
      [MOBILE_FIREBASE_ENV_VARS.projectId]: "fixture-project",
      [MOBILE_FIREBASE_ENV_VARS.apiKey]: "AIza-fixture-key",
      [MOBILE_FIREBASE_ENV_VARS.databaseUrl]: FIXTURE.project_info.firebase_url,
    });
    const env = { ...qa.env, ...stringValues(vars!) } as NodeJS.ProcessEnv;
    expect(bootstrapEnvironmentFor(env)).toBe("qa");
    const { config, refusal } = resolveMobileFirebaseConfig(env, FUNCTIONS_REGION);
    expect(refusal).toBeNull();
    expect(config?.emulators).toBeNull();
    expect(config?.databaseUrl).toMatch(/^https:/);
  });

  test("a NAMED file that does not exist is a refusal too, not a warning and a start", () => {
    const { status, vars, output } = runImport(
      { STRIDETERM_ENV: "qa" },
      { configPath: "C:/nowhere/google-services.json" },
    );
    expect(status).not.toBe(0);
    expect(vars).toBeNull();
    expect(output).toContain("was not found");
  });

  test("qa with the three variables supplied and no file starts with exactly those", () => {
    const supplied = {
      STRIDETERM_ENV: "qa",
      [MOBILE_FIREBASE_ENV_VARS.projectId]: "restored-qa-project",
      [MOBILE_FIREBASE_ENV_VARS.apiKey]: "AIza-restored",
      [MOBILE_FIREBASE_ENV_VARS.databaseUrl]:
        "https://restored-qa-project-default-rtdb.europe-west1.firebasedatabase.app",
    };
    const { vars, status } = runImport(supplied, { configPath: null });
    expect(status).toBe(0);
    const { STRIDETERM_ENV: _declared, ...firebase } = supplied;
    expect(vars).toEqual(firebase);
  });

  test("qa + configuration A's emulator hosts: the launcher passes them on and the RESOLVER refuses the whole configuration", () => {
    // The documented qa command typed into a console that still carries A. The launcher's job is the
    // three Firebase values; the contradiction is the resolver's to refuse, and it does so before any
    // client — and therefore any sign-in mail — exists.
    const leftover = {
      [MOBILE_FIREBASE_ENV_VARS.authEmulator]: "127.0.0.1:9099",
      [MOBILE_FIREBASE_ENV_VARS.databaseEmulator]: "127.0.0.1:9000",
      [MOBILE_FIREBASE_ENV_VARS.functionsEmulator]: "127.0.0.1:5001",
    };
    const { vars, status } = runImport({ ...qa.env, ...leftover });
    expect(status).toBe(0);
    const env = { ...qa.env, ...leftover, ...stringValues(vars!) } as NodeJS.ProcessEnv;
    const { config, refusal } = resolveMobileFirebaseConfig(env, FUNCTIONS_REGION);
    expect(config).toBeNull();
    expect(refusal?.reason).toBe("environment-contradiction");
    expect(refusal?.detail).toContain(MOBILE_FIREBASE_ENV_VARS.authEmulator);
  });

  test("qa + configuration A's explicit HTTP database URL: refused, whichever half supplied it", () => {
    // The launcher keeps a database URL it finds set (a complete environment is left alone), so A's
    // `http://127.0.0.1:9000?ns=…` survives into a qa console. The resolver is what stops it.
    const { vars, status } = runImport({
      ...qa.env,
      [MOBILE_FIREBASE_ENV_VARS.projectId]: "fixture-project",
      [MOBILE_FIREBASE_ENV_VARS.apiKey]: "AIza-fixture-key",
      [MOBILE_FIREBASE_ENV_VARS.databaseUrl]: "http://127.0.0.1:9000?ns=demo-strideterm-mobile-local-default-rtdb",
    });
    expect(status).toBe(0);
    const env = { ...qa.env, ...stringValues(vars!) } as NodeJS.ProcessEnv;
    const { config, refusal } = resolveMobileFirebaseConfig(env, FUNCTIONS_REGION);
    expect(config).toBeNull();
    expect(refusal?.reason).toBe("environment-contradiction");
    expect(refusal?.detail).toContain(MOBILE_FIREBASE_ENV_VARS.databaseUrl);
  });
});

test("pwsh is what runs the launcher, and the launcher still defines the function", () => {
  // The gate above skips where `pwsh` is absent; this one keeps the extraction itself covered
  // everywhere, so a rename of the function cannot pass unnoticed on a machine without PowerShell.
  const script = readFileSync(resolve(process.cwd(), "dev.ps1"), "utf8");
  expect(() => extractFunction(script, FUNCTION_NAME)).not.toThrow();
  expect(extractFunction(script, FUNCTION_NAME)).toContain(MOBILE_FIREBASE_ENV_VARS.apiKey);
});
