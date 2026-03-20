import { html, nothing } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";

function stripHeadRef(value = "") {
  return String(value || "").replace(/^refs\/heads\//, "");
}

// ---------------------------------------------------------------------------
// Markdown rendering
// ---------------------------------------------------------------------------

function escapeHtml(text = "") {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderMarkdownToHtml(text = "") {
  let out = escapeHtml(text);
  // Code blocks: ```...```
  out = out.replace(/```([\s\S]*?)```/g, '<pre><code>$1</code></pre>');
  // Inline code: `...`
  out = out.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  // Bold: **...**
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  // Italic: *...*
  out = out.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>');
  // Line breaks
  out = out.replace(/\n/g, '<br>');
  return out;
}

// ---------------------------------------------------------------------------
// Avatar helpers
// ---------------------------------------------------------------------------

function renderDiffSnippet(text = "") {
  return text.split("\n").map((line) => {
    const escaped = escapeHtml(line);
    if (/^@@/.test(line)) return `<span class="diff-hunk">${escaped}</span>`;
    if (/^\s*\d*\s*\+/.test(line) || /^\+/.test(line)) return `<span class="diff-add">${escaped}</span>`;
    if (/^-/.test(line)) return `<span class="diff-del">${escaped}</span>`;
    return escaped;
  }).join("\n");
}

function avatarColor(name = "") {
  let hash = 0;
  for (const char of name) hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
  const hue = ((hash % 360) + 360) % 360;
  return `hsl(${hue}, 50%, 42%)`;
}

function avatarInitials(name = "") {
  // Strip parenthetical suffixes like "(GreenCode s.r.o.)" and trailing numbers
  const cleaned = name.replace(/\s*\(.*?\)\s*/g, "").replace(/\s*\d+\s*$/, "").trim();
  const parts = cleaned.split(/[\s,]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  return (parts[0]?.[0] || "?").toUpperCase();
}

function formatRelativeTime(isoDate) {
  if (!isoDate) return "";
  const ms = Date.now() - new Date(isoDate).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

function formatWaitDuration(isoDate) {
  if (!isoDate) return "";
  const ms = Date.now() - new Date(isoDate).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "";
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 1) return "less than 1 hour";
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"}, ${hours % 24}h`;
}

function voteLabel(vote = 0) {
  if (vote === 10) return "Approved";
  if (vote === 5) return "Approved with suggestions";
  if (vote === -5) return "Waiting for author";
  if (vote === -10) return "Rejected";
  return "No vote yet";
}

function voteClass(vote = 0) {
  if (vote === 10) return "git-status-code git-status-code--success";
  if (vote === 5) return "git-status-code git-status-code--success";
  if (vote === -5) return "git-status-code git-status-code--pending";
  if (vote === -10) return "git-status-code git-status-code--failed";
  return "git-status-code git-status-code--neutral";
}

function reviewCheckCode(state = "") {
  const normalized = String(state || "").toLowerCase();
  if (normalized === "failed") return "fail";
  if (normalized === "pending") return "wait";
  if (normalized === "succeeded") return "ok";
  if (normalized === "not-applicable") return "skip";
  return "?";
}

function reviewCheckClass(state = "") {
  const normalized = String(state || "").toLowerCase();
  if (normalized === "failed") return "git-status-code git-status-code--failed";
  if (normalized === "pending") return "git-status-code git-status-code--pending";
  if (normalized === "succeeded") return "git-status-code git-status-code--success";
  return "git-status-code git-status-code--neutral";
}

function threadStatusLabel(status = "") {
  const normalized = String(status || "").toLowerCase();
  if (normalized === "active") return "Active";
  if (normalized === "pending") return "Pending";
  if (normalized === "fixed") return "Resolved";
  if (normalized === "closed") return "Closed";
  if (normalized === "wontfix") return "Won't fix";
  if (normalized === "bydesign") return "By design";
  return status || "Unknown";
}

function threadStatusClass(status = "") {
  const normalized = String(status || "").toLowerCase();
  if (normalized === "active") return "workspace-chip workspace-chip--alert";
  if (normalized === "pending") return "workspace-chip";
  return "workspace-chip workspace-chip--muted";
}

function mergeStatusInfo(mergeStatus = "") {
  const normalized = String(mergeStatus || "").toLowerCase();
  if (normalized === "conflicts") return { label: "Merge conflicts detected", icon: "fail", hasConflicts: true, cssClass: "git-status-code--failed" };
  if (normalized === "failure" || normalized === "rejectedbypolicy") return { label: "Merge failed", icon: "fail", hasConflicts: false, cssClass: "git-status-code--failed" };
  if (normalized === "succeeded") return { label: "No merge conflicts", icon: "ok", hasConflicts: false, cssClass: "git-status-code--success" };
  if (normalized === "queued") return { label: "Merge check queued", icon: "wait", hasConflicts: false, cssClass: "git-status-code--pending" };
  if (normalized === "notset" || !mergeStatus) return { label: "Merge status unknown", icon: "?", hasConflicts: false, cssClass: "git-status-code--neutral" };
  return { label: `Merge status: ${mergeStatus}`, icon: "?", hasConflicts: false, cssClass: "git-status-code--neutral" };
}

function changeTypeLabel(changeType = "") {
  const normalized = String(changeType || "").toUpperCase();
  if (normalized === "EDIT" || normalized === "M") return "M";
  if (normalized === "ADD" || normalized === "A") return "A";
  if (normalized === "DELETE" || normalized === "D") return "D";
  if (normalized === "RENAME" || normalized === "R") return "R";
  return normalized || "M";
}

function changeTypeClass(changeType = "") {
  const label = changeTypeLabel(changeType);
  if (label === "A") return "git-status-code git-status-code--success";
  if (label === "D") return "git-status-code git-status-code--failed";
  if (label === "R") return "git-status-code git-status-code--pending";
  return "git-status-code";
}

function fileName(filePath = "") {
  return String(filePath || "").split("/").pop() || filePath;
}

function fileDir(filePath = "") {
  const parts = String(filePath || "").split("/");
  return parts.length > 1 ? parts.slice(0, -1).join("/") + "/" : "";
}

// ---------------------------------------------------------------------------
// Inbox view (unchanged)
// ---------------------------------------------------------------------------

function renderPullRequestRow(item = {}) {
  const pullRequest = item.pullRequest || {};
  const workspaceId = item.role === "author" && item.existingWorkspaceId && !item.reviewWorkspaceId
    ? item.existingWorkspaceId
    : "";
  const actionLabel = item.role === "author" && item.existingWorkspaceId && !item.reviewWorkspaceId
    ? "Attach"
    : (item.reviewWorkspaceId ? "Open" : "Review");
  const authorName = item.author?.displayName || "Unknown author";
  const commentCount = item.commentCount || 0;
  const lastActivity = item.lastActivityAt || pullRequest.creationDate || "";

  return html`
    <article class="azure-pr-row ${item.hasAttention ? "azure-pr-row--attention" : ""}">
      <span class="review-comment__avatar" style="background:${avatarColor(authorName)};flex-shrink:0;">${avatarInitials(authorName)}</span>
      <div class="azure-pr-row__main">
        <div class="azure-pr-row__title">
          <span class="azure-pr-row__id">#${String(pullRequest.id || "")}</span>
          <strong>${pullRequest.title || "Untitled pull request"}</strong>
          ${pullRequest.isDraft ? html`<span class="workspace-chip" style="font-size:10px;">Draft</span>` : nothing}
          ${item.hasAttention ? html`<span class="workspace-chip workspace-chip--alert" style="font-size:10px;">${item.attentionReason || "attention"}</span>` : nothing}
        </div>
        <div class="azure-pr-row__meta">
          <span>${item.project?.name || ""} / ${item.repository?.name || ""}</span>
          <span>&middot;</span>
          <span>${authorName}</span>
          <span>&middot;</span>
          <span class="workspace-chip" style="font-size:10px;padding:0 4px;">${item.role || "reviewer"}</span>
        </div>
        <div class="azure-pr-row__branch">
          ${stripHeadRef(pullRequest.sourceRefName)} &rarr; ${stripHeadRef(pullRequest.targetRefName)}
        </div>
      </div>
      <div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px;flex-shrink:0;min-width:100px;">
        ${commentCount ? html`<span class="review-comment__date" title="${commentCount} comments">\u{1F4AC} ${String(commentCount)}</span>` : nothing}
        ${lastActivity ? html`<span class="review-comment__date">${formatRelativeTime(lastActivity)}</span>` : nothing}
      </div>
      <div class="azure-pr-row__actions">
        <button type="button" class="button" data-action="open-azure-pull-request" data-pr-key=${item.prKey || ""} data-workspace-id=${workspaceId}>
          ${actionLabel}
        </button>
        <button type="button" class="button button--ghost" data-action="open-azure-browser" data-url=${pullRequest.webUrl || pullRequest.url || ""}>Browser</button>
      </div>
    </article>
  `;
}

function renderAzureConnectionCard(connection = {}) {
  const isOk = connection.status === "ok";
  const filters = [
    ...(connection.projectFilters?.length ? connection.projectFilters : []),
    ...(connection.repositoryFilters?.length ? connection.repositoryFilters : []),
  ];
  return html`
    <article class="docker-card" style="border-left:3px solid ${isOk ? "var(--accent)" : "var(--muted)"};">
      <div class="docker-card__head">
        <div style="display:flex;align-items:center;gap:8px;">
          <span class="review-comment__avatar" style="background:${isOk ? "var(--accent)" : "var(--muted)"};flex-shrink:0;width:32px;height:32px;font-size:13px;">${avatarInitials(connection.label || "AZ")}</span>
          <div>
            <h4 style="margin:0;">${connection.label || "Azure DevOps"}</h4>
            <p class="docker-card__meta" style="margin:0;">${connection.orgUrl || ""}</p>
          </div>
        </div>
        <span class="workspace-chip ${isOk ? "" : "workspace-chip--alert"}" style="font-size:10px;">${isOk ? "Connected" : connection.status || "idle"}</span>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;padding:4px 0;font-size:12px;color:var(--muted);">
        <span>\u{1F464} ${connection.login || "no login"}</span>
        ${filters.length ? html`<span>\u{1F4C1} ${filters.join(", ")}</span>` : html`<span>\u{1F4C1} all projects</span>`}
        ${connection.pollSeconds ? html`<span>\u{1F504} ${String(connection.pollSeconds)}s</span>` : nothing}
      </div>
      <div class="docker-card__actions">
        <button type="button" class="button button--ghost" data-action="open-azure-connection-dialog" data-connection-id=${connection.id || ""}>Edit</button>
        <button type="button" class="button button--ghost danger" data-action="delete-azure-connection" data-connection-id=${connection.id || ""}>Delete</button>
      </div>
    </article>
  `;
}

export function renderAzureInboxView(azure = {}, settings = {}) {
  const connections = azure.connections || [];
  const inbox = azure.inbox || {};
  const allPrs = inbox.recentlyUpdated || [];
  const needsReviewCount = inbox.needsMyReview?.length || 0;
  const myPrsCount = inbox.myPullRequests?.length || 0;
  const attentionCount = inbox.needsAttention?.length || 0;

  if (!connections.length) {
    return html`
      <div class="terminal-empty" style="align-content:start;padding-top:32px;">
        <p>No Azure DevOps connections yet</p>
        <small>Add a connection with organization URL, login, PAT and review checkout path.</small>
        <div class="docker-card__actions" style="margin-top:12px;">
          <button type="button" class="button" data-action="open-azure-connection-dialog">Add Azure connection</button>
        </div>
      </div>
    `;
  }

  return html`
    <div class="azure-inbox">
      <div class="azure-inbox__toolbar">
        <div class="azure-inbox__tabs">
          <button type="button" class="azure-tab azure-tab--active" data-action="azure-switch-tab" data-tab="all">
            All <span class="azure-tab__count">${String(allPrs.length)}</span>
          </button>
          <button type="button" class="azure-tab ${attentionCount ? "azure-tab--alert" : ""}" data-action="azure-switch-tab" data-tab="attention">
            Needs attention <span class="azure-tab__count">${String(attentionCount)}</span>
          </button>
          <button type="button" class="azure-tab" data-action="azure-switch-tab" data-tab="needs-review">
            Needs review <span class="azure-tab__count">${String(needsReviewCount)}</span>
          </button>
          <button type="button" class="azure-tab" data-action="azure-switch-tab" data-tab="my-prs">
            My PRs <span class="azure-tab__count">${String(myPrsCount)}</span>
          </button>
          <button type="button" class="azure-tab" data-action="azure-switch-tab" data-tab="connections">
            Connections <span class="azure-tab__count">${String(connections.length)}</span>
          </button>
        </div>
        <div class="azure-inbox__actions">
          <button type="button" class="button button--ghost" data-action="refresh-azure">Refresh</button>
          <button type="button" class="button" data-action="open-azure-connection-dialog">Add connection</button>
        </div>
      </div>

      <div class="azure-inbox__content" data-scroll-key="azure-inbox-content">
        <section class="azure-section azure-section--active" data-azure-section="all">
          ${allPrs.length
            ? html`${allPrs.map((item) => renderPullRequestRow(item))}`
            : html`<div class="azure-empty"><p>No active pull requests.</p></div>`}
        </section>
        <section class="azure-section" data-azure-section="attention">
          ${attentionCount
            ? html`${(inbox.needsAttention || []).map((item) => renderPullRequestRow(item))}`
            : html`<div class="azure-empty"><p>No pull requests need your attention right now.</p></div>`}
        </section>
        <section class="azure-section" data-azure-section="needs-review">
          ${needsReviewCount
            ? html`${(inbox.needsMyReview || []).map((item) => renderPullRequestRow(item))}`
            : html`<div class="azure-empty"><p>No pull requests waiting for your review.</p></div>`}
        </section>
        <section class="azure-section" data-azure-section="my-prs">
          ${myPrsCount
            ? html`${(inbox.myPullRequests || []).map((item) => renderPullRequestRow(item))}`
            : html`<div class="azure-empty"><p>You have no active pull requests.</p></div>`}
        </section>
        <section class="azure-section" data-azure-section="connections">
          <div class="section-head" style="padding:0 0 8px;">
            <div>
              <p class="eyebrow">Azure DevOps Connections</p>
              <h3>${String(connections.length)} connection${connections.length !== 1 ? "s" : ""}</h3>
            </div>
          </div>
          <div class="docker-list azure-connection-list" style="gap:8px;">${connections.map((connection) => renderAzureConnectionCard(connection))}</div>
          <div style="margin-top:12px;padding:8px 10px;font-size:12px;color:var(--muted);border-top:1px solid var(--border);">
            <span>\u{1F4C2} Review root: <code>${settings.reviewRoot || "not set"}</code></span>
          </div>
        </section>
      </div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Review detail — shared helpers
// ---------------------------------------------------------------------------

function renderReviewTabButton({ id, label, count = null, alert = false } = {}, activeTab = "summary", workspaceId = "") {
  const classes = ["azure-tab", activeTab === id ? "azure-tab--active" : "", alert ? "azure-tab--alert" : ""].filter(Boolean).join(" ");
  return html`
    <button type="button" class=${classes} data-action="review-switch-tab" data-workspace-id=${workspaceId} data-tab=${id}>
      ${label}
      ${count !== null ? html`<span class="azure-tab__count">${String(count)}</span>` : nothing}
    </button>
  `;
}

function renderReviewerList(reviewers = []) {
  return reviewers.length
    ? html`${reviewers.map((reviewer) => html`
      <li>
        <span class=${voteClass(reviewer.vote)}>${String(reviewer.vote ?? 0)}</span>
        <span class="git-list__text">
          <strong>${reviewer.displayName || "Unknown reviewer"}</strong>
          <span class="review-check__meta"><span>${voteLabel(reviewer.vote)}</span></span>
        </span>
      </li>
    `)}`
    : html`<li><span>No reviewers</span></li>`;
}

// ---------------------------------------------------------------------------
// Enhanced checks
// ---------------------------------------------------------------------------

function renderReviewCheckList(items = []) {
  if (!items.length) return nothing;
  return html`${items.map((item) => html`
    <li class="review-check-item">
      <span class=${reviewCheckClass(item.state)} style="font-size:13px;font-weight:700;">${reviewCheckCode(item.state)}</span>
      <span class="git-list__text">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;">
          <span>
            <strong>${item.name || "Check"}</strong>
            ${item.url ? html`<a class="button button--ghost" style="font-size:11px;padding:1px 6px;text-decoration:none;margin-left:4px;" data-action="open-azure-browser" data-url=${item.url} title="Open build result in Azure DevOps">${item.name} ${item.stateLabel || item.state}</a>` : nothing}
          </span>
          ${item.url ? html`<button type="button" class="button button--ghost" style="font-size:11px;padding:2px 8px;" data-action="open-azure-browser" data-url=${item.url} title="Open build in Azure DevOps to re-queue">Re-queue</button>` : nothing}
        </div>
        ${item.description && item.description !== item.buildInfo ? html`<span class="review-check__description">${item.description}</span>` : nothing}
        ${item.buildInfo ? html`<span class="review-check__meta"><span>${item.buildInfo}</span></span>` : nothing}
        <span class="review-check__meta">
          <span>${item.stateLabel || item.state || "unknown"}</span>
          ${item.optional === true ? html`<span>optional</span>` : item.optional === false ? html`<span>required</span>` : nothing}
          ${item.source ? html`<span>${item.source}</span>` : nothing}
        </span>
        ${item.errorMessage ? html`<pre class="review-check__error">${item.errorMessage}</pre>` : nothing}
      </span>
    </li>
  `)}`;
}

function renderReviewChecksCard(checks = {}) {
  const items = checks.items || [];
  const hasAny = items.length > 0;
  const hasFailure = checks.failedCount > 0;
  const hasRequiredFailure = checks.requiredFailedCount > 0;
  const allPassed = hasAny && !hasFailure && !checks.pendingCount;

  return html`
    <article class="git-card review-card">
      <div class="section-head">
        <div>
          <p class="eyebrow">Checks</p>
        </div>
      </div>
      ${!hasAny ? html`
        <p class="git-card__hint" style="display:flex;align-items:center;gap:8px;color:var(--muted);">
          <span class="git-status-code git-status-code--neutral">--</span>
          No build or policy checks configured for this PR
        </p>
      ` : html`
        <div class="review-meta-list" style="gap:6px;">
          ${allPassed ? html`
            <p style="display:flex;align-items:center;gap:8px;font-size:13px;">
              <span class="git-status-code git-status-code--success" style="font-size:12px;">ok</span>
              <strong style="color:#6edfb6;">${String(checks.passedCount)} check${checks.passedCount !== 1 ? "s" : ""} passed</strong>
            </p>
          ` : nothing}
          ${hasRequiredFailure ? html`
            <p style="display:flex;align-items:center;gap:8px;font-size:13px;">
              <span class="git-status-code git-status-code--failed" style="font-size:12px;">!!</span>
              <strong style="color:var(--danger);">${String(checks.requiredFailedCount)} required check${checks.requiredFailedCount !== 1 ? "s" : ""} failed</strong>
            </p>
          ` : !hasFailure && !allPassed ? html`
            <p style="display:flex;align-items:center;gap:8px;font-size:13px;">
              <span class="git-status-code git-status-code--success" style="font-size:12px;">ok</span>
              <span>No required checks failed</span>
            </p>
          ` : nothing}
          ${checks.optionalFailedCount ? html`
            <p style="display:flex;align-items:center;gap:8px;font-size:13px;">
              <span class="git-status-code git-status-code--failed" style="font-size:12px;">!</span>
              <span style="color:var(--danger);">${String(checks.optionalFailedCount)} optional check${checks.optionalFailedCount !== 1 ? "s" : ""} failed</span>
            </p>
          ` : nothing}
          ${checks.pendingCount ? html`
            <p style="display:flex;align-items:center;gap:8px;font-size:13px;">
              <span class="git-status-code git-status-code--pending" style="font-size:12px;">~</span>
              <span>${String(checks.pendingCount)} check${checks.pendingCount !== 1 ? "s" : ""} still running</span>
            </p>
          ` : nothing}
        </div>
        <div class="review-card__list" data-scroll-key="review-checks-list">
          <ul class="git-list">${renderReviewCheckList(items)}</ul>
        </div>
      `}
    </article>
  `;
}

// ---------------------------------------------------------------------------
// Merge status card (for summary sidebar)
// ---------------------------------------------------------------------------

function renderMergeStatusCard(detail = {}) {
  const info = mergeStatusInfo(detail.pullRequest?.mergeStatus || "");
  return html`
    <article class="git-card review-card">
      <div class="section-head">
        <div><p class="eyebrow">Merge status</p></div>
      </div>
      <p style="display:flex;align-items:center;gap:8px;font-size:13px;">
        <span class="git-status-code ${info.cssClass}" style="font-size:12px;">${info.icon}</span>
        <strong>${info.label}</strong>
      </p>
      ${info.hasConflicts ? html`<p class="git-card__hint" style="color:var(--danger);">Resolve conflicts in the source branch before merging.</p>` : nothing}
    </article>
  `;
}

// ---------------------------------------------------------------------------
// Summary panel — polished main page
// ---------------------------------------------------------------------------

function renderReviewSummaryPanel(detail = {}, workspaceId = "", reviewers = [], checks = {}) {
  const pr = detail.pullRequest || {};
  const prKey = detail.prKey || "";
  const creationDate = pr.creationDate || null;
  const authorName = detail.author?.displayName || "Unknown author";

  return html`
    <div class="review-panel" data-scroll-key="review-summary-panel">
      <div class="review-grid review-grid--summary">
        <!-- Left: Overview -->
        <article class="git-card review-card review-card--hero">
          <div class="section-head">
            <div>
              <p class="eyebrow">Overview</p>
              <h3>${pr.title || "Azure review"}</h3>
            </div>
          </div>
          ${pr.description ? html`<p class="git-card__hint azure-review__description">${pr.description}</p>` : nothing}
          <p class="git-card__hint" style="font-family:monospace;font-size:12px;">${stripHeadRef(pr.sourceRefName)} &rarr; ${stripHeadRef(pr.targetRefName)}</p>

          <div class="review-meta-list" style="margin:8px 0;gap:2px;">
            <p class="git-card__hint">
              <span class="review-comment__avatar" style="background:${avatarColor(authorName)};width:20px;height:20px;font-size:9px;display:inline-flex;vertical-align:middle;margin-right:4px;">${avatarInitials(authorName)}</span>
              <strong>${authorName}</strong>
            </p>
            ${creationDate ? html`
              <p class="git-card__hint"><strong>Created:</strong> ${new Date(creationDate).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })} (${formatRelativeTime(creationDate)})</p>
              <p class="git-card__hint"><strong>Waiting:</strong> ${formatWaitDuration(creationDate)}</p>
            ` : nothing}
            ${pr.status ? html`<p class="git-card__hint"><strong>Status:</strong> ${pr.status}${pr.isDraft ? " (draft)" : ""}</p>` : nothing}
          </div>

          <div class="review-section-divider"><span>Review actions</span></div>
          <div class="docker-card__actions">
            <button type="button" class="button button--ghost" data-action="azure-vote" data-pr-key=${prKey} data-vote="10" title="Approve this pull request - no further changes needed">Approve</button>
            <button type="button" class="button button--ghost" data-action="azure-vote" data-pr-key=${prKey} data-vote="5" title="Approve with minor suggestions - can be merged but improvements welcome">Approve with suggestions</button>
            <button type="button" class="button button--ghost" data-action="azure-vote" data-pr-key=${prKey} data-vote="-5" title="Wait for author - changes or clarification needed before approval">Wait</button>
            <button type="button" class="button button--ghost danger" data-action="azure-vote" data-pr-key=${prKey} data-vote="-10" title="Reject this pull request - significant issues found, should not be merged">Reject</button>
            <button type="button" class="button button--ghost" data-action="azure-vote" data-pr-key=${prKey} data-vote="0" title="Remove your vote from this pull request">Clear vote</button>
          </div>
          <div class="docker-card__actions">
            <button type="button" class="button" data-action="azure-comment" data-pr-key=${prKey} title="Post a new general comment on this pull request">New comment</button>
          </div>

          <div class="review-section-divider"><span>Git operations</span></div>
          <div class="docker-card__actions">
            <button type="button" class="button button--ghost" data-action="azure-fetch-review-workspace" data-workspace-id=${workspaceId} title="Fetch latest changes from Azure DevOps remote into this review workspace">Fetch</button>
            <button type="button" class="button button--ghost" data-action="azure-rebase-review-workspace" data-workspace-id=${workspaceId} title="Rebase the PR source branch onto the latest target branch (e.g. develop)">Rebase on target</button>
            <button type="button" class="button button--ghost" data-action="azure-push-review-workspace" data-workspace-id=${workspaceId} title="Push local changes from this review workspace back to Azure DevOps">Push branch</button>
            <button type="button" class="button button--ghost" data-action="open-lazygit" data-workspace-id=${workspaceId} title="Open Lazygit terminal UI for advanced git operations in this workspace">Open Lazygit</button>
          </div>
        </article>

        <!-- Right: Stacked sidebar cards -->
        <div class="review-sidebar">
          ${renderReviewChecksCard(checks)}

          <article class="git-card review-card">
            <div class="section-head">
              <div>
                <p class="eyebrow">Reviewers</p>
              </div>
            </div>
            ${reviewers.length ? html`
              <div class="review-card__list" data-scroll-key="reviewers-list"><ul class="git-list">${renderReviewerList(reviewers)}</ul></div>
            ` : html`<p class="git-card__hint" style="color:var(--muted);">No reviewers assigned</p>`}
          </article>

          ${renderMergeStatusCard(detail)}
        </div>
      </div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Files panel — changed files with diff viewing
// ---------------------------------------------------------------------------

function buildFileTree(files = []) {
  const root = { name: "", children: new Map(), files: [] };
  for (const file of files) {
    const parts = (file.path || "").replace(/^\/+/, "").split("/");
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!node.children.has(parts[i])) {
        node.children.set(parts[i], { name: parts[i], children: new Map(), files: [] });
      }
      node = node.children.get(parts[i]);
    }
    node.files.push({ ...file, displayName: parts.at(-1) || file.path });
  }
  // Collapse single-child directories: a/b/c → a/b/c
  function collapse(node) {
    for (const [key, child] of node.children) {
      collapse(child);
      if (child.children.size === 1 && child.files.length === 0) {
        const [grandKey, grandChild] = [...child.children.entries()][0];
        node.children.delete(key);
        node.children.set(`${key}/${grandKey}`, grandChild);
        grandChild.name = `${key}/${grandKey}`;
      }
    }
  }
  collapse(root);
  return root;
}

function renderFileTreeNode(node, depth, selectedPath, workspaceId, targetBranch) {
  const indent = depth * 16;
  const dirs = [...node.children.values()].sort((a, b) => a.name.localeCompare(b.name));
  const files = [...node.files].sort((a, b) => (a.displayName || "").localeCompare(b.displayName || ""));

  return html`
    ${dirs.map((dir) => html`
      <details class="review-tree-dir" open>
        <summary class="review-tree-dir__label" style="padding-left:${String(indent + 6)}px;">
          <span class="review-tree-dir__icon"></span>
          <span>${dir.name}</span>
        </summary>
        ${renderFileTreeNode(dir, depth + 1, selectedPath, workspaceId, targetBranch)}
      </details>
    `)}
    ${files.map((file) => {
      const normalizedPath = (file.path || "").replace(/^\/+/, "");
      const isSelected = selectedPath === file.path || selectedPath === normalizedPath;
      return html`
        <button
          type="button"
          class=${`review-tree-file ${isSelected ? "review-tree-file--active" : ""}`}
          style="padding-left:${String(indent + 6)}px;"
          data-action="review-select-file-diff"
          data-workspace-id=${workspaceId}
          data-path=${file.path || ""}
          data-base-branch=${targetBranch}
          title=${file.path || ""}
        >
          <span class=${changeTypeClass(file.changeType)}>${changeTypeLabel(file.changeType)}</span>
          <span class="review-tree-file__name">${file.displayName}</span>
        </button>
      `;
    })}
  `;
}

function renderReviewFilesPanel(detail = {}, changedFiles = [], reviewUi = {}, workspaceId = "") {
  const diffPreview = reviewUi.reviewFileDiffPreview || null;
  const selectedPath = reviewUi.reviewSelectedFile || "";
  const targetBranch = stripHeadRef(detail.pullRequest?.targetRefName);
  const tree = buildFileTree(changedFiles);

  return html`
    <div class="review-files-split">
      <!-- Left: file tree -->
      <div class="review-files-split__left" data-scroll-key="review-files-list">
        <div class="section-head" style="padding:0 6px;">
          <div>
            <p class="eyebrow">Changed files</p>
            <h3>${String(changedFiles.length)} files</h3>
          </div>
        </div>
        ${changedFiles.length
          ? html`<div class="review-file-tree" style="margin-top:8px;">${renderFileTreeNode(tree, 0, selectedPath, workspaceId, targetBranch)}</div>`
          : html`<p class="git-card__hint" style="padding:6px;">No changed files found.</p>`}
      </div>

      <!-- Right: diff preview -->
      <div class="review-files-split__right" data-scroll-key="review-files-diff">
        ${diffPreview ? html`
          <div class="section-head" style="padding:0 6px;">
            <div>
              <p class="eyebrow">Diff preview</p>
              <h3>${diffPreview.path || selectedPath}</h3>
            </div>
          </div>
          ${diffPreview.diff
            ? html`<pre class="git-output git-output--preview review-diff-output">${unsafeHTML(renderDiffSnippet(diffPreview.diff))}</pre>`
            : html`<p class="git-card__hint" style="padding:6px;">${diffPreview.summary || "No diff available."}</p>`}
        ` : html`
          <div class="review-files-empty">
            <p class="eyebrow">Diff preview</p>
            <p class="git-card__hint">Click on a file in the list to view its diff.</p>
          </div>
        `}
      </div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Comments panel — merged Azure threads + local bridge comments
// ---------------------------------------------------------------------------

function renderCommentThreadCard(thread = {}, prKey = "", draftsByThread = new Map(), commentIndex = 0) {
  const comments = thread.comments || [];
  const parentCommentId = String(comments.at(-1)?.id || 0);
  const hasFileContext = Boolean(thread.filePath);
  const draft = draftsByThread.get(String(thread.id));
  const firstAuthor = comments[0]?.author?.displayName || "";

  return html`
    <article class="docker-card review-comment-card">
      <div class="docker-card__head">
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;width:100%;">
          ${commentIndex ? html`<span class="workspace-chip" style="font-weight:bold;min-width:28px;text-align:center;" title="Comment #${String(commentIndex)} — use this number with MCP tools">#${String(commentIndex)}</span>` : nothing}
          <span class=${threadStatusClass(thread.status)}>${threadStatusLabel(thread.status)}</span>
          ${hasFileContext ? html`
            <span class="review-comment-file" title=${thread.filePath || ""}>
              ${fileName(thread.filePath)}${thread.lineStart ? html`<span class="review-comment-line">:${String(thread.lineStart)}${thread.lineEnd && thread.lineEnd !== thread.lineStart ? `-${String(thread.lineEnd)}` : ""}</span>` : nothing}
            </span>
          ` : nothing}
          ${thread.publishedDate ? html`<span class="review-comment__date">${formatRelativeTime(thread.publishedDate)}</span>` : nothing}
        </div>
      </div>

      ${hasFileContext ? html`
        <div class="review-comment-context">
          <code class="review-comment-context__path">${thread.filePath}${thread.lineStart ? `:${String(thread.lineStart)}` : ""}</code>
          ${thread.codeSnippet ? html`<pre class="review-code-snippet">${unsafeHTML(renderDiffSnippet(thread.codeSnippet))}</pre>` : nothing}
        </div>
      ` : nothing}

      <div class="review-comment-thread">
        ${comments.map((comment, index) => {
          const authorName = comment.author?.displayName || "Unknown author";
          return html`
            <div class="review-comment ${index > 0 ? "review-comment--reply" : ""}">
              <span class="review-comment__avatar" style="background:${avatarColor(authorName)}">${avatarInitials(authorName)}</span>
              <div>
                <div class="review-comment__header">
                  <strong>${authorName}</strong>
                  ${comment.publishedDate ? html`<span class="review-comment__date">${formatRelativeTime(comment.publishedDate)}</span>` : nothing}
                </div>
                <div class="review-comment__body">${unsafeHTML(renderMarkdownToHtml(comment.content || ""))}</div>
              </div>
            </div>
          `;
        })}
      </div>

      ${draft && draft.status !== "synced" ? html`
        <div class="review-comment review-comment--draft" style="${draft.status === "ready-to-sync" ? "opacity:0.7;border-left:2px solid var(--accent);" : ""}">
          <div class="review-comment__header">
            <strong>${draft.status === "ready-to-sync" ? "Queued reply" : "Draft reply"}</strong>
            <span class="workspace-chip workspace-chip--local">${draft.status === "ready-to-sync" ? "queued" : "local draft"}</span>
            ${draft.authorAgent ? html`<span class="review-comment__date">by ${draft.authorAgent}</span>` : nothing}
          </div>
          <div class="review-comment__body">${unsafeHTML(renderMarkdownToHtml(draft.body || ""))}</div>
          <div class="docker-card__actions" style="margin-top:6px;">
            ${draft.status !== "ready-to-sync" ? html`
              <button type="button" class="button button--ghost" data-action="review-bridge-edit-draft" data-pr-key=${prKey} data-comment-key=${draft.commentKey}>Edit</button>
              <button type="button" class="button button--ghost" data-action="review-bridge-queue-draft" data-pr-key=${prKey} data-draft-id=${draft.draftId}>Queue for sync</button>
            ` : html`
              <span class="review-comment__date">Waiting for publish</span>
            `}
            <button type="button" class="button button--ghost danger" data-action="review-bridge-delete-draft" data-pr-key=${prKey} data-draft-id=${draft.draftId} title="Delete this draft">Delete</button>
          </div>
        </div>
      ` : nothing}

      <div class="docker-card__actions">
        <button type="button" class="button button--ghost" data-action="azure-reply-thread" data-pr-key=${prKey} data-thread-id=${String(thread.id || "")} data-parent-comment-id=${parentCommentId}>Reply</button>
        ${String(thread.status || "").toLowerCase() === "active" ? html`
          <button type="button" class="button button--ghost" data-action="azure-resolve-thread" data-pr-key=${prKey} data-thread-id=${String(thread.id || "")}>Resolve</button>
        ` : nothing}
        ${String(thread.status || "").toLowerCase() === "fixed" || String(thread.status || "").toLowerCase() === "closed" ? html`
          <button type="button" class="button button--ghost" data-action="azure-reactivate-thread" data-pr-key=${prKey} data-thread-id=${String(thread.id || "")}>Reactivate</button>
        ` : nothing}
      </div>
    </article>
  `;
}

function renderLocalDraftCard(comment = {}, draft = null, prKey = "", commentIndex = 0) {
  return html`
    <article class="docker-card review-comment-card review-comment-card--local">
      <div class="docker-card__head">
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;width:100%;">
          ${commentIndex ? html`<span class="workspace-chip" style="font-weight:bold;min-width:28px;text-align:center;" title="Comment #${String(commentIndex)} — use this number with MCP tools">#${String(commentIndex)}</span>` : nothing}
          <span class="workspace-chip workspace-chip--local">local</span>
          ${comment.payload?.filePath ? html`<span class="workspace-chip" style="font-size:11px;" title="${comment.payload.filePath}${comment.payload.lineNumber ? `:${String(comment.payload.lineNumber)}` : ""}">${comment.payload.filePath.split("/").pop()}${comment.payload.lineNumber ? `:${String(comment.payload.lineNumber)}` : ""}</span>` : nothing}
          <strong style="font-size:13px;">${comment.title || comment.commentKey}</strong>
          <span class="review-comment__date">${comment.status || "ready-for-agent"} &middot; ${comment.priority || "medium"}</span>
        </div>
      </div>
      ${comment.summary ? html`<p class="git-card__hint" style="margin:0;">${comment.summary}</p>` : nothing}
      ${comment.commentKind === "local-comment" && comment.payload?.questionBody && !draft ? html`
        <div class="review-comment review-comment--draft">
          <div class="review-comment__body">${unsafeHTML(renderMarkdownToHtml(comment.payload.questionBody))}</div>
        </div>
      ` : nothing}
      ${draft ? html`
        <div class="review-comment review-comment--draft">
          <div class="review-comment__header">
            <strong>Draft</strong>
            <span class="workspace-chip">${draft.status || "draft"}</span>
            ${draft.authorAgent ? html`<span class="review-comment__date">by ${draft.authorAgent}</span>` : nothing}
          </div>
          <div class="review-comment__body">${unsafeHTML(renderMarkdownToHtml(draft.body || ""))}</div>
        </div>
      ` : nothing}
      <div class="docker-card__actions">
        <button type="button" class="button" data-action="review-bridge-edit-draft" data-pr-key=${prKey} data-comment-key=${comment.commentKey}>${draft ? "Edit draft" : "Create draft"}</button>
        ${draft ? html`<button type="button" class="button button--ghost" data-action="review-bridge-queue-draft" data-pr-key=${prKey} data-draft-id=${draft.draftId}>Queue for sync</button>` : nothing}
        <button type="button" class="button button--ghost danger" data-action="review-bridge-delete-comment" data-pr-key=${prKey} data-comment-key=${comment.commentKey} title="Delete this local comment and its drafts">Delete</button>
      </div>
    </article>
  `;
}

function renderReviewCommentsPanel(detail = {}, threads = [], reviewBridge = {}, reviewUi = {}, workspaceId = "") {
  const prKey = detail.prKey || "";
  const allComments = reviewBridge.comments || [];
  const draftsByComment = new Map((reviewBridge.drafts || []).map((d) => [d.commentKey, d]));

  // Build comment index maps using stable displayIndex from DB (matches MCP numbering)
  const threadToCommentIndex = new Map();
  const commentKeyToIndex = new Map();
  for (const comment of allComments) {
    if (comment.displayIndex) {
      commentKeyToIndex.set(comment.commentKey, comment.displayIndex);
      if (comment.remoteThreadId) threadToCommentIndex.set(String(comment.remoteThreadId), comment.displayIndex);
    }
  }

  // Build a map of drafts keyed by Azure thread ID for inline display
  const draftsByThread = new Map();
  const threadIdsWithDraft = new Set();
  for (const comment of allComments) {
    if (comment.commentKind !== "local-comment" && comment.remoteThreadId) {
      const draft = draftsByComment.get(comment.commentKey);
      if (draft) {
        draftsByThread.set(String(comment.remoteThreadId), draft);
        threadIdsWithDraft.add(String(comment.remoteThreadId));
      }
    }
  }

  const localComments = allComments.filter((t) => t.commentKind === "local-comment");
  const allActiveThreads = threads.filter((t) => String(t.status || "").toLowerCase() !== "unknown" && !t.isDeleted);

  // Filtering
  const filter = reviewUi.commentFilter || "all";
  const myDisplayName = detail.pullRequest?.createdBy?.displayName || "";
  let filteredThreads = allActiveThreads;
  let filteredLocalComments = localComments;
  if (filter === "has-draft") {
    filteredThreads = allActiveThreads.filter((t) => threadIdsWithDraft.has(String(t.id)));
    filteredLocalComments = localComments.filter((t) => draftsByComment.has(t.commentKey));
  } else if (filter === "active") {
    filteredThreads = allActiveThreads.filter((t) => String(t.status || "").toLowerCase() === "active");
  } else if (filter === "mine") {
    filteredThreads = allActiveThreads.filter((t) => {
      const authors = (t.comments || []).map((c) => c.author?.displayName || "");
      return authors.includes(myDisplayName) || threadIdsWithDraft.has(String(t.id));
    });
  }

  // Text search
  const searchTerm = (reviewUi.commentSearch || "").toLowerCase().trim();
  if (searchTerm) {
    const matchesThread = (t) => {
      const texts = [t.filePath || "", ...(t.comments || []).map((c) => c.content || "")];
      return texts.some((text) => text.toLowerCase().includes(searchTerm));
    };
    const matchesLocal = (c) => {
      return [c.title || "", c.summary || "", c.payload?.questionBody || ""].some((t) => t.toLowerCase().includes(searchTerm));
    };
    filteredThreads = filteredThreads.filter(matchesThread);
    filteredLocalComments = filteredLocalComments.filter(matchesLocal);
  }

  // Sorting
  const sort = reviewUi.commentSort || "index";
  const threadSortIndex = (t) => threadToCommentIndex.get(String(t.id)) || 9999;
  if (sort === "newest") {
    const lastActivity = (t) => {
      const dates = (t.comments || []).map((c) => c.publishedDate || c.lastUpdatedDate || "");
      return dates.length ? dates[dates.length - 1] : t.publishedDate || "";
    };
    filteredThreads = [...filteredThreads].sort((a, b) => (lastActivity(b) || "").localeCompare(lastActivity(a) || ""));
  } else if (sort === "status") {
    const statusOrder = { active: 0, pending: 1, "": 2, fixed: 3, closed: 4, wontfix: 5, bydesign: 6 };
    filteredThreads = [...filteredThreads].sort((a, b) => (statusOrder[String(a.status || "").toLowerCase()] ?? 2) - (statusOrder[String(b.status || "").toLowerCase()] ?? 2));
  } else if (sort === "file") {
    filteredThreads = [...filteredThreads].sort((a, b) => (a.filePath || "").localeCompare(b.filePath || ""));
  } else {
    // Default: by display index
    filteredThreads = [...filteredThreads].sort((a, b) => threadSortIndex(a) - threadSortIndex(b));
  }

  const totalCount = allActiveThreads.length + localComments.length;
  const visibleCount = filteredThreads.length + filteredLocalComments.length;
  const isFiltered = filter !== "all" || searchTerm;

  const sortOptions = [
    { id: "index", label: "#N" },
    { id: "newest", label: "Newest" },
    { id: "status", label: "Status" },
    { id: "file", label: "File" },
  ];

  return html`
    <div class="review-panel" data-scroll-key="review-comments-panel">
      <article class="git-card review-card review-card--stack">
        <div class="section-head">
          <div>
            <p class="eyebrow">Comments</p>
            <h3>${isFiltered ? `${String(visibleCount)} / ${String(totalCount)}` : String(totalCount)} conversation${totalCount !== 1 ? "s" : ""}</h3>
          </div>
          <div class="docker-card__actions">
            <button type="button" class="button button--ghost" data-action="review-comment-nav" data-direction="prev" title="Previous comment">\u25B2 Prev</button>
            <button type="button" class="button button--ghost" data-action="review-comment-nav" data-direction="next" title="Next comment">\u25BC Next</button>
            <button type="button" class="button" data-action="azure-comment" data-pr-key=${prKey}>New comment</button>
            <button type="button" class="button button--ghost" data-action="review-bridge-create-local-comment" data-pr-key=${prKey}>New local comment</button>
          </div>
        </div>

        <div style="display:flex;gap:4px;padding:0 10px 6px;flex-wrap:wrap;align-items:center;">
          ${["all", "active", "has-draft", "mine"].map((f) => html`
            <button type="button"
              class="button button--ghost ${filter === f ? "button--active" : ""}"
              style="font-size:11px;padding:2px 8px;${filter === f ? "background:var(--accent);color:var(--bg);" : ""}"
              data-action="review-comment-filter"
              data-filter=${f}
              data-workspace-id=${workspaceId}
            >${f === "all" ? "All" : f === "active" ? "Active" : f === "has-draft" ? "Has draft" : "Mine"}</button>
          `)}
          <span style="width:1px;height:16px;background:var(--border);margin:0 2px;"></span>
          ${sortOptions.map((s) => html`
            <button type="button"
              class="button button--ghost ${sort === s.id ? "button--active" : ""}"
              style="font-size:11px;padding:2px 8px;${sort === s.id ? "background:var(--accent);color:var(--bg);" : ""}"
              data-action="review-comment-sort"
              data-sort=${s.id}
              data-workspace-id=${workspaceId}
              title="Sort by ${s.label}"
            >\u2195 ${s.label}</button>
          `)}
          <span style="flex:1;"></span>
          <input type="text"
            class="input"
            style="font-size:11px;padding:2px 8px;width:140px;min-width:80px;"
            placeholder="Search..."
            .value=${searchTerm}
            data-action="review-comment-search"
            data-workspace-id=${workspaceId}
          />
        </div>

        <div class="docker-list review-card__list review-card__list--dense" data-scroll-key="comments-list">
          ${filteredThreads.length || filteredLocalComments.length
            ? html`
              ${filteredThreads.map((thread) => renderCommentThreadCard(thread, prKey, draftsByThread, threadToCommentIndex.get(String(thread.id)) || 0))}
              ${filteredLocalComments.length ? html`
                <div class="review-section-divider"><span>Local comments</span></div>
                ${filteredLocalComments.map((comment) => renderLocalDraftCard(comment, draftsByComment.get(comment.commentKey), prKey, commentKeyToIndex.get(comment.commentKey) || 0))}
              ` : nothing}
            `
            : html`<div class="empty-card"><p>${isFiltered ? "No comments match this filter." : "No comments or threads yet."}</p></div>`}
        </div>
      </article>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Conflicts panel
// ---------------------------------------------------------------------------

function renderReviewConflictsPanel(detail = {}, reviewUi = {}, workspaceId = "") {
  const mergeStatus = detail.pullRequest?.mergeStatus || "";
  const info = mergeStatusInfo(mergeStatus);
  const sourceBranch = stripHeadRef(detail.pullRequest?.sourceRefName || "");
  const targetBranch = stripHeadRef(detail.pullRequest?.targetRefName || "");
  const changedFiles = detail.changedFiles || [];
  const localFiles = detail.localChangedFiles || [];
  const localPathSet = new Set(localFiles.map((f) => f.path || f));
  const overlappingFiles = changedFiles.filter((f) => localPathSet.has(f.path || f));
  const diffPreview = reviewUi.reviewFileDiffPreview || null;
  const selectedPath = reviewUi.reviewSelectedFile || "";

  return html`
    <div class="review-panel" data-scroll-key="review-conflicts-panel">
      <article class="git-card review-card">
        <div class="section-head">
          <div>
            <p class="eyebrow">Merge Status</p>
            <h3 style="display:flex;align-items:center;gap:8px;">
              <span class="git-status-code ${info.cssClass}">${info.icon}</span>
              ${info.label}
            </h3>
          </div>
          <div class="docker-card__actions">
            <button type="button" class="button button--ghost" data-action="refresh-azure">Refresh</button>
            <button type="button" class="button button--ghost" data-action="open-azure-browser" data-url=${detail.pullRequest?.webUrl || ""}>View in Azure DevOps</button>
          </div>
        </div>
        <p class="git-card__hint" style="margin:0;">
          ${info.hasConflicts
            ? html`Merge conflicts detected between <strong>${sourceBranch}</strong> and <strong>${targetBranch}</strong>. Resolve conflicts in the source branch and push to update.`
            : mergeStatus === "succeeded"
              ? html`<strong>${sourceBranch}</strong> can be merged into <strong>${targetBranch}</strong> without conflicts.`
              : html`Azure DevOps merge status: <code>${mergeStatus || "not set"}</code>`}
        </p>
      </article>

      ${info.hasConflicts && changedFiles.length ? html`
        <div class="review-files-split" style="margin-top:8px;">
          <div class="review-files-split__left" data-scroll-key="review-conflicts-list">
            <div class="section-head" style="padding:0 6px;">
              <div>
                <p class="eyebrow">Changed Files</p>
                <h3>${String(changedFiles.length)} file${changedFiles.length !== 1 ? "s" : ""}${overlappingFiles.length ? html` <span class="workspace-chip workspace-chip--alert" style="font-size:10px;">${String(overlappingFiles.length)} local</span>` : ""}</h3>
              </div>
            </div>
            <p class="git-card__hint" style="padding:0 6px;margin:4px 0;">Click a file to see its diff. Resolve conflicts in your branch and push.</p>
            <div class="review-file-tree" style="margin-top:4px;">
              ${renderFileTreeNode(buildFileTree(changedFiles), 0, selectedPath, workspaceId, targetBranch)}
            </div>
          </div>
          <div class="review-files-split__right" data-scroll-key="review-conflicts-diff">
            ${diffPreview ? html`
              <div class="section-head" style="padding:0 6px;">
                <div>
                  <p class="eyebrow">Diff preview</p>
                  <h3 style="word-break:break-all;">${diffPreview.path || ""}</h3>
                </div>
              </div>
              ${diffPreview.diff
                ? html`<pre class="git-output git-output--preview review-diff-output">${unsafeHTML(renderDiffSnippet(diffPreview.diff))}</pre>`
                : html`<p class="git-card__hint" style="padding:6px;">${diffPreview.summary || "No diff available."}</p>`}
            ` : html`
              <div class="review-files-empty">
                <p class="eyebrow">Diff preview</p>
                <p class="git-card__hint">Click on a file to view its diff.</p>
              </div>
            `}
          </div>
        </div>
      ` : nothing}

      ${!info.hasConflicts ? html`
        <article class="git-card review-card" style="margin-top:8px;">
          <div style="display:flex;align-items:center;gap:10px;padding:4px 0;">
            <span class="git-status-code git-status-code--success" style="font-size:1.2em;">\u2713</span>
            <div>
              <p style="margin:0;"><strong>No conflicts</strong></p>
              <p class="git-card__hint" style="margin:2px 0 0;">All files can be merged cleanly from <strong>${sourceBranch}</strong> into <strong>${targetBranch}</strong>.</p>
            </div>
          </div>
        </article>
      ` : nothing}
    </div>
  `;
}

// (Drafts & Sync panel removed — drafts are now managed inline in the Comments tab,
//  sync failures shown in the toolbar bar above the tabs)

// ---------------------------------------------------------------------------
// Agent panel — English prompts with copy-to-clipboard
// ---------------------------------------------------------------------------

function renderAgentPromptCard(prompt = {}, prId = "?", prTitle = "") {
  const rendered = (prompt.template || "")
    .replace(/\{prId\}/g, String(prId))
    .replace(/\{prTitle\}/g, prTitle);

  return html`
    <article class="docker-card review-agent-card">
      <div class="docker-card__head">
        <div>
          <h4>${prompt.title}</h4>
          ${prompt.description ? html`<p class="docker-card__meta">${prompt.description}</p>` : nothing}
        </div>
        <div style="display:flex;gap:4px;align-items:center;">
          <button type="button" class="button button--ghost review-copy-btn" data-action="copy-text" data-text=${rendered} title="Copy to clipboard">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 010 1.5h-1.5a.25.25 0 00-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 00.25-.25v-1.5a.75.75 0 011.5 0v1.5A1.75 1.75 0 019.25 16h-7.5A1.75 1.75 0 010 14.25v-7.5z"/><path d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0114.25 11h-7.5A1.75 1.75 0 015 9.25v-7.5zm1.75-.25a.25.25 0 00-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 00.25-.25v-7.5a.25.25 0 00-.25-.25h-7.5z"/></svg>
          </button>
          <button type="button" class="button button--ghost review-copy-btn" data-action="edit-agent-prompt" data-prompt-id=${prompt.promptId || ""} data-prompt-title=${prompt.title || ""} data-prompt-description=${prompt.description || ""} data-prompt-template=${prompt.template || ""} title="Edit this prompt">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M11.013 1.427a1.75 1.75 0 012.474 0l1.086 1.086a1.75 1.75 0 010 2.474l-8.61 8.61c-.21.21-.47.364-.756.445l-3.251.93a.75.75 0 01-.927-.928l.929-3.25c.081-.286.235-.547.445-.758l8.61-8.61zm1.414 1.06a.25.25 0 00-.354 0L3.462 11.098a.25.25 0 00-.064.108l-.631 2.208 2.208-.63a.25.25 0 00.108-.064l8.61-8.61a.25.25 0 000-.354l-1.086-1.086z"/></svg>
          </button>
          ${!prompt.isDefault ? html`
            <button type="button" class="button button--ghost review-copy-btn danger" data-action="delete-agent-prompt" data-prompt-id=${prompt.promptId || ""} title="Delete this prompt">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M6.5 1.75a.25.25 0 01.25-.25h2.5a.25.25 0 01.25.25V3h-3V1.75zM11 3V1.75A1.75 1.75 0 009.25 0h-2.5A1.75 1.75 0 005 1.75V3H2.75a.75.75 0 000 1.5h.928l.856 10.268A1.75 1.75 0 006.282 16h3.436a1.75 1.75 0 001.748-1.632l.856-10.268h.928a.75.75 0 000-1.5H11z"/></svg>
            </button>
          ` : nothing}
        </div>
      </div>
      <pre class="git-output review-agent-prompt">${rendered}</pre>
    </article>
  `;
}

function renderReviewAgentPanel(detail = {}, reviewBridge = {}, reviewUi = {}, workspaceId = "") {
  const prId = detail.pullRequest?.id || "?";
  const prTitle = detail.pullRequest?.title || "";
  const prompts = reviewBridge.agentPrompts || [];
  const agentSubTab = reviewUi.agentSubTab || "prompts";
  const env = (reviewBridge.agentInstructions || {}).env || {};
  const prKey = env.STRIDETERM_REVIEW_PR_KEY || detail.prKey || "";
  const reviewRoot = env.STRIDETERM_REVIEW_DB ? env.STRIDETERM_REVIEW_DB.replace(/[/\\][^/\\]+$/, "") : "";
  const mcpSpec = reviewBridge.mcpServerSpec || {};
  // In dev mode, execPath points to electron binary — show the packaged app path instead
  const rawCommand = mcpSpec.command || "";
  const isDevPath = /electron|node_modules/i.test(rawCommand);
  const mcpCommand = isDevPath ? "strideterm" : rawCommand;
  const mcpCommandNote = isDevPath ? "(replace with the actual path to your installed strIDEterm binary)" : "";
  const mcpArgs = mcpSpec.args || [];
  const mcpEnv = mcpSpec.env || {};

  return html`
    <div class="review-panel" data-scroll-key="review-agent-panel">
      <div style="display:flex;gap:4px;padding:0 0 8px;">
        <button type="button"
          class="button button--ghost ${agentSubTab === "prompts" ? "button--active" : ""}"
          style="font-size:12px;padding:4px 12px;${agentSubTab === "prompts" ? "background:var(--accent);color:var(--bg);" : ""}"
          data-action="review-agent-subtab" data-subtab="prompts" data-workspace-id=${workspaceId}
        >Prompts</button>
        <button type="button"
          class="button button--ghost ${agentSubTab === "connect" ? "button--active" : ""}"
          style="font-size:12px;padding:4px 12px;${agentSubTab === "connect" ? "background:var(--accent);color:var(--bg);" : ""}"
          data-action="review-agent-subtab" data-subtab="connect" data-workspace-id=${workspaceId}
        >Connect your agent</button>
      </div>

      ${agentSubTab === "prompts" ? html`
        <article class="git-card review-card review-card--stack">
          <div class="section-head">
            <div>
              <p class="eyebrow">Review Prompts</p>
              <h3>Ready-to-use prompts for AI agents</h3>
            </div>
          </div>
          <p class="git-card__hint">Copy a prompt and paste it into Claude Code, Codex, or any MCP-capable agent. Click edit to customize.</p>
          <div class="docker-list review-card__list review-card__list--dense review-agent-prompts" data-scroll-key="agent-prompts">
            ${prompts.length ? prompts.map((p) => renderAgentPromptCard(p, prId, prTitle)) : html`<p class="git-card__hint">No prompts configured.</p>`}
          </div>
        </article>
      ` : html`
        <article class="git-card review-card">
          <div class="section-head">
            <div>
              <p class="eyebrow">Connect Any MCP Agent</p>
              <h3>Use the review bridge with your own agent</h3>
            </div>
          </div>
          <p class="git-card__hint">Claude Code and Codex get MCP tools auto-attached when launched in this workspace. For other agents, configure the MCP server with one of the examples below.</p>
          ${mcpCommandNote ? html`<p class="git-card__hint" style="color:var(--warning);"><strong>Dev mode:</strong> ${mcpCommandNote}</p>` : nothing}

          <div style="margin-top:12px;">
            <p class="eyebrow" style="margin-bottom:4px;">Available MCP Tools</p>
            <div style="display:grid;gap:4px;font-size:12px;">
              ${[
                { name: "list_review_comments", desc: "List all comment threads with status and draft previews" },
                { name: "get_review_comment", desc: "Get full detail for a comment by #N index" },
                { name: "create_review_comment", desc: "Create a new review comment with auto-created draft" },
                { name: "save_review_draft", desc: "Save a draft reply for a comment" },
                { name: "queue_review_draft", desc: "Queue a draft for publishing to Azure DevOps" },
              ].map((tool) => html`
                <div style="display:flex;gap:8px;padding:4px 8px;border-left:2px solid var(--accent);">
                  <code style="flex-shrink:0;color:var(--accent);">${tool.name}</code>
                  <span style="color:var(--muted);">${tool.desc}</span>
                </div>
              `)}
            </div>
          </div>

          <div style="margin-top:16px;">
            <p class="eyebrow" style="margin-bottom:4px;">OpenCode / Crush</p>
            <p class="git-card__hint" style="margin:0 0 4px;">Create <code>.opencode.json</code> in your project root:</p>
            <pre class="git-output review-agent-prompt" style="font-size:11px;padding:8px;margin:0;">${`{
  "mcpServers": {
    "strideterm-review": {
      "type": "stdio",
      "command": "${mcpCommand.replace(/\\/g, "\\\\")}"${mcpArgs.length ? `,
      "args": ${JSON.stringify(mcpArgs)}` : ""}${Object.keys(mcpEnv).length ? `,
      "env": [${Object.entries(mcpEnv).map(([k, v]) => `"${k}=${v}"`).join(", ")}]` : ""}
    }
  }
}`}</pre>
          </div>

          <div style="margin-top:16px;">
            <p class="eyebrow" style="margin-bottom:4px;">Claude Code (standalone)</p>
            <p class="git-card__hint" style="margin:0 0 4px;">Create <code>mcp.json</code> and run <code>claude --mcp-config mcp.json</code>:</p>
            <pre class="git-output review-agent-prompt" style="font-size:11px;padding:8px;margin:0;">${`{
  "mcpServers": {
    "strideterm-review": {
      "command": "${mcpCommand.replace(/\\/g, "\\\\")}"${mcpArgs.length ? `,
      "args": ${JSON.stringify(mcpArgs)}` : ""}${Object.keys(mcpEnv).length ? `,
      "env": ${JSON.stringify(mcpEnv)}` : ""}
    }
  }
}`}</pre>
          </div>

          <div style="margin-top:16px;">
            <p class="eyebrow" style="margin-bottom:4px;">Generic MCP (any stdio-capable agent)</p>
            <p class="git-card__hint" style="margin:0 0 4px;">Run this command as your MCP server process:</p>
            <pre class="git-output review-agent-prompt" style="font-size:11px;padding:8px;margin:0;">${Object.keys(mcpEnv).length ? Object.entries(mcpEnv).map(([k, v]) => `${k}=${v}`).join(" ") + " " : ""}${mcpCommand} ${mcpArgs.join(" ")}</pre>
          </div>
        </article>
      `}
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Main review view — updated tabs
// ---------------------------------------------------------------------------

export function renderAzureReviewView(detail = {}, workspaceId = "", reviewBridge = {}, reviewUi = {}) {
  const pullRequest = detail.pullRequest || {};
  const threads = detail.threads || [];
  const changedFiles = detail.changedFiles?.length ? detail.changedFiles : (detail.localChangedFiles || []);
  const reviewers = detail.reviewerSummary?.reviewers || [];
  const checks = detail.checks || {};
  const syncQueue = reviewBridge.syncQueue || [];
  const pendingSyncCount = syncQueue.filter((item) => item.status === "pending" || item.status === "failed").length;
  const failedSyncItems = syncQueue.filter((item) => item.status === "failed");
  const activeTab = reviewUi.activeReviewTab || "summary";
  const mergeStatus = pullRequest.mergeStatus || "";
  const conflictInfo = mergeStatusInfo(mergeStatus);
  const activeThreads = threads.filter((t) => String(t.status || "").toLowerCase() !== "unknown" && !t.isDeleted);
  const localCommentCount = (reviewBridge.comments || []).filter((t) => t.commentKind === "local-comment").length;
  const commentCount = activeThreads.length + localCommentCount;

  return html`
    <div class="git-view review-shell">
      <div class="git-view__toolbar">
        <div class="git-view__summary">
          <span class="workspace-chip"><strong>PR #${String(pullRequest.id || "")}</strong></span>
          <span class="workspace-chip">${detail.project?.name || ""} / ${detail.repository?.name || ""}</span>
          <span class="workspace-chip">${detail.role || ""}</span>
          ${checks.failedCount ? html`<span class="workspace-chip workspace-chip--alert">${String(checks.failedCount)} failed checks</span>` : nothing}
          ${checks.pendingCount ? html`<span class="workspace-chip">${String(checks.pendingCount)} pending checks</span>` : nothing}
          ${detail.hasAttention ? html`<span class="workspace-chip workspace-chip--alert">${detail.attentionReason || "attention"}</span>` : nothing}
          ${pendingSyncCount ? html`<span class="workspace-chip">${String(pendingSyncCount)} queued drafts</span>` : nothing}
        </div>
        <div class="git-view__actions" style="margin-left:auto;">
          <button type="button" class="button button--ghost" data-action="refresh-azure" title="Refresh PR data from Azure DevOps">Refresh</button>
          <button type="button" class="button button--ghost" data-action="mark-azure-pr-seen" data-pr-key=${detail.prKey || ""} title="Mark this PR as seen, clearing attention flags">Mark seen</button>
          <button type="button" class="button" data-action="review-bridge-sync" data-pr-key=${detail.prKey || ""} title=${pendingSyncCount ? `Publish ${pendingSyncCount} queued draft(s) to Azure DevOps` : "No drafts queued for publishing"} ?disabled=${!pendingSyncCount}>Publish queued drafts${pendingSyncCount ? ` (${pendingSyncCount})` : ""}</button>
          <button type="button" class="button button--ghost" data-action="open-azure-browser" data-url=${pullRequest.webUrl || pullRequest.url || ""} title="Open this PR in Azure DevOps browser">Browser</button>
        </div>
      </div>

      ${failedSyncItems.length ? html`
        <div style="padding:4px 12px;font-size:11px;background:rgba(255,80,80,0.08);border-bottom:1px solid var(--border);display:flex;flex-wrap:wrap;gap:6px;align-items:center;">
          <span class="workspace-chip workspace-chip--alert" style="font-size:10px;">Sync failed</span>
          ${failedSyncItems.map((entry) => html`
            <span style="color:var(--muted);" title=${entry.lastError || ""}>${entry.operation || "publish"} &middot; ${String(entry.attempts || 0)} attempt(s)${entry.lastError ? ` — ${entry.lastError.slice(0, 80)}` : ""}</span>
          `)}
          <button type="button" class="button button--ghost" style="font-size:10px;padding:1px 8px;margin-left:auto;" data-action="review-bridge-sync" data-pr-key=${detail.prKey || ""}>Retry</button>
        </div>
      ` : nothing}

      <div class="review-subtabs">
        ${renderReviewTabButton({ id: "summary", label: "Summary" }, activeTab, workspaceId)}
        ${renderReviewTabButton({ id: "files", label: "Files", count: changedFiles.length }, activeTab, workspaceId)}
        ${renderReviewTabButton({ id: "comments", label: "Comments", count: commentCount }, activeTab, workspaceId)}
        ${renderReviewTabButton({ id: "conflicts", label: "Conflicts", count: conflictInfo.hasConflicts ? changedFiles.length : 0, alert: conflictInfo.hasConflicts }, activeTab, workspaceId)}
        ${renderReviewTabButton({ id: "agent", label: "Agent" }, activeTab, workspaceId)}
      </div>

      <div class="review-content">
        ${activeTab === "files"
          ? renderReviewFilesPanel(detail, changedFiles, reviewUi, workspaceId)
          : activeTab === "comments"
            ? renderReviewCommentsPanel(detail, threads, reviewBridge, reviewUi, workspaceId)
            : activeTab === "conflicts"
              ? renderReviewConflictsPanel(detail, reviewUi, workspaceId)
              : activeTab === "agent"
                ? renderReviewAgentPanel(detail, reviewBridge, reviewUi, workspaceId)
                : renderReviewSummaryPanel(detail, workspaceId, reviewers, checks)}
      </div>
    </div>
  `;
}
