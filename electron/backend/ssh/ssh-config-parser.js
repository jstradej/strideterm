import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import sshConfig from "ssh-config";

export async function parseSshConfig(configPath = path.join(homedir(), ".ssh", "config")) {
  const raw = await readFile(configPath, "utf8").catch(() => "");
  if (!raw) return [];

  const parsed = sshConfig.parse(raw);
  const hosts = [];

  for (const block of parsed) {
    if (block.type === 1 && block.param.toLowerCase() === "host") {
      const hostValue = block.value;
      if (hostValue.includes("*") || hostValue.includes("?")) continue; // skip wildcards

      const hostObj = {
        name: hostValue,
        host: hostValue,
        port: 22,
        username: process.env.USER || "root",
        auth: { methods: ["publickey"] },
        advanced: {},
      };

      for (const line of block.config) {
        const param = line.param.toLowerCase();
        const value = line.value;
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

export async function parseKnownHosts(filePath = path.join(homedir(), ".ssh", "known_hosts")) {
  return {}; // V1 stub
}
