/// <reference types="node" />
import { writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { BaseProvider, checkBinaryOnPath } from "./base-provider.js";
import type { ProviderConfig, BinaryCheckResult } from "./base-provider.js";

export class GeminiProvider extends BaseProvider {
  static override id = "gemini";
  static override displayName = "Gemini CLI";
  static override models = [
    { id: "gemini-3-pro-preview", name: "Gemini 3 Pro (preview)", suggestedRole: "judge" },
    { id: "gemini-3-flash-preview", name: "Gemini 3 Flash (preview)", suggestedRole: "worker" },
    { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", suggestedRole: null },
    { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", suggestedRole: null },
  ];

  static defaultSkipPermissions = false;

  override buildCommand({ model, skipPermissions = false }: ProviderConfig = {}): string {
    const parts = ["gemini"];
    if (skipPermissions) parts.push("--yolo");
    if (model) parts.push("-m", model);
    return parts.join(" ");
  }

  override get idleDetection(): string {
    return "silence";
  }

  override get idleTimeoutMs(): number {
    return 8000;
  }

  /**
   * Ensure .gemini/ is in the project's .gitignore so Gemini's per-project
   * state (chats, cache) doesn't leak into commits.
   *
   * Notification hooks are NOT configured here — they live at user scope in
   * ~/.gemini/settings.json and are set up explicitly via the Settings dialog
   * (see gemini-hook-config.js). Tool-approval skipping is handled by the
   * --yolo CLI flag when skipPermissions is on.
   */
  override async beforeStart(cwd: string): Promise<void> {
    await this.#ensureGitIgnore(cwd);
  }

  async #ensureGitIgnore(cwd: string): Promise<void> {
    const gitignorePath = path.join(cwd, ".gitignore");
    const entry = ".gemini/";
    try {
      const content = await readFile(gitignorePath, "utf8");
      if (content.includes(entry)) return;
      const sep = content.endsWith("\n") ? "" : "\n";
      await writeFile(gitignorePath, content + sep + entry + "\n", "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        await writeFile(gitignorePath, entry + "\n", "utf8").catch(() => {});
      }
    }
  }

  override async checkAvailability(): Promise<BinaryCheckResult> {
    return checkBinaryOnPath("gemini");
  }
}
