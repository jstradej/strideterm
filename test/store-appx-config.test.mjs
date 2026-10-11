import assert from "node:assert/strict";
import test from "node:test";

import { readStoreIdentity, STORE_IDENTITY_ENV } from "../scripts/store-appx-config.mjs";

test("Store identity is skipped only when all repository variables are absent", () => {
  assert.deepEqual(readStoreIdentity({}), { status: "skipped" });
});

test("required Store identity fails when all variables are absent", () => {
  assert.throws(() => readStoreIdentity({ MS_STORE_REQUIRE_IDENTITY: "true" }), /identity is required/);
});

test("partial Store identity configuration fails with missing variable names", () => {
  assert.throws(
    () => readStoreIdentity({ MS_STORE_IDENTITY_NAME: "example" }),
    (error) => error.message.includes(STORE_IDENTITY_ENV[1]) && error.message.includes(STORE_IDENTITY_ENV[2]),
  );
});

test("complete Store identity is mapped to electron-builder fields", () => {
  assert.deepEqual(
    readStoreIdentity({
      MS_STORE_IDENTITY_NAME: "Example.Product",
      MS_STORE_PUBLISHER: "CN=Example Publisher",
      MS_STORE_PUBLISHER_DISPLAY_NAME: "Example Publisher",
    }),
    {
      status: "configured",
      identity: {
        identityName: "Example.Product",
        publisher: "CN=Example Publisher",
        publisherDisplayName: "Example Publisher",
      },
    },
  );
});

test("explicit validation identity is accepted", () => {
  assert.equal(
    readStoreIdentity({
      MS_STORE_IDENTITY_NAME: "strIDEterm.BuildValidation",
      MS_STORE_PUBLISHER: "CN=strIDEterm Build Validation",
      MS_STORE_PUBLISHER_DISPLAY_NAME: "strIDEterm Build Validation",
    }).status,
    "configured",
  );
});

test("placeholder and test identities fail closed", () => {
  assert.throws(
    () =>
      readStoreIdentity({
        MS_STORE_IDENTITY_NAME: "Example.Product",
        MS_STORE_PUBLISHER: "CN=strIDEterm Test",
        MS_STORE_PUBLISHER_DISPLAY_NAME: "Example Publisher",
      }),
    /placeholder or test values/,
  );
});
