import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createNotifyUrlRegistry, normalizeCwd, SHARD_LEASE_TTL_MS } from "./notify-url-registry.js";

let tempDir: string;
let sharedDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "strideterm-notify-registry-"));
  sharedDir = path.join(tempDir, "shared");
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

function makeRegistry(instanceId: string) {
  return createNotifyUrlRegistry({
    sharedDir,
    localPath: path.join(tempDir, instanceId, "hooks", "notify-urls.json"),
    instanceId,
  });
}

const REPO = "/work/repo";
const KEY = normalizeCwd(REPO);
const urlFor = (port: number, sid: string) => `http://127.0.0.1:${port}/notify?sid=${encodeURIComponent(sid)}&secret=s`;

describe("notify URL registry", () => {
  test("an instance replaces only its own entry for a session", () => {
    const registry = makeRegistry("aaaaaaaaaaaa");
    registry.register(REPO, urlFor(1111, "ws:p1"));
    registry.register(REPO, urlFor(2222, "ws:p1"));
    registry.register(REPO, urlFor(3333, "ws:p2"));

    expect(registry.readOwn()[KEY].map((entry) => entry.url)).toEqual([urlFor(2222, "ws:p1"), urlFor(3333, "ws:p2")]);
  });

  test("unregister and cleanupPort touch only this instance's file", () => {
    const mine = makeRegistry("aaaaaaaaaaaa");
    const theirs = makeRegistry("bbbbbbbbbbbb");
    mine.register(REPO, urlFor(1111, "ws:p1"));
    theirs.register(REPO, urlFor(2222, "ws:p1"));

    // The other installation restored a workspace with the SAME ids — the case
    // a sid-keyed eviction got wrong.
    expect(mine.unregister("ws:p1")).toBe(1);
    expect(mine.readOwn()[KEY]).toBeUndefined();
    expect(theirs.readOwn()[KEY].map((entry) => entry.url)).toEqual([urlFor(2222, "ws:p1")]);

    theirs.register(REPO, urlFor(2222, "ws:p2"));
    expect(theirs.cleanupPort(2222)).toBe(2);
    expect(theirs.readOwn()[KEY]).toBeUndefined();
  });

  test("the per-data-dir copy is kept in step for an older installed script", async () => {
    const registry = makeRegistry("aaaaaaaaaaaa");
    registry.register(REPO, urlFor(1111, "ws:p1"));
    const local = JSON.parse(
      await fs.readFile(path.join(tempDir, "aaaaaaaaaaaa", "hooks", "notify-urls.json"), "utf8"),
    );
    expect(local[KEY][0].url).toBe(urlFor(1111, "ws:p1"));
  });

  test("two processes registering at the same time keep both entries", async () => {
    // P2-5: with one shared document, dev and prod each read the old content,
    // each appended their own entry and the second rename discarded the
    // first's — silently, and only under a race. Two REAL processes, hammering
    // the same key, are the only honest way to show that cannot happen: they
    // never write the same file.
    const moduleUrl = pathToFileURL(
      path.join(fileURLToPath(new URL(".", import.meta.url)), "notify-url-registry.ts"),
    ).href;
    const writerPath = path.join(tempDir, "writer.mts");
    await fs.writeFile(
      writerPath,
      [
        `import { createNotifyUrlRegistry } from ${JSON.stringify(moduleUrl)};`,
        "const [sharedDir, localPath, instanceId, repo, count] = process.argv.slice(2);",
        "const registry = createNotifyUrlRegistry({ sharedDir, localPath, instanceId });",
        "for (let i = 0; i < Number(count); i += 1) {",
        "  registry.register(repo, `http://127.0.0.1:${9000 + i}/notify?sid=${instanceId}%3Ap&secret=s`);",
        "}",
      ].join("\n"),
      "utf8",
    );

    const ITERATIONS = 25;
    const run = (instanceId: string) =>
      new Promise<void>((resolve, reject) => {
        execFile(
          process.execPath,
          [
            "--import",
            "tsx",
            writerPath,
            sharedDir,
            path.join(tempDir, instanceId, "hooks", "notify-urls.json"),
            instanceId,
            REPO,
            String(ITERATIONS),
          ],
          { cwd: process.cwd() },
          (err) => (err ? reject(err) : resolve()),
        );
      });

    await Promise.all([run("aaaaaaaaaaaa"), run("bbbbbbbbbbbb")]);

    const reader = makeRegistry("cccccccccccc");
    const merged = reader.readMerged();
    const lastUrl = (instanceId: string) =>
      `http://127.0.0.1:${9000 + ITERATIONS - 1}/notify?sid=${instanceId}%3Ap&secret=s`;
    expect(merged[KEY].map((entry) => entry.url).sort()).toEqual(
      [lastUrl("aaaaaaaaaaaa"), lastUrl("bbbbbbbbbbbb")].sort(),
    );
  }, 60_000);

  test("a shard left behind by an installation that is gone stops being routed, and is swept", async () => {
    // P3-4: nobody but a shard's owner ever writes it, so a file left by a
    // crash, a deleted dev data dir or an uninstalled portable copy had no one
    // to clean it up — notify.mjs merged it forever and every hook paid a
    // connect attempt to a dead (by now possibly recycled) port. Crash
    // residue, not a clean unregister: the process died mid-run.
    const mine = makeRegistry("aaaaaaaaaaaa");
    const theirs = makeRegistry("bbbbbbbbbbbb");
    mine.register(REPO, urlFor(1111, "ws:p1"));
    theirs.register(REPO, urlFor(2222, "ws:p1"));

    const abandoned = path.join(sharedDir, "instances", "cccccccccccc.json");
    await fs.writeFile(
      abandoned,
      JSON.stringify({
        updatedAt: Date.now() - SHARD_LEASE_TTL_MS - 60_000,
        urls: { [KEY]: [{ url: urlFor(3333, "ws:p1"), instanceId: "cccccccccccc", sid: "ws:p1" }] },
      }),
      "utf8",
    );

    const reader = makeRegistry("dddddddddddd");
    expect(
      reader
        .readMerged()
        [KEY].map((entry) => entry.url)
        .sort(),
    ).toEqual([urlFor(1111, "ws:p1"), urlFor(2222, "ws:p1")].sort());
    expect(reader.pruneExpiredShards()).toBe(1);
    await expect(fs.stat(abandoned)).rejects.toThrow();
    // The two live installations are untouched — the sweep only ever removes.
    expect(mine.readOwn()[KEY].map((entry) => entry.url)).toEqual([urlFor(1111, "ws:p1")]);
    expect(theirs.readOwn()[KEY].map((entry) => entry.url)).toEqual([urlFor(2222, "ws:p1")]);
  });

  test("a shard with no lease is dated by its mtime, not assumed fresh or assumed dead", async () => {
    // The shape an earlier build wrote. Assuming it fresh would leave residue
    // routable forever; assuming it dead would strip a live sibling on an
    // older build of its hooks the moment we started.
    const legacy = path.join(sharedDir, "instances", "eeeeeeeeeeee.json");
    await fs.mkdir(path.dirname(legacy), { recursive: true });
    await fs.writeFile(legacy, JSON.stringify({ [KEY]: [urlFor(4444, "ws:p1")] }), "utf8");

    const reader = makeRegistry("dddddddddddd");
    expect(reader.readMerged()[KEY].map((entry) => entry.url)).toEqual([urlFor(4444, "ws:p1")]);
    expect(reader.pruneExpiredShards()).toBe(0);

    const longAgo = new Date(Date.now() - SHARD_LEASE_TTL_MS - 60_000);
    await fs.utimes(legacy, longAgo, longAgo);
    expect(reader.readMerged()[KEY]).toBeUndefined();
    expect(reader.pruneExpiredShards()).toBe(1);
  });

  test("a shard that cannot be read is dated by its mtime, not swept as expired", async () => {
    // The sweep is the one operation that touches another installation's file,
    // so a failed READ must never be mistaken for an expired lease. On Windows
    // a read landing on the writer's rename fails outright, and treating that
    // as "infinitely old" would delete the shard of an instance that is very
    // much alive. The mtime survives a failed read.
    const unreadable = path.join(sharedDir, "instances", "ffffffffffff.json");
    await fs.mkdir(path.dirname(unreadable), { recursive: true });
    await fs.writeFile(unreadable, '{"partially-writ', "utf8");

    const reader = makeRegistry("dddddddddddd");
    expect(reader.pruneExpiredShards()).toBe(0);
    expect(existsSync(unreadable)).toBe(true);

    // Ancient AND unreadable is residue, and does go.
    const longAgo = new Date(Date.now() - SHARD_LEASE_TTL_MS - 60_000);
    await fs.utimes(unreadable, longAgo, longAgo);
    expect(reader.pruneExpiredShards()).toBe(1);
  });

  test("renewing the lease keeps a long-running instance routable", async () => {
    // Weeks of uptime with no panel opened or closed: nothing rewrites the
    // shard, so the periodic renewal is the only thing standing between a live
    // installation and being swept as abandoned.
    const registry = makeRegistry("aaaaaaaaaaaa");
    registry.register(REPO, urlFor(1111, "ws:p1"));
    const stale = JSON.parse(await fs.readFile(registry.ownPath, "utf8"));
    stale.updatedAt = Date.now() - SHARD_LEASE_TTL_MS - 60_000;
    await fs.writeFile(registry.ownPath, JSON.stringify(stale), "utf8");

    const reader = makeRegistry("dddddddddddd");
    expect(reader.readMerged()[KEY]).toBeUndefined();

    registry.renewLease();
    expect(reader.readMerged()[KEY].map((entry) => entry.url)).toEqual([urlFor(1111, "ws:p1")]);
  });

  test("the sweep rebuilds the aggregate, so a swept URL is not left in an unleased mirror", async () => {
    // P3-2: the aggregate is a bare map with no lease of its own, so a copy
    // written while the swept installation was alive still names its URLs —
    // and once the shard is deleted, nothing is left to recognise them by.
    // Rebuilding it in the same operation is what keeps the dead port from
    // staying routable until some later persist() happens to come along.
    const mine = makeRegistry("aaaaaaaaaaaa");
    mine.register(REPO, urlFor(1111, "ws:p1"));

    const abandoned = path.join(sharedDir, "instances", "cccccccccccc.json");
    await fs.writeFile(
      abandoned,
      JSON.stringify({
        updatedAt: Date.now() - SHARD_LEASE_TTL_MS - 60_000,
        urls: { [KEY]: [{ url: urlFor(3333, "ws:p1"), instanceId: "cccccccccccc", sid: "ws:p1" }] },
      }),
      "utf8",
    );
    // The aggregate as the dead instance's own last write left it.
    const aggregatePath = path.join(sharedDir, "notify-urls.json");
    await fs.writeFile(
      aggregatePath,
      JSON.stringify({ [KEY]: [{ url: urlFor(1111, "ws:p1") }, { url: urlFor(3333, "ws:p1") }] }),
      "utf8",
    );

    expect(makeRegistry("dddddddddddd").pruneExpiredShards()).toBe(1);

    const aggregate = JSON.parse(await fs.readFile(aggregatePath, "utf8"));
    expect(aggregate[KEY].map((entry: { url: string }) => entry.url)).toEqual([urlFor(1111, "ws:p1")]);
  });

  test("the legacy aggregate is rebuilt from the per-instance files, so a lost update heals", async () => {
    const mine = makeRegistry("aaaaaaaaaaaa");
    const theirs = makeRegistry("bbbbbbbbbbbb");
    mine.register(REPO, urlFor(1111, "ws:p1"));
    theirs.register(REPO, urlFor(2222, "ws:p1"));

    // Simulate the worst a concurrent mirror write can do: the aggregate ends
    // up describing only one instance. The next write rebuilds it from the
    // files that are actually authoritative.
    const aggregatePath = path.join(sharedDir, "notify-urls.json");
    await fs.writeFile(aggregatePath, JSON.stringify({}), "utf8");
    mine.register(REPO, urlFor(1111, "ws:p2"));

    const aggregate = JSON.parse(await fs.readFile(aggregatePath, "utf8"));
    expect(aggregate[KEY].map((entry: { url: string }) => entry.url).sort()).toEqual(
      [urlFor(1111, "ws:p1"), urlFor(1111, "ws:p2"), urlFor(2222, "ws:p1")].sort(),
    );
  });
});
