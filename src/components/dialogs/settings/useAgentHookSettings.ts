import { onBeforeUnmount, onMounted, reactive, ref } from "vue";
import type { Transport } from "../../../transport.js";

interface HookProviderConfig {
  id: string;
  title: string;
  statusMethod: string;
  configureMethod: string;
  removeMethod: string;
  testMethod: string;
  configureLabel: string;
  configureTitle: string;
  removeTitle: string;
  testTitle: string;
  configJson: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  manual: Record<string, any>;
  infoText?: string;
  warningStatus?: string;
  warningText?: string;
  refreshAfterConfigure?: boolean;
}

interface TestResult {
  ok: boolean;
  reason?: string;
  detail?: string;
}

const HOOK_STATUS_LABELS = {
  configured: "Configured",
  partial: "Partial — upgrade available",
  "not-configured": "Not configured",
  "script-missing": "Script missing",
  "flag-missing": "Feature flag missing",
  "configured-but-disabled": "Configured — hooks disabled",
  error: "Error",
  unknown: "Checking...",
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function createHookProvider(api: any, config: HookProviderConfig) {
  const provider = reactive({
    id: config.id,
    title: config.title,
    configureLabel: config.configureLabel,
    configureTitle: config.configureTitle,
    removeTitle: config.removeTitle,
    testTitle: config.testTitle,
    configJson: config.configJson,
    manual: config.manual,
    infoText: config.infoText || "",
    warningStatus: config.warningStatus || "",
    warningText: config.warningText || "",
    status: "unknown",
    error: "",
    busy: false,
    testing: false,
    testResult: null as TestResult | null,
    copied: false,
    refresh: async () => {},
    configure: async () => {},
    remove: async () => {},
    test: async () => {},
    copyConfig: async () => {},
    dispose: () => {},
  });

  let copiedTimer: ReturnType<typeof setTimeout> | undefined;

  provider.refresh = async () => {
    if (!api?.[config.statusMethod]) {
      provider.status = "unknown";
      return;
    }
    try {
      const result = await api[config.statusMethod]();
      provider.status = result.status || "unknown";
    } catch {
      provider.status = "error";
    }
  };

  provider.configure = async () => {
    if (!api?.[config.configureMethod]) return;
    provider.busy = true;
    provider.error = "";
    try {
      const result = await api[config.configureMethod]();
      if (result.ok) {
        provider.status = "configured";
        if (config.refreshAfterConfigure) {
          await provider.refresh();
        }
      } else {
        provider.error = result.error || "Configuration failed.";
        provider.status = "error";
      }
    } catch (error) {
      provider.error = (error instanceof Error ? error.message : null) || "Unexpected error during configuration.";
      provider.status = "error";
    } finally {
      provider.busy = false;
    }
  };

  provider.remove = async () => {
    if (!api?.[config.removeMethod]) return;
    provider.busy = true;
    provider.error = "";
    try {
      const result = await api[config.removeMethod]();
      if (result.ok) {
        provider.status = "not-configured";
      } else {
        provider.error = result.error || "Removal failed.";
      }
    } catch (error) {
      provider.error = (error instanceof Error ? error.message : null) || "Unexpected error during removal.";
    } finally {
      provider.busy = false;
    }
  };

  provider.test = async () => {
    if (!api?.[config.testMethod]) return;
    provider.testing = true;
    provider.testResult = null;
    try {
      const result = await api[config.testMethod]();
      provider.testResult = result;
      if (result?.ok) {
        await provider.refresh();
      }
    } catch (error) {
      provider.testResult = {
        ok: false,
        reason: "exception",
        detail: (error instanceof Error ? error.message : null) || String(error),
      };
    } finally {
      provider.testing = false;
    }
  };

  provider.copyConfig = async () => {
    try {
      await navigator.clipboard.writeText(provider.configJson);
      provider.copied = true;
      if (copiedTimer) {
        clearTimeout(copiedTimer);
      }
      copiedTimer = setTimeout(() => {
        provider.copied = false;
        copiedTimer = undefined;
      }, 2000);
    } catch {
      // Clipboard API not available.
    }
  };

  provider.dispose = () => {
    if (copiedTimer) {
      clearTimeout(copiedTimer);
      copiedTimer = undefined;
    }
  };

  return provider;
}

function hookTestFailLabel(reason: string | undefined): string {
  switch (reason) {
    case "timeout":
      return "Hook did not arrive within 2s";
    case "notify-server-unavailable":
      return "Notify server is not running — enable Agent hook first";
    case "configure-failed":
      return "Could not configure Claude Code settings";
    case "config-error":
      return "Error reading Claude Code settings";
    case "spawn-failed":
    case "spawn-error":
      return "Could not launch notify.mjs — Node.js may be missing";
    case "exception":
      return "Unexpected error";
    default:
      return `Failed (${reason || "unknown"})`;
  }
}

function formatMetricsUptime(ms: number): string {
  const sec = Math.floor((ms || 0) / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hrs = Math.floor(min / 60);
  const remMin = min % 60;
  return remMin > 0 ? `${hrs}h ${remMin}m` : `${hrs}h`;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function useAgentHookSettings(api: any) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const metricsSnapshot = ref<any>(null);
  let metricsTimer: ReturnType<typeof setInterval> | undefined;

  async function refreshMetrics() {
    try {
      if (api?.getNotificationMetrics) {
        metricsSnapshot.value = await api.getNotificationMetrics();
      }
    } catch {
      // Best-effort — metrics viewer just shows stale or empty data.
    }
  }

  const providers = [
    createHookProvider(api, {
      id: "claude",
      title: "Claude Code",
      statusMethod: "getClaudeHookStatus",
      configureMethod: "configureClaudeHook",
      removeMethod: "removeClaudeHook",
      testMethod: "testClaudeHook",
      configureLabel: "Configure Claude Code",
      configureTitle:
        "Install strIDEterm hook entries into ~/.claude/settings.json so Claude Code fires Notification/Stop/SubagentStop/UserPromptSubmit events to the local listener. Merges with existing user hooks.",
      removeTitle: "Remove only strIDEterm's hook entries from ~/.claude/settings.json. Your own hooks stay intact.",
      testTitle:
        "End-to-end probe: spawns notify.mjs with a synthetic payload and measures round-trip latency to confirm the full pipeline (hook → HTTP listener → dispatcher) is live.",
      configJson: `{
  "hooks": {
    "Notification": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "node \\"~/.strideterm/hooks/notify.mjs\\"",
            "timeout": 5
          }
        ]
      }
    ]
  }
}`,
      manual: {
        type: "claude-doc",
        path: "~/.claude/settings.json",
        docsUrl: "https://github.com/jstradej/strideterm#agent-notification-hooks",
        docsLabel: "notify script",
      },
    }),
    createHookProvider(api, {
      id: "gemini",
      title: "Gemini CLI",
      statusMethod: "getGeminiHookStatus",
      configureMethod: "configureGeminiHook",
      removeMethod: "removeGeminiHook",
      testMethod: "testGeminiHook",
      configureLabel: "Configure Gemini CLI",
      configureTitle:
        "Install strIDEterm hook entries into ~/.gemini/settings.json. Registers AfterAgent, Notification, and BeforeAgent events (mapped to Claude-compatible names for the shared dispatcher). Preserves your existing Gemini settings.",
      removeTitle:
        "Remove only strIDEterm's hook entries from ~/.gemini/settings.json. Other Gemini config (MCP servers, extensions, user hooks) stays intact.",
      testTitle:
        "End-to-end probe through the shared notify.mjs. Confirms the Gemini hook → listener → dispatcher pipeline delivers events within 2 s.",
      configJson: `{
  "hooks": {
    "AfterAgent": [
      {
        "matcher": "*",
        "hooks": [
          {
            "name": "strideterm-Stop",
            "type": "command",
            "command": "node \\"~/.strideterm/hooks/notify.mjs\\" Stop",
            "timeout": 5000
          }
        ]
      }
    ],
    "Notification": [
      {
        "matcher": "*",
        "hooks": [
          {
            "name": "strideterm-Notification",
            "type": "command",
            "command": "node \\"~/.strideterm/hooks/notify.mjs\\" Notification",
            "timeout": 5000
          }
        ]
      }
    ],
    "BeforeAgent": [
      {
        "matcher": "*",
        "hooks": [
          {
            "name": "strideterm-UserPromptSubmit",
            "type": "command",
            "command": "node \\"~/.strideterm/hooks/notify.mjs\\" UserPromptSubmit",
            "timeout": 5000
          }
        ]
      }
    ]
  }
}`,
      manual: {
        type: "single-path",
        before: "If auto-configure fails, add this to",
        path: "~/.gemini/settings.json",
        after: ":",
      },
    }),
    createHookProvider(api, {
      id: "codex",
      title: "Codex CLI",
      statusMethod: "getCodexHookStatus",
      configureMethod: "configureCodexHook",
      removeMethod: "removeCodexHook",
      testMethod: "testCodexHook",
      configureLabel: "Configure Codex CLI",
      configureTitle:
        "Writes two files: (1) [features] codex_hooks = true into ~/.codex/config.toml (required for Codex to load hooks), (2) Stop + UserPromptSubmit entries into ~/.codex/hooks.json. Merges with existing settings.",
      removeTitle:
        "Remove only strIDEterm's hook entries from ~/.codex/hooks.json. The codex_hooks feature flag in config.toml is left alone — other hooks you may have rely on it.",
      testTitle:
        "End-to-end probe through the shared notify.mjs. Confirms the Codex hook → listener → dispatcher pipeline delivers events within 2 s.",
      configJson: `{
  "hooks": {
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "node \\"~/.strideterm/hooks/notify.mjs\\" Stop",
            "timeout": 5
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "node \\"~/.strideterm/hooks/notify.mjs\\" UserPromptSubmit",
            "timeout": 5
          }
        ]
      }
    ]
  }
}`,
      manual: {
        type: "double-path",
        firstPath: "~/.codex/config.toml",
        secondPath: "~/.codex/hooks.json",
      },
      infoText: "Requires Codex CLI 0.121.0+ on Windows.",
      warningStatus: "flag-missing",
      warningText:
        "Hooks are registered but the codex_hooks feature flag is not set in ~/.codex/config.toml. Click Configure to fix.",
    }),
    createHookProvider(api, {
      id: "copilot",
      title: "GitHub Copilot",
      statusMethod: "getCopilotHookStatus",
      configureMethod: "configureCopilotHook",
      removeMethod: "removeCopilotHook",
      testMethod: "testCopilotHook",
      configureLabel: "Configure GitHub Copilot",
      configureTitle:
        "Install strIDEterm hook entries into ~/.copilot/config.json. Registers sessionEnd and userPromptSubmitted events (mapped to Claude-compatible argv for the shared dispatcher). Preserves your existing Copilot settings.",
      removeTitle:
        "Remove only strIDEterm's hook entries from ~/.copilot/config.json. Other Copilot config (model, MCP servers, user hooks) stays intact.",
      testTitle:
        "End-to-end probe through the shared notify.mjs. Confirms the Copilot hook → listener → dispatcher pipeline delivers events within 2 s.",
      configJson: `{
  "hooks": {
    "sessionEnd": [
      {
        "type": "command",
        "bash": "node \\"~/.strideterm/hooks/notify.mjs\\" Stop",
        "powershell": "node \\"~/.strideterm/hooks/notify.mjs\\" Stop",
        "timeoutSec": 5
      }
    ],
    "userPromptSubmitted": [
      {
        "type": "command",
        "bash": "node \\"~/.strideterm/hooks/notify.mjs\\" UserPromptSubmit",
        "powershell": "node \\"~/.strideterm/hooks/notify.mjs\\" UserPromptSubmit",
        "timeoutSec": 5
      }
    ]
  }
}`,
      manual: {
        type: "single-path",
        before: "If auto-configure fails, add this to",
        path: "~/.copilot/config.json",
        after: ":",
      },
      infoText: "Requires GitHub Copilot CLI 1.0.32+.",
      warningStatus: "configured-but-disabled",
      warningText:
        "Hooks are registered but disableAllHooks is true in ~/.copilot/config.json. Set it back to false (or remove the key) to let hooks fire.",
      refreshAfterConfigure: true,
    }),
    createHookProvider(api, {
      id: "opencode",
      title: "OpenCode",
      statusMethod: "getOpencodeHookStatus",
      configureMethod: "configureOpencodeHook",
      removeMethod: "removeOpencodeHook",
      testMethod: "testOpencodeHook",
      configureLabel: "Configure OpenCode",
      configureTitle:
        "Install strIDEterm hook entries into the OpenCode config file (~/.config/opencode/config.json on Linux/macOS, %AppData%\\opencode\\config.json on Windows). Registers Stop and UserPromptSubmit events for the shared notify dispatcher. Preserves your existing OpenCode settings.",
      removeTitle:
        "Remove only strIDEterm's hook entries from the OpenCode config file. All other OpenCode settings stay intact.",
      testTitle:
        "End-to-end probe through the shared notify.mjs. Confirms the OpenCode hook → listener → dispatcher pipeline delivers events within 2 s.",
      configJson: `{
  "hooks": {
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "node \\"~/.strideterm/hooks/notify.mjs\\" Stop",
            "timeout": 5
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "node \\"~/.strideterm/hooks/notify.mjs\\" UserPromptSubmit",
            "timeout": 5
          }
        ]
      }
    ]
  }
}`,
      manual: {
        type: "single-path",
        before: "If auto-configure fails, add this to",
        path: "~/.config/opencode/config.json",
        after: ":",
      },
    }),
  ];

  onMounted(() => {
    for (const provider of providers) {
      provider.refresh();
    }
    refreshMetrics();
    metricsTimer = setInterval(refreshMetrics, 10_000);
  });

  onBeforeUnmount(() => {
    if (metricsTimer) {
      clearInterval(metricsTimer);
      metricsTimer = undefined;
    }
    for (const provider of providers) {
      provider.dispose();
    }
  });

  return {
    metricsSnapshot,
    refreshMetrics,
    providers,
    statusLabels: HOOK_STATUS_LABELS,
    hookTestFailLabel,
    formatMetricsUptime,
  };
}
