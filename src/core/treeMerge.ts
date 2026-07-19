/**
 * Semantic merge of two TreeBundle snapshots by task.id.
 * Pure — no vscode / git. Rules: docs/adr/semantic-tree-merge.md
 */

import { edgesFromTasks, sanitizeLoadedTreeBundle } from "./forest";
import { detectPromanFileProblem } from "./promanConflict";
import { TaskFileChange, TaskNode, TaskStatus, TreeBundle } from "./types";

const STATUS_RANK: Record<TaskStatus, number> = {
  todo: 0,
  new: 1,
  blocked: 2,
  in_progress: 3,
  needs_rework: 4,
  error: 5,
  done: 6,
};

export interface MergeTreeOptions {
  /** Common ancestor for delete detection. Without it, presence wins. */
  base?: TreeBundle;
}

export type MergeTreeResult =
  | { ok: true; tree: TreeBundle }
  | { ok: false; error: string };

function preferNonEmpty(ours: string | undefined, theirs: string | undefined): string | undefined {
  const o = ours?.trim() ? ours : undefined;
  const t = theirs?.trim() ? theirs : undefined;
  if (o && t) return o;
  return o ?? t;
}

function mergeStatus(ours: TaskStatus, theirs: TaskStatus): TaskStatus {
  const ro = STATUS_RANK[ours] ?? 0;
  const rt = STATUS_RANK[theirs] ?? 0;
  if (rt > ro) return theirs;
  return ours;
}

function unionStrings(ours: string[] | undefined, theirs: string[] | undefined): string[] | undefined {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const x of [...(ours ?? []), ...(theirs ?? [])]) {
    if (!x || seen.has(x)) continue;
    seen.add(x);
    out.push(x);
  }
  return out.length ? out : undefined;
}

function unionChangedFiles(
  ours: TaskFileChange[] | undefined,
  theirs: TaskFileChange[] | undefined
): TaskFileChange[] | undefined {
  const map = new Map<string, TaskFileChange>();
  for (const f of theirs ?? []) {
    if (f?.path) map.set(f.path, { ...f });
  }
  for (const f of ours ?? []) {
    if (f?.path) map.set(f.path, { ...f });
  }
  const out = [...map.values()];
  return out.length ? out : undefined;
}

function mergeEstimates(
  o: number | undefined,
  t: number | undefined
): number | undefined {
  if (o == null && t == null) return undefined;
  if (o == null) return t;
  if (t == null) return o;
  return Math.max(o, t);
}

function mergeTask(ours: TaskNode, theirs: TaskNode): TaskNode {
  return {
    id: ours.id,
    title: preferNonEmpty(ours.title, theirs.title) || ours.title || theirs.title,
    description: preferNonEmpty(ours.description, theirs.description) ?? "",
    status: mergeStatus(ours.status, theirs.status),
    children: unionStrings(ours.children, theirs.children) ?? [],
    dependsOn: unionStrings(ours.dependsOn, theirs.dependsOn) ?? [],
    source: ours.source || theirs.source || "manual",
    impactHint: preferNonEmpty(ours.impactHint, theirs.impactHint),
    assignee: preferNonEmpty(ours.assignee, theirs.assignee),
    estimateSp: mergeEstimates(ours.estimateSp, theirs.estimateSp),
    estimateHours: mergeEstimates(ours.estimateHours, theirs.estimateHours),
    tags: unionStrings(ours.tags, theirs.tags),
    code: unionStrings(ours.code, theirs.code),
    tests: unionStrings(ours.tests, theirs.tests),
    changedFiles: unionChangedFiles(ours.changedFiles, theirs.changedFiles),
  };
}

function collectIds(
  ours: Record<string, TaskNode>,
  theirs: Record<string, TaskNode>,
  base?: Record<string, TaskNode>
): string[] {
  if (!base) {
    return [...new Set([...Object.keys(ours), ...Object.keys(theirs)])];
  }
  const ids = new Set<string>([...Object.keys(ours), ...Object.keys(theirs), ...Object.keys(base)]);
  const keep: string[] = [];
  for (const id of ids) {
    const inOurs = Boolean(ours[id]);
    const inTheirs = Boolean(theirs[id]);
    const inBase = Boolean(base[id]);
    if (inBase && !inOurs && inTheirs) continue; // ours deleted
    if (inBase && inOurs && !inTheirs) continue; // theirs deleted
    if (inBase && !inOurs && !inTheirs) continue;
    if (inOurs || inTheirs) keep.push(id);
  }
  return keep;
}

function recomputeRoots(tasks: Record<string, TaskNode>): string[] {
  const child = new Set<string>();
  for (const t of Object.values(tasks)) {
    for (const id of t.children) child.add(id);
  }
  return Object.keys(tasks).filter((id) => !child.has(id));
}

function filterRefs(tasks: Record<string, TaskNode>): void {
  for (const t of Object.values(tasks)) {
    t.children = t.children.filter((id) => tasks[id]);
    t.dependsOn = t.dependsOn.filter((id) => tasks[id]);
  }
}

/**
 * Merge two valid tree bundles by task.id.
 * `ours` and `theirs` must share the same tree id (or refuse).
 */
export function mergeTreeByTaskId(
  ours: TreeBundle,
  theirs: TreeBundle,
  options: MergeTreeOptions = {}
): MergeTreeResult {
  if (!ours?.id || !theirs?.id) {
    return { ok: false, error: "missing tree id" };
  }
  if (ours.id !== theirs.id) {
    return { ok: false, error: `tree id mismatch: ${ours.id} vs ${theirs.id}` };
  }
  if (options.base && options.base.id !== ours.id) {
    return { ok: false, error: `base tree id mismatch: ${options.base.id} vs ${ours.id}` };
  }

  const ids = collectIds(ours.tasks, theirs.tasks, options.base?.tasks);
  const tasks: Record<string, TaskNode> = {};
  for (const id of ids) {
    const o = ours.tasks[id];
    const th = theirs.tasks[id];
    if (o && th) tasks[id] = mergeTask(o, th);
    else if (o) tasks[id] = { ...o, children: [...o.children], dependsOn: [...o.dependsOn] };
    else if (th) tasks[id] = { ...th, children: [...th.children], dependsOn: [...th.dependsOn] };
  }
  filterRefs(tasks);

  const draft: TreeBundle = {
    id: ours.id,
    title: preferNonEmpty(ours.title, theirs.title) || ours.id,
    sourceFile: ours.sourceFile ?? theirs.sourceFile,
    roots: recomputeRoots(tasks),
    tasks,
    edges: edgesFromTasks(tasks),
    updatedAt: new Date().toISOString(),
  };

  const sanitized = sanitizeLoadedTreeBundle(draft, `${ours.id}.json`);
  if (!sanitized) {
    return { ok: false, error: "merged tree failed sanitize" };
  }
  return { ok: true, tree: sanitized };
}

/** Parse a tree JSON text; reject conflict markers / invalid JSON. */
export function parseTreeBundleJson(
  text: string,
  fileName: string
): MergeTreeResult {
  const kind = detectPromanFileProblem(text);
  if (kind === "conflict_markers") {
    return { ok: false, error: "conflict markers present — resolve in git first" };
  }
  if (kind === "invalid_json") {
    return { ok: false, error: "invalid JSON" };
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, error: "invalid JSON" };
  }
  const bundle = sanitizeLoadedTreeBundle(data, fileName);
  if (!bundle) return { ok: false, error: `unsafe or mismatched tree file ${fileName}` };
  return { ok: true, tree: bundle };
}
