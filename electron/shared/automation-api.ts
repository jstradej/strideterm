import { z } from "zod";
import { automationStateSchema } from "./automation.js";

const id = z.string().trim().min(1).max(200);
const version = z.iso.datetime({ offset: true });
const key = z.string().regex(/^[A-Za-z0-9._:-]{8,200}$/u);
export const checkoutSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("here") }).strict(),
  z
    .object({
      mode: z.literal("worktree"),
      repository: z.string().trim().min(1).max(1024).optional(),
      branch: z
        .string()
        .trim()
        .min(1)
        .max(200)
        .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u),
    })
    .strict(),
]);
export const automationDefinitionInputSchema = z
  .object({
    enabled: automationStateSchema.shape.enabled,
    trigger: automationStateSchema.shape.trigger,
    executor: automationStateSchema.shape.executor,
    prompt: automationStateSchema.shape.prompt,
    location: automationStateSchema.shape.location,
    policy: automationStateSchema.shape.policy,
  })
  .strict();
export const automationCreateSchema = z
  .object({
    parentWorkspaceId: id,
    name: z.string().trim().min(1).max(200),
    definition: automationDefinitionInputSchema,
    isolated: z.boolean().optional(),
    jiraMcpEnabled: z.boolean().optional(),
    sshMcpEnabled: z.boolean().optional(),
    checkout: checkoutSchema.optional(),
    idempotencyKey: key.optional(),
  })
  .strict()
  .refine((input) => input.checkout?.mode !== "worktree" || Boolean(input.idempotencyKey), {
    message: "Worktree creation requires an idempotency key.",
    path: ["idempotencyKey"],
  });
export const automationUpdateSchema = z
  .object({
    workspaceId: id,
    expectedUpdatedAt: version,
    name: z.string().trim().min(1).max(200).optional(),
    isolated: z.boolean().optional(),
    definition: automationDefinitionInputSchema,
    jiraMcpEnabled: z.boolean().optional(),
    sshMcpEnabled: z.boolean().optional(),
  })
  .strict();
export const automationSetEnabledSchema = z
  .object({ workspaceId: id, expectedUpdatedAt: version, enabled: z.boolean() })
  .strict();
export const automationRunNowSchema = z.object({ workspaceId: id, idempotencyKey: key }).strict();
export const automationRunRefSchema = z.object({ workspaceId: id, runId: z.uuid() }).strict();
export const automationRunsSchema = z
  .object({
    workspaceId: id,
    offset: z.number().int().min(0).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  })
  .strict();
export const automationDeleteRunsSchema = z
  .object({ workspaceId: id, runIds: z.array(z.uuid()).min(1).max(100) })
  .strict();
export const automationSetPausedSchema = z.object({ paused: z.boolean() }).strict();
export type AutomationDefinitionInput = z.infer<typeof automationDefinitionInputSchema>;
export type AutomationCreateInput = z.infer<typeof automationCreateSchema>;
export type AutomationUpdateInput = z.infer<typeof automationUpdateSchema>;
export type AutomationSetEnabledInput = z.infer<typeof automationSetEnabledSchema>;
export type AutomationRunNowInput = z.infer<typeof automationRunNowSchema>;
export type AutomationRunRefInput = z.infer<typeof automationRunRefSchema>;
export type AutomationRunsInput = z.infer<typeof automationRunsSchema>;
export type AutomationDeleteRunsInput = z.infer<typeof automationDeleteRunsSchema>;
export type AutomationSetPausedInput = z.infer<typeof automationSetPausedSchema>;
