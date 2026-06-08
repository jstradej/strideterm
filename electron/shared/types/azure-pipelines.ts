/**
 * Transport DTOs for the Azure DevOps "Pipelines" tab.
 *
 * These are not persisted state — they are produced on demand by the backend
 * Azure manager (from the Build/Pipelines REST APIs) and consumed by the
 * frontend pipelines store/components.
 */

/** A single build run, as shown next to a pipeline (latest run) or in history. */
export interface AzureBuildRef {
  /** Build id, which equals the Pipelines run id used to re-run. */
  id: number;
  buildNumber: string;
  /** Raw Azure status: notStarted | inProgress | completed | cancelling | postponed | none */
  status: string;
  /** Raw Azure result (only when completed): succeeded | partiallySucceeded | failed | canceled */
  result?: string;
  sourceBranch: string;
  queueTime?: string;
  startTime?: string;
  finishTime?: string;
  /** Display name of who requested the run, when available. */
  requestedFor?: string;
  /** Raw Azure reason: manual | individualCI | schedule | pullRequest | … */
  reason?: string;
  /** Commit sha the run built (sourceVersion), when available. */
  sourceVersion?: string;
  /** Browser URL (_links.web.href) for the run. */
  webUrl: string;
}

/** A pipeline (build definition) with its latest run, for the list view. */
export interface AzurePipelineSummary {
  connectionId: string;
  project: { id: string; name: string };
  /** Definition id == pipelineId used by the Pipelines run API. */
  id: number;
  name: string;
  /** Definition folder path (e.g. "\\CI"). */
  folder: string;
  /** enabled | paused | disabled — disabled blocks queueing. */
  queueStatus: string;
  /** Browser URL for the pipeline definition. */
  webUrl: string;
  lastRun?: AzureBuildRef;
}

/**
 * A pipeline run in the per-pipeline history (expand view). Sourced from the
 * Build API so it carries the same rich fields as {@link AzureBuildRef} (who,
 * branch, commit, timing) — `state` is filled from the build `status` so the
 * existing status-icon logic keeps working.
 */
export interface AzurePipelineRun {
  id: number;
  name: string;
  /** Build status used as run state: notStarted | inProgress | completed | cancelling | … */
  state: string;
  /** Raw result (only when completed): succeeded | partiallySucceeded | failed | canceled */
  result?: string;
  createdDate?: string;
  finishedDate?: string;
  /** Display name of who requested the run, when available. */
  requestedFor?: string;
  /** Full source ref, e.g. "refs/heads/main". */
  sourceBranch?: string;
  /** Commit sha the run built (sourceVersion), when available. */
  sourceVersion?: string;
  startTime?: string;
  finishTime?: string;
  webUrl: string;
}

/** One stage of a run, from the build timeline (run-detail view). */
export interface AzureRunStage {
  name: string;
  /** Timeline record state: pending | inProgress | completed. */
  state: string;
  /** Timeline record result: succeeded | failed | canceled | skipped | … */
  result?: string;
}

/** A single error issue from the build timeline, with its stage→job→task breadcrumb. */
export interface AzureRunError {
  message: string;
  /** Breadcrumb of the record that raised it, e.g. "Deploy • Deploy New Version • Check pods". */
  context: string;
}

/** On-demand detail for one run: its stages and surfaced errors (one timeline fetch). */
export interface AzureRunDetail {
  stages: AzureRunStage[];
  errors: AzureRunError[];
}

/** Seed values extracted from a past run to pre-fill the re-run dialog. */
export interface AzurePipelineRunSeed {
  /** Full ref name the run used, e.g. "refs/heads/main". */
  branch: string;
  /** templateParameters of that run (name → value). */
  parameters: Record<string, string>;
  /** variables of that run; secret values are blanked but flagged. */
  variables: Array<{ name: string; value: string; isSecret: boolean }>;
}
