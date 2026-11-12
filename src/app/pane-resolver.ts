import { defineAsyncComponent, type Component } from "vue";
import { jiraViewIdFromTab } from "./jira-view-tabs.js";
import PaneLoading from "../components/workspace/PaneLoading.vue";

// A pane's chunk can take a moment on first open (the Files pane pulls in Monaco); show a spinner rather than an
// empty panel. The short delay keeps a cached chunk from flashing it.
const lazyPane = (loader: () => Promise<Component>) =>
  defineAsyncComponent({ loader, loadingComponent: PaneLoading, delay: 150 });

const GitPane = lazyPane(() => import("../components/workspace/GitPane.vue"));
const DockerPane = lazyPane(() => import("../components/workspace/DockerPane.vue"));
const InboxPane = lazyPane(() => import("../components/workspace/InboxPane.vue"));
const JiraInboxPane = lazyPane(() => import("../components/workspace/JiraInboxPane.vue"));
const AzureReviewPane = lazyPane(() => import("../components/workspace/AzureReviewPane.vue"));
const BrowserPane = lazyPane(() => import("../components/workspace/BrowserPane.vue"));
const FileManagerPane = lazyPane(() => import("../components/workspace/FileManagerPane.vue"));
const SftpBrowserPane = lazyPane(() => import("../components/workspace/SftpBrowserPane.vue"));
const TaskDashboardPane = lazyPane(() => import("../components/workspace/TaskDashboardPane.vue"));
const HeadlessJudgePane = lazyPane(() => import("../components/workspace/HeadlessJudgePane.vue"));

const PANE_COMPONENTS: Record<string, unknown> = {
  git: GitPane,
  docker: DockerPane,
  azure: InboxPane,
  review: AzureReviewPane,
  github: InboxPane,
  jira: JiraInboxPane,
  browser: BrowserPane,
  files: FileManagerPane,
  sftp: SftpBrowserPane,
  "task-dashboard": TaskDashboardPane,
  "headless-judge": HeadlessJudgePane,
};

export function resolvePaneComponent(type: string): unknown {
  return PANE_COMPONENTS[type] ?? null;
}

export function resolvePaneProps(type: string, viewId: string, workspaceId: string): Record<string, unknown> {
  if (type === "git") return { workspaceId: viewId.replace(/^git:/, "") };
  if (type === "docker") return { workspaceId: viewId.replace(/^docker:/, "") };
  if (type === "azure") return { workspaceId: viewId.replace(/^azure:/, ""), provider: "azure" };
  if (type === "github") return { workspaceId: viewId.replace(/^github:/, ""), provider: "github" };
  if (type === "jira") {
    const jiraViewId = jiraViewIdFromTab(viewId, workspaceId) || "issues";
    return { workspaceId, jiraViewId };
  }
  if (type === "review") return { workspaceId: viewId.replace(/^review:/, "") };
  if (type === "files") return { workspaceId: viewId.replace(/^files:/, "") };
  if (type === "sftp") return { workspaceId, panelId: viewId.replace(/^sftp:/, "") };
  if (type === "task-dashboard") return { workspaceId: viewId.replace(/^task-dashboard:/, "") };
  if (type === "headless-judge") return { sessionId: viewId };
  return {};
}
