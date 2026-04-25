import { describe, expect, test } from "vitest";
import { DockerManager } from "./docker-manager.js";
import type { DockerState } from "../shared/types/state.js";

interface DockerBackendDef {
  type: "host" | "wsl";
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

  constructor({ backend, lazydockerBackend = null, responses = {} }: FakeConstructorArgs) {
    super();
    // @ts-expect-error accessing private fields for test override
    this.backend = backend;
    // @ts-expect-error accessing private fields for test override
    this.lazydockerBackend = lazydockerBackend;
    this.responses = responses;
    this.commands = [];
  }

  override async detectBackend() {
    // @ts-expect-error accessing private fields for test override
    return this.backend as DockerBackendDef;
  }

  override async detectLazydocker() {
    // @ts-expect-error accessing private fields for test override
    return this.lazydockerBackend as DockerBackendDef | null;
  }

  override async runDocker(args: string[]): Promise<{ stdout: string; stderr: string }> {
    this.commands.push(args);
    const key = args.join(" ");
    if (this.responses[key] instanceof Error) {
      throw this.responses[key];
    }
    return this.responses[key] || { stdout: "", stderr: "" };
  }
}

describe("DockerManager", () => {
  test("refresh builds snapshot from docker json lines", async () => {
    const manager = new FakeDockerManager({
      backend: { type: "wsl", file: "wsl.exe", argsPrefix: ["-e", "sh", "-lc"] },
      lazydockerBackend: { type: "wsl", file: "wsl.exe", argsPrefix: ["-e", "sh", "-lc"] },
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
    expect(snapshot.backend).toBe("wsl");
    expect(snapshot.lazydocker.available).toBe(true);
    expect(snapshot.contexts).toHaveLength(1);
    expect(snapshot.containers).toHaveLength(2);
    expect(snapshot.containers[0].Names).toBe("redis-dev");
  });

  test("createShellLaunch uses WSL wrapper when backend lives in WSL", () => {
    const manager = new FakeDockerManager({
      backend: { type: "wsl", file: "wsl.exe", argsPrefix: ["-e", "sh", "-lc"] },
    });

    const launch = manager.createShellLaunch("abc123");

    expect(launch!.file).toBe("wsl.exe");
    expect(launch!.args.slice(0, 3)).toEqual(["-e", "sh", "-lc"]);
    expect(launch!.args[3]).toContain("docker");
    expect(launch!.args[3]).toContain("exec");
    expect(launch!.args[3]).toContain("abc123");
  });

  test("performAction maps remove to rm -f", async () => {
    const manager = new FakeDockerManager({
      backend: { type: "host", file: "docker", argsPrefix: [] },
      responses: {
        "rm -f abc123": { stdout: "", stderr: "" },
      },
    });

    manager.refresh = async (): Promise<DockerState> => manager.getSnapshot();
    await manager.performAction("remove", "abc123");

    expect(manager.commands[0]).toEqual(["rm", "-f", "abc123"]);
  });

  test("createLazydockerLaunch uses the detected lazydocker backend", () => {
    const manager = new FakeDockerManager({
      backend: { type: "wsl", file: "wsl.exe", argsPrefix: ["-e", "sh", "-lc"] },
      lazydockerBackend: { type: "wsl", file: "wsl.exe", argsPrefix: ["-e", "sh", "-lc"] },
    });

    const launch = manager.createLazydockerLaunch();

    expect(launch!.file).toBe("wsl.exe");
    expect(launch!.args).toEqual(["-e", "sh", "-lc", "lazydocker"]);
  });
});
