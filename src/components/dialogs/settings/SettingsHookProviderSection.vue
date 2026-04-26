<template>
  <div>
    <div class="hook-section-title" :class="{ 'hook-section-title--spaced': spaced }">{{ provider.title }}</div>
    <p v-if="provider.warningStatus && provider.warningStatus === provider.status" class="hook-warn">
      {{ provider.warningText }}
    </p>
    <p v-if="provider.infoText" class="hook-info">{{ provider.infoText }}</p>
    <div class="hook-status-row">
      <span class="hook-status-badge" :class="'hook-status--' + provider.status">
        {{ statusLabels[provider.status] || provider.status }}
      </span>
      <button
        v-if="provider.status !== 'configured'"
        type="button"
        class="button button--small"
        :disabled="provider.busy"
        :title="provider.configureTitle"
        @click="provider.configure()"
      >
        {{ provider.busy ? "Configuring..." : provider.configureLabel }}
      </button>
      <button
        v-else
        type="button"
        class="button button--ghost button--small"
        :disabled="provider.busy"
        :title="provider.removeTitle"
        @click="provider.remove()"
      >
        Remove hook
      </button>
      <button
        v-if="provider.status === 'configured' || provider.status === 'partial'"
        type="button"
        class="button button--small"
        :disabled="provider.busy || provider.testing"
        :title="provider.testTitle"
        @click="provider.test()"
      >
        {{ provider.testing ? "Testing..." : "Test hook" }}
      </button>
    </div>

    <p
      v-if="provider.testResult"
      class="hook-test-result"
      :class="provider.testResult.ok ? 'hook-test-ok' : 'hook-test-fail'"
    >
      <span v-if="provider.testResult.ok">✓ Hook delivered in {{ provider.testResult.elapsedMs }} ms.</span>
      <span v-else>
        ✗ {{ hookTestFailLabel(provider.testResult.reason) }}
        <span v-if="provider.testResult.detail"> — {{ provider.testResult.detail }}</span>
      </span>
    </p>
    <pre v-if="provider.testResult && !provider.testResult.ok && provider.testResult.logTail" class="hook-log-tail">{{
      provider.testResult.logTail
    }}</pre>
    <p v-if="provider.error" class="hook-error">{{ provider.error }}</p>

    <details class="hook-setup-details">
      <summary class="hook-setup-summary">Manual setup (advanced)</summary>
      <div class="hook-setup-content">
        <p v-if="provider.manual.type === 'claude-doc'">
          If auto-configure fails, add this to <code>{{ provider.manual.path }}</code> and place the
          <a href="#" class="link-accent" @click.prevent="api?.openExternal?.(provider.manual.docsUrl)">{{
            provider.manual.docsLabel
          }}</a>
          at the referenced path:
        </p>
        <p v-else-if="provider.manual.type === 'double-path'">
          If auto-configure fails, (1) add <code>[features]<br />codex_hooks = true</code> to
          <code>{{ provider.manual.firstPath }}</code
          >, then (2) add this to <code>{{ provider.manual.secondPath }}</code
          >:
        </p>
        <p v-else>
          {{ provider.manual.before }} <code>{{ provider.manual.path }}</code
          >{{ provider.manual.after }}
        </p>

        <pre class="hook-setup-code">{{ provider.configJson }}</pre>
        <button type="button" class="button button--ghost hook-copy-btn" @click="provider.copyConfig()">
          {{ provider.copied ? "Copied!" : "Copy to clipboard" }}
        </button>
      </div>
    </details>
  </div>
</template>

<script setup lang="ts">
import type { Transport } from "../../../transport.js";

interface TestResult {
  ok: boolean;
  reason?: string;
  detail?: string;
  elapsedMs?: number;
  logTail?: string;
}

interface HookProvider {
  id: string;
  title: string;
  status: string;
  warningStatus?: string;
  warningText?: string;
  infoText?: string;
  busy?: boolean;
  testing?: boolean;
  testResult?: TestResult | null;
  error?: string;
  configureLabel: string;
  configureTitle: string;
  removeTitle: string;
  testTitle: string;
  configJson: string;
  copied?: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  manual: Record<string, any>;
  configure: () => void;
  remove: () => void;
  test: () => void;
  copyConfig: () => void;
}

interface Props {
  provider: HookProvider;
  statusLabels: Record<string, string>;
  hookTestFailLabel: (reason?: string) => string;
  api?: Transport | null;
  spaced?: boolean;
}

withDefaults(defineProps<Props>(), {
  api: null,
  spaced: false,
});
</script>

<style scoped>
.hook-section-title {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  opacity: 0.65;
}

.hook-section-title--spaced {
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid var(--border);
}

.hook-status-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.hook-status-badge {
  font-size: 12px;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 4px;
}

.hook-status--configured {
  color: var(--success, #4caf50);
  background: rgba(76, 175, 80, 0.12);
}

.hook-status--not-configured,
.hook-status--unknown {
  color: var(--muted);
  background: rgba(255, 255, 255, 0.06);
}

.hook-status--error,
.hook-status--script-missing,
.hook-status--flag-missing,
.hook-status--configured-but-disabled {
  color: var(--danger);
  background: rgba(255, 80, 80, 0.12);
}

.hook-warn {
  color: var(--warning, #e8a540);
  font-size: 12px;
  margin: 0;
}

.hook-info {
  color: var(--muted);
  font-size: 11px;
  margin: 0;
  opacity: 0.8;
}

.hook-error {
  color: var(--danger);
  font-size: 12px;
  margin: 0;
}

.hook-test-result {
  font-size: 12px;
  margin: 4px 0 0;
}

.hook-test-ok {
  color: var(--success, #6edfb6);
}

.hook-test-fail {
  color: var(--danger);
}

.hook-log-tail {
  font-size: 11px;
  max-height: 140px;
  overflow: auto;
  background: rgba(0, 0, 0, 0.25);
  padding: 6px 8px;
  border-radius: 4px;
  margin: 4px 0 0;
  white-space: pre-wrap;
  font-family: var(--mono, monospace);
}

.button--small {
  padding: 4px 10px;
  font-size: 12px;
}

.hook-setup-details {
  margin-top: 2px;
}

.hook-setup-summary {
  font-size: 12px;
  color: var(--muted);
  cursor: pointer;
  user-select: none;
}

.hook-setup-content {
  margin-top: 8px;
}

.hook-setup-content p {
  font-size: 12px;
  color: var(--muted);
  margin-bottom: 6px;
}

.hook-setup-code {
  font-size: 11px;
  line-height: 1.4;
  padding: 8px 10px;
  border-radius: 4px;
  background: rgba(0, 0, 0, 0.3);
  border: 1px solid var(--border);
  overflow-x: auto;
  white-space: pre;
}

.hook-copy-btn {
  margin-top: 6px;
  font-size: 12px;
}

.link-accent {
  color: var(--accent);
}
</style>
