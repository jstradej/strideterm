/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import sshConfig from "ssh-config";
import type { Section } from "ssh-config";

export interface ParsedSshHost {
  name: string;
  host: string;
  port: number;
  username: string;
  auth: { methods: string[] };
  advanced: Record<string, unknown>;
  _identityFile?: string;
}

export async function parseSshConfig(configPath = path.join(homedir(), ".ssh", "config")): Promise<ParsedSshHost[]> {
  const raw = await readFile(configPath, "utf8").catch(() => "");
  if (!raw) return [];

  const parsed = sshConfig.parse(raw);
  const hosts: ParsedSshHost[] = [];

  for (const block of parsed) {
    if (block.type === 1 && (block as Section).param.toLowerCase() === "host") {
      const section = block as Section;
      const hostValue = typeof section.value === "string" ? section.value : "";
      if (hostValue.includes("*") || hostValue.includes("?")) continue; // skip wildcards

      const hostObj: ParsedSshHost = {
        name: hostValue,
        host: hostValue,
        port: 22,
        username: process.env["USER"] || "root",
        auth: { methods: ["publickey"] },
        advanced: {},
      };

      for (const line of section.config) {
        if (line.type !== 1) continue;
        const directive = line as Section;
        const param = directive.param.toLowerCase();
        const value = typeof directive.value === "string" ? directive.value : "";
        if (param === "hostname") hostObj.host = value;
        if (param === "port") hostObj.port = parseInt(value, 10) || 22;
        if (param === "user") hostObj.username = value;
        if (param === "identityfile") {
          // just marking it to be resolved during import
          hostObj._identityFile = value;
        }
      }

      hosts.push(hostObj);
    }
  }

  return hosts;
}
