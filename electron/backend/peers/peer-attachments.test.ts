import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { PEER_ATTACHMENT_LIST_MAX_ITEMS, peerAttachmentItemSchema } from "../../shared/peers.js";
import * as attachments from "../attachments.js";
import { createPeerAttachmentsHost } from "./peer-attachments.js";

const roots: string[] = [];
afterEach(async () => {
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
});

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "strideterm-peer-att-unit-"));
  roots.push(root);
  return root;
}

async function seed(root: string, name: string, bytes = "data"): Promise<string> {
  const started = await attachments.begin(
    root,
    name,
    bytes.length,
    "",
    "seed",
    `seed-${name}`,
    attachments.DESKTOP_LIMITS,
  );
  await attachments.chunk(root, started.transferId, 0, Buffer.from(bytes).toString("base64"), "seed");
  await attachments.finish(root, started.transferId, "seed");
  return started.transferId;
}

async function plantFinished(root: string, name: string, updatedAt: number): Promise<void> {
  const id = randomUUID();
  const dir = path.join(root, ".strideterm", ".attachment-transfers", id);
  await mkdir(dir, { recursive: true });
  const done = { transferId: id, path: `.strideterm/attachments/${id}/${name}`, size: 1, sha256: "a".repeat(64), name };
  await writeFile(
    path.join(dir, "state.json"),
    JSON.stringify({ id, name, size: 1, sha256: done.sha256, offset: 1, createdAt: updatedAt, updatedAt, done }),
  );
}

const profiles = [{ id: "p", name: "Profile" }];
const workspace = (id: string, cwd: string) => ({ id, name: id, profileId: "p", cwd, panels: [] });

describe("peer attachments host", () => {
  test("lists only the last 14 days and says so when more than the cap are recent", async () => {
    const root = await makeRoot();
    await seed(root, "a.txt");
    const state = { profiles, workspaces: [workspace("ws", root)] } as never;
    const day = 24 * 60 * 60 * 1000;
    expect((await createPeerAttachmentsHost({ getState: () => state }).list()).items).toHaveLength(1);
    const later = createPeerAttachmentsHost({ getState: () => state, now: () => Date.now() + 15 * day });
    expect(await later.list()).toEqual({ items: [], truncated: false });
  });

  test("caps the list at the newest 200 across workspaces and flags truncation", async () => {
    const workspaces: Array<ReturnType<typeof workspace>> = [];
    for (let w = 0; w < 3; w++) {
      const root = await makeRoot();
      for (let i = 0; i < 67; i++) await plantFinished(root, `f${i}.txt`, Date.now() - i * 1000 - w);
      workspaces.push(workspace(`ws-${w}`, root));
    }
    const host = createPeerAttachmentsHost({ getState: () => ({ profiles, workspaces }) as never });
    const list = await host.list();
    expect(list.items).toHaveLength(PEER_ATTACHMENT_LIST_MAX_ITEMS);
    expect(list.truncated).toBe(true);
    const times = list.items.map((item) => item.uploadedAt);
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });

  test("two workspaces on one folder list its attachments once", async () => {
    const root = await makeRoot();
    await seed(root, "a.txt");
    const state = { profiles, workspaces: [workspace("one", root), workspace("two", root)] } as never;
    const list = await createPeerAttachmentsHost({ getState: () => state }).list();
    expect(list.items.map((item) => item.workspaceId)).toEqual(["one"]);
  });

  test("profile and workspace names are cut to the 200 characters the device accepts", async () => {
    const root = await makeRoot();
    await seed(root, "a.txt");
    const state = {
      profiles: [{ id: "p", name: "P".repeat(500) }],
      workspaces: [{ ...workspace("w", root), name: "W".repeat(500) }],
    } as never;
    const list = await createPeerAttachmentsHost({ getState: () => state }).list();
    expect(list.items[0]!.profileName).toBe("P".repeat(200));
    expect(list.items[0]!.workspaceName).toBe("W".repeat(200));
    expect(peerAttachmentItemSchema.safeParse(list.items[0]).success).toBe(true);
  });

  test("a workspace whose folder is gone does not fail the list", async () => {
    const root = await makeRoot();
    await seed(root, "a.txt");
    const gone = path.join(await makeRoot(), "missing");
    const state = { profiles, workspaces: [workspace("gone", gone), workspace("ok", root)] } as never;
    const list = await createPeerAttachmentsHost({ getState: () => state }).list();
    expect(list.items.map((item) => item.workspaceId)).toEqual(["ok"]);
  });
});
