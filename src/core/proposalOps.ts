import { TaskNode, TaskStatus, TASK_STATUSES } from "./types";
import { isSafeId } from "./pathSafety";

export type StructureOp =
  | { op: "upsert"; tasks: TaskNode[]; parentId?: string | null }
  | { op: "delete"; taskId: string; mode: "promote" | "cascade" }
  | { op: "setStatus"; taskId: string; status: TaskStatus }
  | { op: "setDepends"; taskId: string; dependsOn: string[] };

const STATUSES = new Set<string>(TASK_STATUSES);

function asString(v: unknown, field: string): string {
  if (typeof v !== "string" || !v.trim()) throw new Error(`Invalid ${field}`);
  return v;
}

function parseTaskNode(raw: unknown, index: number): TaskNode {
  if (!raw || typeof raw !== "object") throw new Error(`tasks[${index}] must be object`);
  const t = raw as Record<string, unknown>;
  const id = asString(t.id, `tasks[${index}].id`);
  if (!isSafeId(id)) throw new Error(`Unsafe task id: ${id}`);
  const title = asString(t.title, `tasks[${index}].title`);
  const status = (typeof t.status === "string" && STATUSES.has(t.status) ? t.status : "todo") as TaskStatus;
  const children = Array.isArray(t.children)
    ? t.children.filter((c): c is string => typeof c === "string" && isSafeId(c))
    : [];
  const dependsOn = Array.isArray(t.dependsOn)
    ? t.dependsOn.filter((c): c is string => typeof c === "string" && isSafeId(c))
    : [];
  return {
    id,
    title,
    description: typeof t.description === "string" ? t.description : "",
    status,
    children,
    dependsOn,
    source: typeof t.source === "string" ? t.source : "agent",
    impactHint: typeof t.impactHint === "string" ? t.impactHint : undefined,
    estimateSp: typeof t.estimateSp === "number" ? t.estimateSp : undefined,
    estimateHours: typeof t.estimateHours === "number" ? t.estimateHours : undefined,
    tags: Array.isArray(t.tags) ? t.tags.filter((x): x is string => typeof x === "string") : undefined,
    code: Array.isArray(t.code) ? t.code.filter((x): x is string => typeof x === "string") : undefined,
    tests: Array.isArray(t.tests) ? t.tests.filter((x): x is string => typeof x === "string") : undefined,
    assignee: typeof t.assignee === "string" ? t.assignee : undefined,
  };
}

function parseOneOp(raw: unknown, index: number): StructureOp {
  if (!raw || typeof raw !== "object") throw new Error(`ops[${index}] must be object`);
  const o = raw as Record<string, unknown>;
  const op = o.op;
  if (op === "upsert") {
    if (!Array.isArray(o.tasks) || o.tasks.length === 0) {
      throw new Error(`ops[${index}].tasks must be non-empty array`);
    }
    if (o.tasks.length > 100) throw new Error(`ops[${index}].tasks too large`);
    const parentId =
      o.parentId === null || o.parentId === undefined
        ? o.parentId
        : asString(o.parentId, `ops[${index}].parentId`);
    if (typeof parentId === "string" && !isSafeId(parentId)) {
      throw new Error(`Unsafe parentId: ${parentId}`);
    }
    return {
      op: "upsert",
      tasks: o.tasks.map((t, i) => parseTaskNode(t, i)),
      parentId: parentId as string | null | undefined,
    };
  }
  if (op === "delete") {
    const taskId = asString(o.taskId, `ops[${index}].taskId`);
    if (!isSafeId(taskId)) throw new Error(`Unsafe taskId: ${taskId}`);
    const mode = o.mode === "cascade" ? "cascade" : "promote";
    return { op: "delete", taskId, mode };
  }
  if (op === "setStatus") {
    const taskId = asString(o.taskId, `ops[${index}].taskId`);
    if (!isSafeId(taskId)) throw new Error(`Unsafe taskId: ${taskId}`);
    const status = asString(o.status, `ops[${index}].status`);
    if (!STATUSES.has(status)) throw new Error(`Invalid status: ${status}`);
    return { op: "setStatus", taskId, status: status as TaskStatus };
  }
  if (op === "setDepends") {
    const taskId = asString(o.taskId, `ops[${index}].taskId`);
    if (!isSafeId(taskId)) throw new Error(`Unsafe taskId: ${taskId}`);
    if (!Array.isArray(o.dependsOn)) throw new Error(`ops[${index}].dependsOn must be array`);
    const dependsOn = o.dependsOn.filter((c): c is string => typeof c === "string" && isSafeId(c));
    return { op: "setDepends", taskId, dependsOn };
  }
  throw new Error(`ops[${index}]: unknown op (allowed: upsert|delete|setStatus|setDepends)`);
}

/** Validate & normalize proposal ops from agent / disk JSON. */
export function parseStructureOps(
  raw: unknown
): { ok: true; ops: StructureOp[] } | { ok: false; error: string } {
  try {
    if (!Array.isArray(raw)) return { ok: false, error: "ops must be an array" };
    if (raw.length === 0) return { ok: false, error: "ops must not be empty" };
    if (raw.length > 50) return { ok: false, error: "ops: max 50 per proposal" };
    const ops = raw.map((item, i) => parseOneOp(item, i));
    return { ok: true, ops };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Safe basename for .proman/imports — rejects traversal and odd names.
 */
export function sanitizeImportBasename(name: string): string | null {
  if (!name || typeof name !== "string") return null;
  // Never honor parent segments — only the final path component
  const base = name.replace(/\\/g, "/").split("/").filter(Boolean).pop()?.trim() ?? "";
  if (!base || base === "." || base === ".." || base.includes("\0")) return null;
  if (base.includes("..") || /[/\\]/.test(base)) return null;
  const cleaned = base.replace(/[^\w.\- ()[\]]+/g, "_").replace(/^\.+/, "").slice(0, 180);
  if (!cleaned || cleaned === "." || cleaned === ".." || cleaned.includes("..")) return null;
  return cleaned;
}
