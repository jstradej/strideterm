import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { writeFileAtomic } from "../shared/fs-durable.js";

const itemSchema = z
  .object({
    profileId: z.string(),
    parentId: z.string(),
    key: z.string(),
    hash: z.string(),
    workspaceId: z.string(),
    status: z.enum(["pending", "ready", "failed"]),
    error: z.string().optional(),
  })
  .strict();
type Item = z.infer<typeof itemSchema>;
/** Durable create intent, reserved before creating a workspace; prompts are never stored. */
export class AutomationCreateKeys {
  private items: Item[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly file: string,
    private readonly exists: (item: Item) => boolean,
  ) {}
  async load(): Promise<void> {
    try {
      this.items = z.array(itemSchema).parse(JSON.parse(await readFile(this.file, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  private async save(): Promise<void> {
    await writeFileAtomic(this.file, `${JSON.stringify(this.items)}\n`);
  }
  create(
    profileId: string,
    parentId: string,
    key: string,
    hash: string,
    effect: (workspaceId: string) => Promise<void>,
  ): Promise<string> {
    const operation = this.queue
      .catch(() => {})
      .then(async () => {
        const existing = this.items.find(
          (item) => item.profileId === profileId && item.parentId === parentId && item.key === key,
        );
        if (existing) {
          if (existing.hash !== hash) throw new Error("This idempotency key was already used with a different request");
          if (existing.status === "ready") return existing.workspaceId;
          if (existing.status === "failed")
            throw new Error(existing.error || "The original automation creation failed");
          if (this.exists(existing)) {
            existing.status = "ready";
            await this.save();
            return existing.workspaceId;
          }
          existing.status = "failed";
          existing.error =
            "The runtime stopped before the automation workspace was created; use a new idempotency key.";
          await this.save();
          throw new Error(existing.error);
        }
        const item: Item = {
          profileId,
          parentId,
          key,
          hash,
          workspaceId: `workspace-${randomUUID()}`,
          status: "pending",
        };
        this.items.push(item);
        try {
          await this.save();
        } catch (error) {
          this.items.pop();
          throw error;
        }
        try {
          await effect(item.workspaceId);
        } catch (error) {
          // If the effect made the workspace before failing, preserve its identity for recovery.
          if (!this.exists(item)) {
            item.status = "failed";
            item.error = "Automation creation failed. Use a new idempotency key.";
            await this.save();
          }
          throw error;
        }
        item.status = "ready";
        await this.save();
        return item.workspaceId;
      });
    this.queue = operation;
    return operation;
  }
}
