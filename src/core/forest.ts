import * as path from "path";
import {
  DependencyEdge,
  ProjectMeta,
  ProjectState,
  TaskNode,
  TaskStatus,
  TASK_STATUSES,
  TreeBundle,
  TreeDescriptor,
} from "./types";
import { enrichAllTasks } from "./taskMeta";
import { isSafeId, parseTreeFileName } from "./pathSafety";

const LEGACY_TREE_ID = "main";

/** Namespace delimiter — must not appear as a single `_` join to avoid prefix collisions. */
export const TREE_ID_SEP = "__";

export function treeNamespacePrefix(treeId: string): string {
  return `${treeId}${TREE_ID_SEP}`;
}

/** Task id belongs to tree via explicit namespace (not a longer tree id's prefix). */
export function isNamespacedUnderTree(treeId: string, taskId: string): boolean {
  if (!isSafeId(treeId) || typeof taskId !== "string") return false;
  const prefix = treeNamespacePrefix(treeId);
  return taskId.startsWith(prefix) && taskId.length > prefix.length;
}

function shortHash(input: string): string {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36).slice(0, 6);
}

/** Stable slug for a tree from an import filename / relative path. */
export function treeSlugFromSource(sourceFile: string): string {
  const normalized = sourceFile.replace(/\\/g, "/");
  const base = path.basename(normalized).replace(/\.md$/i, "");
  const dir = path.dirname(normalized);
  let slug = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
  if (!slug || !/^[a-z0-9]/.test(slug)) slug = `tree_${slug || "import"}`;
  // Disambiguate same basename in different folders
  if (dir && dir !== "." && dir !== "/") {
    slug = `${slug}_${shortHash(dir)}`.slice(0, 48);
  }
  if (!isSafeId(slug)) {
    slug = `t_${slug.replace(/[^a-z0-9_]/g, "").slice(0, 40)}` || "tree_import";
  }
  return slug;
}

export function titleFromSource(sourceFile: string): string {
  return path.basename(sourceFile).replace(/\.md$/i, "") || sourceFile;
}

/** Prefix task ids with treeId__ so forests stay unique when flattened. */
export function namespaceTaskIds(
  treeId: string,
  data: { roots: string[]; tasks: Record<string, TaskNode> }
): { roots: string[]; tasks: Record<string, TaskNode> } {
  if (!isSafeId(treeId)) {
    throw new Error(`Unsafe tree id: ${treeId}`);
  }
  const prefix = treeNamespacePrefix(treeId);
  const mapId = (id: string): string => {
    if (id.startsWith(prefix)) return id;
    return `${prefix}${id}`;
  };
  const tasks: Record<string, TaskNode> = {};
  for (const [id, node] of Object.entries(data.tasks)) {
    const nid = mapId(id);
    tasks[nid] = {
      ...node,
      id: nid,
      children: (node.children ?? []).map(mapId),
      dependsOn: (node.dependsOn ?? []).map(mapId),
    };
  }
  return {
    roots: data.roots.map(mapId).filter((id) => tasks[id]),
    tasks,
  };
}

/**
 * Accept a tree JSON loaded from `fileName` under trees/.
 * Rejects unsafe ids and id/filename mismatch.
 */
export function sanitizeLoadedTreeBundle(
  raw: unknown,
  fileName: string
): TreeBundle | null {
  const fileId = parseTreeFileName(fileName);
  if (!fileId) return null;
  if (!raw || typeof raw !== "object") return null;
  const bundle = raw as Partial<TreeBundle>;
  if (typeof bundle.id !== "string" || !isSafeId(bundle.id)) return null;
  if (bundle.id !== fileId) return null;
  if (!bundle.tasks || typeof bundle.tasks !== "object") return null;
  const tasks = enrichAllTasks(bundle.tasks as Record<string, TaskNode>);
  // Drop tasks whose ids look like path traversal (defense in depth)
  for (const id of Object.keys(tasks)) {
    if (!isSafeId(id) && !isNamespacedUnderTree(bundle.id, id)) {
      // namespaced ids are still isSafeId if treeId and rest are safe
      if (!isSafeId(id)) delete tasks[id];
    }
  }
  const roots = (bundle.roots ?? []).filter((id) => Boolean(tasks[id]));
  return {
    id: bundle.id,
    title:
      typeof bundle.title === "string" && bundle.title.trim()
        ? bundle.title.trim()
        : bundle.id,
    sourceFile:
      typeof bundle.sourceFile === "string" ? bundle.sourceFile : undefined,
    roots,
    tasks,
    edges:
      Array.isArray(bundle.edges) && bundle.edges.length
        ? bundle.edges
        : edgesFromTasks(tasks),
    updatedAt:
      typeof bundle.updatedAt === "string"
        ? bundle.updatedAt
        : new Date().toISOString(),
  };
}

/**
 * Merge incoming MD structure into an existing tree, preserving progress fields.
 */
export function mergeTreePreserveProgress(
  existing: TreeBundle | null | undefined,
  incoming: { roots: string[]; tasks: Record<string, TaskNode> }
): { roots: string[]; tasks: Record<string, TaskNode> } {
  const prev = existing?.tasks ?? {};
  const tasks: Record<string, TaskNode> = {};

  for (const [id, node] of Object.entries(incoming.tasks)) {
    const old = prev[id];
    if (old) {
      tasks[id] = enrichAllTasks({
        [id]: {
          ...node,
          status: old.status,
          assignee: old.assignee ?? node.assignee,
          impactHint: old.impactHint ?? node.impactHint,
          estimateSp: node.estimateSp ?? old.estimateSp,
          estimateHours: node.estimateHours ?? old.estimateHours,
          tags: node.tags?.length ? node.tags : old.tags,
          code: node.code?.length ? node.code : old.code,
          tests: node.tests?.length ? node.tests : old.tests,
          changedFiles: old.changedFiles?.length ? old.changedFiles : node.changedFiles,
        },
      })[id];
    } else {
      tasks[id] = enrichAllTasks({ [id]: node })[id];
    }
  }

  for (const [id, old] of Object.entries(prev)) {
    if (tasks[id]) continue;
    if (old.source === "manual" || old.source?.startsWith("manual")) {
      tasks[id] = old;
    }
  }

  const roots = [...incoming.roots.filter((id) => tasks[id])];
  for (const id of Object.keys(tasks)) {
    const referenced = Object.values(tasks).some((t) => t.children.includes(id));
    if (!referenced && !roots.includes(id)) {
      const t = tasks[id];
      if (t.source === "manual" || t.source?.startsWith("manual")) roots.push(id);
    }
  }

  return { roots, tasks };
}

export function edgesFromTasks(tasks: Record<string, TaskNode>): DependencyEdge[] {
  const edges: DependencyEdge[] = [];
  for (const t of Object.values(tasks)) {
    for (const dep of t.dependsOn) {
      if (tasks[dep]) {
        edges.push({ from: t.id, to: dep, kind: "dependsOn" });
        edges.push({ from: dep, to: t.id, kind: "blocks" });
      }
    }
  }
  return edges;
}

export function flattenForest(trees: TreeBundle[]): {
  roots: string[];
  tasks: Record<string, TaskNode>;
  edges: DependencyEdge[];
} {
  const tasks: Record<string, TaskNode> = {};
  const roots: string[] = [];
  for (const tree of trees) {
    if (!isSafeId(tree.id)) continue;
    Object.assign(tasks, tree.tasks);
    for (const r of tree.roots) {
      if (tasks[r] && !roots.includes(r)) roots.push(r);
    }
  }
  return { roots, tasks, edges: edgesFromTasks(tasks) };
}

export function descriptorsFromTrees(trees: TreeBundle[]): TreeDescriptor[] {
  return trees
    .filter((t) => isSafeId(t.id))
    .map((t) => ({
      id: t.id,
      title: t.title,
      sourceFile: t.sourceFile,
      updatedAt: t.updatedAt,
    }));
}

export function syncMetaTrees(meta: ProjectMeta, trees: TreeBundle[]): ProjectMeta {
  const safe = trees.filter((t) => isSafeId(t.id));
  return {
    ...meta,
    trees: descriptorsFromTrees(safe),
    activeTreeId:
      meta.activeTreeId && safe.some((t) => t.id === meta.activeTreeId)
        ? meta.activeTreeId
        : safe[0]?.id,
  };
}

export function findTreeIdForTask(trees: TreeBundle[], taskId: string): string | undefined {
  for (const tree of trees) {
    if (tree.tasks[taskId]) return tree.id;
  }
  // Prefer longest matching namespace (avoids shorter prefix stealing)
  const matches = trees
    .filter((t) => isSafeId(t.id) && isNamespacedUnderTree(t.id, taskId))
    .sort((a, b) => b.id.length - a.id.length);
  return matches[0]?.id;
}

export function findTree(trees: TreeBundle[], treeId: string): TreeBundle | undefined {
  return trees.find((t) => t.id === treeId);
}

/**
 * Copy progress fields from a flat `tree.json` snapshot into per-tree bundles.
 * Fixes desync when MCP/agent updates `.proman/tree.json` but UI reads `trees/*.json`.
 * Returns true if any node changed.
 */
export function applyFlatProgressToTrees(
  trees: TreeBundle[],
  flatTasks: Record<string, TaskNode> | null | undefined
): boolean {
  if (!flatTasks || typeof flatTasks !== "object") return false;
  let changed = false;
  for (const tree of trees) {
    if (!isSafeId(tree.id) || !tree.tasks) continue;
    let treeChanged = false;
    for (const id of Object.keys(tree.tasks)) {
      const flat = flatTasks[id];
      const node = tree.tasks[id];
      if (!flat || !node) continue;
      if (flat.status && flat.status !== node.status) {
        if ((TASK_STATUSES as readonly string[]).includes(flat.status)) {
          node.status = flat.status as TaskStatus;
          treeChanged = true;
        }
      }
      if ("assignee" in flat) {
        const next =
          typeof flat.assignee === "string"
            ? flat.assignee.replace(/^@+/, "").slice(0, 200) || undefined
            : undefined;
        if (next !== node.assignee) {
          node.assignee = next;
          treeChanged = true;
        }
      }
      if ("impactHint" in flat) {
        const hint =
          typeof flat.impactHint === "string" ? flat.impactHint.slice(0, 2000) : undefined;
        if (hint !== (node.impactHint ?? undefined)) {
          node.impactHint = hint;
          treeChanged = true;
        }
      }
    }
    if (treeChanged) {
      tree.edges = edgesFromTasks(tree.tasks);
      tree.updatedAt = new Date().toISOString();
      changed = true;
    }
  }
  return changed;
}

export function projectStateFromForest(
  meta: ProjectMeta,
  trees: TreeBundle[]
): ProjectState {
  const safe = trees.filter((t) => isSafeId(t.id));
  const flat = flattenForest(safe);
  return {
    meta: syncMetaTrees(meta, safe),
    trees: safe,
    roots: flat.roots,
    tasks: flat.tasks,
    edges: flat.edges,
  };
}

/** Migrate legacy single tree.json into a forest. */
export function legacyToForest(
  meta: ProjectMeta,
  roots: string[],
  tasks: Record<string, TaskNode>,
  edges: DependencyEdge[]
): TreeBundle[] {
  const now = new Date().toISOString();
  return [
    {
      id: LEGACY_TREE_ID,
      title: meta.name || "Main",
      sourceFile: meta.planningDir,
      roots,
      tasks: enrichAllTasks(tasks),
      edges: edges.length ? edges : edgesFromTasks(tasks),
      updatedAt: meta.updatedAt || now,
    },
  ];
}

export function emptyTreeBundle(
  id: string,
  title: string,
  sourceFile?: string
): TreeBundle {
  if (!isSafeId(id)) {
    throw new Error(`Unsafe tree id: ${id}`);
  }
  return {
    id,
    title,
    sourceFile,
    roots: [],
    tasks: {},
    edges: [],
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Sync flat task map back into per-tree bundles.
 * Ownership: (1) already in tree.tasks, (2) namespaced under that treeId
 * (longest tree id wins). Never claim another tree's membership set.
 */
export function pullFlatIntoForest(state: ProjectState): void {
  state.trees = state.trees.filter((t) => isSafeId(t.id));
  const claimed = new Set<string>();
  const byLen = [...state.trees].sort((a, b) => b.id.length - a.id.length);

  for (const tree of byLen) {
    const nextTasks: Record<string, TaskNode> = {};
    for (const id of Object.keys(tree.tasks)) {
      if (state.tasks[id] && !claimed.has(id)) {
        nextTasks[id] = state.tasks[id];
        claimed.add(id);
      }
    }
    for (const [id, t] of Object.entries(state.tasks)) {
      if (claimed.has(id)) continue;
      if (isNamespacedUnderTree(tree.id, id)) {
        nextTasks[id] = t;
        claimed.add(id);
      }
    }
    tree.tasks = nextTasks;
    tree.roots = Object.keys(nextTasks).filter(
      (id) => !Object.values(nextTasks).some((n) => n.children.includes(id))
    );
    tree.edges = edgesFromTasks(nextTasks);
    tree.updatedAt = new Date().toISOString();
  }

  const orphans = Object.keys(state.tasks).filter((id) => !claimed.has(id));
  if (orphans.length) {
    let tree =
      findTree(state.trees, state.meta.activeTreeId ?? "") ??
      state.trees[0] ??
      emptyTreeBundle(LEGACY_TREE_ID, state.meta.name || "Main");
    if (!state.trees.includes(tree)) {
      if (!isSafeId(tree.id)) tree = emptyTreeBundle(LEGACY_TREE_ID, state.meta.name || "Main");
      state.trees.push(tree);
    }
    for (const id of orphans) {
      tree.tasks[id] = state.tasks[id];
      claimed.add(id);
    }
    tree.roots = Object.keys(tree.tasks).filter(
      (id) => !Object.values(tree.tasks).some((t) => t.children.includes(id))
    );
    tree.edges = edgesFromTasks(tree.tasks);
    tree.updatedAt = new Date().toISOString();
  }
  const flat = flattenForest(state.trees);
  state.roots = flat.roots;
  state.tasks = flat.tasks;
  state.edges = flat.edges;
  state.meta = syncMetaTrees(state.meta, state.trees);
}

export { LEGACY_TREE_ID };
