import { describe, expect, test, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";

// vi.hoisted ensures mockSpawn is created before the module factory runs.
const mockSpawn = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawn: mockSpawn }));

import { DockerLogSession, DockerLogManager } from "./docker-log-streamer.js";

// Minimal mock child process
class MockChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  lastSignal: string | null = null;

  kill(signal: string): boolean {
    this.lastSignal = signal;
    return true;
  }
}

const hostBackend = {
  id: "host",
  type: "host" as const,
  file: "docker",
  argsPrefix: [] as string[],
};

const wslBackend = {
  id: "wsl",
  type: "wsl" as const,
  file: "wsl.exe",
  argsPrefix: ["-e", "sh", "-lc"] as string[],
};

let mockChild: MockChild;

beforeEach(() => {
  mockChild = new MockChild();
  mockSpawn.mockReturnValue(mockChild);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("DockerLogSession", () => {
  test("emits data from child stdout", () => {
    const session = new DockerLogSession("s1", hostBackend, "default", "abc123");
    const received: string[] = [];
    session.on("data", (b: Buffer) => received.push(b.toString()));

    session.start();
    mockChild.stdout.emit("data", Buffer.from("hello logs"));

    expect(received).toEqual(["hello logs"]);
  });

  test("emits data from child stderr", () => {
    const session = new DockerLogSession("s2", hostBackend, "default", "abc123");
    const received: string[] = [];
    session.on("data", (b: Buffer) => received.push(b.toString()));

    session.start();
    mockChild.stderr.emit("data", Buffer.from("err line"));

    expect(received).toEqual(["err line"]);
  });

  test("emits close with exit code", () => {
    const session = new DockerLogSession("s3", hostBackend, "default", "abc123");
    let closedCode: number | null = -99;
    session.on("close", (code: number | null) => {
      closedCode = code;
    });

    session.start();
    mockChild.emit("close", 0);

    expect(closedCode).toBe(0);
  });

  test("stop() sends SIGTERM to host child", () => {
    const session = new DockerLogSession("s4", hostBackend, "default", "abc123");
    session.start();
    session.stop();

    expect(mockChild.lastSignal).toBe("SIGTERM");
  });

  test("stop() sends SIGTERM then SIGINT after 500ms for WSL backend", () => {
    const session = new DockerLogSession("s5", wslBackend, "default", "abc123");
    session.start();
    session.stop();

    expect(mockChild.lastSignal).toBe("SIGTERM");

    // Before 500ms deadline, no SIGINT yet
    mockChild.lastSignal = null;
    vi.advanceTimersByTime(499);
    expect(mockChild.lastSignal).toBeNull();

    // At 500ms, SIGINT fires
    vi.advanceTimersByTime(1);
    expect(mockChild.lastSignal).toBe("SIGINT");
  });

  test("start() called again before the old child closes (defensive restart) clears a pending WSL kill timer", () => {
    const session = new DockerLogSession("s-defensive", wslBackend, "default", "abc123");
    session.start();
    session.stop(); // WSL: sends SIGTERM immediately, schedules a SIGINT follow-up in 500ms

    // Simulate a fresh start() before the old child's "close" event fires —
    // the "defensive restart" branch at the top of start(). It must cancel
    // the stale kill timer, not just drop the reference to it.
    const secondChild = new MockChild();
    mockSpawn.mockReturnValueOnce(secondChild);
    session.start();

    mockChild.lastSignal = null;

    // Advance past where the stale 500ms SIGINT timer would have fired.
    vi.advanceTimersByTime(600);

    // Nothing should receive a delayed SIGINT — the old child is gone and the
    // newly-respawned child was never a valid target for that follow-up.
    expect(mockChild.lastSignal).toBeNull();
    expect(secondChild.lastSignal).toBeNull();
  });

  test("stop() is a no-op when session not started", () => {
    const session = new DockerLogSession("s6", hostBackend, "default", "abc123");
    expect(() => session.stop()).not.toThrow();
  });

  test("start() passes --tail and --timestamps options to docker logs", () => {
    const session = new DockerLogSession("s-opts", hostBackend, "default", "abc", { tail: 500, timestamps: true });
    session.start();
    const args = mockSpawn.mock.calls[0][1] as string[];
    expect(args).toContain("--tail");
    expect(args[args.indexOf("--tail") + 1]).toBe("500");
    expect(args).toContain("--timestamps");
  });

  test("start() defaults tail to 1000 and omits --timestamps when not requested", () => {
    const session = new DockerLogSession("s-default", hostBackend, "default", "abc");
    session.start();
    const args = mockSpawn.mock.calls[0][1] as string[];
    expect(args[args.indexOf("--tail") + 1]).toBe("1000");
    expect(args).not.toContain("--timestamps");
  });

  test("start() honors tail='all'", () => {
    const session = new DockerLogSession("s-all", hostBackend, "default", "abc", { tail: "all" });
    session.start();
    const args = mockSpawn.mock.calls[0][1] as string[];
    expect(args[args.indexOf("--tail") + 1]).toBe("all");
  });

  test("getOptions() returns current options after restart", () => {
    const session = new DockerLogSession("s-get", hostBackend, "default", "abc", { tail: 100 });
    session.start();
    // Each call returns a new child; queue a second for the restart respawn.
    const secondChild = new MockChild();
    mockSpawn.mockReturnValueOnce(secondChild);
    session.restart({ timestamps: true, tail: 5000 });
    // restart triggers stop() on first child, then close event triggers respawn
    mockChild.emit("close", 0);
    expect(session.getOptions()).toEqual({ timestamps: true, tail: 5000 });
  });

  test("restart() respawns with updated args after old child closes", () => {
    const session = new DockerLogSession("s-restart", hostBackend, "default", "abc", { tail: 100 });
    session.start();
    expect(mockSpawn).toHaveBeenCalledTimes(1);

    // Prepare the second child that will be returned for the respawn
    const secondChild = new MockChild();
    mockSpawn.mockReturnValueOnce(secondChild);

    session.restart({ timestamps: true });
    // Old child must have been signalled
    expect(mockChild.lastSignal).toBe("SIGTERM");
    // Respawn happens only after old child's "close" event
    mockChild.emit("close", 0);
    expect(mockSpawn).toHaveBeenCalledTimes(2);
    const newArgs = mockSpawn.mock.calls[1][1] as string[];
    expect(newArgs).toContain("--timestamps");
  });

  test("spawn() throwing synchronously emits error + close(1) without crashing", () => {
    const session = new DockerLogSession("s-throw", hostBackend, "default", "abc");
    mockSpawn.mockImplementationOnce(() => {
      throw new Error("ENOENT: docker not found");
    });
    const errors: Error[] = [];
    const closes: Array<number | null> = [];
    session.on("error", (e: Error) => errors.push(e));
    session.on("close", (c: number | null) => closes.push(c));

    expect(() => session.start()).not.toThrow();
    expect(errors[0].message).toContain("ENOENT");
    expect(closes).toEqual([1]);
  });

  test("runtime error event from child surfaces via 'error' event", () => {
    const session = new DockerLogSession("s-runtime", hostBackend, "default", "abc");
    const errors: Error[] = [];
    session.on("error", (e: Error) => errors.push(e));

    session.start();
    mockChild.emit("error", new Error("broken pipe"));

    expect(errors[0].message).toBe("broken pipe");
  });

  test("host session spawns docker directly with --context and --tail flags", () => {
    const session = new DockerLogSession("s7", hostBackend, "my-ctx", "cid123");
    session.start();

    expect(mockSpawn).toHaveBeenCalledWith(
      "docker",
      ["--context", "my-ctx", "logs", "-f", "--tail", "1000", "cid123"],
      expect.any(Object),
    );
  });

  test("WSL session wraps command in shell string with --context flag", () => {
    const session = new DockerLogSession("s8", wslBackend, "my-ctx", "cid123");
    session.start();

    expect(mockSpawn).toHaveBeenCalledWith("wsl.exe", expect.arrayContaining(["-e", "sh", "-lc"]), expect.any(Object));
    const callArgs = mockSpawn.mock.calls[0]![1] as string[];
    const shellCmd = callArgs[callArgs.length - 1] as string;
    expect(shellCmd).toContain("--context");
    expect(shellCmd).toContain("my-ctx");
    expect(shellCmd).toContain("logs");
    expect(shellCmd).toContain("cid123");
  });
});

describe("DockerLogManager", () => {
  test("openSession delivers data via callback", () => {
    const manager = new DockerLogManager();
    const chunks: string[] = [];

    manager.openSession(
      "m1",
      hostBackend,
      "default",
      "abc",
      (_sid, d) => chunks.push(d.toString()),
      () => {},
    );

    mockChild.stdout.emit("data", Buffer.from("log line"));
    expect(chunks).toEqual(["log line"]);
  });

  test("closeSession stops the session and removes it", () => {
    const manager = new DockerLogManager();
    manager.openSession(
      "m2",
      hostBackend,
      "default",
      "abc",
      () => {},
      () => {},
    );
    expect(manager.hasSession("m2")).toBe(true);

    manager.closeSession("m2");
    expect(manager.hasSession("m2")).toBe(false);
    expect(mockChild.lastSignal).toBe("SIGTERM");
  });

  test("opening a session with the same ID closes the previous one first", () => {
    const manager = new DockerLogManager();
    const firstChild = new MockChild();
    const secondChild = new MockChild();
    mockSpawn.mockReturnValueOnce(firstChild).mockReturnValueOnce(secondChild);

    manager.openSession(
      "dup",
      hostBackend,
      "default",
      "c1",
      () => {},
      () => {},
    );
    manager.openSession(
      "dup",
      hostBackend,
      "default",
      "c2",
      () => {},
      () => {},
    );

    expect(firstChild.lastSignal).toBe("SIGTERM");
    expect(manager.hasSession("dup")).toBe(true);
  });

  test("closeAll stops all open sessions", () => {
    const manager = new DockerLogManager();
    const c1 = new MockChild();
    const c2 = new MockChild();
    mockSpawn.mockReturnValueOnce(c1).mockReturnValueOnce(c2);

    manager.openSession(
      "a",
      hostBackend,
      "default",
      "c1",
      () => {},
      () => {},
    );
    manager.openSession(
      "b",
      hostBackend,
      "default",
      "c2",
      () => {},
      () => {},
    );
    manager.closeAll();

    expect(manager.hasSession("a")).toBe(false);
    expect(manager.hasSession("b")).toBe(false);
    expect(c1.lastSignal).toBe("SIGTERM");
    expect(c2.lastSignal).toBe("SIGTERM");
  });
});

describe("DockerLogManager — options + update", () => {
  test("openSession with options forwards tail + timestamps to session", () => {
    const manager = new DockerLogManager();
    manager.openSession(
      "s1",
      hostBackend,
      "default",
      "abc",
      () => {},
      () => {},
      { tail: 50, timestamps: true },
    );
    const args = mockSpawn.mock.calls[0][1] as string[];
    expect(args[args.indexOf("--tail") + 1]).toBe("50");
    expect(args).toContain("--timestamps");
  });

  test("updateSession returns false for unknown sessionId", () => {
    const manager = new DockerLogManager();
    expect(manager.updateSession("nope", { tail: 100 })).toBe(false);
  });

  test("updateSession restarts existing session with new options", () => {
    const manager = new DockerLogManager();
    manager.openSession(
      "s2",
      hostBackend,
      "default",
      "abc",
      () => {},
      () => {},
      { tail: 100 },
    );
    const second = new MockChild();
    mockSpawn.mockReturnValueOnce(second);
    const ok = manager.updateSession("s2", { tail: 9999 });
    expect(ok).toBe(true);
    mockChild.emit("close", 0);
    const args = mockSpawn.mock.calls[1][1] as string[];
    expect(args[args.indexOf("--tail") + 1]).toBe("9999");
  });
});
