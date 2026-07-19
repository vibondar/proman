import { TaskNode, TaskStatus, ProjectState, TreeBundle, ProjectMeta, DependencyEdge } from "../core/types";
import { isSafeId, resolveTreeJsonPath } from "./pathSafety";
import { parseStructureOps, StructureOp } from "./proposalOps";
import {
  wsExists,
  wsMkdir,
  wsReadDir,
  wsReadText,
  wsWriteText,
  wsWriteTreeJson,
} from "./workspaceIo";
import {
  edgesFromTasks,
  flattenForest,
  legacyToForest,
  projectStateFromForest,
  pullFlatIntoForest,
  syncMetaTrees,
  applyFlatProgressToTrees,
} from "./forest";
import { normalizeProjectMeta } from "./projectMeta";
import {
  loadTreeBundlesFromTexts,
  PromanFileProblem,
  tryParsePromanJson,
} from "./promanConflict";

const PROMAN = ".proman";

export interface LoadProjectResult {
  state: ProjectState | null;
  /** Paths relative to `.proman/`. */
  problems: PromanFileProblem[];
}

export async function loadProjectStateWithProblems(
  workspaceRoot: string
): Promise<LoadProjectResult> {
  const problems: PromanFileProblem[] = [];
  const metaText = await wsReadText(workspaceRoot, PROMAN, "project.json");
  if (!metaText) return { state: null, problems };

  const metaParsed = tryParsePromanJson(metaText);
  if (!metaParsed.ok) {
    problems.push({ path: "project.json", kind: metaParsed.kind });
    return { state: null, problems };
  }
  const meta = normalizeProjectMeta(metaParsed.data as ProjectMeta);

  const trees: TreeBundle[] = [];
  const dir = await wsReadDir(workspaceRoot, PROMAN, "trees");
  if (dir) {
    const entries: { fileName: string; text: string }[] = [];
    for (const [name, type] of dir) {
      if ((type as number) !== 1) continue; // File
      if (!name.endsWith(".json")) continue;
      const text = await wsReadText(workspaceRoot, PROMAN, "trees", name);
      if (!text) continue;
      entries.push({ fileName: name, text });
    }
    const loaded = loadTreeBundlesFromTexts(entries);
    problems.push(...loaded.problems);
    trees.push(...loaded.trees);
  }

  if (trees.length) {
    const treeText = await wsReadText(workspaceRoot, PROMAN, "tree.json");
    if (treeText) {
      const flatParsed = tryParsePromanJson(treeText);
      if (!flatParsed.ok) {
        problems.push({ path: "tree.json", kind: flatParsed.kind });
      } else {
        const flat = flatParsed.data as { tasks?: Record<string, TaskNode> };
        applyFlatProgressToTrees(trees, flat.tasks);
      }
    }
    return { state: projectStateFromForest(meta, trees), problems };
  }

  const treeText = await wsReadText(workspaceRoot, PROMAN, "tree.json");
  if (!treeText) return { state: null, problems };
  const treeParsed = tryParsePromanJson(treeText);
  if (!treeParsed.ok) {
    problems.push({ path: "tree.json", kind: treeParsed.kind });
    return { state: null, problems };
  }
  const tree = treeParsed.data as {
    roots?: string[];
    tasks?: Record<string, TaskNode>;
  };
  let edges: DependencyEdge[] = [];
  const edgesText = await wsReadText(workspaceRoot, PROMAN, "edges.json");
  if (edgesText) {
    const edgesParsed = tryParsePromanJson(edgesText);
    if (edgesParsed.ok) edges = edgesParsed.data as DependencyEdge[];
  } else {
    edges = edgesFromTasks(tree.tasks ?? {});
  }
  return {
    state: projectStateFromForest(
      meta,
      legacyToForest(meta, tree.roots ?? [], tree.tasks ?? {}, edges)
    ),
    problems,
  };
}

export async function loadProjectState(workspaceRoot: string): Promise<ProjectState | null> {
  return (await loadProjectStateWithProblems(workspaceRoot)).state;
}

export async function saveProjectState(workspaceRoot: string, state: ProjectState): Promise<void> {
  await wsMkdir(workspaceRoot, PROMAN, "prompts");
  await wsMkdir(workspaceRoot, PROMAN, "imports");
  await wsMkdir(workspaceRoot, PROMAN, "proposals");
  await wsMkdir(workspaceRoot, PROMAN, "trees");
  state.meta.updatedAt = new Date().toISOString();
  if (!state.trees?.length) {
    state.trees = legacyToForest(state.meta, state.roots, state.tasks, state.edges ?? []);
  }
  state.trees = state.trees.filter((t) => isSafeId(t.id));
  pullFlatIntoForest(state);
  state.meta = syncMetaTrees(state.meta, state.trees);
  const flat = flattenForest(state.trees);
  state.roots = flat.roots;
  state.tasks = flat.tasks;
  state.edges = flat.edges;

  const okMeta = await wsWriteText(
    workspaceRoot,
    [PROMAN, "project.json"],
    JSON.stringify(state.meta, null, 2)
  );
  let okTrees = true;
  for (const tree of state.trees) {
    if (!resolveTreeJsonPath(workspaceRoot, tree.id)) {
      okTrees = false;
      continue;
    }
    const ok = await wsWriteTreeJson(
      workspaceRoot,
      tree.id,
      JSON.stringify(tree, null, 2)
    );
    if (!ok) okTrees = false;
  }
  const okTree = await wsWriteText(
    workspaceRoot,
    [PROMAN, "tree.json"],
    JSON.stringify({ roots: state.roots, tasks: state.tasks }, null, 2)
  );
  const okEdges = await wsWriteText(
    workspaceRoot,
    [PROMAN, "edges.json"],
    JSON.stringify(state.edges ?? [], null, 2)
  );
  if (!okMeta || !okTrees || !okTree || !okEdges) {
    throw new Error("Failed to save .proman state inside workspace");
  }
}

export function applyBlocked(state: ProjectState): void {
  for (const t of Object.values(state.tasks)) {
    if (t.status === "done" || t.status === "needs_rework" || t.status === "error") {
      continue;
    }
    const unmet = t.dependsOn.some((id) => {
      const d = state.tasks[id];
      return d && d.status !== "done";
    });
    if (unmet) t.status = "blocked";
    else if (t.status === "blocked") t.status = "todo";
  }
}

/**
 * DFS order: first leaf-ish todo/in_progress that is not blocked by unmet deps.
 * When `treeId` is set, only walks that tree's roots (per-tree Drive).
 */
export function nextActionable(
  state: ProjectState,
  treeId?: string | null
): {
  task: TaskNode | null;
  reason: string;
  queue: Array<{ id: string; title: string; status: TaskStatus }>;
  treeId: string | null;
} {
  const queue: Array<{ id: string; title: string; status: TaskStatus }> = [];
  const resolvedTreeId =
    treeId && state.trees.some((t) => t.id === treeId) ? treeId : null;
  const tree = resolvedTreeId
    ? state.trees.find((t) => t.id === resolvedTreeId)
    : undefined;
  const roots = tree ? tree.roots : state.roots;
  const tasks = tree ? tree.tasks : state.tasks;

  const visit = (id: string) => {
    const t = tasks[id] ?? state.tasks[id];
    if (!t) return;
    for (const c of t.children) visit(c);
    if (
      t.status === "todo" ||
      t.status === "new" ||
      t.status === "in_progress" ||
      t.status === "needs_rework"
    ) {
      const unmet = t.dependsOn.filter(
        (d) => (state.tasks[d] ?? tasks[d])?.status !== "done"
      );
      if (unmet.length === 0) {
        queue.push({ id: t.id, title: t.title, status: t.status });
      }
    }
  };
  for (const r of roots) visit(r);

  const scoped = resolvedTreeId;
  const inProg = queue.find((q) => q.status === "in_progress");
  if (inProg) {
    return {
      task: state.tasks[inProg.id] ?? null,
      reason: "Продолжить текущую in_progress",
      queue,
      treeId: scoped,
    };
  }
  const rework = queue.find((q) => q.status === "needs_rework");
  if (rework) {
    return {
      task: state.tasks[rework.id] ?? null,
      reason: "Доработка (needs_rework)",
      queue,
      treeId: scoped,
    };
  }
  if (queue.length) {
    const first = queue[0]!;
    return {
      task: state.tasks[first.id] ?? null,
      reason: "Следующая разблокированная задача (снизу вверх)",
      queue,
      treeId: scoped,
    };
  }
  return {
    task: null,
    reason: "Нет разблокированных задач",
    queue,
    treeId: scoped,
  };
}

export interface StructureProposal {
  id: string;
  createdAt: string;
  summary: string;
  rationale: string;
  status: "pending" | "accepted" | "rejected";
  ops: StructureOp[];
}

export async function writeProposal(
  workspaceRoot: string,
  proposal: StructureProposal
): Promise<string> {
  if (!isSafeId(proposal.id)) {
    throw new Error(`Unsafe proposal id: ${proposal.id}`);
  }
  const parsed = parseStructureOps(proposal.ops);
  if (!parsed.ok) throw new Error(parsed.error);
  proposal.ops = parsed.ops;
  await wsMkdir(workspaceRoot, PROMAN, "proposals");
  const ok = await wsWriteText(
    workspaceRoot,
    [PROMAN, "proposals", `${proposal.id}.json`],
    JSON.stringify(proposal, null, 2)
  );
  if (!ok) throw new Error("proposal file path escapes workspace");
  return `${workspaceRoot}/${PROMAN}/proposals/${proposal.id}.json`;
}

export async function readProposal(
  workspaceRoot: string,
  proposalId: string
): Promise<StructureProposal | null> {
  if (!isSafeId(proposalId)) return null;
  if (!(await wsExists(workspaceRoot, PROMAN, "proposals", `${proposalId}.json`))) {
    return null;
  }
  try {
    const text = await wsReadText(workspaceRoot, PROMAN, "proposals", `${proposalId}.json`);
    if (!text) return null;
    const raw = JSON.parse(text) as StructureProposal;
    const parsed = parseStructureOps(raw.ops);
    if (!parsed.ok) return null;
    return { ...raw, ops: parsed.ops };
  } catch {
    return null;
  }
}

/** Apply an accepted structure proposal onto on-disk .proman state */
export async function applyProposalToDisk(
  workspaceRoot: string,
  proposal: StructureProposal
): Promise<void> {
  const parsed = parseStructureOps(proposal.ops);
  if (!parsed.ok) throw new Error(parsed.error);
  const state = await loadProjectState(workspaceRoot);
  if (!state) throw new Error("no project");
  for (const op of parsed.ops) {
    if (op.op === "upsert") {
      for (const node of op.tasks) {
        const existing = state.tasks[node.id];
        const exists = Boolean(existing);
        let status = node.status ?? (existing ? existing.status : "new");
        if (!exists && (!node.status || node.status === "todo")) {
          status = "new";
        }
        state.tasks[node.id] = {
          ...node,
          status,
          children: node.children ?? [],
          dependsOn: node.dependsOn ?? [],
        };
        const parentId = op.parentId ?? null;
        const parentNode = parentId ? state.tasks[parentId] : undefined;
        if (parentNode) {
          if (!parentNode.children.includes(node.id)) {
            parentNode.children.push(node.id);
          }
        } else if (!state.roots.includes(node.id)) {
          const hasParent = Object.values(state.tasks).some((t) =>
            t.children.includes(node.id)
          );
          if (!hasParent) state.roots.push(node.id);
        }
      }
    } else if (op.op === "setStatus") {
      const t = state.tasks[op.taskId];
      if (t) t.status = op.status;
    } else if (op.op === "setDepends") {
      const t = state.tasks[op.taskId];
      if (t) t.dependsOn = op.dependsOn;
    } else if (op.op === "delete") {
      const task = state.tasks[op.taskId];
      if (!task) continue;
      const parent = Object.entries(state.tasks).find(([, t]) =>
        t.children.includes(op.taskId)
      )?.[0];
      if (op.mode === "cascade") {
        const stack = [...task.children];
        while (stack.length) {
          const id = stack.pop()!;
          const t = state.tasks[id];
          if (!t) continue;
          stack.push(...t.children);
          delete state.tasks[id];
        }
        if (parent) {
          const parentNode = state.tasks[parent];
          if (parentNode) {
            parentNode.children = parentNode.children.filter((id) => id !== op.taskId);
          }
        } else {
          state.roots = state.roots.filter((id) => id !== op.taskId);
        }
      } else {
        if (parent) {
          const p = state.tasks[parent];
          if (p) {
            const idx = p.children.indexOf(op.taskId);
            if (idx >= 0) p.children.splice(idx, 1, ...task.children);
            p.children = p.children.filter((id) => id !== op.taskId);
          }
        } else {
          const idx = state.roots.indexOf(op.taskId);
          if (idx >= 0) state.roots.splice(idx, 1, ...task.children);
          state.roots = state.roots.filter((id) => id !== op.taskId);
        }
      }
      delete state.tasks[op.taskId];
    }
  }
  applyBlocked(state);
  await saveProjectState(workspaceRoot, state);
}
