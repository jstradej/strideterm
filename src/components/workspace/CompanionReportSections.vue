<template>
  <div class="crs">
    <section v-if="verdict?.blockingFindings?.length" class="crs__section">
      <h3 class="crs__heading">Required findings</h3>
      <div v-for="f in verdict.blockingFindings" :key="f.id" class="crs__finding">
        <p class="crs__finding-title">
          <span class="crs__id">{{ f.id }}</span> {{ f.title }}
        </p>
        <p v-if="repeatedFindingIds.includes(f.id)" class="crs__repeat-hint">
          &#9888; Repeated across 3+ rounds without being resolved — consider Pause and review.
        </p>
        <p class="crs__finding-impact">{{ f.impact }}</p>
        <p class="crs__finding-action"><strong>Required:</strong> {{ f.requiredAction }}</p>
        <ul class="crs__evidence">
          <li v-for="(e, i) in f.evidence" :key="i">{{ e }}</li>
        </ul>
      </div>
    </section>

    <details v-if="verdict?.advisories?.length" class="crs__section crs__advisories">
      <summary class="crs__heading">Advisories ({{ verdict.advisories.length }}) — optional, not required</summary>
      <div v-for="a in verdict.advisories" :key="a.id" class="crs__advisory">
        <p class="crs__finding-title">
          <span class="crs__id">{{ a.id }}</span> {{ a.title }}
        </p>
        <p class="crs__finding-action">{{ a.recommendation }}</p>
        <p v-if="a.tradeoff" class="crs__tradeoff">Trade-off: {{ a.tradeoff }}</p>
      </div>
    </details>

    <section v-if="verdict?.questions?.length" class="crs__section">
      <h3 class="crs__heading">Questions</h3>
      <div v-for="q in verdict.questions" :key="q.id" class="crs__finding">
        <p class="crs__finding-title">
          <span class="crs__id">{{ q.id }}</span> {{ q.question }}
        </p>
        <p class="crs__finding-impact">{{ q.whyNeeded }}</p>
      </div>
    </section>

    <!-- Role-specific summary -->
    <details v-if="analysis?.type === 'reviewer'" class="crs__section crs__role-summary" open>
      <summary class="crs__heading">Requirement checklist</summary>
      <ul class="crs__checklist">
        <li v-for="(item, i) in analysis.requirementAudit" :key="i" :class="`crs__checklist-item--${item.status}`">
          <strong>{{ item.status.toUpperCase() }}</strong> — {{ item.requirement }}
        </li>
      </ul>
    </details>

    <details v-else-if="analysis?.type === 'critic'" class="crs__section crs__role-summary" open>
      <summary class="crs__heading">Steelman &amp; hypotheses</summary>
      <p class="crs__steelman">{{ analysis.steelman }}</p>
      <ul class="crs__checklist">
        <li v-for="(h, i) in analysis.hypotheses" :key="i" :class="`crs__checklist-item--${h.disposition}`">
          <strong>{{ h.strength.toUpperCase() }}/{{ h.disposition }}</strong> — {{ h.hypothesis }}
        </li>
      </ul>
    </details>

    <details v-else-if="analysis?.type === 'consultant'" class="crs__section crs__role-summary" open>
      <summary class="crs__heading">Recommendation</summary>
      <p class="crs__recommended-next"><strong>Next step:</strong> {{ analysis.recommendedNextStep }}</p>
      <div v-for="(d, i) in analysis.decisions" :key="i" class="crs__decision">
        <p class="crs__decision-title">{{ d.decision }}</p>
        <ul class="crs__options">
          <li v-for="(o, j) in d.options" :key="j">
            <strong>{{ o.option }}</strong> (reversibility: {{ o.reversibility }}) — {{ o.benefits.join(", ") }}
            <span v-if="o.costsAndRisks.length"> · risks: {{ o.costsAndRisks.join(", ") }}</span>
          </li>
        </ul>
        <p class="crs__decision-recommendation">Recommended: {{ d.recommendation }}</p>
      </div>
    </details>

    <details v-else-if="analysis?.type === 'planner'" class="crs__section crs__role-summary" open>
      <summary class="crs__heading">Plan coverage &amp; decisions</summary>
      <ul class="crs__checklist">
        <li v-for="(c, i) in analysis.coverageAudit" :key="i" :class="`crs__checklist-item--${c.status}`">
          <strong>{{ c.area }}</strong
          >: {{ c.status }} — {{ c.evidence }}
        </li>
      </ul>
      <div v-if="analysis.decisions.length" class="crs__planner-block">
        <p class="crs__block-label">Decisions</p>
        <ul>
          <li v-for="(d, i) in analysis.decisions" :key="i">{{ d.decision }} → {{ d.chosenDefault }}</li>
        </ul>
      </div>
      <div v-if="analysis.assumptions.length" class="crs__planner-block">
        <p class="crs__block-label">Assumptions</p>
        <ul>
          <li v-for="(a, i) in analysis.assumptions" :key="i">{{ a.assumption }} — {{ a.rationale }}</li>
        </ul>
      </div>
      <div v-if="analysis.openQuestions.length" class="crs__planner-block">
        <p class="crs__block-label">Open questions (documentation only — not a pending decision)</p>
        <ul>
          <li v-for="(q, i) in analysis.openQuestions" :key="i">
            {{ q.question }} — default: {{ q.assumedDefault }}, resolve by: {{ q.resolveBy }}
          </li>
        </ul>
      </div>
    </details>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";

const props = withDefaults(
  defineProps<{
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    verdict?: Record<string, any> | null;
    role?: string;
    /** Blocking finding IDs that have repeated 3+ rounds without a fix
     * (plan §4.15) — purely a Dashboard hint, never changes the verdict. */
    repeatedFindingIds?: string[];
  }>(),
  { repeatedFindingIds: () => [] },
);

const analysis = computed(() => props.verdict?.roleAnalysis || null);
</script>

<style scoped>
.crs__section {
  margin-bottom: 14px;
}
.crs__heading {
  font-size: 12px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  opacity: 0.75;
  margin: 0 0 8px;
  cursor: default;
}
.crs__advisories summary,
.crs__role-summary summary {
  cursor: pointer;
}
.crs__finding,
.crs__advisory {
  border: 1px solid var(--border, #333);
  border-radius: 4px;
  padding: 8px 10px;
  margin-bottom: 8px;
  font-size: 12px;
}
.crs__id {
  font-family: monospace;
  font-size: 11px;
  opacity: 0.7;
  margin-right: 4px;
}
.crs__finding-title {
  margin: 0 0 4px;
  font-weight: 600;
}
.crs__finding-impact,
.crs__finding-action {
  margin: 0 0 4px;
  opacity: 0.9;
}
.crs__repeat-hint {
  margin: 0 0 4px;
  color: #ffb74d;
  font-weight: 600;
}
.crs__evidence {
  margin: 4px 0 0;
  padding-left: 16px;
  opacity: 0.8;
}
.crs__tradeoff {
  margin: 4px 0 0;
  font-style: italic;
  opacity: 0.75;
}
.crs__checklist {
  margin: 0;
  padding-left: 18px;
  font-size: 12px;
}
.crs__checklist-item--verified,
.crs__checklist-item--complete,
.crs__checklist-item--disproved {
  opacity: 0.75;
}
.crs__checklist-item--missing,
.crs__checklist-item--blocking {
  color: #ef9a9a;
}
.crs__steelman {
  font-size: 12px;
  font-style: italic;
  opacity: 0.85;
  margin: 0 0 8px;
}
.crs__recommended-next {
  font-size: 13px;
  margin: 0 0 10px;
}
.crs__decision {
  border-top: 1px solid var(--border, #333);
  padding-top: 8px;
  margin-top: 8px;
  font-size: 12px;
}
.crs__decision-title {
  font-weight: 600;
  margin: 0 0 4px;
}
.crs__options {
  margin: 0 0 4px;
  padding-left: 18px;
}
.crs__decision-recommendation {
  margin: 0;
  opacity: 0.85;
}
.crs__planner-block {
  margin-top: 8px;
  font-size: 12px;
}
.crs__block-label {
  font-weight: 600;
  opacity: 0.75;
  margin: 0 0 4px;
}
</style>
