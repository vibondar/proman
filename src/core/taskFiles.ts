import * as path from "path";
import { resolveInside } from "./pathSafety";
import {
  ProjectState,
  TaskFileChange,
  TaskFileKind,
  TaskNode,
} from "./types";

const MAX_FILES = 100;
const MAX_PATH_LEN = 500;

export interface DoneTaskFileRow extends TaskFileChange {
  /** Present when the file comes from a done subtask (rollup). */
  fromTaskId?: string;
  fromTaskTitle?: string;
  /** true when path came from planned Код:/Тесты: fallback */
  fromPlan?: boolean;
}

function normalizeRelPath(raw: string): string | null {
  if (typeof raw !== "string") return null;
  if (!raw || raw.includes("\0")) return null;
  let p = raw.trim().replace(/\\/g, "/");
  if (!p || p.length > MAX_PATH_LEN) return null;
  // Strip leading ./ 
  p = p.replace(/^\.\/+/, "");
  if (!p || p === "." || p.includes("\0")) return null;
  return p;
}

function parseKind(raw: unknown): TaskFileKind | undefined {
  if (raw === "created" || raw === "modified") return raw;
  return undefined;
}

/**
 * Sanitize agent/MCP file lists: keep only paths that resolve inside the workspace.
 */
export function sanitizeTaskFiles(
  workspaceRoot: string,
  raw: unknown
): TaskFileChange[] {
  if (!Array.isArray(raw) || !workspaceRoot) return [];
  const out: TaskFileChange[] = [];
  const seen = new Set<string>();

  for (const item of raw) {
    if (out.length >= MAX_FILES) break;
    let pathStr: string | undefined;
    let kind: TaskFileKind | undefined;
    if (typeof item === "string") {
      pathStr = item;
    } else if (item && typeof item === "object") {
      const o = item as { path?: unknown; kind?: unknown };
      if (typeof o.path === "string") pathStr = o.path;
      kind = parseKind(o.kind);
    }
    if (!pathStr) continue;
    const rel = normalizeRelPath(pathStr);
    if (!rel) continue;
    // Reject absolute paths that are outside — resolveInside with absolute:
    // path.resolve(root, absolute) on unix replaces root; check carefully.
    if (path.isAbsolute(pathStr.trim())) {
      const abs = path.resolve(pathStr.trim());
      const rootAbs = path.resolve(workspaceRoot);
      const prefix = rootAbs.endsWith(path.sep) ? rootAbs : rootAbs + path.sep;
      if (abs !== rootAbs && !abs.startsWith(prefix)) continue;
      const inside = path.relative(rootAbs, abs).replace(/\\/g, "/");
      if (!inside || inside.startsWith("..")) continue;
      if (seen.has(inside)) continue;
      seen.add(inside);
      out.push(kind ? { path: inside, kind } : { path: inside });
      continue;
    }
    if (rel.split("/").some((seg) => seg === "..")) continue;
    const full = resolveInside(workspaceRoot, ...rel.split("/").filter(Boolean));
    if (!full) continue;
    const rootAbs = path.resolve(workspaceRoot);
    const normalized = path.relative(rootAbs, full).replace(/\\/g, "/");
    if (!normalized || normalized.startsWith("..")) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(kind ? { path: normalized, kind } : { path: normalized });
  }
  return out;
}

function filesFromTask(task: TaskNode): DoneTaskFileRow[] {
  if (task.changedFiles?.length) {
    return task.changedFiles.map((f) => ({
      path: f.path,
      kind: f.kind,
    }));
  }
  const planned: DoneTaskFileRow[] = [];
  const seen = new Set<string>();
  for (const p of [...(task.code ?? []), ...(task.tests ?? [])]) {
    const rel = normalizeRelPath(p);
    if (!rel || seen.has(rel)) continue;
    seen.add(rel);
    planned.push({ path: rel, fromPlan: true });
  }
  return planned;
}

/**
 * For a done task: own changedFiles (or code/tests fallback) plus done descendants.
 */
export function collectDoneTaskFiles(
  state: ProjectState,
  taskId: string
): DoneTaskFileRow[] {
  const root = state.tasks[taskId];
  if (!root || root.status !== "done") return [];

  const byPath = new Map<string, DoneTaskFileRow>();

  const add = (row: DoneTaskFileRow, from?: { id: string; title: string }) => {
    const existing = byPath.get(row.path);
    if (existing) {
      if (!existing.kind && row.kind) existing.kind = row.kind;
      return;
    }
    byPath.set(row.path, {
      ...row,
      ...(from && from.id !== taskId
        ? { fromTaskId: from.id, fromTaskTitle: from.title }
        : {}),
    });
  };

  for (const f of filesFromTask(root)) {
    add(f);
  }

  const visit = (id: string) => {
    const t = state.tasks[id];
    if (!t) return;
    for (const childId of t.children ?? []) {
      const child = state.tasks[childId];
      if (!child) continue;
      if (child.status === "done") {
        for (const f of filesFromTask(child)) {
          add(f, { id: child.id, title: child.title });
        }
      }
      visit(childId);
    }
  };
  visit(taskId);

  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}

/** Resolve a workspace-relative path for opening in the editor; null if unsafe. */
export function resolveTaskFilePath(
  workspaceRoot: string,
  relPath: string
): string | null {
  const files = sanitizeTaskFiles(workspaceRoot, [relPath]);
  if (!files.length) return null;
  return resolveInside(workspaceRoot, ...files[0].path.split("/").filter(Boolean));
}
