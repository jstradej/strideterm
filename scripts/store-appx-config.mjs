export const STORE_IDENTITY_ENV = Object.freeze([
  "MS_STORE_IDENTITY_NAME",
  "MS_STORE_PUBLISHER",
  "MS_STORE_PUBLISHER_DISPLAY_NAME",
]);

export function readStoreIdentity(environment = process.env) {
  const values = STORE_IDENTITY_ENV.map((name) => [name, environment[name]?.trim() ?? ""]);
  const configured = values.filter(([, value]) => value.length > 0);

  if (configured.length === 0) {
    if (environment.MS_STORE_REQUIRE_IDENTITY === "true") {
      throw new Error(
        `Microsoft Store identity is required; set all three repository variables: ${STORE_IDENTITY_ENV.join(", ")}`,
      );
    }
    return { status: "skipped" };
  }

  const missing = values.filter(([, value]) => value.length === 0).map(([name]) => name);
  if (missing.length > 0) {
    throw new Error(
      `Incomplete Microsoft Store identity configuration; set all three repository variables: ${missing.join(", ")}`,
    );
  }

  const identity = Object.fromEntries(values);
  const forbiddenValues = new Set([
    "placeholder",
    "changeme",
    "cn=ms",
    "stridetermtest",
    "cn=strideterm test",
    "strideterm test",
  ]);
  const invalid = values.filter(([, value]) => forbiddenValues.has(value.toLowerCase())).map(([name]) => name);
  if (invalid.length > 0) {
    throw new Error(`Microsoft Store identity contains placeholder or test values: ${invalid.join(", ")}`);
  }

  return {
    status: "configured",
    identity: {
      identityName: identity.MS_STORE_IDENTITY_NAME,
      publisher: identity.MS_STORE_PUBLISHER,
      publisherDisplayName: identity.MS_STORE_PUBLISHER_DISPLAY_NAME,
    },
  };
}
