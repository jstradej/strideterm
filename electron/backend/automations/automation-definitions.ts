import { randomUUID } from "node:crypto";
import { automationStateSchema, MAX_AUTOMATIONS_PER_WORKSPACE, type AutomationState } from "../../shared/automation.js";
import type { AppState, WorkspaceState } from "../../shared/types/state.js";
import { normalizeWorkspace } from "../default-state.js";
import { insertWorkspace } from "../workspace-order.js";
import { getProvider } from "../providers/provider-registry.js";

export interface AutomationActor {
  kind: "desktop" | "remote" | "mobile" | "agent";
  sessionId?: string;
  /** Supplied by the authenticated agent grant, never by request input. */
  canSkipPermissions?: boolean;
}
export interface DefinitionStore {
  mutate(change: (state: AppState) => void): Promise<unknown>;
}
export interface AutomationDefinitionsOptions {
  store: DefinitionStore;
  assertScope: (workspaceId: string, state?: AppState) => void;
  changed: () => void;
  resetFailures?: (workspaceId: string) => Promise<void>;
  now?: () => Date;
}
function updatedAt(previous: string | undefined, now: Date): string {
  return new Date(Math.max(now.getTime(), previous ? Date.parse(previous) + 1 : 0)).toISOString();
}
function assertFutureOnce(definition: AutomationState, now: Date): void {
  if (
    definition.trigger.type === "schedule" &&
    definition.trigger.kind === "once" &&
    Date.parse(definition.trigger.at) <= now.getTime()
  )
    throw new Error("Choose a future date and time for a one-time automation.");
}
/** Reject nested connection and query references outside the workspace profile. */
export function assertAutomationEventScope(
  state: AppState,
  profileId: string,
  trigger: AutomationState["trigger"],
): void {
  if (trigger.type !== "event") return;
  const integrations = state.settings.integrations;
  const connections =
    trigger.source === "github"
      ? integrations.github.connections
      : trigger.source === "azure-devops"
        ? integrations.azureDevops.connections
        : integrations.jira.connections;
  if (
    trigger.connectionId &&
    !connections.some(
      (connection) => connection.id === trigger.connectionId && (connection.profileId || "default") === profileId,
    )
  )
    throw new Error("Connection is not available in this profile");
  if (trigger.jiraQueryId) {
    if (trigger.source !== "jira") throw new Error("Jira query requires a Jira trigger");
    const query = integrations.jira.queries.find(
      (item) => item.id === trigger.jiraQueryId && (item.profileId || "default") === profileId,
    );
    if (
      !query ||
      (trigger.connectionId && trigger.connectionId !== query.connectionId) ||
      !integrations.jira.connections.some(
        (connection) => connection.id === query.connectionId && (connection.profileId || "default") === profileId,
      )
    )
      throw new Error("Jira query is not available in this profile");
  }
}
function clampAgentPermissions(definition: AutomationState, actor: AutomationActor): void {
  if (actor.kind !== "agent" || actor.canSkipPermissions === true) return;
  if (definition.executor.type === "agent") definition.executor.agent.skipPermissions = false;
  else {
    definition.executor.worker.skipPermissions = false;
    definition.executor.judge.skipPermissions = false;
  }
}
export function assertAutomationParent(parent: WorkspaceState | undefined): asserts parent is WorkspaceState {
  if (
    !parent ||
    !parent.cwd ||
    ["docker", "azure", "github", "jira", "jira-board", "task", "automation"].includes(parent.kind)
  )
    throw new Error("Unsupported automation parent workspace");
  if (
    parent.panels.some(
      (panel) =>
        /^\s*wsl(?:\.exe)?(?:\s|$)/iu.test(panel.command) &&
        /\b(?:claude|codex|copilot|opencode|gemini)\b/iu.test(panel.command),
    )
  )
    throw new Error("WSL agent commands are not supported for automations");
}
function panelsFor(definition: AutomationState, dashboardId: string, agentId: string) {
  const panels = [
    { id: dashboardId, title: "Dashboard", command: "__automation-dashboard__", shell: false, startup: "none" },
  ];
  if (definition.executor.type === "agent") {
    const role = definition.executor.agent;
    const provider = getProvider(role.providerId);
    panels.push({
      id: agentId,
      title: `Agent (${role.providerId}${role.model ? ` ${role.model}` : ""})`,
      command: provider.buildCommand({ model: role.model, effort: role.effort, skipPermissions: role.skipPermissions }),
      shell: false,
      startup: "manual",
    });
  }
  return panels;
}

/** Runtime-owned definition mutations. Scope and event references are checked inside the same state mutation. */
export class AutomationDefinitions {
  private readonly now: () => Date;
  constructor(private readonly options: AutomationDefinitionsOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async create(
    parentWorkspaceId: string,
    name: string,
    definitionInput: unknown,
    actor: AutomationActor,
    isolated = false,
    optIns: { jiraMcpEnabled?: boolean; sshMcpEnabled?: boolean } = {},
    checkout?: { workspaceId: string; cwd: string; parentCwd: string; profileId: string },
  ): Promise<string> {
    this.options.assertScope(parentWorkspaceId);
    const id = checkout?.workspaceId || `workspace-${randomUUID()}`;
    const dashboardId = `panel-${randomUUID()}`;
    const agentId = `panel-${randomUUID()}`;
    await this.options.store.mutate((state) => {
      this.options.assertScope(parentWorkspaceId, state);
      const parent = state.workspaces.find((workspace) => workspace.id === parentWorkspaceId);
      assertAutomationParent(parent);
      if (checkout && (parent.cwd !== checkout.parentCwd || (parent.profileId || "default") !== checkout.profileId))
        throw new Error("Automation parent changed while preparing the worktree");
      if (state.workspaces.some((workspace) => workspace.id === id))
        throw new Error("Automation workspace already exists");
      if (optIns.jiraMcpEnabled === true && !parent.jiraMcpEnabled)
        throw new Error("Parent has not enabled Jira tools");
      if (optIns.sshMcpEnabled === true && !parent.sshMcpEnabled) throw new Error("Parent has not enabled SSH tools");
      if (
        state.workspaces.filter(
          (workspace) =>
            workspace.kind === "automation" && workspace.automation?.parentWorkspaceId === parentWorkspaceId,
        ).length >= MAX_AUTOMATIONS_PER_WORKSPACE
      )
        throw new Error("Automation limit reached");
      const at = updatedAt(undefined, this.now());
      const source = definitionInput && typeof definitionInput === "object" ? definitionInput : {};
      const definition = automationStateSchema.parse({
        ...source,
        parentWorkspaceId,
        createdBy: { kind: actor.kind, ...(actor.sessionId ? { sessionId: actor.sessionId } : {}) },
        createdAt: at,
        updatedAt: at,
        enabledAt: (source as { enabled?: unknown }).enabled === true ? at : null,
      });
      if (definition.enabled) delete definition.disabledReason;
      else definition.disabledReason = "user";
      assertFutureOnce(definition, this.now());
      clampAgentPermissions(definition, actor);
      assertAutomationEventScope(state, parent.profileId || "default", definition.trigger);
      const panels = panelsFor(definition, dashboardId, agentId);
      const workspace = normalizeWorkspace({
        id,
        name: name.trim() || "Automation",
        icon: "⚙",
        color: parent.color,
        kind: "automation",
        source: "manual",
        cwd: checkout?.cwd || parent.cwd,
        profileId: parent.profileId,
        panels,
        activePanelId: dashboardId,
        automation: definition,
        jiraMcpEnabled: parent.jiraMcpEnabled === true && optIns.jiraMcpEnabled !== false,
        sshMcpEnabled: parent.sshMcpEnabled === true && optIns.sshMcpEnabled !== false,
        internalMcpEnabled: false,
        sandboxEnabled: parent.sandboxEnabled === true || isolated,
        sandboxAllowedDomains: parent.sandboxAllowedDomains ?? [],
      });
      insertWorkspace(state.workspaces, workspace, parentWorkspaceId);
    });
    this.options.changed();
    return id;
  }

  async update(
    workspaceId: string,
    expectedUpdatedAt: string,
    definitionInput: unknown,
    actor: AutomationActor,
    optIns: { jiraMcpEnabled?: boolean; sshMcpEnabled?: boolean; name?: string; isolated?: boolean } = {},
  ): Promise<void> {
    this.options.assertScope(workspaceId);
    await this.options.store.mutate((state) => {
      this.options.assertScope(workspaceId, state);
      const workspace = state.workspaces.find((item) => item.id === workspaceId);
      if (workspace?.kind !== "automation" || !workspace.automation) throw new Error("Automation not found");
      const prior = workspace.automation;
      if (prior.updatedAt !== expectedUpdatedAt) throw new Error("Automation changed elsewhere; reload and try again");
      const parent = state.workspaces.find((item) => item.id === prior.parentWorkspaceId);
      assertAutomationParent(parent);
      if ((parent.profileId || "default") !== (workspace.profileId || "default"))
        throw new Error("Automation parent is in another profile");
      if (optIns.jiraMcpEnabled === true && !parent.jiraMcpEnabled)
        throw new Error("Parent has not enabled Jira tools");
      if (optIns.sshMcpEnabled === true && !parent.sshMcpEnabled) throw new Error("Parent has not enabled SSH tools");
      const input = definitionInput && typeof definitionInput === "object" ? definitionInput : {};
      const at = updatedAt(prior.updatedAt, this.now());
      const next = automationStateSchema.parse({
        ...input,
        parentWorkspaceId: prior.parentWorkspaceId,
        createdBy: prior.createdBy,
        createdAt: prior.createdAt,
        updatedAt: at,
        enabledAt:
          (input as { enabled?: unknown }).enabled === true
            ? prior.enabled &&
              JSON.stringify((input as { trigger?: unknown }).trigger) === JSON.stringify(prior.trigger)
              ? prior.enabledAt
              : at
            : null,
      });
      if (next.enabled) delete next.disabledReason;
      else if (prior.enabled) next.disabledReason = "user";
      else next.disabledReason = prior.disabledReason || "user";
      clampAgentPermissions(next, actor);
      if (next.enabled) assertFutureOnce(next, this.now());
      assertAutomationEventScope(state, workspace.profileId || "default", next.trigger);
      const dashboardId =
        workspace.panels.find((panel) => panel.command === "__automation-dashboard__")?.id || `panel-${randomUUID()}`;
      const agentId =
        workspace.panels.find((panel) => panel.command !== "__automation-dashboard__")?.id || `panel-${randomUUID()}`;
      workspace.panels = panelsFor(next, dashboardId, agentId);
      workspace.automation = next;
      if (optIns.name !== undefined) workspace.name = optIns.name.trim();
      if (parent.sandboxEnabled || optIns.isolated || workspace.sandboxEnabled) {
        workspace.sandboxEnabled = true;
        const isolated = new Set([workspace.id]);
        for (let changed = true; changed;) {
          changed = false;
          for (const child of state.workspaces) {
            if (
              child.kind !== "task" ||
              !child.task ||
              isolated.has(child.id) ||
              !isolated.has(child.task.parentWorkspaceId)
            )
              continue;
            child.sandboxEnabled = true;
            child.sandboxAllowedDomains = [...(workspace.sandboxAllowedDomains || [])];
            isolated.add(child.id);
            changed = true;
          }
        }
      }
      workspace.jiraMcpEnabled =
        parent.jiraMcpEnabled === true && (optIns.jiraMcpEnabled ?? workspace.jiraMcpEnabled) === true;
      workspace.sshMcpEnabled =
        parent.sshMcpEnabled === true && (optIns.sshMcpEnabled ?? workspace.sshMcpEnabled) === true;
      if (!workspace.jiraMcpEnabled) {
        for (const child of state.workspaces) {
          if (child.kind === "task" && child.task?.parentWorkspaceId === workspace.id) child.jiraMcpEnabled = false;
        }
      }
    });
    await this.options.resetFailures?.(workspaceId);
    this.options.changed();
  }
  async setEnabled(workspaceId: string, enabled: boolean, expectedUpdatedAt: string): Promise<void> {
    this.options.assertScope(workspaceId);
    let reenabled = false;
    await this.options.store.mutate((state) => {
      this.options.assertScope(workspaceId, state);
      const workspace = state.workspaces.find((item) => item.id === workspaceId);
      if (workspace?.kind !== "automation" || !workspace.automation) throw new Error("Automation not found");
      const definition = workspace.automation;
      if (definition.updatedAt !== expectedUpdatedAt)
        throw new Error("Automation changed elsewhere; reload and try again");
      if (enabled) {
        const parent = state.workspaces.find((item) => item.id === definition.parentWorkspaceId);
        assertAutomationParent(parent);
        if ((parent.profileId || "default") !== (workspace.profileId || "default"))
          throw new Error("Automation parent is in another profile");
        const parsed = automationStateSchema.safeParse(definition);
        if (!parsed.success) throw new Error("Automation definition is invalid");
        assertFutureOnce(definition, this.now());
        assertAutomationEventScope(state, workspace.profileId || "default", definition.trigger);
      }
      if (definition.enabled === enabled) return;
      reenabled = enabled;
      const at = updatedAt(definition.updatedAt, this.now());
      definition.enabled = enabled;
      definition.enabledAt = enabled ? at : null;
      definition.updatedAt = at;
      if (enabled) delete definition.disabledReason;
      else definition.disabledReason = "user";
    });
    if (reenabled) await this.options.resetFailures?.(workspaceId);
    this.options.changed();
  }
}
