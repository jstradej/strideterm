import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  buildSshTmuxAttachCommand,
  buildSshTmuxPreviewCommand,
  normalizeSshTmuxTarget,
  SSH_TMUX_NO_MATCH_EXIT,
  SSH_TMUX_OUTPUT_MARKER,
} from "./ssh-tmux.js";

const names = ["  víc prostoru  ", "-dash", "$10", "x.*:not a tmux target", "🧭 ' \\ $(printf injected) ;"];
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("preserves literal tmux names and validates the read-only option", () => {
  for (const name of names)
    expect(normalizeSshTmuxTarget({ name, readOnly: false })).toEqual({ name, readOnly: false });
  for (const name of ["", "newline\n", "tab\t", "bad\u007fname", "\ud800", "x".repeat(513)]) {
    expect(normalizeSshTmuxTarget({ name })).toBeNull();
  }
  expect(normalizeSshTmuxTarget({ name: "safe", readOnly: "yes" })).toBeNull();
});

function runTmuxCommand(command: string, existingName: string) {
  const binDir = mkdtempSync(join(tmpdir(), "strideterm-tmux-shell-test-"));
  tempDirs.push(binDir);
  writeFileSync(
    join(binDir, "tmux"),
    `#!/bin/sh
case "$*" in
  '-u list-sessions -F #{session_id} #{session_name}')
    printf '$7 %s-longer\n$9 %s\n' "$TEST_SESSION_NAME" "$TEST_SESSION_NAME";;
  'if-shell -F 1 '*)
    IFS= read -r input
    printf '%s\n%s' "$4" "$input";;
  '-u capture-pane -p -S -100 -t '*)
    printf '%s\n' "$7";;
  *) exit 55;;
esac
`,
    { mode: 0o700 },
  );
  return spawnSync("sh", ["-c", command], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH}`, TEST_SESSION_NAME: existingName },
    input: "terminal input\n",
  });
}

test.skipIf(process.platform === "win32").each(names)(
  "targets only the literal name %j and preserves terminal stdin",
  (name) => {
    expect(runTmuxCommand(buildSshTmuxAttachCommand({ name, readOnly: true }), name)).toMatchObject({
      status: 0,
      stdout: "attach-session -r -t '$9'\nterminal input",
    });
    expect(runTmuxCommand(buildSshTmuxPreviewCommand(name), name)).toMatchObject({
      status: 0,
      stdout: `${SSH_TMUX_OUTPUT_MARKER}$9:\n`,
    });
  },
);

test.skipIf(process.platform === "win32")(
  "does not attach to a session whose name merely starts with the requested name",
  () => {
    expect(runTmuxCommand(buildSshTmuxAttachCommand({ name: "prefix" }), "prefix-more")).toMatchObject({
      status: SSH_TMUX_NO_MATCH_EXIT,
      stderr: "tmux session no longer exists.\n",
    });
  },
);
