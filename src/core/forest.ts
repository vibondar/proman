import * as path from "path";
import {
  DependencyEdge,
  ProjectMeta,
  ProjectState,
  TaskNode,
  TreeBundle,
  TreeDescriptor,
} from "./types";
import { enrichAllTasks } from "./taskMeta";
import { isSafeId } from "./pathSafety";

const LEGACY_TREE_ID = "main";

/** Stable slug for a tree from an import filename / relative path. */
export function treeSlugFromSource(sourceFile: string): string {
  const base = path.basename(sourceFile).replace(/\.md$/i, "");
  let slug = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
  if (!slug || !/^[a-z0-9]/.test(slug)) slug = `tree_${slug || "import"}`;
  if (!isSafeId(slug)) {
    slug = `t_${slug.replace(/[^a-z0-9_]/g, "").slice(0, 40)}` || "tree_import";
  }
  return slug;
}

export function titleFromSource(sourceFile: string): string {
  return path.basename(sourceFile).replace(/\.md$/i, "") || sourceFile;
}

/** Prefix task ids with treeId_ so forests stay unique when flattened. */
export function namespaceTaskIds(
  treeId: string,
  data: { roots: string[]; tasks: Record<string, TaskNode> }
): { roots: string[]; tasks: Record<string, TaskNode> } {
  const mapId = (id: string): string => {
    if (id.startsWith(`${treeId}_`)) return id;
    return `${treeId}_${id}`;
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
          // Keep runtime estimates if MD omitted them
          estimateSp: node.estimateSp ?? old.estimateSp,
          estimateHours: node.estimateHours ?? old.estimateHours,
          tags: node.tags?.length ? node.tags : old.tags,
          code: node.code?.length ? node.code : old.code,
          tests: node.tests?.length ? node.tests : old.tests,
        },
      })[id];
    } else {
      tasks[id] = enrichAllTasks({ [id]: node })[id];
    }
  }

  // Keep manually added tasks that are not in the new MD parse
  for (const [id, old] of Object.entries(prev)) {
    if (tasks[id]) continue;
    if (old.source === "manual" || old.source?.startsWith("manual")) {
      tasks[id] = old;
    }
  }

  // Re-attach orphan manual roots
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
    Object.assign(tasks, tree.tasks);
    for (const r of tree.roots) {
      if (tasks[r] && !roots.includes(r)) roots.push(r);
    }
  }
  return { roots, tasks, edges: edgesFromTasks(tasks) };
}

export function descriptorsFromTrees(trees: TreeBundle[]): TreeDescriptor[] {
  return trees.map((t) => ({
    id: t.id,
    title: t.title,
    sourceFile: t.sourceFile,
    updatedAt: t.updatedAt,
  }));
}

export function syncMetaTrees(meta: ProjectMeta, trees: TreeBundle[]): ProjectMeta {
  return {
    ...meta,
    trees: descriptorsFromTrees(trees),
    activeTreeId: meta.activeTreeId && trees.some((t) => t.id === meta.activeTreeId)
      ? meta.activeTreeId
      : trees[0]?.id,
  };
}

export function findTreeIdForTask(trees: TreeBundle[], taskId: string): string | undefined {
  for (const tree of trees) {
    if (tree.tasks[taskId]) return tree.id;
  }
  return undefined;
}

export function findTree(trees: TreeBundle[], treeId: string): TreeBundle | undefined {
  return trees.find((t) => t.id === treeId);
}

export function projectStateFromForest(
  meta: ProjectMeta,
  trees: TreeBundle[]
): ProjectState {
  const flat = flattenForest(trees);
  return {
    meta: syncMetaTrees(meta, trees),
    trees,
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

export function pullFlatIntoForest(state: ProjectState): void {
  const claimed = new Set<string>();
  for (const tree of state.trees) {
    const nextTasks: Record<string, TaskNode> = {};
    for (const id of Object.keys(tree.tasks)) {
      if (state.tasks[id]) {
        nextTasks[id] = state.tasks[id];
        claimed.add(id);
      }
    }
    for (const [id, t] of Object.entries(state.tasks)) {
      if (claimed.has(id)) continue;
      if (id.startsWith(`${tree.id}_`)) {
        nextTasks[id] = t;
        claimed.add(id);
      }
    }
    tree.tasks = nextTasks;
    tree.roots = Object.keys(nextTasks).filter(
      (id) => !Object.values(nextTasks).some((t) => t.children.includes(id))
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
    if (!state.trees.includes(tree)) state.trees.push(tree);
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
