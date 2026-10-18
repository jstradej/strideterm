import { describe, expect, test } from "vitest";
import { Effect } from "effect";
import { runEffect } from "./runtime.js";

function checkRunEffectTypes(): void {
  // @ts-expect-error An errorful Effect needs a typed failure mapper.
  void runEffect(Effect.fail("typed failure"));
  // @ts-expect-error The mapper must return an Error for Promise rejection.
  void runEffect(Effect.fail("typed failure"), (error) => String(error));
}
void checkRunEffectTypes;

describe("runEffect", () => {
  test("runs effects without a failure channel directly", async () => {
    await expect(runEffect(Effect.succeed(42))).resolves.toBe(42);
  });

  test("passes the typed failure through an explicit mapper and rejects with its Error", async () => {
    const failure = Effect.fail({ _tag: "Failure", detail: "operation failed" } as const);
    const mapped = new Error("operation failed");

    await expect(runEffect(failure, (error) => new Error(error.detail))).rejects.toBeInstanceOf(Error);
    await expect(runEffect(failure, () => mapped)).rejects.toBe(mapped);
  });
});
