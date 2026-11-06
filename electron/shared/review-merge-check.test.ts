import { describe, expect, test } from "vitest";
import { mapAzureConflicts, parseMergeTreeConflicts } from "./review-merge-check.js";

describe("parseMergeTreeConflicts", () => {
  test("drops the tree id, keeps each conflicted path once", () => {
    const stdout = "4b825dc642cb6eb9a060e54bf8d69288fbee4904\npom.xml\npom.xml\nsrc/a b/Ä.java\n\n";
    expect(parseMergeTreeConflicts(stdout)).toEqual(["pom.xml", "src/a b/Ä.java"]);
  });

  test("CRLF output and a tree id alone", () => {
    expect(parseMergeTreeConflicts("abc\r\ndocker-compose.yml\r\n")).toEqual(["docker-compose.yml"]);
    expect(parseMergeTreeConflicts("abc\n")).toEqual([]);
  });
});

describe("mapAzureConflicts", () => {
  test("rooted Azure paths become repository-relative, duplicates and empty paths are dropped", () => {
    expect(
      mapAzureConflicts([
        { conflictPath: "/pom.xml", conflictType: "editEdit" },
        { conflictPath: "/pom.xml", conflictType: "editEdit" },
        { conflictPath: "/streams/docker-compose-streams.yml", conflictType: "editEdit" },
        { conflictType: "deleteEdit" },
        null,
      ]),
    ).toEqual([
      { path: "pom.xml", type: "editEdit" },
      { path: "streams/docker-compose-streams.yml", type: "editEdit" },
    ]);
  });
});
