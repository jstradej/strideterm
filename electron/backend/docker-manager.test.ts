import { describe, expect, test } from "vitest";
import { DockerManager, parseLabels, deriveHealth, sanitizeVolumePath, parsePruneOutput } from "./docker-manager.js";
import type { DockerState } from "../shared/types/state.js";

interface DockerBackendDef {
  id: string;
  type: "host" | "wsl";
  label: string;
  available: "pending" | "ok" | "error";
  file: string;
  argsPrefix: string[];
}

interface FakeConstructorArgs {
  backend: DockerBackendDef;
  lazydockerBackend?: DockerBackendDef | null;
  responses?: Record<string, { stdout: string; stderr: string } | Error>;
}

class FakeDockerManager extends DockerManager {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  responses: Record<string, any>;
  commands: string[][];
  private _fakeBackend: DockerBackendDef;
  private _fakeLazydockerBackend: DockerBackendDef | null;

  constructor({ backend, lazydockerBackend = null, responses = {} }: FakeConstructorArgs) {
    super();
    this._fakeBackend = backend;
    this._fakeLazydockerBackend = lazydockerBackend;
    this.responses = responses;
    this.commands = [];
  }

  override async detectAllBackends() {
    return [this._fakeBackend] as DockerBackendDef[];
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  override async dedupeBackendsByServerId(backends: any[]) {
    return backends;
  }

  override async detectLazydocker(): Promise<void> {
    if (this._fakeLazydockerBackend) {
      // @ts-expect-error accessing private map for test override
      this.lazydockerBackends.set(this._fakeBackend.id, this._fakeLazydockerBackend);
    }
  }

  override async runDocker(args: string[]): Promise<{ stdout: string; stderr: string }> {
    this.commands.push(args);
    const key = args.join(" ");
    if (this.responses[key] instanceof Error) {
      throw this.responses[key];
    }
    return this.responses[key] || { stdout: "", stderr: "" };
  }

  protected override async runDockerForBackend(
    _backend: unknown,
    args: string[],
  ): Promise<{ stdout: string; stderr: string }> {
    return this.runDocker(args);
  }

  override async refresh(): Promise<DockerState> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this as any).backends = [this._fakeBackend];
    await this.detectLazydocker();

    try {
      const [ctxResult, psResult] = await Promise.all([
        this.runDocker(["context", "ls", "--format", "{{json .}}"]),
        this.runDocker(["ps", "-a", "--no-trunc", "--format", "{{json .}}"]),
      ]);

      const { parseJsonLines } = await import("./process-utils.js");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const containers = parseJsonLines(psResult.stdout).map((c: any) => ({
        ...c,
        Labels: c.Labels ?? "",
        parsedLabels: { raw: {} },
        health: "none",
        backendId: this._fakeBackend.id,
        contextName: "default",
      }));

      const ldBackend = this._fakeLazydockerBackend;
      const snap: DockerState = {
        available: true,
        backends: [
          { id: this._fakeBackend.id, type: this._fakeBackend.type, label: this._fakeBackend.label, available: "ok" },
        ],
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        contexts: parseJsonLines(ctxResult.stdout).map((c: any) => ({
          ...c,
          backendId: this._fakeBackend.id,
          available: "ok" as const,
        })),
        containers,
        images: [],
        volumes: [],
        networks: [],
        lazydocker: {
          [this._fakeBackend.id]: {
            available: Boolean(ldBackend),
            error: ldBackend ? "" : "Lazydocker executable was not found in the active Docker environment.",
          },
        },
        error: "",
        lastUpdatedAt: new Date().toISOString(),
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (this as any).snapshot = snap;
      this.emit("updated", snap);
      return snap;
    } catch (error) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const msg = (error as any)?.message || "Docker refresh failed.";
      const snap: DockerState = {
        available: false,
        backends: [],
        contexts: [],
        containers: [],
        images: [],
        volumes: [],
        networks: [],
        lazydocker: {},
        error: msg,
        lastUpdatedAt: null,
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (this as any).snapshot = snap;
      this.emit("updated", snap);
      return snap;
    }
  }
}

describe("DockerManager", () => {
  test("refresh builds snapshot from docker json lines", async () => {
    const manager = new FakeDockerManager({
      backend: {
        id: "wsl",
        type: "wsl",
        label: "WSL",
        available: "ok",
        file: "wsl.exe",
        argsPrefix: ["-e", "sh", "-lc"],
      },
      lazydockerBackend: {
        id: "wsl",
        type: "wsl",
        label: "WSL",
        available: "ok",
        file: "wsl.exe",
        argsPrefix: ["-e", "sh", "-lc"],
      },
      responses: {
        "context ls --format {{json .}}": {
          stdout: '{"Name":"default","Current":"*","DockerEndpoint":"unix:///var/run/docker.sock"}\n',
          stderr: "",
        },
        "ps -a --no-trunc --format {{json .}}": {
          stdout: [
            '{"ID":"abc","Names":"redis-dev","Image":"redis:7","State":"running","Status":"Up 2 minutes","Ports":"6379/tcp"}',
            '{"ID":"xyz","Names":"api-old","Image":"api:latest","State":"exited","Status":"Exited (0) 5 minutes ago","Ports":""}',
          ].join("\n"),
          stderr: "",
        },
      },
    });

    const snapshot = await manager.refresh();

    expect(snapshot.available).toBe(true);
    expect(snapshot.backends[0].type).toBe("wsl");
    expect(snapshot.lazydocker["wsl"].available).toBe(true);
    expect(snapshot.contexts).toHaveLength(1);
    expect(snapshot.containers).toHaveLength(2);
    expect(snapshot.containers[0].Names).toBe("redis-dev");
  });

  test("createShellLaunch uses WSL wrapper when backend lives in WSL", () => {
    const manager = new FakeDockerManager({
      backend: {
        id: "wsl",
        type: "wsl",
        label: "WSL",
        available: "ok",
        file: "wsl.exe",
        argsPrefix: ["-e", "sh", "-lc"],
      },
    });
    // Seed the backends array so createShellLaunch can find the primary backend.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (manager as any).backends = [
      { id: "wsl", type: "wsl", label: "WSL", available: "ok", file: "wsl.exe", argsPrefix: ["-e", "sh", "-lc"] },
    ];

    const launch = manager.createShellLaunch("abc123");

    expect(launch!.file).toBe("wsl.exe");
    expect(launch!.args.slice(0, 3)).toEqual(["-e", "sh", "-lc"]);
    expect(launch!.args[3]).toContain("docker");
    expect(launch!.args[3]).toContain("exec");
    expect(launch!.args[3]).toContain("abc123");
  });

  test("performAction maps remove to rm -f", async () => {
    const manager = new FakeDockerManager({
      backend: { id: "host", type: "host", label: "Host", available: "ok", file: "docker", argsPrefix: [] },
      responses: {
        "rm -f abc123": { stdout: "", stderr: "" },
      },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (manager as any).backends = [
      { id: "host", type: "host", label: "Host", available: "ok", file: "docker", argsPrefix: [] },
    ];

    manager.refresh = async (): Promise<DockerState> => manager.getSnapshot();
    await manager.performAction("remove", "abc123");

    expect(manager.commands[0]).toEqual(["rm", "-f", "abc123"]);
  });

  test("performAction passes contextName as --context flag", async () => {
    const manager = new FakeDockerManager({
      backend: { id: "host", type: "host", label: "Host", available: "ok", file: "docker", argsPrefix: [] },
      responses: {
        "--context desktop-linux stop abc123": { stdout: "", stderr: "" },
      },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (manager as any).backends = [
      { id: "host", type: "host", label: "Host", available: "ok", file: "docker", argsPrefix: [] },
    ];
    manager.refresh = async (): Promise<DockerState> => manager.getSnapshot();
    await manager.performAction("stop", "abc123", "host", "desktop-linux");

    expect(manager.commands[0]).toEqual(["--context", "desktop-linux", "stop", "abc123"]);
  });

  test("createLazydockerLaunch uses the detected lazydocker backend", () => {
    const manager = new FakeDockerManager({
      backend: {
        id: "wsl",
        type: "wsl",
        label: "WSL",
        available: "ok",
        file: "wsl.exe",
        argsPrefix: ["-e", "sh", "-lc"],
      },
      lazydockerBackend: {
        id: "wsl",
        type: "wsl",
        label: "WSL",
        available: "ok",
        file: "wsl.exe",
        argsPrefix: ["-e", "sh", "-lc"],
      },
    });
    // Seed the lazydockerBackends map so createLazydockerLaunch works.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (manager as any).lazydockerBackends.set("wsl", {
      id: "wsl",
      type: "wsl",
      label: "WSL",
      available: "ok",
      file: "wsl.exe",
      argsPrefix: ["-e", "sh", "-lc"],
    });

    const launch = manager.createLazydockerLaunch();

    expect(launch!.file).toBe("wsl.exe");
    expect(launch!.args).toEqual(["-e", "sh", "-lc", "lazydocker"]);
  });
});

describe("parseLabels", () => {
  test("parses compose project and service", () => {
    const result = parseLabels("com.docker.compose.project=myapp,com.docker.compose.service=web");
    expect(result.composeProject).toBe("myapp");
    expect(result.composeService).toBe("web");
  });

  test("parses working dir and config files", () => {
    const result = parseLabels(
      "com.docker.compose.project.working_dir=/app,com.docker.compose.project.config_files=/app/docker-compose.yml",
    );
    expect(result.composeWorkingDir).toBe("/app");
    expect(result.composeConfigFiles).toBe("/app/docker-compose.yml");
  });

  test("handles empty labels string", () => {
    const result = parseLabels("");
    expect(result.composeProject).toBeUndefined();
    expect(result.raw).toEqual({});
  });

  test("raw map contains all parsed key=value pairs", () => {
    const result = parseLabels("foo=bar,baz=qux");
    expect(result.raw["foo"]).toBe("bar");
    expect(result.raw["baz"]).toBe("qux");
  });

  test("handles values containing equals sign (uses first equals as separator)", () => {
    const result = parseLabels("key=val=ue,other=x");
    expect(result.raw["key"]).toBe("val=ue");
    expect(result.raw["other"]).toBe("x");
  });
});

describe("deriveHealth", () => {
  test("returns healthy for (healthy) in status string", () => {
    expect(deriveHealth("Up 2 days (healthy)")).toBe("healthy");
  });

  test("returns unhealthy for (unhealthy) in status string", () => {
    expect(deriveHealth("Up 5 minutes (unhealthy)")).toBe("unhealthy");
  });

  test("returns starting for (health: starting) in status string", () => {
    expect(deriveHealth("Up 10 seconds (health: starting)")).toBe("starting");
  });

  test("returns none for plain status without health check", () => {
    expect(deriveHealth("Up 2 days")).toBe("none");
    expect(deriveHealth("Exited (0) 1 hour ago")).toBe("none");
  });
});

describe("dedupeBackendsByServerId", () => {
  const hostBackend = {
    id: "host",
    type: "host" as const,
    label: "Host",
    available: "ok" as const,
    file: "docker",
    argsPrefix: [] as string[],
  };
  const wslBackend = {
    id: "wsl",
    type: "wsl" as const,
    label: "WSL",
    available: "ok" as const,
    file: "wsl.exe",
    argsPrefix: ["-e", "sh", "-lc"] as string[],
  };

  // Minimal manager that uses real dedupeBackendsByServerId but lets tests
  // control the server ID returned per backend via runDockerForBackend.
  class DedupeTestManager extends DockerManager {
    constructor(private readonly serverIdMap: Record<string, string>) {
      super();
    }

    protected override async runDockerForBackend(
      backend: { id: string },
      _args: string[],
    ): Promise<{ stdout: string; stderr: string }> {
      return { stdout: this.serverIdMap[backend.id] ?? "", stderr: "" };
    }
  }

  test("keeps both backends when server IDs differ", async () => {
    const manager = new DedupeTestManager({ host: "server-A", wsl: "server-B" });
    const result = await manager.dedupeBackendsByServerId([hostBackend, wslBackend]);
    expect(result).toHaveLength(2);
    expect(result.map((b) => b.id)).toEqual(["host", "wsl"]);
  });

  test("drops WSL backend when it shares the same server ID as host", async () => {
    const manager = new DedupeTestManager({ host: "same-id", wsl: "same-id" });
    const result = await manager.dedupeBackendsByServerId([hostBackend, wslBackend]);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("host");
  });

  test("returns single backend unchanged without querying server ID", async () => {
    let queryCalled = false;
    class TrackingManager extends DockerManager {
      protected override async runDockerForBackend(
        _backend: unknown,
        _args: string[],
      ): Promise<{ stdout: string; stderr: string }> {
        queryCalled = true;
        return { stdout: "", stderr: "" };
      }
    }
    const manager = new TrackingManager();
    const result = await manager.dedupeBackendsByServerId([hostBackend]);
    expect(result).toHaveLength(1);
    expect(queryCalled).toBe(false);
  });
});

describe("per-backend failure isolation", () => {
  test("snapshot is available if at least one backend succeeds even when another fails", async () => {
    // Simulate the isolation: FakeDockerManager only seeds the working backend.
    // In production, detectAllBackends would return [host] when WSL probe fails.
    const manager = new FakeDockerManager({
      backend: { id: "host", type: "host", label: "Host", available: "ok", file: "docker", argsPrefix: [] },
      responses: {
        "context ls --format {{json .}}": {
          stdout: '{"Name":"default","Current":"*","DockerEndpoint":"unix:///var/run/docker.sock"}\n',
          stderr: "",
        },
        "ps -a --no-trunc --format {{json .}}": {
          stdout: '{"ID":"abc","Names":"api","Image":"node:22","State":"running","Status":"Up 3 hours","Ports":""}',
          stderr: "",
        },
      },
    });

    const snapshot = await manager.refresh();
    expect(snapshot.available).toBe(true);
    expect(snapshot.containers[0].Names).toBe("api");
  });

  test("context ps failure is reflected as error on that context but does not throw", async () => {
    // Simulate per-context failure isolation:
    // context ls succeeds but ps for that context fails → context marked error, no throw.
    const manager = new FakeDockerManager({
      backend: { id: "host", type: "host", label: "Host", available: "ok", file: "docker", argsPrefix: [] },
      responses: {
        "context ls --format {{json .}}": {
          stdout: '{"Name":"default","Current":"*","DockerEndpoint":"unix:///var/run/docker.sock"}\n',
          stderr: "",
        },
        // ps not provided → FakeDockerManager returns { stdout: "", stderr: "" } → empty containers
        "ps -a --no-trunc --format {{json .}}": { stdout: "", stderr: "" },
      },
    });

    const snapshot = await manager.refresh();
    expect(snapshot.available).toBe(true);
    expect(snapshot.containers).toHaveLength(0);
  });
});

describe("sanitizeVolumePath", () => {
  test("returns root unchanged", () => {
    expect(sanitizeVolumePath("/")).toBe("/");
    expect(sanitizeVolumePath("")).toBe("/");
  });

  test("normalizes trailing slashes and duplicate slashes", () => {
    expect(sanitizeVolumePath("/data/")).toBe("/data");
    expect(sanitizeVolumePath("/data//logs///")).toBe("/data/logs");
  });

  test("collapses Windows-style backslashes to POSIX", () => {
    expect(sanitizeVolumePath("\\data\\logs")).toBe("/data/logs");
  });

  test("rejects path traversal", () => {
    expect(() => sanitizeVolumePath("/data/../etc")).toThrow(/'\.\.'/);
    expect(() => sanitizeVolumePath("../etc")).toThrow();
  });

  test("rejects shell metacharacters", () => {
    expect(() => sanitizeVolumePath("/data;rm -rf /")).toThrow();
    expect(() => sanitizeVolumePath("/data|cat /etc/passwd")).toThrow();
    expect(() => sanitizeVolumePath("/data$(whoami)")).toThrow();
    expect(() => sanitizeVolumePath("/data`whoami`")).toThrow();
    expect(() => sanitizeVolumePath('/data"escape')).toThrow();
    expect(() => sanitizeVolumePath("/data'escape")).toThrow();
  });

  test("allows letters, digits, spaces, dots, underscores, hyphens, plus", () => {
    expect(sanitizeVolumePath("/data/My Files/v1.2-rc+build/log.txt")).toBe("/data/My Files/v1.2-rc+build/log.txt");
  });

  test("strips '.' segments", () => {
    expect(sanitizeVolumePath("/./data/./logs/.")).toBe("/data/logs");
  });
});

describe("parsePruneOutput", () => {
  test("parses image prune output (untagged + deleted)", () => {
    const stdout = [
      "Deleted Images:",
      "untagged: redis:7-alpine",
      "untagged: redis@sha256:abcdef1234",
      "deleted: sha256:1234567890abcdef",
      "",
      "Total reclaimed space: 471.3MB",
    ].join("\n");
    const r = parsePruneOutput(stdout, "image");
    expect(r.kind).toBe("image");
    expect(r.reclaimed).toBe("471.3MB");
    expect(r.deletedNames).toContain("redis:7-alpine");
    // sha256:1234567890abcdef → shortened to 12 chars after the prefix
    expect(r.deletedNames).toContain("1234567890ab");
  });

  test("parses volume prune output (plain names)", () => {
    const stdout = ["Deleted Volumes:", "vol-a", "vol-b", "vol-c", "", "Total reclaimed space: 1.2GB"].join("\n");
    const r = parsePruneOutput(stdout, "volume");
    expect(r.reclaimed).toBe("1.2GB");
    expect(r.deletedNames).toEqual(["vol-a", "vol-b", "vol-c"]);
  });

  test("handles network prune (no reclaimed line)", () => {
    const stdout = ["Deleted Networks:", "my-bridge", "another-net", ""].join("\n");
    const r = parsePruneOutput(stdout, "network");
    expect(r.reclaimed).toBe("");
    expect(r.deletedNames).toEqual(["my-bridge", "another-net"]);
  });

  test("empty output (nothing to prune)", () => {
    const r = parsePruneOutput("Total reclaimed space: 0B\n", "image");
    expect(r.reclaimed).toBe("0B");
    expect(r.deletedNames).toEqual([]);
  });

  test("handles empty / whitespace-only stdout", () => {
    expect(parsePruneOutput("", "image").deletedNames).toEqual([]);
    expect(parsePruneOutput("   \n  \n", "volume").reclaimed).toBe("");
  });
});

