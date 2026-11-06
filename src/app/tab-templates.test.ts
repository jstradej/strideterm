import { describe, expect, it } from "vitest";
import { agentTemplatesForPlatform, shellTemplatesForPlatform } from "./tab-templates.js";

const TEMPLATES = [
  { title: "Shell", command: "" },
  { title: "WSL", command: "wsl", platforms: ["win32"] },
  { title: "Git Bash", command: '"C:\\Program Files\\Git\\bin\\bash.exe" --login -i', platforms: ["win32"] },
  { title: "PowerShell 7", command: "pwsh", platforms: ["win32"] },
  { title: "PowerShell", command: "powershell.exe -NoLogo", platforms: ["win32"] },
  { title: "Zsh", command: "zsh", platforms: ["darwin", "linux"] },
  { title: "Fish", command: "/usr/bin/fish", platforms: ["darwin", "linux"] },
  { title: "Claude Code", command: "claude" },
  { title: "Gemini CLI", command: "gemini" },
  { title: "Dev Server", command: "npm run dev" },
  { title: "Tests", command: "npm test" },
  { title: "Docker Compose", command: "docker compose up" },
  { title: "Lazygit", command: "lazygit" },
  { title: "Script", command: "bash -c ./build.sh" },
  { title: "PS script", command: "pwsh -File build.ps1" },
  { title: "Chained", command: "bash && echo hi" },
  { title: "Browser", command: "https://" },
  { title: "Files", command: "__files__" },
];

const titles = (list: { title?: string }[]) => list.map((tmpl) => tmpl.title);

describe("tab template pickers", () => {
  it("lists only interactive shells of the runtime platform", () => {
    expect(titles(shellTemplatesForPlatform(TEMPLATES, "win32"))).toEqual([
      "Shell",
      "WSL",
      "Git Bash",
      "PowerShell 7",
      "PowerShell",
    ]);
    expect(titles(shellTemplatesForPlatform(TEMPLATES, "darwin"))).toEqual(["Shell", "Zsh", "Fish"]);
    expect(titles(shellTemplatesForPlatform(TEMPLATES, "linux"))).toEqual(["Shell", "Zsh", "Fish"]);
  });

  it("lists every known agent CLI, including ones without MCP support", () => {
    expect(titles(agentTemplatesForPlatform(TEMPLATES, "win32"))).toEqual(["Claude Code", "Gemini CLI"]);
  });
});
