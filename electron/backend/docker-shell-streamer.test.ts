import { describe, expect, test, vi, beforeEach, afterEach } from "vitest";

// Mock node-pty before the streamer imports it. `vi.hoisted` runs before any
// import is resolved so the fake ptySpawn captures the registration.
const mockPtySpawn = vi.hoisted(() => vi.fn());
vi.mock("node-pty", () => ({
  default: { spawn: mockPtySpawn },
  spawn: mockPtySpawn,
}));

import { DockerShellSession, DockerShellManager } from "./docker-shell-streamer.js";

interface MockPtyEvents {
  data: ((data: string) => void) | null;
  exit: ((evt: { exitCode: number }) => void) | null;
}

class MockPty {
  private events: MockPtyEvents = { data: null, exit: null };
  killed = false;
  lastResize: { cols: number; rows: number } | null = null;
  writes: string[] = [];

  onData(cb: (d: string) => void): void {
    this.events.data = cb;
  }

  onExit(cb: (e: { exitCode: number }) => void): void {
    this.events.exit = cb;
  }

  write(data: string): void {
    this.writes.push(data);
  }

  resize(cols: number, rows: number): void {
    this.lastResize = { cols, rows };
  }

  kill(): void {
    this.killed = true;
  }

  emitData(s: string): void {
    this.events.data?.(s);
  }

  emitExit(code: number): void {
    this.events.exit?.({ exitCode: code });
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

let pty: MockPty;

beforeEach(() => {
  pty = new MockPty();
  mockPtySpawn.mockReturnValue(pty);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("DockerShellSession", () => {
  test("emits data from pty", () => {
    const session = new DockerShellSession("s1", hostBackend, "default", "abc123");
    const received: string[] = [];
    session.on("data", (d: string) => received.push(d));

    session.start();
    pty.emitData("$ ");

    expect(received).toEqual(["$ "]);
  });

  test("emits close with exit code", () => {
    const session = new DockerShellSession("s2", hostBackend, "default", "abc123");
    let closedCode: number | null = -99;
    session.on("close", (code: number | null) => {
      closedCode = code;
    });

    session.start();
    pty.emitExit(0);

    expect(closedCode).toBe(0);
  });

  test("write() forwards to pty", () => {
    const session = new DockerShellSession("s3", hostBackend, "default", "abc123");
    session.start();
    session.write("ls -la\r");

    expect(pty.writes).toEqual(["ls -la\r"]);
  });

  test("write() is a no-op before start()", () => {
    const session = new DockerShellSession("s3a", hostBackend, "default", "abc123");
    session.write("dropped");

    expect(pty.writes).toEqual([]);
  });

  test("resize() forwards to pty", () => {
    const session = new DockerShellSession("s4", hostBackend, "default", "abc123");
    session.start();
    session.resize(120, 40);

    expect(pty.lastResize).toEqual({ cols: 120, rows: 40 });
  });

  test("resize() ignores non-positive dimensions", () => {
    const session = new DockerShellSession("s4b", hostBackend, "default", "abc123");
    session.start();
    session.resize(0, 40);
    session.resize(120, 0);

    expect(pty.lastResize).toBeNull();
  });

  test("stop() kills the pty", () => {
    const session = new DockerShellSession("s5", hostBackend, "default", "abc123");
    session.start();
    session.stop();

    expect(pty.killed).toBe(true);
  });

  test("host backend spawns docker directly with exec -it", () => {
    const session = new DockerShellSession("s6", hostBackend, "ctx-a", "abc123");
    session.start();

    expect(mockPtySpawn).toHaveBeenCalledTimes(1);
    const [file, args] = mockPtySpawn.mock.calls[0];
    expect(file).toBe("docker");
    expect(args).toEqual([
      "--context",
      "ctx-a",
      "exec",
      "-it",
      "abc123",
      "sh",
      "-lc",
      "command -v bash >/dev/null 2>&1 && exec bash || exec sh",
    ]);
  });

  test("wsl backend wraps docker in `sh -lc 'docker ...'`", () => {
    const session = new DockerShellSession("s7", wslBackend, "ctx-b", "def456");
    session.start();

    expect(mockPtySpawn).toHaveBeenCalledTimes(1);
    const [file, args] = mockPtySpawn.mock.calls[0];
    expect(file).toBe("wsl.exe");
    // Last arg is the assembled `docker ...` command string fed to `sh -lc`.
    // Each docker arg is single-quoted by quotePosixArg so it survives the
    // outer shell layer; that's the security-relevant invariant for WSL.
    expect(args.slice(0, 3)).toEqual(["-e", "sh", "-lc"]);
    const cmd = args[3] as string;
    expect(cmd.startsWith("docker '--context' 'ctx-b' 'exec' '-it' 'def456'")).toBe(true);
    expect(cmd).toContain("'command -v bash >/dev/null 2>&1 && exec bash || exec sh'");
  });

  test("spawn throwing surfaces close(1) and no exception", () => {
    mockPtySpawn.mockImplementationOnce(() => {
      throw new Error("ENOENT");
    });
    const session = new DockerShellSession("s8", hostBackend, "default", "abc123");
    let closedCode: number | null = -99;
    session.on("close", (code: number | null) => {
      closedCode = code;
    });

    expect(() => session.start()).not.toThrow();
    expect(closedCode).toBe(1);
  });

  test("write after exit is a no-op (pty cleared)", () => {
    const session = new DockerShellSession("s9", hostBackend, "default", "abc123");
    session.start();
    pty.emitExit(0);
    session.write("late");

    expect(pty.writes).toEqual([]);
  });
});

describe("DockerShellManager", () => {
  test("openSession stores and routes data + close callbacks", () => {
    const mgr = new DockerShellManager();
    const data: string[] = [];
    let closeCode: number | null = -99;

    mgr.openSession(
      "id1",
      hostBackend,
      "default",
      "c1",
      80,
      24,
      (_sid, d) => data.push(d),
      (_sid, code) => {
        closeCode = code;
      },
    );

    pty.emitData("prompt$ ");
    pty.emitExit(0);

    expect(data).toEqual(["prompt$ "]);
    expect(closeCode).toBe(0);
    expect(mgr.hasSession("id1")).toBe(false); // close removes from map
  });

  test("opening the same sessionId twice closes the previous one", () => {
    const mgr = new DockerShellManager();
    const ptys: MockPty[] = [];
    mockPtySpawn.mockImplementation(() => {
      const p = new MockPty();
      ptys.push(p);
      return p;
    });

    mgr.openSession("dup", hostBackend, "default", "c1", 80, 24, vi.fn(), vi.fn());
    mgr.openSession("dup", hostBackend, "default", "c1", 80, 24, vi.fn(), vi.fn());

    expect(ptys).toHaveLength(2);
    expect(ptys[0].killed).toBe(true);
    expect(ptys[1].killed).toBe(false);
  });

  test("writeSession / resizeSession route to the right pty", () => {
    const mgr = new DockerShellManager();
    mgr.openSession("rw", hostBackend, "default", "c1", 80, 24, vi.fn(), vi.fn());
    mgr.writeSession("rw", "x");
    mgr.resizeSession("rw", 100, 30);

    expect(pty.writes).toEqual(["x"]);
    expect(pty.lastResize).toEqual({ cols: 100, rows: 30 });
  });

  test("writeSession on an unknown id is a silent no-op", () => {
    const mgr = new DockerShellManager();
    expect(() => mgr.writeSession("ghost", "x")).not.toThrow();
  });

  test("closeAll kills every open session and clears the map", () => {
    const mgr = new DockerShellManager();
    const ptys: MockPty[] = [];
    mockPtySpawn.mockImplementation(() => {
      const p = new MockPty();
      ptys.push(p);
      return p;
    });

    mgr.openSession("a", hostBackend, "default", "c1", 80, 24, vi.fn(), vi.fn());
    mgr.openSession("b", hostBackend, "default", "c2", 80, 24, vi.fn(), vi.fn());
    mgr.closeAll();

    expect(ptys.every((p) => p.killed)).toBe(true);
    expect(mgr.hasSession("a")).toBe(false);
    expect(mgr.hasSession("b")).toBe(false);
  });
});
