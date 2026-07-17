import * as path from "path";

/** Safe proposal / task-like ids: no path separators or traversal. */
export function isSafeId(id: string): boolean {
  return typeof id === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(id);
}

/**
 * Resolve path that must stay inside `root`.
 * Returns null if the result would escape (incl. via .. or absolute override).
 */
export function resolveInside(root: string, ...parts: string[]): string | null {
  const rootAbs = path.resolve(root);
  const candidate = path.resolve(rootAbs, ...parts);
  const prefix = rootAbs.endsWith(path.sep) ? rootAbs : rootAbs + path.sep;
  if (candidate !== rootAbs && !candidate.startsWith(prefix)) {
    return null;
  }
  return candidate;
}

/** Resolve planningDir relative to workspace; reject absolute escapes. */
export function resolvePlanningDir(
  workspaceRoot: string,
  planningDir: string
): string | null {
  if (!planningDir || typeof planningDir !== "string") return null;
  if (path.isAbsolute(planningDir)) {
    return resolveInside(workspaceRoot, path.relative(workspaceRoot, planningDir));
  }
  return resolveInside(workspaceRoot, planningDir);
}
