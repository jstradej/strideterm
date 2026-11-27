import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { it } from "vitest";
import { readCodexAccountUsage } from "./codex.js";
import { createUsageAccountStore } from "./account-store.js";

it("reads two isolated CLI logins and restores their identifiable quota history after restart", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "strideterm usage "));
  try {
    const windows = process.platform === "win32";
    const shim = windows
      ? path.join(root, "node_modules", "@openai", "codex", "bin", "codex.js")
      : path.join(root, "codex");
    await mkdir(path.dirname(shim), { recursive: true });
    if (windows) await writeFile(path.join(root, "codex.cmd"), "exit /b 1");
    await writeFile(
      shim,
      [
        "#!/usr/bin/env node",
        "const lines = require('node:readline').createInterface({input:process.stdin});",
        "const login = require('node:path').basename(process.env.CODEX_HOME);",
        "lines.on('line', line => {",
        "  const {id, method} = JSON.parse(line);",
        "  if (method === 'initialized') return;",
        "  const result = method === 'initialize' ? {} : method === 'account/read'",
        "    ? {account:{type:'chatgpt',email:login+'@example.invalid'}}",
        "    : {rateLimits:{primary:{windowDurationMins:300,usedPercent:login==='work'?75:10}}};",
        "  console.log(JSON.stringify({id,result}));",
        "});",
      ].join("\n"),
      { mode: 0o755 },
    );
    const readings = await Promise.all(
      ["home", "work"].map(async (login) => {
        const accountDir = path.join(root, login);
        await mkdir(accountDir);
        return readCodexAccountUsage({
          ...process.env,
          PATH: [root, path.dirname(process.execPath)].join(path.delimiter),
          CODEX_HOME: accountDir,
        });
      }),
    );
    const store = createUsageAccountStore(root);
    for (const reading of readings) store.observe("codex", { ...reading, provider: "codex", checkedAt: Date.now() });
    const reopened = createUsageAccountStore(root).history("codex");
    assert.deepEqual(Object.fromEntries(reopened.map((account) => [account.label, account.windows[0]?.usedPercent])), {
      "home@example.invalid": 10,
      "work@example.invalid": 75,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
