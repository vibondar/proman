import { TaskNode, TaskStatus, ProjectState, TreeBundle } from "../core/types";
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
  sanitizeLoadedTreeBundle,
  syncMetaTrees,
  applyFlatProgressToTrees,
} from "./forest";
import { normalizeProjectMeta } from "./projectMeta";

const PROMAN = ".proman";

export async function loadProjectState(workspaceRoot: string): Promise<ProjectState | null> {
  const metaText = await wsReadText(workspaceRoot, PROMAN, "project.json");
  if (!metaText) return null;
  const meta = normalizeProjectMeta(JSON.parse(metaText));

  const trees: TreeBundle[] = [];
  const dir = await wsReadDir(workspaceRoot, PROMAN, "trees");
  if (dir) {
    for (const [name, type] of dir) {
      if ((type as number) !== 1) continue; // File
      if (!name.endsWith(".json")) continue;
      const text = await wsReadText(workspaceRoot, PROMAN, "trees", name);
      if (!text) continue;
      try {
        const bundle = sanitizeLoadedTreeBundle(JSON.parse(text), name);
        if (bundle) trees.push(bundle);
      } catch {
        /* skip */
      }
    }
  }

  if (trees.length) {
    const treeText = await wsReadText(workspaceRoot, PROMAN, "tree.json");
    if (treeText) {
      try {
        const flat = JSON.parse(treeText) as { tasks?: Record<string, TaskNode> };
        applyFlatProgressToTrees(trees, flat.tasks);
      } catch {
        /* ignore */
      }
    }
    return projectStateFromForest(meta, trees);
  }

  const treeText = await wsReadText(workspaceRoot, PROMAN, "tree.json");
  if (!treeText) return null;
  const tree = JSON.parse(treeText);
  let edges = [];
  const edgesText = await wsReadText(workspaceRoot, PROMAN, "edges.json");
  if (edgesText) edges = JSON.parse(edgesText);
  return projectStateFromForest(
    meta,
    legacyToForest(meta, tree.roots ?? [], tree.tasks ?? {}, edges)
  );
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

/** DFS order: first leaf-ish todo/in_progress that is not blocked by unmet deps */
export function nextActionable(state: ProjectState): {
  task: TaskNode | null;
  reason: string;
  queue: Array<{ id: string; title: string; status: TaskStatus }>;
} {
  const queue: Array<{ id: string; title: string; status: TaskStatus }> = [];
  const visit = (id: string) => {
    const t = state.tasks[id];
    if (!t) return;
    for (const c of t.children) visit(c);
    if (
      t.status === "todo" ||
      t.status === "new" ||
      t.status === "in_progress" ||
      t.status === "needs_rework"
    ) {
      const unmet = t.dependsOn.filter((d) => state.tasks[d]?.status !== "done");
      if (unmet.length === 0) {
        queue.push({ id: t.id, title: t.title, status: t.status });
      }
    }
  };
  for (const r of state.roots) visit(r);

  const inProg = queue.find((q) => q.status === "in_progress");
  if (inProg) {
    return {
      task: state.tasks[inProg.id],
      reason: "Продолжить текущую in_progress",
      queue,
    };
  }
  const rework = queue.find((q) => q.status === "needs_rework");
  if (rework) {
    return {
      task: state.tasks[rework.id],
      reason: "Доработка (needs_rework)",
      queue,
    };
  }
  if (queue.length) {
    return {
      task: state.tasks[queue[0].id],
      reason: "Следующая разблокированная задача (снизу вверх)",
      queue,
    };
  }
  return { task: null, reason: "Нет разблокированных задач", queue };
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
        const exists = Boolean(state.tasks[node.id]);
        let status = node.status ?? (exists ? state.tasks[node.id].status : "new");
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
        if (parentId && state.tasks[parentId]) {
          if (!state.tasks[parentId].children.includes(node.id)) {
            state.tasks[parentId].children.push(node.id);
          }
        } else if (!state.roots.includes(node.id)) {
          const hasParent = Object.values(state.tasks).some((t) =>
            t.children.includes(node.id)
          );
          if (!hasParent) state.roots.push(node.id);
        }
      }
    } else if (op.op === "setStatus") {
      if (state.tasks[op.taskId]) state.tasks[op.taskId].status = op.status;
    } else if (op.op === "setDepends") {
      if (state.tasks[op.taskId]) state.tasks[op.taskId].dependsOn = op.dependsOn;
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
          state.tasks[parent].children = state.tasks[parent].children.filter(
            (id) => id !== op.taskId
          );
        } else {
          state.roots = state.roots.filter((id) => id !== op.taskId);
        }
      } else {
        if (parent) {
          const p = state.tasks[parent];
          const idx = p.children.indexOf(op.taskId);
          if (idx >= 0) p.children.splice(idx, 1, ...task.children);
          p.children = p.children.filter((id) => id !== op.taskId);
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
