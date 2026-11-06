import { parseAgentCommand } from "../../electron/shared/agent-ssh.js";
import { PROVIDER_CHOICES } from "../../electron/shared/agent-provider-catalog.js";

export interface TabTemplate {
  title?: string;
  command?: string;
  icon?: string;
  platforms?: string[];
}

export const FALLBACK_TAB_TEMPLATES: TabTemplate[] = [
  { title: "Shell", command: "", icon: "\u{1F4BB}" },
  { title: "PowerShell", command: "powershell", icon: "\u{1F537}", platforms: ["win32"] },
  { title: "Bash", command: "bash", icon: "\u{1F41A}", platforms: ["darwin", "linux"] },
  { title: "Zsh", command: "zsh", icon: "\u{1F41A}", platforms: ["darwin", "linux"] },
  { title: "Claude Code", command: "claude", icon: "\u{1F916}" },
  { title: "Codex", command: "codex", icon: "\u{1F9E0}" },
  { title: "Gemini CLI", command: "gemini", icon: "✨" },
  { title: "GitHub Copilot", command: "copilot", icon: "\u{1F419}" },
  { title: "OpenCode", command: "opencode", icon: "\u{1F9EC}" },
  { title: "Browser", command: "https://", icon: "\u{1F310}" },
  { title: "Files", command: "__files__", icon: "\u{1F4C2}" },
];

export function templatesForPlatform(configured: unknown, platform: string): TabTemplate[] {
  const list = Array.isArray(configured) && configured.length ? (configured as TabTemplate[]) : FALLBACK_TAB_TEMPLATES;
  return list.filter((tmpl) => !Array.isArray(tmpl.platforms) || !platform || tmpl.platforms.includes(platform));
}

const SHELL_EXECUTABLES = new Set([
  "cmd",
  "powershell",
  "pwsh",
  "bash",
  "zsh",
  "sh",
  "fish",
  "nu",
  "dash",
  "ksh",
  "tcsh",
  "csh",
  "elvish",
  "xonsh",
  "wsl",
]);
const RUNS_A_COMMAND = /(^|\s)(-c|\/c|-command|-file|-encodedcommand|-e)(\s|$)|&&|\|\||[|;]/i;

function commandWords(command: string | undefined): string[] {
  const words: string[] = [];
  for (const match of (command || "").trim().matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) {
    words.push(match[1] ?? match[2] ?? match[3] ?? "");
  }
  return words;
}

function executableName(command: string | undefined): string {
  const first = commandWords(command)[0] || "";
  return (first.split(/[\\/]/).pop() || "").toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, "");
}

function isAgentTemplate(tmpl: TabTemplate): boolean {
  return (
    !!parseAgentCommand(tmpl.command) ||
    PROVIDER_CHOICES.some((provider) => provider.id === executableName(tmpl.command))
  );
}

function isShellTemplate(tmpl: TabTemplate): boolean {
  const command = (tmpl.command || "").trim();
  if (!command) return true;
  if (!SHELL_EXECUTABLES.has(executableName(command))) return false;
  return !RUNS_A_COMMAND.test(commandWords(command).slice(1).join(" "));
}

export function agentTemplatesForPlatform(configured: unknown, platform: string): TabTemplate[] {
  return templatesForPlatform(configured, platform).filter(isAgentTemplate);
}

export function shellTemplatesForPlatform(configured: unknown, platform: string): TabTemplate[] {
  return templatesForPlatform(configured, platform).filter(isShellTemplate);
}
