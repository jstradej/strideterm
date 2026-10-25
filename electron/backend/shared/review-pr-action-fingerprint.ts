import type { ReviewPrActionSnapshot } from "../../shared/review-pr-actions.js";

export function reviewPrActionSnapshotFingerprint(snapshot: ReviewPrActionSnapshot): string {
  const checks = [...snapshot.checks.items].sort((left, right) =>
    `${left.kind || ""}\0${left.name}\0${left.state}\0${left.url || ""}`.localeCompare(
      `${right.kind || ""}\0${right.name}\0${right.state}\0${right.url || ""}`,
    ),
  );
  return JSON.stringify({
    provider: snapshot.provider,
    prKey: snapshot.prKey,
    connectionId: snapshot.connectionId,
    repository: snapshot.repository,
    number: snapshot.number,
    url: snapshot.url,
    title: snapshot.title,
    state: snapshot.state,
    isDraft: snapshot.isDraft,
    autoMerge: snapshot.autoMerge,
    mergeReadiness: snapshot.mergeReadiness,
    source: snapshot.source,
    target: snapshot.target,
    checks: { ...snapshot.checks, items: checks },
    review: snapshot.review,
    supportedActions: [...snapshot.supportedActions].sort(),
  });
}
