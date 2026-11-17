import { z } from "zod";
import { EFFORT_LEVELS, PROVIDER_CHOICES } from "./agent-provider-catalog.js";
import { AUTOMATION_EVENT_CATALOG, AUTOMATION_EVENT_KINDS } from "./automation-events.js";
import { isValidAutomationCron } from "./automation-schedule.js";

export const MAX_AUTOMATIONS_PER_WORKSPACE = 20;
export const MIN_AUTOMATION_INTERVAL_MINUTES = 5;

const timestamp = z.iso.datetime({ offset: true });
const agentRoleSchema = z
  .object({
    providerId: z.string().refine((id) => PROVIDER_CHOICES.some((provider) => provider.id === id)),
    model: z
      .string()
      .max(100)
      .refine((value) => value === "" || (/^[A-Za-z0-9]/u.test(value) && /^[A-Za-z0-9._:/@+-]+$/u.test(value))),
    effort: z.enum(EFFORT_LEVELS).optional(),
    skipPermissions: z.boolean(),
  })
  .strict()
  .refine(
    (role) =>
      !role.effort ||
      PROVIDER_CHOICES.some(
        (provider) => provider.id === role.providerId && provider.effortLevels.includes(role.effort!),
      ),
    "Effort is not supported by this provider.",
  );

export const scheduleTriggerSchema = z.discriminatedUnion("kind", [
  z.object({ type: z.literal("schedule"), kind: z.literal("once"), at: timestamp }).strict(),
  z
    .object({
      type: z.literal("schedule"),
      kind: z.literal("interval"),
      everyMinutes: z.number().int().min(MIN_AUTOMATION_INTERVAL_MINUTES),
      anchor: timestamp,
    })
    .strict(),
  z
    .object({
      type: z.literal("schedule"),
      kind: z.literal("cron"),
      expression: z.string().trim().min(1),
      timezone: z.string().min(1).optional(),
    })
    .strict()
    .refine(
      (trigger) => isValidAutomationCron(trigger.expression, trigger.timezone),
      "Invalid cron expression, timezone, or interval shorter than five minutes.",
    ),
]);
export type ScheduleTrigger = z.infer<typeof scheduleTriggerSchema>;

export const eventTriggerSchema = z
  .object({
    type: z.literal("event"),
    source: z.enum(["azure-devops", "github", "jira"]),
    kinds: z.array(z.enum(AUTOMATION_EVENT_KINDS)).min(1),
    connectionId: z.string().min(1).optional(),
    repositories: z.array(z.string().min(1)).optional(),
    role: z.enum(["author", "reviewer"]).optional(),
    targetBranches: z.array(z.string().min(1)).optional(),
    jiraQueryId: z.string().min(1).optional(),
  })
  .strict()
  .refine(
    (trigger) =>
      trigger.kinds.every((kind) =>
        AUTOMATION_EVENT_CATALOG.some((entry) => entry.kind === kind && entry.sources.includes(trigger.source)),
      ),
    "Event kind is not available for this source.",
  );

export const automationStateSchema = z
  .object({
    parentWorkspaceId: z.string().min(1),
    enabled: z.boolean(),
    trigger: z.union([scheduleTriggerSchema, eventTriggerSchema]),
    executor: z.discriminatedUnion("type", [
      z.object({ type: z.literal("agent"), agent: agentRoleSchema }).strict(),
      z
        .object({
          type: z.literal("task"),
          worker: agentRoleSchema,
          judge: agentRoleSchema,
          maxRounds: z.number().int().min(1).max(100),
        })
        .strict(),
    ]),
    prompt: z.string().max(20000),
    location: z.enum(["automation", "pr-review"]),
    policy: z
      .object({
        maxRunMinutes: z.number().int().min(5).max(720),
        catchUp: z.enum(["skip", "run-once"]),
        maxRunsPerHour: z.number().int().min(1),
        subjectCooldownMinutes: z.number().int().min(0),
      })
      .strict(),
    createdBy: z
      .object({ kind: z.enum(["desktop", "remote", "mobile", "agent"]), sessionId: z.string().optional() })
      .strict(),
    createdAt: timestamp,
    updatedAt: timestamp,
    enabledAt: timestamp.nullable(),
    disabledReason: z
      .enum([
        "user",
        "failures",
        "once-fired",
        "parent-removed",
        "profile-removed",
        "cwd-missing",
        "invalid-definition",
      ])
      .optional(),
  })
  .strict()
  .refine(
    (state) =>
      state.location !== "pr-review" ||
      (state.trigger.type === "event" &&
        state.trigger.source !== "jira" &&
        state.trigger.kinds.every((kind) => ["pr-new", "pr-ready", "pr-source-updated"].includes(kind)) &&
        state.executor.type === "agent" &&
        state.executor.agent.providerId !== "gemini"),
    "PR review is available only for supported PR events and agent providers.",
  );
export type AutomationState = z.infer<typeof automationStateSchema>;
