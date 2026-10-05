/**
 * The stores call the transport as CallableTransport, so every payload is
 * type-checked against the IPC bridge types (z.infer of the main process's
 * zod schemas). They used to cast it to `any`, which is how Approve sent
 * String(vote) and Resolve sent String(threadId) for months: the handler's
 * z.number() refused both at runtime and nothing in the typecheck noticed.
 *
 * This guard fails when a store goes back to calling a transport method
 * through an `any` cast. Feature probes such as
 * `typeof (api as AnyApi).getPerformanceSnapshot === "function"` call nothing
 * and are not matched.
 */
import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const STORES = [
  "stores/app.ts",
  "stores/app-api-actions.ts",
  "stores/app-dialog-actions.ts",
  "stores/app-workspace-actions.ts",
  "stores/git-ui.ts",
];

// Plain path join rather than `new URL(..., import.meta.url)`: Vite rewrites
// that pattern into an asset request, which resolves to an http:// URL here.
const SRC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// `(ctx.getApi() as AnyApi).x(`, `(_api as any)?.x(`, `(api as AnyApi).x(`,
// and `const api = getApi() as AnyApi;` (whose later calls are untyped).
const UNTYPED_CALL = /\(\s*(?:ctx\.)?(?:getApi\(\)|_?api)\s+as\s+(?:AnyApi|any)\s*\)\s*\??\.\s*\w+\s*\(/g;
const UNTYPED_BINDING = /=\s*(?:ctx\.)?getApi\(\)\s+as\s+(?:AnyApi|any)\s*;/g;

describe("stores call the transport with typed payloads", () => {
  test.each(STORES)("%s has no transport call through an `any` cast", (file) => {
    const source = readFileSync(resolve(SRC_DIR, file), "utf8");
    const offenders = [...(source.match(UNTYPED_CALL) || []), ...(source.match(UNTYPED_BINDING) || [])];
    expect(offenders, "use `as CallableTransport` (src/transport.ts) so the payload is checked").toEqual([]);
  });

  test("the guard still recognises the shapes it forbids", () => {
    const samples = [
      "(ctx.getApi() as AnyApi).voteAzurePullRequest({ prKey, vote })",
      "(_api as any).gitListBranches(payload)",
      "(_api as AnyApi)?.setGridLayout(layout)",
      "(api as AnyApi).saveProfile(profile)",
    ];
    for (const sample of samples) expect(sample.match(UNTYPED_CALL), sample).not.toBeNull();
    expect("const api = getApi() as AnyApi;".match(UNTYPED_BINDING)).not.toBeNull();
    expect('typeof (api as AnyApi).getPerformanceSnapshot === "function"'.match(UNTYPED_CALL)).toBeNull();
  });
});
