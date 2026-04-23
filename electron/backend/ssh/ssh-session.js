import { Client } from "ssh2";

const KEEPALIVE_INTERVAL = 30000;
const KEEPALIVE_MAX = 3;
const READY_TIMEOUT = 20000;

export class SshSession {
  constructor(opts) {
    this.host = opts.host;
    this.auth = opts.auth || {};
    this.jumps = opts.jumps || [];
    this.dimensions = opts.dimensions || { cols: 80, rows: 24 };
    this.verify = opts.verify;
    this.onData = opts.onData;
    this.onExit = opts.onExit;
    this.onAuthPrompt = opts.onAuthPrompt;
    this.onHostKeyDecision = opts.onHostKeyDecision;
    this.onReady = opts.onReady;
    this.client = null;
    this.stream = null;
    this.jumpClients = [];
    this.ready = false;
    this.ended = false;
    // Populated by the primary host verifier; the manager persists this on
    // successful connect for first-time hosts under accept-new/warn policy.
    this.verifiedHostKey = null;
  }

  async start() {
    const sock = await this._connectChain();

    return new Promise((resolve, reject) => {
      const client = new Client();
      this.client = client;

      let settled = false;
      const finish = (fn, arg) => {
        if (settled) return;
        settled = true;
        fn(arg);
      };

      client
        .on("ready", () => {
          this.ready = true;
          client.shell(
            {
              term: "xterm-256color",
              cols: this.dimensions.cols || 80,
              rows: this.dimensions.rows || 24,
            },
            (err, stream) => {
              if (err) {
                finish(reject, err);
                return;
              }
              this.stream = stream;
              stream.on("data", (buf) => this.onData?.(buf.toString("utf-8")));
              stream.stderr.on("data", (buf) => this.onData?.(buf.toString("utf-8")));
              stream.on("close", (code, signal) => {
                if (this.ended) return;
                this.ended = true;
                this.onExit?.({ exitCode: typeof code === "number" ? code : 0, signal: signal || null });
              });
              try {
                this.onReady?.();
              } catch {
                // reporting failure should never break the shell
              }
              if (this.host.advanced?.command) {
                stream.write(this.host.advanced.command + "\r");
              }
              finish(resolve);
            },
          );
        })
        .on("keyboard-interactive", (name, instructions, _lang, prompts, finishPrompt) => {
          this.onAuthPrompt?.({ name, instructions, prompts, finish: finishPrompt });
        })
        .on("banner", (msg) => this.onData?.(msg))
        .on("error", (err) => {
          if (this.ready) {
            // Post-ready errors: treat as exit with nonzero code, not as start() reject.
            if (this.ended) return;
            this.ended = true;
            this.onExit?.({ exitCode: 1, signal: null, error: err.message });
            return;
          }
          finish(reject, err);
        })
        .on("close", () => {
          if (!this.ready) {
            finish(reject, new Error("Connection closed before ready"));
            return;
          }
          if (this.ended) return;
          this.ended = true;
          this.onExit?.({ exitCode: 0, signal: null });
        });

      client.connect(this._buildConnectConfig(sock));
    });
  }

  async _connectChain() {
    if (this.jumps.length === 0) return null;

    let currentSock = null;
    this.jumpClients = [];

    for (let i = 0; i < this.jumps.length; i += 1) {
      const jump = this.jumps[i];
      const jumpClient = new Client();
      this.jumpClients.push(jumpClient);

      await new Promise((resolveConnect, rejectConnect) => {
        let settled = false;
        const settle = (fn, arg) => {
          if (settled) return;
          settled = true;
          fn(arg);
        };
        jumpClient.on("ready", () => settle(resolveConnect));
        jumpClient.on("error", (err) => settle(rejectConnect, err));
        jumpClient.on("close", () => {
          if (!settled) settle(rejectConnect, new Error("Jump connection closed"));
        });

        const cfg = {
          host: jump.host.host,
          port: jump.host.port || 22,
          username: jump.host.username,
          ...jump.auth,
          readyTimeout: READY_TIMEOUT,
          hostVerifier: this._makeHostVerifier(jump.host, jump.verify),
        };
        if (currentSock) cfg.sock = currentSock;
        jumpClient.connect(cfg);
      });

      const nextHost = i + 1 < this.jumps.length ? this.jumps[i + 1].host : this.host;
      const nextPort = nextHost.port || 22;

      currentSock = await new Promise((resolveForward, rejectForward) => {
        jumpClient.forwardOut("127.0.0.1", 0, nextHost.host, nextPort, (err, stream) => {
          if (err) rejectForward(err);
          else resolveForward(stream);
        });
      });
    }

    return currentSock;
  }

  _buildConnectConfig(sock) {
    const cfg = {
      host: this.host.host,
      port: this.host.port || 22,
      username: this.host.username,
      ...this.auth,
      readyTimeout: READY_TIMEOUT,
      keepaliveInterval: this.host.advanced?.keepaliveIntervalMs ?? KEEPALIVE_INTERVAL,
      keepaliveCountMax: this.host.advanced?.keepaliveCountMax ?? KEEPALIVE_MAX,
      compress: this.host.advanced?.compression !== false,
      algorithms: this.host.advanced?.algorithms || undefined,
      hostVerifier: this._makeHostVerifier(this.host, this.verify, (info) => {
        this.verifiedHostKey = info;
      }),
    };
    if (sock) cfg.sock = sock;
    return cfg;
  }

  // `hostVerifier` in ssh2 receives the raw host key Buffer (plus a callback
  // for async verdict). We compute the fingerprint ourselves, check the store,
  // and escalate to the user on mismatch via onHostKeyDecision.
  _makeHostVerifier(host, verify, onAccepted) {
    return (keyOrHash, callback) => {
      try {
        const result = verify ? verify({ key: keyOrHash }) : { ok: true };
        if (result && typeof result === "object") {
          if (result.ok === true) {
            // Capture fingerprint so the caller can persist it on successful
            // connect (handles first-time TOFU acceptance).
            if (result.first && result.fingerprint && typeof onAccepted === "function") {
              onAccepted({ fingerprint: result.fingerprint, keyType: result.keyType, first: true });
            }
            if (typeof callback === "function") callback(true);
            return true;
          }
          if (result.mismatch && this.onHostKeyDecision) {
            this.onHostKeyDecision(
              { fingerprint: result.fingerprint, keyType: result.keyType, previous: result.previous },
              (accept) => {
                if (accept && typeof onAccepted === "function") {
                  onAccepted({ fingerprint: result.fingerprint, keyType: result.keyType, first: false });
                }
                if (typeof callback === "function") callback(!!accept);
              },
            );
            return; // decision pending
          }
          // strict new-host rejection
          if (typeof callback === "function") callback(false);
          return false;
        }
        // Backward-compat: legacy verify that returned a plain boolean.
        if (typeof callback === "function") callback(!!result);
        return !!result;
      } catch {
        if (typeof callback === "function") callback(false);
        return false;
      }
    };
  }

  write(data) {
    if (this.stream) this.stream.write(data);
  }

  resize(cols, rows) {
    if (this.stream) this.stream.setWindow(rows, cols, 0, 0);
  }

  async stop() {
    try {
      if (this.stream) this.stream.end();
    } catch {
      // already closed
    }
    try {
      if (this.client) this.client.end();
    } catch {
      // already closed
    }
    for (const jc of this.jumpClients) {
      try {
        jc.end();
      } catch {
        // already closed
      }
    }
    this.ready = false;
  }
}
