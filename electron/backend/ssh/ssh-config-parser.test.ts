/// <reference types="node" />
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { afterEach, describe, expect, test } from "vitest";
import { parseSshConfig } from "./ssh-config-parser.js";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("parseSshConfig alias import", () => {
  test("imports each exact alias without expanding directives or importing wildcard patterns", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-ssh-config-"));
    dirs.push(dir);
    const file = path.join(dir, "config");
    await fs.writeFile(
      file,
      [
        "Host prod staging !ignored *",
        "  HostName gateway.internal",
        "  User operator",
        "  Port 2200",
        "  IdentityFile ~/.ssh/prod",
        "Host *.example.com qa?",
        "  HostName wildcard.internal",
        "Match user operator",
        "  HostName match.internal",
      ].join("\n"),
    );

    await expect(parseSshConfig(file)).resolves.toEqual([
      { name: "prod", host: "prod", advanced: { launchVia: "system-ssh" } },
      { name: "staging", host: "staging", advanced: { launchVia: "system-ssh" } },
    ]);
  });
});
