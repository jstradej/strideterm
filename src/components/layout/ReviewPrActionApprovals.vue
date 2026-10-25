<template>
  <aside v-if="proposals.length" class="review-pr-approvals" aria-label="Pull request approvals">
    <article v-for="proposal in proposals" :key="proposal.proposalId" class="review-pr-approval">
      <header class="review-pr-approval__header">
        <div>
          <p class="eyebrow">{{ providerName(proposal.provider) }} · Approval required</p>
          <h2>{{ proposal.title }}</h2>
        </div>
        <span class="review-pr-approval__action">{{ actionLabel(proposal.action, proposal.options.mergeMethod) }}</span>
      </header>

      <p class="review-pr-approval__message">{{ proposal.message }}</p>

      <dl class="review-pr-approval__details">
        <div>
          <dt>Pull request</dt>
          <dd>
            <a
              v-if="webUrl(proposal.snapshot.url)"
              :href="webUrl(proposal.snapshot.url)"
              target="_blank"
              rel="noopener noreferrer"
            >
              {{ proposal.snapshot.repository }} #{{ proposal.snapshot.number }} · {{ proposal.snapshot.title }}
            </a>
            <span v-else
              >{{ proposal.snapshot.repository }} #{{ proposal.snapshot.number }} · {{ proposal.snapshot.title }}</span
            >
          </dd>
        </div>
        <div>
          <dt>State</dt>
          <dd>{{ proposal.snapshot.state }}<span v-if="proposal.snapshot.isDraft"> · Draft</span></dd>
        </div>
        <div>
          <dt>Source</dt>
          <dd>
            <code>{{ proposal.snapshot.source.repository }}:{{ proposal.snapshot.source.branch }}</code> ·
            <code>{{ proposal.snapshot.source.sha }}</code>
          </dd>
        </div>
        <div>
          <dt>Target</dt>
          <dd>
            <code>{{ proposal.snapshot.target.repository }}:{{ proposal.snapshot.target.branch }}</code> ·
            <code>{{ proposal.snapshot.target.sha }}</code>
          </dd>
        </div>
        <div>
          <dt>Checks</dt>
          <dd>
            {{ proposal.snapshot.checks.state }} · {{ proposal.snapshot.checks.successful }}/{{
              proposal.snapshot.checks.total
            }}
            passed<span v-if="proposal.snapshot.checks.failed"> · {{ proposal.snapshot.checks.failed }} failed</span
            ><span v-if="proposal.snapshot.checks.pending"> · {{ proposal.snapshot.checks.pending }} pending</span>
          </dd>
        </div>
        <div>
          <dt>Merge readiness</dt>
          <dd>
            {{ proposal.snapshot.mergeReadiness.state
            }}<span v-if="proposal.snapshot.mergeReadiness.reason">
              · {{ proposal.snapshot.mergeReadiness.reason }}</span
            >
          </dd>
        </div>
        <div>
          <dt>Review</dt>
          <dd>
            {{ proposal.snapshot.review.approvals }} approvals<span
              v-if="proposal.snapshot.review.requiredApprovals !== null"
            >
              / {{ proposal.snapshot.review.requiredApprovals }} required</span
            ><span v-if="proposal.snapshot.review.changesRequested">
              · {{ proposal.snapshot.review.changesRequested }} changes requested</span
            >
          </dd>
        </div>
      </dl>

      <ul
        v-if="proposal.snapshot.checks.items.length"
        class="review-pr-approval__checks"
        aria-label="Pull request checks"
      >
        <li v-for="check in proposal.snapshot.checks.items" :key="`${check.name}:${check.state}`">
          <span>{{ check.name }}</span
          ><span>{{ check.state }}</span>
        </li>
      </ul>

      <p v-if="errors.get(proposal.proposalId)" class="dialog__error" role="alert">
        {{ errors.get(proposal.proposalId) }}
      </p>
      <footer class="review-pr-approval__footer">
        <span>Review the live pull request before deciding. A changed proposal requires a new approval.</span>
        <div>
          <button
            class="button button--ghost"
            type="button"
            :disabled="isBusy(proposal.proposalId)"
            @click="decide(proposal, false)"
          >
            Reject
          </button>
          <button
            class="button"
            :class="{ 'button--danger': isDangerous(proposal.action) }"
            type="button"
            :disabled="isBusy(proposal.proposalId)"
            @click="decide(proposal, true)"
          >
            {{ isBusy(proposal.proposalId) ? "Checking…" : "Approve and run" }}
          </button>
        </div>
      </footer>
    </article>
  </aside>
</template>

<script setup lang="ts">
import { reactive } from "vue";
import type { ReviewPrActionProposal, ReviewPrAction } from "../../../electron/shared/review-pr-actions.js";

const props = defineProps<{
  proposals: ReviewPrActionProposal[];
  isBusy: (proposalId: string) => boolean;
  approve: (proposal: ReviewPrActionProposal) => Promise<void>;
  reject: (proposal: ReviewPrActionProposal) => Promise<void>;
}>();

const errors = reactive(new Map<string, string>());

function providerName(provider: ReviewPrActionProposal["provider"]): string {
  return provider === "github" ? "GitHub" : "Azure DevOps";
}

function actionLabel(action: ReviewPrAction, method?: string): string {
  const labels = new Map<ReviewPrAction, string>([
    ["approve", "Approve"],
    ["complete", "Complete pull request"],
    ["enable_auto_complete", "Enable auto-complete"],
    ["disable_auto_complete", "Disable auto-complete"],
    ["merge", "Merge pull request"],
    ["enable_auto_merge", "Enable auto-merge"],
    ["disable_auto_merge", "Disable auto-merge"],
    ["set_draft", "Mark as draft"],
    ["set_ready", "Mark ready for review"],
    ["abandon", "Abandon pull request"],
    ["reactivate", "Reactivate pull request"],
    ["close", "Close pull request"],
    ["reopen", "Reopen pull request"],
  ]);
  return `${labels.get(action) || action}${method ? ` · ${method}` : ""}`;
}

function isDangerous(action: ReviewPrAction): boolean {
  return ["complete", "merge", "abandon", "close", "reactivate"].includes(action);
}

function webUrl(value?: string): string | undefined {
  if (!value) return undefined;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : undefined;
  } catch {
    return undefined;
  }
}

async function decide(proposal: ReviewPrActionProposal, approved: boolean): Promise<void> {
  errors.delete(proposal.proposalId);
  try {
    await (approved ? props.approve(proposal) : props.reject(proposal));
  } catch (error) {
    errors.set(proposal.proposalId, error instanceof Error ? error.message : String(error));
  }
}
</script>

<style scoped>
.review-pr-approvals {
  position: fixed;
  z-index: 1200;
  right: 18px;
  bottom: 18px;
  display: grid;
  gap: 12px;
  width: min(620px, calc(100vw - 36px));
  max-height: min(82vh, 900px);
  overflow-y: auto;
}

.review-pr-approval {
  padding: 18px;
  border: 1px solid var(--border, rgba(255, 255, 255, 0.18));
  border-radius: 12px;
  background: var(--panel, #202329);
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.48);
}

.review-pr-approval__header,
.review-pr-approval__footer,
.review-pr-approval__footer > div {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.review-pr-approval h2 {
  margin: 4px 0 0;
  font-size: 16px;
}
.review-pr-approval__action {
  font-size: 12px;
  font-weight: 700;
}
.review-pr-approval__message {
  white-space: pre-wrap;
  line-height: 1.45;
}
.review-pr-approval__details {
  display: grid;
  gap: 7px;
  margin: 14px 0;
  font-size: 12px;
}
.review-pr-approval__details > div {
  display: grid;
  grid-template-columns: 82px minmax(0, 1fr);
  gap: 8px;
}
.review-pr-approval__details dt {
  color: var(--text-muted, #a3a7af);
}
.review-pr-approval__details dd {
  margin: 0;
  overflow-wrap: anywhere;
}
.review-pr-approval code {
  overflow-wrap: anywhere;
}
.review-pr-approval__checks {
  display: grid;
  gap: 4px;
  max-height: 110px;
  overflow: auto;
  padding: 0;
  list-style: none;
  font-size: 12px;
}
.review-pr-approval__checks li {
  display: flex;
  justify-content: space-between;
  gap: 10px;
}
.review-pr-approval__footer {
  align-items: flex-end;
  margin-top: 16px;
}
.review-pr-approval__footer > span {
  max-width: 270px;
  color: var(--text-muted, #a3a7af);
  font-size: 11px;
}

@media (max-width: 620px) {
  .review-pr-approvals {
    right: 10px;
    bottom: 10px;
    width: calc(100vw - 20px);
    max-height: 88vh;
  }
  .review-pr-approval {
    padding: 14px;
  }
  .review-pr-approval__footer {
    align-items: stretch;
    flex-direction: column;
  }
  .review-pr-approval__footer > span {
    max-width: none;
  }
}
</style>
