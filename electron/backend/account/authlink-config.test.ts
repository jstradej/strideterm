// Where a sign-in link is allowed to come back to, and what a pasted one is allowed to be.
//
// THE TWO THINGS THIS FILE IS REALLY ABOUT. The broker origin is a trust decision — it is the host
// that will be handed a live `oobCode` — so a dev, qa or prod build must not be pointable at
// another one by anything in its environment, and a build with no answer must block a NEW sign-in
// rather than fall back to prod. And the pasted-link parser is fed text out of somebody's mail
// client, so it accepts exactly one shape, unwraps exactly one level of `continueUrl`, and never
// fetches what it was given.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, test } from "vitest";

import {
  AUTHLINK_ENV_VARS,
  continueUrlFor,
  MAX_OOB_CODE_LENGTH,
  MAX_PASTED_LINK_LENGTH,
  normalizeAuthEmail,
  parseSignInLink,
  resolveAuthLinkConfig,
  sameAuthEmail,
} from "./authlink-config.js";
import { bootstrapEnvironmentFor } from "../mobile/bootstrap-trust.js";
import { MOBILE_FIREBASE_ENV_VARS, resolveMobileFirebaseConfig } from "../mobile/mobile-firebase-config.js";
import { FUNCTIONS_REGION } from "../mobile/mobile-rtdb-paths.js";

const FIREBASE = resolveMobileFirebaseConfig(
  {
    STRIDETERM_ENV: "local",
    [MOBILE_FIREBASE_ENV_VARS.projectId]: "demo-strideterm",
    [MOBILE_FIREBASE_ENV_VARS.authEmulator]: "127.0.0.1:9099",
    [MOBILE_FIREBASE_ENV_VARS.databaseEmulator]: "127.0.0.1:9000",
    [MOBILE_FIREBASE_ENV_VARS.functionsEmulator]: "127.0.0.1:5001",
  },
  FUNCTIONS_REGION,
).config!;

/** A production-shaped project: no emulator, so no plain-HTTP action handler is ever accepted. */
const PROD_FIREBASE = resolveMobileFirebaseConfig(
  {
    [MOBILE_FIREBASE_ENV_VARS.projectId]: "strideterm-mobile-prod",
    [MOBILE_FIREBASE_ENV_VARS.apiKey]: "AIza-the-real-one",
    [MOBILE_FIREBASE_ENV_VARS.databaseUrl]: "https://strideterm-mobile-prod.europe-west1.firebasedatabase.app",
  },
  FUNCTIONS_REGION,
).config!;

const ATTEMPT = "a".repeat(43);

/**
 * The production snapshot, BUILT BY THE RESOLVER rather than typed out.
 *
 * F07 asks the parser to judge a link against "konfiguraci aktuálního prostředí včetně aktuálního
 * Firebase project/API key a povolených handler hostů/cest", and a test that hand-wrote that
 * configuration would be testing the parser against a second opinion about it. This is the same object
 * a real production build gets.
 */
const PROD = resolveAuthLinkConfig({ firebase: PROD_FIREBASE, environment: "prod", env: {} }).config!;
const HANDLER = "https://strideterm-mobile-prod.firebaseapp.com/__/auth/action";
const API_KEY = "AIza-the-real-one";

/** The live shape from phase-0 row 8: apiKey, continueUrl, lang, mode=signIn, a 54-char oobCode. */
function liveLink(
  patch: {
    handler?: string;
    apiKey?: string | null;
    mode?: string | null;
    code?: string;
    inner?: string;
    extra?: string;
  } = {},
): string {
  const inner = patch.inner ?? `https://auth.strideterm.com/c?attempt=${ATTEMPT}`;
  const parts = [`continueUrl=${encodeURIComponent(inner)}`, "lang=en"];
  if (patch.apiKey !== null) parts.unshift(`apiKey=${patch.apiKey ?? API_KEY}`);
  if (patch.mode !== null) parts.push(`mode=${patch.mode ?? "signIn"}`);
  parts.push(`oobCode=${patch.code ?? "L".repeat(54)}`);
  if (patch.extra) parts.push(patch.extra);
  return `${patch.handler ?? HANDLER}?${parts.join("&")}`;
}

describe("choosing the broker origin", () => {
  test("dev, qa and prod map to their own fixed hosts", () => {
    expect(resolveAuthLinkConfig({ firebase: FIREBASE, environment: "prod", env: {} }).config?.origin).toBe(
      "https://auth.strideterm.com",
    );
    expect(resolveAuthLinkConfig({ firebase: FIREBASE, environment: "qa", env: {} }).config?.origin).toBe(
      "https://auth-qa.strideterm.com",
    );
    expect(resolveAuthLinkConfig({ firebase: FIREBASE, environment: "dev", env: {} }).config?.origin).toBe(
      "https://auth-dev.strideterm.com",
    );
  });

  test("a deployed build IGNORES the environment override entirely", () => {
    // The property this whole file exists for: nothing in the environment may point a dev, qa or
    // prod build at another broker, because that broker would receive live sign-in codes.
    for (const environment of ["dev", "qa", "prod"] as const) {
      const resolved = resolveAuthLinkConfig({
        firebase: FIREBASE,
        environment,
        env: { [AUTHLINK_ENV_VARS.devOrigin]: "https://attacker.example" },
      });
      expect(resolved.config?.origin).not.toContain("attacker");
      expect(resolved.config?.isLocal).toBe(false);
    }
  });

  test("a local build with no explicit origin gets NO broker, and does not fall back to prod", () => {
    const resolved = resolveAuthLinkConfig({ firebase: FIREBASE, environment: "local", env: {} });
    expect(resolved.config).toBeNull();
    expect(resolved.refusal).toBe("local-origin-missing");
  });

  test("a local build may use a loopback origin over plain HTTP, and nothing else may", () => {
    const local = resolveAuthLinkConfig({
      firebase: FIREBASE,
      environment: "local",
      env: { [AUTHLINK_ENV_VARS.devOrigin]: "http://127.0.0.1:8788" },
    });
    expect(local.config).toMatchObject({ environment: "local", origin: "http://127.0.0.1:8788", isLocal: true });
    // And the snapshot carries the rest of what a paste has to be judged against (F07).
    expect(local.config?.firebaseProjectId).toBe(FIREBASE.projectId);

    for (const value of ["http://auth.example.test", "ftp://127.0.0.1", "not a url", "http://127.0.0.1:8788/c"]) {
      const refused = resolveAuthLinkConfig({
        firebase: FIREBASE,
        environment: "local",
        env: { [AUTHLINK_ENV_VARS.devOrigin]: value },
      });
      expect(refused.config, value).toBeNull();
      expect(refused.refusal).toBe("local-origin-invalid");
    }
  });

  test("a local build may still use an HTTPS origin", () => {
    const resolved = resolveAuthLinkConfig({
      firebase: FIREBASE,
      environment: "local",
      env: { [AUTHLINK_ENV_VARS.devOrigin]: "https://auth-dev.example.test" },
    });
    expect(resolved.config?.origin).toBe("https://auth-dev.example.test");
  });

  test("a CONTRADICTORY declared environment blocks a new sign-in and does not fall back (F11)", () => {
    const resolved = resolveAuthLinkConfig({ firebase: FIREBASE, environment: "unresolved", env: {} });
    expect(resolved.config).toBeNull();
    expect(resolved.refusal).toBe("environment-unresolved");
  });

  test("no Firebase configuration at all means the whole hosted feature is absent", () => {
    const resolved = resolveAuthLinkConfig({ firebase: null, environment: "prod", env: {} });
    expect(resolved.config).toBeNull();
    expect(resolved.refusal).toBe("not-configured");
  });
});

describe("the continueUrl", () => {
  const config = PROD;

  test("carries the attempt id and NOTHING else", () => {
    // No address, no purpose, no uid. The address is typed again by the person on the confirmation
    // page; the purpose never leaves the desktop.
    expect(continueUrlFor(config, ATTEMPT)).toBe(`https://auth.strideterm.com/c?attempt=${ATTEMPT}`);
  });
});

describe("the pasted-link parser", () => {
  const config = PROD;

  test("accepts our own link", () => {
    expect(parseSignInLink(config, `https://auth.strideterm.com/c?attempt=${ATTEMPT}&oobCode=CODE`)).toEqual({
      attemptId: ATTEMPT,
      oobCode: "CODE",
    });
  });

  test("the parameter set the LIVE action handler produces is accepted, apiKey and lang included", () => {
    // MEASURED, not typed out from memory: phase 0 row 8 (`docs/PASSWORDLESS-PHASE0.md` in the mobile
    // repository, live run 2026-09-09) recorded the real link as `apiKey`, `continueUrl`, `lang`,
    // `mode=signIn` and a 54-character `oobCode`, with our own `/c?attempt=…` nested inside. It is
    // still accepted — F07 asks for the shapes to be pinned, and "Zachovat legitimní původní e-mailový
    // odkaz z fáze 0" in the same breath.
    const code = "L".repeat(54);
    expect(parseSignInLink(config, liveLink({ code }))).toEqual({ attemptId: ATTEMPT, oobCode: code });
    // The project's OTHER default host serves the same handler, so it is allowed too.
    const webApp = liveLink({ handler: "https://strideterm-mobile-prod.web.app/__/auth/action", code });
    expect(parseSignInLink(config, webApp)).toEqual({ attemptId: ATTEMPT, oobCode: code });
  });

  test("accepts the fixed production mail domain only for its project and environment", () => {
    const handler = "https://mail.strideterm.com/__/auth/action";
    expect(parseSignInLink(config, liveLink({ handler, code: "MAIL-CODE" }))).toEqual({
      attemptId: ATTEMPT,
      oobCode: "MAIL-CODE",
    });
    for (const environment of ["dev", "qa"] as const) {
      const other = resolveAuthLinkConfig({ firebase: PROD_FIREBASE, environment, env: {} }).config!;
      const inner = `${other.origin}/c?attempt=${ATTEMPT}`;
      expect(parseSignInLink(other, liveLink({ handler, inner }))).toBeNull();
    }
    const otherProject = resolveAuthLinkConfig({
      firebase: { ...PROD_FIREBASE, projectId: "another-project" },
      environment: "prod",
      env: {},
    }).config!;
    expect(parseSignInLink(otherProject, liveLink({ handler }))).toBeNull();
    for (const invalidHandler of [
      "http://mail.strideterm.com/__/auth/action",
      "https://mail.strideterm.com.evil.test/__/auth/action",
      "https://mail.strideterm.com/__/auth/other",
    ]) {
      expect(parseSignInLink(config, liveLink({ handler: invalidHandler }))).toBeNull();
    }
  });

  test("a nested link for ANOTHER environment is refused rather than followed", () => {
    const other = liveLink({ inner: `https://auth-qa.strideterm.com/c?attempt=${ATTEMPT}` });
    expect(parseSignInLink(config, other)).toBeNull();
  });

  test("the OUTER handler must be one this configuration names (F07)", () => {
    // This used to be deliberately open, on the grounds that a crafted wrapper can only ever produce
    // an `invalid-code`. F07 rejects that reasoning: the requirement is about which shapes the parser
    // accepts, and a parser whose outer layer is any URL cannot say it has been shown them.
    for (const handler of [
      "https://another-project.firebaseapp.com/__/auth/action",
      "https://strideterm-mobile-prod.firebaseapp.com.evil.test/__/auth/action",
      "https://strideterm-mobile-prod.firebaseapp.com/__/auth/other",
      "https://auth.example.test/__/auth/action",
      "http://strideterm-mobile-prod.firebaseapp.com/__/auth/action",
    ]) {
      expect(parseSignInLink(config, liveLink({ handler })), handler).toBeNull();
    }
  });

  test("apiKey's VALUE is never compared (security review 2026-09-13, I2) — only allowlisted handlers decide project identity", () => {
    // A link carrying a DIFFERENT project's key is still accepted: the outer handler and the nested
    // origin are the checks that matter, and a legitimate link may carry any client key (an Android
    // app's, say) of the same project, which need not equal this desktop's own configured web key.
    expect(parseSignInLink(config, liveLink({ apiKey: "AIza-somebody-elses" }))).not.toBeNull();
    // And a link with no apiKey at all is still accepted: the parameter is optional in the shape, and
    // the environment check that matters is the nested origin.
    expect(parseSignInLink(config, liveLink({ apiKey: null }))).not.toBeNull();
  });

  test("a DUPLICATED apiKey is still refused, like every other critical parameter", () => {
    expect(
      parseSignInLink(config, `https://auth.strideterm.com/c?attempt=${ATTEMPT}&oobCode=CODE&apiKey=A&apiKey=B`),
    ).toBeNull();
  });

  test("a wrong `mode` is refused at BOTH layers, and a duplicated one is not read as absent", () => {
    // THE BUG F07 NAMES. `singleParam` answered null for "absent" AND for "duplicated", and the check
    // let null through — so `?mode=signIn&mode=resetPassword` passed a test whose only job is to
    // refuse the second value.
    expect(parseSignInLink(config, liveLink({ mode: "resetPassword" }))).toBeNull();
    expect(parseSignInLink(config, liveLink({ extra: "mode=resetPassword" }))).toBeNull();
    expect(parseSignInLink(config, `${HANDLER}?mode=signIn&mode=signIn&oobCode=C`)).toBeNull();
    const innerWrongMode = liveLink({ inner: `https://auth.strideterm.com/c?attempt=${ATTEMPT}&mode=resetPassword` });
    expect(parseSignInLink(config, innerWrongMode)).toBeNull();
    const innerDuplicateMode = liveLink({
      inner: `https://auth.strideterm.com/c?attempt=${ATTEMPT}&mode=signIn&mode=resetPassword`,
    });
    expect(parseSignInLink(config, innerDuplicateMode)).toBeNull();
  });

  test("outer and inner codes that DISAGREE are a conflict, not a preference", () => {
    const conflicting = liveLink({
      code: "OUTER-CODE",
      inner: `https://auth.strideterm.com/c?attempt=${ATTEMPT}&oobCode=INNER-CODE`,
    });
    expect(parseSignInLink(config, conflicting)).toBeNull();
    // The same code at both layers is the ordinary case and is fine.
    const agreeing = liveLink({
      code: "SAME-CODE",
      inner: `https://auth.strideterm.com/c?attempt=${ATTEMPT}&oobCode=SAME-CODE`,
    });
    expect(parseSignInLink(config, agreeing)).toEqual({ attemptId: ATTEMPT, oobCode: "SAME-CODE" });
  });

  test("a second layer of nesting is excessive depth, not something to follow", () => {
    const doubled = liveLink({
      inner:
        `https://auth.strideterm.com/c?attempt=${ATTEMPT}&continueUrl=` +
        encodeURIComponent(`https://auth.strideterm.com/c?attempt=${"b".repeat(43)}`),
    });
    expect(parseSignInLink(config, doubled)).toBeNull();
  });

  test("more than one layer of URL ENCODING does not smuggle a shape through", () => {
    // A doubly-encoded `continueUrl` decodes to a string that is not a URL of ours, so the inner
    // origin check refuses it — asserted rather than assumed, because "it cannot happen" is what the
    // duplicate-`mode` hole looked like too.
    const inner = `https://auth.strideterm.com/c?attempt=${ATTEMPT}`;
    const doubled = `${HANDLER}?apiKey=${API_KEY}&mode=signIn&oobCode=C&continueUrl=${encodeURIComponent(encodeURIComponent(inner))}`;
    expect(parseSignInLink(config, doubled)).toBeNull();
  });

  test("an inner apiKey for another project is accepted, not refused (I2)", () => {
    const inner = `https://auth.strideterm.com/c?attempt=${ATTEMPT}&apiKey=AIza-somebody-elses`;
    expect(parseSignInLink(config, liveLink({ inner }))).not.toBeNull();
  });

  test("a DUPLICATED inner apiKey is still refused, like every other critical parameter", () => {
    const inner = `https://auth.strideterm.com/c?attempt=${ATTEMPT}&apiKey=A&apiKey=B`;
    expect(parseSignInLink(config, liveLink({ inner }))).toBeNull();
  });

  test("a LOCAL build accepts the emulator's own handler, and a prod build never does", () => {
    // Configuration A pastes exactly this link (the emulator-only procedure, written out in
    // `docs/PASSWORDLESS-LOCAL-TESTING.md` in the cloud repository), and the emulator serves it over
    // plain HTTP on a loopback port — which is why it is gated on the declared environment rather
    // than on the shape of the URL.
    const local = resolveAuthLinkConfig({
      firebase: FIREBASE,
      environment: "local",
      env: { [AUTHLINK_ENV_VARS.devOrigin]: "http://localhost:8788" },
    }).config!;
    const emulatorLink =
      "http://127.0.0.1:9099/emulator/action?mode=signIn&oobCode=EMU-CODE&continueUrl=" +
      encodeURIComponent(`http://localhost:8788/c?attempt=${ATTEMPT}`);
    expect(parseSignInLink(local, emulatorLink)).toEqual({ attemptId: ATTEMPT, oobCode: "EMU-CODE" });
    // The same link on a prod configuration is refused by the handler allowlist.
    expect(parseSignInLink(config, emulatorLink)).toBeNull();
  });

  test("a CUSTOM action domain is accepted only when somebody named it, and never in prod", () => {
    const qa = resolveAuthLinkConfig({
      firebase: FIREBASE,
      environment: "qa",
      env: { [AUTHLINK_ENV_VARS.actionDomains]: "https://auth-action.example.test" },
    }).config!;
    const custom = liveLink({
      handler: "https://auth-action.example.test/__/auth/action",
      apiKey: FIREBASE.apiKey,
      inner: `https://auth-qa.strideterm.com/c?attempt=${ATTEMPT}`,
    });
    expect(parseSignInLink(qa, custom)).not.toBeNull();
    // Prod ignores the variable entirely, exactly as it ignores the local origin.
    const prodWithVariable = resolveAuthLinkConfig({
      firebase: PROD_FIREBASE,
      environment: "prod",
      env: { [AUTHLINK_ENV_VARS.actionDomains]: "https://auth-action.example.test" },
    }).config!;
    expect(prodWithVariable.actionHandlers.some((handler) => handler.origin.includes("example.test"))).toBe(false);
  });

  test("this module cannot fetch anything, which is the one property a behaviour test cannot show", () => {
    // "Nikdy načtenou URL sám nenavštěvuje" (plan §"Záložní ruční vložení odkazu"), and F05's "Nepřidávat
    // fetch libovolných URL získaných z e-mailu". Every other assertion in this file is about what the
    // parser RETURNS; this one is about what it must never do, and an absence is not observable from a
    // return value. So it is a source-shape check — deliberately, and narrowly: no outbound call of any
    // kind appears in a module whose whole input is text out of somebody's mail client.
    //
    // The plan warns against tests that only look for strings in the source. That warning is about
    // using one INSTEAD of a behavioural test, and every rule this parser enforces is exercised above.
    const source = readFileSync(resolve(process.cwd(), "electron/backend/account/authlink-config.ts"), "utf8");
    for (const forbidden of ["fetch(", "XMLHttpRequest", "http.request", "https.request", "openExternal", "shell."]) {
      expect(source, forbidden).not.toContain(forbidden);
    }
  });

  test("no error path prints the code or the link", () => {
    // F07: "Nové error cesty nesmějí vypsat kód ani celý link." The parser answers `null` — it has no
    // error object and no logger — so the property is that it RETURNS rather than throws, for every
    // refusal above. A thrown error would carry a stack, and a stack in this file would carry the URL.
    for (const value of [
      `https://auth.strideterm.com/c?attempt=${ATTEMPT}&oobCode=CODE&apiKey=A&apiKey=B`,
      liveLink({ mode: "resetPassword" }),
      liveLink({ handler: "https://another-project.firebaseapp.com/__/auth/action" }),
      `${HANDLER}?oobCode=A&oobCode=B`,
    ]) {
      expect(() => parseSignInLink(config, value)).not.toThrow();
      expect(parseSignInLink(config, value)).toBeNull();
    }
  });

  test("a link from another origin, another path or another mode is refused", () => {
    for (const value of [
      `https://auth-qa.strideterm.com/c?attempt=${ATTEMPT}&oobCode=CODE`,
      `https://auth.strideterm.com.evil.test/c?attempt=${ATTEMPT}&oobCode=CODE`,
      `https://auth.strideterm.com/other?attempt=${ATTEMPT}&oobCode=CODE`,
      `https://auth.strideterm.com/c?attempt=${ATTEMPT}&oobCode=CODE&mode=resetPassword`,
      `http://auth.strideterm.com/c?attempt=${ATTEMPT}&oobCode=CODE`,
    ]) {
      expect(parseSignInLink(config, value), value).toBeNull();
    }
  });

  test("a DUPLICATED critical parameter is refused, not resolved", () => {
    // Not something a mail client produces; something somebody builds. Every parser that quietly
    // picks one picks a different one from the parser downstream of it.
    expect(
      parseSignInLink(config, `https://auth.strideterm.com/c?attempt=${ATTEMPT}&attempt=${"b".repeat(43)}&oobCode=C`),
    ).toBeNull();
    expect(parseSignInLink(config, `https://auth.strideterm.com/c?attempt=${ATTEMPT}&oobCode=A&oobCode=B`)).toBeNull();
  });

  test("a malformed attempt id, an empty code and an over-long paste are refused", () => {
    expect(parseSignInLink(config, "https://auth.strideterm.com/c?attempt=short&oobCode=C")).toBeNull();
    expect(parseSignInLink(config, `https://auth.strideterm.com/c?attempt=${ATTEMPT}&oobCode=`)).toBeNull();
    expect(parseSignInLink(config, `https://auth.strideterm.com/c?attempt=${ATTEMPT}`)).toBeNull();
    const huge = `https://auth.strideterm.com/c?attempt=${ATTEMPT}&oobCode=${"x".repeat(5000)}`;
    expect(parseSignInLink(config, huge)).toBeNull();
    // The CODE's own bound, separately from the paste's: this link is well under
    // `MAX_PASTED_LINK_LENGTH`, so only `MAX_OOB_CODE_LENGTH` can refuse it.
    const longCode = `https://auth.strideterm.com/c?attempt=${ATTEMPT}&oobCode=${"x".repeat(MAX_OOB_CODE_LENGTH + 1)}`;
    expect(longCode.length).toBeLessThan(MAX_PASTED_LINK_LENGTH);
    expect(parseSignInLink(config, longCode)).toBeNull();
    const atTheLimit = `https://auth.strideterm.com/c?attempt=${ATTEMPT}&oobCode=${"x".repeat(MAX_OOB_CODE_LENGTH)}`;
    expect(parseSignInLink(config, atTheLimit)?.oobCode).toHaveLength(MAX_OOB_CODE_LENGTH);
  });

  test("rubbish is refused rather than half-parsed", () => {
    // eslint-disable-next-line no-script-url -- the point of the case is that a script URL is refused
    const scriptUrl = "javascript:alert(1)";
    for (const value of ["", "   ", "not a url", scriptUrl, "//auth.strideterm.com/c"]) {
      expect(parseSignInLink(config, value), value).toBeNull();
    }
    expect(parseSignInLink(config, 42 as unknown as string)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// F10 — the documented procedure has to be one this build accepts
// ---------------------------------------------------------------------------
//
// THE OTHER HALF OF THE STATIC CONFIGURATION TEST. The cloud repository's
// `check-authlink-local-config.mjs` compares the two documented configurations against the Worker's
// own vars and the dev `google-services.json`; it cannot see this build's resolver. This does: every
// broker origin `docs/development.md` tells somebody to export is fed to `resolveAuthLinkConfig`, and
// a documented value the resolver refuses fails here rather than at the person's keyboard.
describe("a contradictory Firebase configuration blocks a new sign-in with its own reason (R06)", () => {
  test("no Firebase config BECAUSE it was refused is `environment-contradiction`, not `not-configured`", () => {
    const refused = resolveAuthLinkConfig({
      firebase: null,
      environment: "qa",
      env: {},
      firebaseRefusal: { reason: "environment-contradiction" },
    });
    expect(refused.config).toBeNull();
    expect(refused.refusal).toBe("environment-contradiction");
    // Without a refusal, null Firebase is still what it always was: nothing configured at all.
    expect(resolveAuthLinkConfig({ firebase: null, environment: "qa", env: {} }).refusal).toBe("not-configured");
  });
});

describe("the documented local procedure agrees with the resolver", () => {
  const documentation = readFileSync(resolve(process.cwd(), "docs/development.md"), "utf8");

  test("every documented broker origin is one a local build accepts", () => {
    const documented = [...documentation.matchAll(/STRIDETERM_MOBILE_AUTHLINK_ORIGIN\s*=\s*"([^"]+)"/g)].map(
      (match) => match[1]!,
    );
    // The section exists, and it names at least one origin. A regex that matched nothing would make
    // every assertion below vacuous.
    expect(documented.length).toBeGreaterThan(0);
    for (const origin of documented) {
      const resolved = resolveAuthLinkConfig({
        firebase: FIREBASE,
        environment: "local",
        env: { [AUTHLINK_ENV_VARS.devOrigin]: origin },
      });
      expect(resolved.refusal, origin).toBeNull();
      expect(resolved.config?.origin, origin).toBe(origin);
    }
  });

  test("the documented environment declaration is one this build recognises", () => {
    // F11's variable, and its values. A document naming `staging` would send somebody to a build
    // whose sign-in refuses with `environment-unresolved`.
    const declared = [...documentation.matchAll(/STRIDETERM_ENV\s*=\s*"([^"]+)"/g)].map((match) => match[1]!);
    expect(declared.length).toBeGreaterThan(0);
    for (const value of declared) {
      expect(bootstrapEnvironmentFor({ STRIDETERM_ENV: value } as NodeJS.ProcessEnv), value).not.toBe("unresolved");
    }
  });

  test("`dev.ps1` declares the environment rather than leaving it to be inferred", () => {
    // The script is what a developer actually runs, and F11's whole point is that setting a data
    // directory is not a declaration. If this line goes, a bare `dev.ps1` resolves to whatever
    // `STRIDETERM_ENV` happened to already be set to in the shell, rather than to `local`.
    const script = readFileSync(resolve(process.cwd(), "dev.ps1"), "utf8");
    expect(script).toContain("$env:STRIDETERM_ENV = 'local'");
  });

  test("the documented procedure does not tell a local build to use the prod broker", () => {
    // "Neopravovat nesoulad vypnutím allowlistu nebo automatickým přechodem na produkční broker."
    const section = documentation.slice(documentation.indexOf("### Exercising passwordless sign-in"));
    expect(section).not.toContain('STRIDETERM_MOBILE_AUTHLINK_ORIGIN = "https://auth.strideterm.com"');
    expect(section).toContain("Do not point a local build at the prod broker");
  });
});

describe("the shared email normalisation", () => {
  test("folds the DOMAIN and leaves the local part exactly as typed", () => {
    // Byte-for-byte the rule in `authlink/worker/src/attempt-core.ts`. Two implementations of one
    // rule is a drift risk; the desktop taking the broker's word for the address would be worse.
    expect(normalizeAuthEmail("  Person.Name+tag@Example.COM  ")).toBe("Person.Name+tag@example.com");
    expect(normalizeAuthEmail("a.b.c+x@d.test")).toBe("a.b.c+x@d.test");
  });

  test("two spellings differing only in case are the SAME address, and neither is rewritten", () => {
    // Phase-0 row 36, observed: the Identity Toolkit lowercases the whole address. So the comparison
    // is case-insensitive — and `normalizeAuthEmail`, which is what `sendOobCode` is called with,
    // still leaves the local part exactly as typed rather than choosing a mailbox on Firebase's
    // behalf.
    expect(sameAuthEmail("Person.Case@example.test", "person.case@example.test")).toBe(true);
    expect(sameAuthEmail("person@example.test", "person@example.test")).toBe(true);
    expect(sameAuthEmail("person@example.test", "someone@example.test")).toBe(false);
    // A `+tag` and a dot are part of the address and are NOT folded away: that would be inventing a
    // mailbox merge, which is a different thing from ignoring case.
    expect(sameAuthEmail("person+one@example.test", "person@example.test")).toBe(false);
    expect(sameAuthEmail("first.last@example.test", "firstlast@example.test")).toBe(false);
    expect(normalizeAuthEmail("Person.Case@Example.TEST")).toBe("Person.Case@example.test");
  });

  test("refuses anything that is not one ordinary address", () => {
    for (const value of ["a b@c.test", "a@b@c.test", "a@", "@b.test", "", "a@b", `${"a".repeat(320)}@b.test`]) {
      expect(normalizeAuthEmail(value), value).toBeNull();
    }
    for (const value of [null, undefined, 42, {}]) expect(normalizeAuthEmail(value)).toBeNull();
  });
});
