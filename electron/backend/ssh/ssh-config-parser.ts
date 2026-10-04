/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import sshConfig, { LineType } from "ssh-config";
import type { Section } from "ssh-config";

export interface ParsedSshHost {
  name: string;
  host: string;
  advanced: { launchVia: "system-ssh" };
}

export async function parseSshConfig(configPath = path.join(homedir(), ".ssh", "config")): Promise<ParsedSshHost[]> {
  const raw = await readFile(configPath, "utf8").catch(() => "");
  if (!raw) return [];

  const parsed = sshConfig.parse(raw);
  const hosts: ParsedSshHost[] = [];

  for (const block of parsed) {
    if (block.type === LineType.DIRECTIVE && (block as Section).param.toLowerCase() === "host") {
      const section = block as Section;
      const patterns =
        typeof section.value === "string" ? section.value.trim().split(/\s+/) : section.value.map((item) => item.val);
      for (const alias of patterns) {
        if (!alias || alias.startsWith("!") || /[*?]/.test(alias)) continue;
        hosts.push({ name: alias, host: alias, advanced: { launchVia: "system-ssh" } });
      }
    }
  }

  return hosts;
}
