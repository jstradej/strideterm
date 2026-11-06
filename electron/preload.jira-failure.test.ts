import { beforeAll, describe, expect, it, vi } from "vitest";
import ts from "typescript";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { JIRA_IPC_FAILURE_MARKER } from "./shared/jira-ipc-failure.js";

const invoke = vi.fn();
const exposed: Record<string, (...args: unknown[]) => Promise<unknown>> = {};

beforeAll(() => {
  // Vite does not transpile .cts, and the real preload cannot be imported outside Electron: compile it the way
  // tsc does and run it against a fake `electron`.
  const source = readFileSync(resolve(process.cwd(), "electron/preload.cts"), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const electron = {
    contextBridge: {
      exposeInMainWorld: (_name: string, api: Record<string, (...args: unknown[]) => Promise<unknown>>) => {
        Object.assign(exposed, api);
      },
    },
    ipcRenderer: { invoke, on: vi.fn(), send: vi.fn(), removeListener: vi.fn(), removeAllListeners: vi.fn() },
  };
  const module = { exports: {} };
  vm.runInNewContext(`(function (require, module, exports, process, window) {${compiled}
})`)(
    (id: string) => {
      if (id === "electron") return electron;
      throw new Error(`unexpected require(${id})`);
    },
    module,
    module.exports,
    { argv: [] },
    { addEventListener: vi.fn(), removeEventListener: vi.fn() },
  );
});

describe("preload Jira failure envelope", () => {
  it("uses the same marker the main process answers with, and sends every Jira channel through the wrapper", () => {
    const source = readFileSync(resolve(process.cwd(), "electron/preload.cts"), "utf8");
    expect(source).toContain(`"${JIRA_IPC_FAILURE_MARKER}"`);
    expect(source).not.toMatch(/ipcRenderer\.invoke\("jira:/);
  });

  it("turns the envelope back into an Error carrying jiraError and code", async () => {
    invoke.mockResolvedValueOnce({ [JIRA_IPC_FAILURE_MARKER]: 1, message: "Sign in again.", code: "auth-expired" });
    const error = (await exposed.getJiraIssue({}).catch((cause: unknown) => cause)) as Error & {
      code?: string;
      jiraError?: { code: string; retryAfterMs?: number };
    };
    // Created in the preload's own vm realm, so not `instanceof` this realm's Error.
    expect(Object.prototype.toString.call(error)).toBe("[object Error]");
    expect(error.message).toBe("Sign in again.");
    expect(error.code).toBe("auth-expired");
    expect(error.jiraError).toEqual({ code: "auth-expired" });
    expect(invoke).toHaveBeenLastCalledWith("jira:issue", {});

    invoke.mockResolvedValueOnce({
      [JIRA_IPC_FAILURE_MARKER]: 1,
      message: "Slow down.",
      code: "rate-limited",
      retryAfterMs: 2500,
    });
    const limited = (await exposed.searchJiraIssues({}).catch((cause: unknown) => cause)) as {
      jiraError: unknown;
    };
    expect(limited.jiraError).toEqual({ code: "rate-limited", retryAfterMs: 2500 });
  });

  it("reads the task channels that look up Jira issues through the same wrapper", async () => {
    for (const [method, channel] of [
      ["createTaskWorkspace", "task:create-workspace"],
      ["startTask", "task:start"],
      ["azureQuickFixCreate", "azure:quickfix:create"],
      ["githubQuickFixCreate", "github:quickfix:create"],
    ] as const) {
      invoke.mockResolvedValueOnce({ [JIRA_IPC_FAILURE_MARKER]: 1, message: "Sign in again.", code: "auth-expired" });
      const error = (await exposed[method]({}).catch((cause: unknown) => cause)) as {
        code?: string;
        jiraError?: unknown;
      };
      expect(error.jiraError).toEqual({ code: "auth-expired" });
      expect(error.code).toBe("auth-expired");
      expect(invoke).toHaveBeenLastCalledWith(channel, {});
    }
  });

  it("passes an ordinary result through untouched", async () => {
    invoke.mockResolvedValueOnce({ ok: true });
    await expect(exposed.getJiraIssue({})).resolves.toEqual({ ok: true });
  });
});
