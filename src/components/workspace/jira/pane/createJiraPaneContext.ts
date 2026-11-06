import type { JiraPaneContext } from "./jira-pane-context.js";
import type { JiraInboxPaneProps } from "./jira-pane-types.js";
import { useJiraPaneCore } from "./useJiraPaneCore.js";
import { useJiraBranchStart } from "./useJiraBranchStart.js";
import { useJiraIssueDetail } from "./useJiraIssueDetail.js";
import { useJiraBoard } from "./useJiraBoard.js";
import { useJiraSearch } from "./useJiraSearch.js";
import { useJiraConnections } from "./useJiraConnections.js";
import { useJiraPaneSync } from "./useJiraPaneSync.js";
import { useJiraPaneUi } from "./useJiraPaneUi.js";
import { useJiraPaneLifecycle } from "./useJiraPaneLifecycle.js";
import { useJiraPaneNavigation } from "./useJiraPaneNavigation.js";
import { useJiraPaneSignIn } from "./useJiraPaneSignIn.js";

function install<T extends Partial<JiraPaneContext>>(ctx: JiraPaneContext, part: T): T {
  return Object.assign(ctx, part);
}

export function createJiraPaneContext(props: JiraInboxPaneProps): JiraPaneContext {
  const ctx = {} as JiraPaneContext;
  const core = install(ctx, useJiraPaneCore(ctx, props));
  const branchStart = install(ctx, useJiraBranchStart(ctx));
  const issueDetail = install(ctx, useJiraIssueDetail(ctx));
  const board = install(ctx, useJiraBoard(ctx));
  const search = install(ctx, useJiraSearch(ctx));
  const connections = install(ctx, useJiraConnections(ctx));
  const derived = install(ctx, useJiraPaneSync(ctx));
  const signIn = install(ctx, useJiraPaneSignIn(ctx));
  const ui = install(ctx, useJiraPaneUi(ctx));
  const navigation = install(ctx, useJiraPaneNavigation(ctx));
  const lifecycle = install(ctx, useJiraPaneLifecycle(ctx));
  const complete: JiraPaneContext = {
    ...core,
    ...branchStart,
    ...issueDetail,
    ...board,
    ...search,
    ...connections,
    ...derived,
    ...signIn,
    ...ui,
    ...navigation,
    ...lifecycle,
  };
  return complete;
}
