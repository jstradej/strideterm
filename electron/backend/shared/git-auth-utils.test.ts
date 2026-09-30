import { describe, expect, test, vi } from "vitest";
import {
  createGitConfigEnvProbe,
  encodeAuthHeader,
  gitAuthEnvironment,
  gitSupportsConfigEnv,
  parseGitVersion,
} from "./git-auth-utils.js";

describe("parseGitVersion / gitSupportsConfigEnv", () => {
  test("parses the usual `git --version` shapes", () => {
    expect(parseGitVersion("git version 2.43.0")).toEqual({ major: 2, minor: 43 });
    expect(parseGitVersion("git version 2.39.3 (Apple Git-146)")).toEqual({ major: 2, minor: 39 });
    expect(parseGitVersion("git version 2.45.1.windows.1\n")).toEqual({ major: 2, minor: 45 });
    expect(parseGitVersion("garbage")).toBeNull();
    expect(parseGitVersion("")).toBeNull();
  });

  test("2.31 is the first version with GIT_CONFIG_*", () => {
    expect(gitSupportsConfigEnv("git version 2.30.9")).toBe(false);
    expect(gitSupportsConfigEnv("git version 2.31.0")).toBe(true);
    expect(gitSupportsConfigEnv("git version 2.9.5")).toBe(false);
    expect(gitSupportsConfigEnv("git version 3.0.0")).toBe(true);
    expect(gitSupportsConfigEnv("git version 1.99.0")).toBe(false);
    expect(gitSupportsConfigEnv("unknown")).toBe(false);
  });
});

describe("createGitConfigEnvProbe", () => {
  test("reads the version once and remembers the answer", async () => {
    const read = vi.fn(async () => "git version 2.40.0");
    const probe = createGitConfigEnvProbe(read);
    expect(await probe()).toBe(true);
    expect(await probe()).toBe(true);
    expect(read).toHaveBeenCalledTimes(1);
  });

  test("a failing version read resolves false", async () => {
    const probe = createGitConfigEnvProbe(() => Promise.reject(new Error("spawn git ENOENT")));
    expect(await probe()).toBe(false);
  });
});

describe("gitAuthEnvironment", () => {
  test("adds the three GIT_CONFIG_* variables to a copy of the base env", () => {
    const base = { PATH: "/bin" };
    const env = gitAuthEnvironment("me", "tok", base);
    expect(env).toEqual({
      PATH: "/bin",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.extraheader",
      GIT_CONFIG_VALUE_0: encodeAuthHeader("me", "tok"),
    });
    expect(base).toEqual({ PATH: "/bin" });
  });

  test("appends after an existing GIT_CONFIG_COUNT", () => {
    const env = gitAuthEnvironment("me", "tok", {
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "a.b",
      GIT_CONFIG_VALUE_0: "1",
      GIT_CONFIG_KEY_1: "c.d",
      GIT_CONFIG_VALUE_1: "2",
    });
    expect(env.GIT_CONFIG_COUNT).toBe("3");
    expect(env.GIT_CONFIG_KEY_0).toBe("a.b");
    expect(env.GIT_CONFIG_KEY_1).toBe("c.d");
    expect(env.GIT_CONFIG_KEY_2).toBe("http.extraheader");
    expect(env.GIT_CONFIG_VALUE_2).toBe(encodeAuthHeader("me", "tok"));
  });

  test("a malformed GIT_CONFIG_COUNT is treated as absent", () => {
    expect(gitAuthEnvironment("me", "tok", { GIT_CONFIG_COUNT: "lots" }).GIT_CONFIG_COUNT).toBe("1");
  });
});
