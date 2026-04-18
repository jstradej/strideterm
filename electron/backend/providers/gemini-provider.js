import { writeFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { BaseProvider, checkBinaryOnPath } from "./base-provider.js";

export class GeminiProvider extends BaseProvider {
  static id = "gemini";
  static displayName = "Gemini CLI";
  static models = [
    { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", suggestedRole: "judge" },
    { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", suggestedRole: "worker" },
  ];

  static defaultSkipPermissions = false;

  buildCommand({ model, skipPermissions = false } = {}) {
    const parts = ["gemini"];
    if (skipPermissions) parts.push("--yolo");
    if (model) parts.push("-m", model);
    return parts.join(" ");
  }

  get idleDetection() {
    return "silence";
  }

  get idleTimeoutMs() {
    return 8000;
  }

  /**
   * Write .gemini/settings.json with yolo approval mode so the agent doesn't
   * prompt for tool approvals during task execution. Also ensures .gemini/ is
   * in the project's .gitignore.
   */
  async beforeStart(cwd) {
    const geminiDir = path.join(cwd, ".gemini");
    await mkdir(geminiDir, { recursive: true });

    const settingsPath = path.join(geminiDir, "settings.json");
    const settings = { toolApproval: "yolo" };
    await writeFile(settingsPath, JSON.stringify(settings, null, 2), "utf8");

    await this.#ensureGitIgnore(cwd);
  }

  async #ensureGitIgnore(cwd) {
    const gitignorePath = path.join(cwd, ".gitignore");
    const entry = ".gemini/";
    try {
      const content = await readFile(gitignorePath, "utf8");
      if (content.includes(entry)) return;
      const sep = content.endsWith("\n") ? "" : "\n";
      await writeFile(gitignorePath, content + sep + entry + "\n", "utf8");
    } catch (err) {
      if (err.code === "ENOENT") {
        await writeFile(gitignorePath, entry + "\n", "utf8").catch(() => {});
      }
    }
  }

  async checkAvailability() {
    return checkBinaryOnPath("gemini");
  }
}
