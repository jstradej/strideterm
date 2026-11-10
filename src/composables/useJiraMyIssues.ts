import { computed, shallowRef, type Ref, type ShallowRef } from "vue";

export type JiraMyIssueCategory = "new" | "indeterminate";
export type JiraMyIssue = {
  ref: { connectionId: string; issueId: string; issueKey: string };
  summary?: string;
  status?: string;
  statusCategory?: string;
  updated?: string;
};
type ConnectionRow = {
  connectionId: string;
  label: string;
  issues: JiraMyIssue[];
  hasMore: boolean;
  cache: { fetchedAt: number; stale: boolean } | null;
  error?: { code: string };
};
type Refresh = "cache-only" | "if-stale" | "force";
type Api = { getJiraMyIssues?: (payload: { refresh?: Refresh }) => Promise<unknown> } | null | undefined;
type Entry = {
  rows: ShallowRef<ConnectionRow[] | null>;
  loading: ShallowRef<boolean>;
  inflight: Promise<ConnectionRow[] | null> | null;
  inflightRefresh: Refresh | null;
  lastAskedAt: number;
};

/** Coming back to the window refreshes data older than this. */
const RETURN_REFRESH_AFTER_MS = 5 * 60_000;
/** A background refresh (focus, badge click) is sent at most this often; Refresh always goes through. */
const BACKGROUND_THROTTLE_MS = 60_000;

// One entry per profile, shared by every mounted header, so two headers never ask twice.
const entries = new Map<string, Entry>();

function entryFor(profileId: string): Entry {
  let entry = entries.get(profileId);
  if (!entry) {
    entry = {
      rows: shallowRef(null),
      loading: shallowRef(false),
      inflight: null,
      inflightRefresh: null,
      lastAskedAt: 0,
    };
    entries.set(profileId, entry);
  }
  return entry;
}

function parseRows(value: unknown): ConnectionRow[] {
  const connections = (value as { connections?: unknown } | null)?.connections;
  return Array.isArray(connections) ? (connections as ConnectionRow[]) : [];
}

export function resetJiraMyIssuesForTests(): void {
  entries.clear();
}

export function useJiraMyIssues(getApi: () => Api, profileId: Ref<string>) {
  const entry = computed(() => entryFor(profileId.value));
  const rows = computed(() => entry.value.rows.value ?? []);
  const loading = computed(() => entry.value.loading.value);
  const fetchedAt = computed(() => {
    const times = rows.value.flatMap((row) => (row.cache ? [row.cache.fetchedAt] : []));
    return times.length ? Math.min(...times) : null;
  });
  const failedLabels = computed(() => rows.value.filter((row) => row.error).map((row) => row.label));
  const hasMore = computed(() => rows.value.some((row) => row.hasMore));

  function issuesIn(category: JiraMyIssueCategory): JiraMyIssue[] {
    return rows.value
      .flatMap((row) => row.issues)
      .filter((issue) => issue.statusCategory === category)
      .sort((left, right) => Date.parse(right.updated || "") - Date.parse(left.updated || ""));
  }

  /** Throws when the transport fails; per-connection failures come back as rows with `error`. */
  async function load(refresh: Refresh): Promise<ConnectionRow[] | null> {
    const current = entry.value;
    const api = getApi();
    if (!api?.getJiraMyIssues) return null;
    while (current.inflight && current.inflightRefresh === "cache-only" && refresh !== "cache-only") {
      await current.inflight.catch(() => undefined);
    }
    if (current.inflight) return current.inflight;
    if (refresh === "if-stale" && Date.now() - current.lastAskedAt < BACKGROUND_THROTTLE_MS) return current.rows.value;
    if (refresh !== "cache-only") current.lastAskedAt = Date.now();
    current.loading.value = refresh !== "cache-only";
    const request = api.getJiraMyIssues({ refresh }).then((result) => {
      const parsed = parseRows(result);
      current.rows.value = parsed;
      return parsed;
    });
    current.inflight = request;
    current.inflightRefresh = refresh;
    try {
      return await request;
    } finally {
      if (current.inflight === request) {
        current.inflight = null;
        current.inflightRefresh = null;
        current.loading.value = false;
      }
    }
  }

  /** First paint from the cache; asks Jira only when a connection has nothing cached yet. */
  async function ensureLoaded(): Promise<void> {
    if (entry.value.rows.value) return;
    const cached = await load("cache-only");
    if (cached?.some((row) => !row.cache && !row.error)) await load("if-stale");
  }

  async function refreshIfOld(): Promise<void> {
    const at = fetchedAt.value;
    if (at === null || Date.now() - at >= RETURN_REFRESH_AFTER_MS) await load("if-stale");
  }

  return { rows, loading, fetchedAt, failedLabels, hasMore, issuesIn, load, ensureLoaded, refreshIfOld };
}
