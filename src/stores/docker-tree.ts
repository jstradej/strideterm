import { defineStore } from "pinia";
import { ref, computed } from "vue";
import { useAppStore } from "./app.js";
import type {
  DockerContainer,
  DockerContext,
  DockerBackend,
  DockerImage,
  DockerVolume,
  DockerNetwork,
} from "../../electron/shared/types/state.js";

export interface TreeNode {
  id: string;
  kind:
    | "backend"
    | "context"
    | "project"
    | "container"
    | "orphans"
    | "images-group"
    | "image"
    | "volumes-group"
    | "volume"
    | "networks-group"
    | "network";
  label: string;
  status: "running" | "stopped" | "mixed" | "unavailable" | "pending";
  health?: DockerContainer["health"];
  error?: string;
  children?: TreeNode[];
  backendId?: string;
  contextName?: string;
  projectName?: string;
  containerId?: string;
  imageId?: string;
  volumeName?: string;
  networkId?: string;
  /** For images / volumes / networks — extra metadata for tooltips. */
  meta?: string;
}

function containerStatus(container: DockerContainer): TreeNode["status"] {
  const state = (container.State || "").toLowerCase();
  return state === "running" ? "running" : "stopped";
}

function aggregateStatus(containers: DockerContainer[]): TreeNode["status"] {
  if (containers.length === 0) return "stopped";
  const running = containers.filter((c) => (c.State || "").toLowerCase() === "running").length;
  if (running === 0) return "stopped";
  if (running === containers.length) return "running";
  return "mixed";
}

function buildContextTree(
  context: DockerContext,
  containers: DockerContainer[],
  images: DockerImage[],
  volumes: DockerVolume[],
  networks: DockerNetwork[],
): TreeNode {
  const ctxContainers = containers.filter((c) => c.backendId === context.backendId && c.contextName === context.Name);
  const ctxImages = images.filter((i) => i.backendId === context.backendId && i.contextName === context.Name);
  const ctxVolumes = volumes.filter((v) => v.backendId === context.backendId && v.contextName === context.Name);
  const ctxNetworks = networks.filter((n) => n.backendId === context.backendId && n.contextName === context.Name);

  // Group by compose project
  const projectMap = new Map<string, DockerContainer[]>();
  const orphans: DockerContainer[] = [];

  for (const c of ctxContainers) {
    const proj = c.parsedLabels?.composeProject;
    if (proj) {
      if (!projectMap.has(proj)) projectMap.set(proj, []);
      projectMap.get(proj)!.push(c);
    } else {
      orphans.push(c);
    }
  }

  const children: TreeNode[] = [];

  for (const [projName, projContainers] of projectMap.entries()) {
    const projNodeId = `be:${context.backendId}/ctx:${context.Name}/proj:${projName}`;
    children.push({
      id: projNodeId,
      kind: "project",
      label: projName,
      status: aggregateStatus(projContainers),
      backendId: context.backendId,
      contextName: context.Name,
      projectName: projName,
      children: projContainers.map((c) => ({
        id: `be:${context.backendId}/cnt:${c.ID}`,
        kind: "container" as const,
        label: c.Names?.replace(/^\//, "") || c.ID.slice(0, 12),
        status: containerStatus(c),
        health: c.health,
        backendId: context.backendId,
        contextName: context.Name,
        projectName: projName,
        containerId: c.ID,
      })),
    });
  }

  if (orphans.length > 0) {
    children.push({
      id: `be:${context.backendId}/ctx:${context.Name}/orphans`,
      kind: "orphans",
      label: "(no compose project)",
      status: aggregateStatus(orphans),
      backendId: context.backendId,
      contextName: context.Name,
      children: orphans.map((c) => ({
        id: `be:${context.backendId}/cnt:${c.ID}`,
        kind: "container" as const,
        label: c.Names?.replace(/^\//, "") || c.ID.slice(0, 12),
        status: containerStatus(c),
        health: c.health,
        backendId: context.backendId,
        contextName: context.Name,
        containerId: c.ID,
      })),
    });
  }

  if (ctxImages.length > 0) {
    children.push({
      id: `be:${context.backendId}/ctx:${context.Name}/images`,
      kind: "images-group",
      label: `Images (${ctxImages.length})`,
      status: "stopped",
      backendId: context.backendId,
      contextName: context.Name,
      children: ctxImages.map((img) => ({
        id: `be:${context.backendId}/ctx:${context.Name}/img:${img.ID}`,
        kind: "image" as const,
        label: img.Repository === "<none>" ? img.ID.slice(0, 12) : `${img.Repository}:${img.Tag}`,
        status: "stopped",
        backendId: context.backendId,
        contextName: context.Name,
        imageId: img.ID,
        meta: img.Size ? `${img.Size}${img.CreatedSince ? ` · ${img.CreatedSince}` : ""}` : img.CreatedSince,
      })),
    });
  }

  if (ctxVolumes.length > 0) {
    children.push({
      id: `be:${context.backendId}/ctx:${context.Name}/volumes`,
      kind: "volumes-group",
      label: `Volumes (${ctxVolumes.length})`,
      status: "stopped",
      backendId: context.backendId,
      contextName: context.Name,
      children: ctxVolumes.map((vol) => ({
        id: `be:${context.backendId}/ctx:${context.Name}/vol:${vol.Name}`,
        kind: "volume" as const,
        label: vol.Name,
        status: "stopped",
        backendId: context.backendId,
        contextName: context.Name,
        volumeName: vol.Name,
        meta: vol.Driver,
      })),
    });
  }

  if (ctxNetworks.length > 0) {
    children.push({
      id: `be:${context.backendId}/ctx:${context.Name}/networks`,
      kind: "networks-group",
      label: `Networks (${ctxNetworks.length})`,
      status: "stopped",
      backendId: context.backendId,
      contextName: context.Name,
      children: ctxNetworks.map((net) => ({
        id: `be:${context.backendId}/ctx:${context.Name}/net:${net.ID || net.Name}`,
        kind: "network" as const,
        label: net.Name,
        status: "stopped",
        backendId: context.backendId,
        contextName: context.Name,
        networkId: net.ID,
        meta: net.Driver + (net.Scope ? ` · ${net.Scope}` : ""),
      })),
    });
  }

  return {
    id: `be:${context.backendId}/ctx:${context.Name}`,
    kind: "context",
    label: context.Name + (context.Current ? " (current)" : ""),
    status: context.available === "error" ? "unavailable" : aggregateStatus(ctxContainers),
    error: context.available === "error" ? context.error : undefined,
    backendId: context.backendId,
    contextName: context.Name,
    children,
  };
}

function buildTree(
  backends: DockerBackend[],
  contexts: DockerContext[],
  containers: DockerContainer[],
  images: DockerImage[] = [],
  volumes: DockerVolume[] = [],
  networks: DockerNetwork[] = [],
): TreeNode[] {
  if (backends.length === 0) return [];

  // Adaptive collapsing: skip backend level if only 1 backend; skip context level if only 1 context per backend
  const backendNodes: TreeNode[] = backends.map((backend) => {
    const backendContexts = contexts.filter((c) => c.backendId === backend.id);
    const backendContainers = containers.filter((c) => c.backendId === backend.id);
    const backendImages = images.filter((i) => i.backendId === backend.id);
    const backendVolumes = volumes.filter((v) => v.backendId === backend.id);
    const backendNetworks = networks.filter((n) => n.backendId === backend.id);

    const contextNodes = backendContexts.map((ctx) =>
      buildContextTree(ctx, backendContainers, backendImages, backendVolumes, backendNetworks),
    );

    return {
      id: `be:${backend.id}`,
      kind: "backend" as const,
      label: backend.label,
      status: backend.available === "error" ? "unavailable" : aggregateStatus(backendContainers),
      error: backend.available === "error" ? backend.error : undefined,
      backendId: backend.id,
      children: contextNodes,
    };
  });

  // If only one backend, collapse it (show its children as roots)
  if (backendNodes.length === 1) {
    const singleBackend = backendNodes[0];
    const children = singleBackend.children || [];
    // If only one context, collapse it too
    if (children.length === 1 && children[0].kind === "context") {
      return children[0].children || [];
    }
    return children;
  }

  return backendNodes;
}

export const useDockerTree = defineStore("docker-tree", () => {
  const appStore = useAppStore();

  // sessionStorage-backed expand state
  const STORAGE_KEY = "docker-tree-expanded";
  function loadExpanded(): Set<string> {
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY);
      if (raw) return new Set(JSON.parse(raw) as string[]);
    } catch {
      // ignore
    }
    return new Set();
  }
  function saveExpanded(set: Set<string>): void {
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify([...set]));
    } catch {
      // ignore
    }
  }

  const expanded = ref<Set<string>>(loadExpanded());

  function toggle(nodeId: string): void {
    if (expanded.value.has(nodeId)) {
      expanded.value.delete(nodeId);
    } else {
      expanded.value.add(nodeId);
    }
    // Trigger reactivity for Set mutations
    expanded.value = new Set(expanded.value);
    saveExpanded(expanded.value);
  }

  function isExpanded(nodeId: string): boolean {
    return expanded.value.has(nodeId);
  }

  function expandAll(nodes: TreeNode[]): void {
    for (const node of nodes) {
      if (node.children?.length) {
        expanded.value.add(node.id);
        expandAll(node.children);
      }
    }
    expanded.value = new Set(expanded.value);
    saveExpanded(expanded.value);
  }

  const dockerState = computed(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return appStore.dockerState() || null;
  });

  const treeNodes = computed((): TreeNode[] => {
    const ds = dockerState.value;
    if (!ds?.available) return [];
    return buildTree(
      ds.backends || [],
      ds.contexts || [],
      ds.containers || [],
      ds.images || [],
      ds.volumes || [],
      ds.networks || [],
    );
  });

  // -------------------------------------------------------------------------
  // Filter
  // -------------------------------------------------------------------------

  /** User-typed query in the toolbar above the tree. Substring, case-insensitive. */
  const filter = ref("");

  function setFilter(q: string): void {
    filter.value = q;
  }

  /**
   * Apply the filter recursively. A node passes if its own label matches OR
   * any descendant matches; matching subtrees are auto-expanded so the user
   * can see hits without manually drilling in.
   */
  function applyFilter(nodes: TreeNode[], q: string, autoExpand: Set<string>): TreeNode[] {
    const ql = q.toLowerCase();
    const result: TreeNode[] = [];
    for (const n of nodes) {
      const selfMatch = n.label.toLowerCase().includes(ql);
      const filteredChildren = n.children ? applyFilter(n.children, q, autoExpand) : undefined;
      const childMatch = filteredChildren && filteredChildren.length > 0;
      if (selfMatch || childMatch) {
        if (childMatch) autoExpand.add(n.id);
        result.push({ ...n, children: filteredChildren });
      }
    }
    return result;
  }

  const filteredTreeNodes = computed((): { nodes: TreeNode[]; autoExpand: Set<string> } => {
    const q = filter.value.trim();
    if (!q) return { nodes: treeNodes.value, autoExpand: new Set() };
    const autoExpand = new Set<string>();
    return { nodes: applyFilter(treeNodes.value, q, autoExpand), autoExpand };
  });

  /**
   * Expand-or-not decision for a node. When the user has typed a filter, the
   * tree is pruned to matching descendants — so any non-leaf node that's still
   * visible is, by definition, on a path to a match. Always expand those, so
   * the user doesn't have to click through to see matching deep children.
   * Falls back to the user's manually-set expand state otherwise.
   */
  function isExpandedWithFilter(nodeId: string, hasChildren = false): boolean {
    if (filter.value.trim() && hasChildren) return true;
    return expanded.value.has(nodeId);
  }

  /** True when the user has a non-empty filter active. */
  const filterActive = computed(() => !!filter.value.trim());

  return {
    expanded,
    toggle,
    isExpanded,
    isExpandedWithFilter,
    expandAll,
    treeNodes,
    filteredTreeNodes,
    filter,
    filterActive,
    setFilter,
    dockerState,
  };
});
