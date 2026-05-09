import { defineAsyncComponent } from "vue";

const GitPane = defineAsyncComponent(() => import("../components/workspace/GitPane.vue"));
const DockerPane = defineAsyncComponent(() => import("../components/workspace/DockerPane.vue"));
const AzureInboxPane = defineAsyncComponent(() => import("../components/workspace/AzureInboxPane.vue"));
const AzureReviewPane = defineAsyncComponent(() => import("../components/workspace/AzureReviewPane.vue"));
const GitHubInboxPane = defineAsyncComponent(() => import("../components/workspace/GitHubInboxPane.vue"));
const BrowserPane = defineAsyncComponent(() => import("../components/workspace/BrowserPane.vue"));
const FileManagerPane = defineAsyncComponent(() => import("../components/workspace/FileManagerPane.vue"));
const TaskDashboardPane = defineAsyncComponent(() => import("../components/workspace/TaskDashboardPane.vue"));
const HeadlessJudgePane = defineAsyncComponent(() => import("../components/workspace/HeadlessJudgePane.vue"));

const PANE_COMPONENTS: Record<string, unknown> = {
  git: GitPane,
  docker: DockerPane,
  azure: AzureInboxPane,
  review: AzureReviewPane,
  github: GitHubInboxPane,
  browser: BrowserPane,
  files: FileManagerPane,
  "task-dashboard": TaskDashboardPane,
  "headless-judge": HeadlessJudgePane,
};

export function resolvePaneComponent(type: string): unknown {
  return PANE_COMPONENTS[type] ?? null;
}

export function resolvePaneProps(type: string, viewId: string): Record<string, unknown> {
  if (type === "git") return { workspaceId: viewId.replace(/^git:/, "") };
  if (type === "docker") return { workspaceId: viewId.replace(/^docker:/, "") };
  if (type === "azure") return { workspaceId: viewId.replace(/^azure:/, "") };
  if (type === "github") return { workspaceId: viewId.replace(/^github:/, "") };
  if (type === "review") return { workspaceId: viewId.replace(/^review:/, "") };
  if (type === "files") return { workspaceId: viewId.replace(/^files:/, "") };
  if (type === "task-dashboard") return { workspaceId: viewId.replace(/^task-dashboard:/, "") };
  if (type === "headless-judge") return { sessionId: viewId };
  return {};
}
