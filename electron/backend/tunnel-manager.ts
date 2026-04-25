/// <reference types="node" />
import { EventEmitter } from "node:events";
import { once } from "node:events";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { execFileText } from "./process-utils.js";
import { APP_CONFIG } from "../../config/app-config.js";

const QUICK_TUNNEL_URL = /(https:\/\/[a-z0-9-]+\.trycloudflare\.com)/i;

interface TunnelSnapshot {
  available: boolean;
  status: string;
  mode: string;
  publicUrl: string;
  localUrl: string;
  error: string;
  startedAt: string | null;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function createSnapshot(overrides: Partial<TunnelSnapshot> = {}): TunnelSnapshot {
  return {
    available: false,
    status: "idle",
    mode: APP_CONFIG.tunnel.mode,
    publicUrl: "",
    localUrl: "",
    error: "",
    startedAt: null,
    ...overrides,
  };
}

function resolveCloudflaredBinary(preferredBinary = ""): string {
  if (preferredBinary) {
    return preferredBinary;
  }

  const candidates = APP_CONFIG.tunnel.binaries;

  return candidates.find((candidate) => candidate === "cloudflared" || existsSync(candidate)) || "cloudflared";
}

export function extractQuickTunnelUrl(rawText: unknown): string {
  const match = String(rawText || "").match(QUICK_TUNNEL_URL);
  return match?.[1] || "";
}

export class CloudflareTunnelManager extends EventEmitter {
  private snapshot: TunnelSnapshot;
  private processHandle: ChildProcess | null;
  private stopRequested: boolean;
  private binaryPreference: string;
  private binary: string;

  constructor({ binaryPath = "" }: { binaryPath?: string } = {}) {
    super();
    this.snapshot = createSnapshot();
    this.processHandle = null;
    this.stopRequested = false;
    this.binaryPreference = String(binaryPath || "").trim();
    this.binary = resolveCloudflaredBinary(this.binaryPreference);
  }

  getSnapshot(): TunnelSnapshot {
    return clone(this.snapshot);
  }

  setBinaryPreference(binaryPath = ""): void {
    this.binaryPreference = String(binaryPath || "").trim();
    this.binary = resolveCloudflaredBinary(this.binaryPreference);
  }

  async refreshAvailability(): Promise<TunnelSnapshot> {
    try {
      this.binary = resolveCloudflaredBinary(this.binaryPreference);
      await execFileText(this.binary, ["--version"]);
      this.snapshot = {
        ...this.snapshot,
        available: true,
        error: this.snapshot.status === "idle" ? "" : this.snapshot.error,
      };
    } catch {
      this.snapshot = createSnapshot({
        ...this.snapshot,
        available: false,
        status: this.processHandle ? this.snapshot.status : "idle",
        error: this.binaryPreference
          ? "Configured cloudflared binary could not be started."
          : "cloudflared was not found on PATH.",
      });
    }

    this.emit("updated", this.getSnapshot());
    return this.getSnapshot();
  }

  async startQuickTunnel(localUrl: string): Promise<TunnelSnapshot> {
    await this.refreshAvailability();
    if (!this.snapshot.available) {
      throw new Error(this.snapshot.error || "cloudflared is unavailable.");
    }

    await this.stop({ preserveAvailability: true, quiet: true });

    this.stopRequested = false;
    this.processHandle = spawn(this.binary, ["tunnel", "--url", localUrl, "--no-autoupdate"], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    this.snapshot = createSnapshot({
      ...this.snapshot,
      available: true,
      status: "connecting",
      localUrl,
      publicUrl: "",
      error: "",
      startedAt: new Date().toISOString(),
    });
    this.emit("updated", this.getSnapshot());

    return new Promise((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        this.stop({ preserveAvailability: true, quiet: true }).catch(() => {});
        reject(new Error("Quick tunnel did not report a public URL."));
      }, APP_CONFIG.tunnel.connectTimeoutMs);

      const handleOutput = (chunk: Buffer | string) => {
        const url = extractQuickTunnelUrl(chunk.toString());
        if (!url || settled) {
          return;
        }

        settled = true;
        clearTimeout(timeout);
        this.snapshot = createSnapshot({
          ...this.snapshot,
          available: true,
          status: "connected",
          publicUrl: url,
          localUrl,
          error: "",
        });
        this.emit("updated", this.getSnapshot());
        resolve(this.getSnapshot());
      };

      const handleExit = (code: number | null) => {
        this.processHandle = null;
        clearTimeout(timeout);
        const wasRequested = this.stopRequested;
        this.stopRequested = false;

        if (wasRequested) {
          this.snapshot = createSnapshot({
            available: this.snapshot.available,
            error: "",
          });
          this.emit("updated", this.getSnapshot());
          if (!settled) {
            settled = true;
            resolve(this.getSnapshot());
          }
          return;
        }

        const message = code ? `cloudflared exited with code ${code}.` : "cloudflared exited unexpectedly.";
        this.snapshot = createSnapshot({
          available: this.snapshot.available,
          error: message,
        });
        this.emit("updated", this.getSnapshot());
        if (!settled) {
          settled = true;
          reject(new Error(message));
        }
      };

      this.processHandle!.stdout?.on("data", handleOutput);
      this.processHandle!.stderr?.on("data", handleOutput);
      this.processHandle!.once("exit", handleExit);
      this.processHandle!.once("error", (error: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        this.processHandle = null;
        this.snapshot = createSnapshot({
          available: this.snapshot.available,
          error: error.message || "Failed to launch cloudflared.",
        });
        this.emit("updated", this.getSnapshot());
        reject(error);
      });
    });
  }

  async stop({ preserveAvailability = false, quiet = false }: { preserveAvailability?: boolean; quiet?: boolean } = {}): Promise<TunnelSnapshot> {
    if (!this.processHandle) {
      this.snapshot = createSnapshot({
        available: preserveAvailability ? this.snapshot.available : false,
        error: preserveAvailability ? "" : this.snapshot.error,
      });
      if (!quiet) {
        this.emit("updated", this.getSnapshot());
      }
      return this.getSnapshot();
    }

    const processHandle = this.processHandle;
    this.stopRequested = true;
    processHandle.kill();
    await once(processHandle, "exit").catch(() => {});
    this.processHandle = null;
    this.snapshot = createSnapshot({
      available: preserveAvailability ? this.snapshot.available : false,
      error: "",
    });
    if (!quiet) {
      this.emit("updated", this.getSnapshot());
    }
    return this.getSnapshot();
  }
}
