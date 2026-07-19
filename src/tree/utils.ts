/**
 * Resolve a task id from a tree command argument, or fall back to selection.
 * Duck-typed to avoid pulling VS Code TreeItem classes into unit tests.
 */
export function resolveTaskId(
  arg: { kind?: string; task?: { id?: string } } | string | undefined,
  fallback: () => string | null | undefined
): string | undefined {
  if (!arg) return fallback() ?? undefined;
  if (typeof arg === "string") return arg;
  if (arg.kind === "section") return undefined;
  return arg.task?.id;
}

type DriveTreeSource = {
  kind?: string;
  treeId?: string;
};

/**
 * Drive Mode scopes to a **tree section header**, not a task/epic node.
 * Prefer explicit section arg → selected section → activeTreeId fallback.
 */
export function resolveDriveTreeId(
  arg: DriveTreeSource | undefined,
  selection: DriveTreeSource | undefined,
  activeTreeId: string | null | undefined
): string | undefined {
  if (arg?.kind === "section" && arg.treeId) return arg.treeId;
  if (selection?.kind === "section" && selection.treeId) return selection.treeId;
  return activeTreeId ?? undefined;
}
