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

/**
 * One runtime parameter a pipeline declares, used to render typed controls in
 * the re-run dialog (combobox for choices, checkbox for booleans, …). Sourced
 * from the same data provider the Azure DevOps "Run pipeline" panel uses.
 */
export interface AzurePipelineParameterDef {
  /** Parameter name (the templateParameters key). */
  name: string;
  /** Friendly label from the YAML `displayName`; falls back to `name`. */
  displayName: string;
  /** Azure parameter type: string | boolean | number | object | … */
  type: string;
  /** Declared default, as a string (booleans as "true"/"false"). */
  default?: string;
  /** Allowed values (choice/enum) — render as a combobox. */
  values?: string[];
}

/**
 * Branch and tag refs of a pipeline's repository, for the re-run dialog's
 * branch picker. Full ref names (e.g. "refs/heads/main", "refs/tags/v1.2") so
 * they can be used directly as the run's source ref. Empty when the pipeline's
 * repo isn't Azure Repos Git (e.g. GitHub) — the field stays free-text then.
 */
export interface AzurePipelineRefs {
  branches: string[];
  tags: string[];
  /** Repo id (Azure Repos Git only) so the dialog can lazily fetch commits; "" otherwise. */
  repositoryId: string;
}

/** A recent commit, for the re-run dialog's Commits tab. */
export interface AzurePipelineCommit {
  /** Full 40-char commit id — used as the run's source `version`. */
  id: string;
  /** Abbreviated id for display. */
  shortId: string;
  /** First line of the commit message. */
  comment: string;
  author: string;
  date?: string;
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
