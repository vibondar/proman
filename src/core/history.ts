import { isSafeId } from "./pathSafety";
import { wsMkdir, wsReadText, wsWriteText } from "./workspaceIo";

export type HistoryKind = "status" | "assignee" | "comment";

export interface HistoryEntry {
  id: string;
  at: string;
  /** Who performed the change (from project.json currentUser). */
  actor: string;
  taskId: string;
  kind: HistoryKind;
  from?: string;
  to?: string;
  /** Optional short text (e.g. comment preview). */
  message?: string;
}

export interface HistoryFile {
  entries: HistoryEntry[];
}

const MAX_ENTRIES = 500;

export function newHistoryId(): string {
  return `h_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function makeHistoryEntry(
  partial: Omit<HistoryEntry, "id" | "at"> & { at?: string; id?: string }
): HistoryEntry {
  return {
    id: partial.id ?? newHistoryId(),
    at: partial.at ?? new Date().toISOString(),
    actor: partial.actor,
    taskId: partial.taskId,
    kind: partial.kind,
    from: partial.from,
    to: partial.to,
    message: partial.message,
  };
}

/** Merge + cap (pure). Newest last in file; we append then trim from the front. */
export function mergeHistoryEntries(
  existing: HistoryEntry[],
  incoming: HistoryEntry[],
  max = MAX_ENTRIES
): HistoryEntry[] {
  const merged = [...existing, ...incoming];
  if (merged.length <= max) return merged;
  return merged.slice(merged.length - max);
}

export async function loadHistory(workspaceRoot: string): Promise<HistoryEntry[]> {
  const text = await wsReadText(workspaceRoot, ".proman", "history.json");
  if (!text) return [];
  try {
    const data = JSON.parse(text) as HistoryFile;
    return Array.isArray(data.entries) ? data.entries : [];
  } catch {
    return [];
  }
}

export async function appendHistory(
  workspaceRoot: string,
  incoming: HistoryEntry[]
): Promise<void> {
  if (!incoming.length) return;
  const existing = await loadHistory(workspaceRoot);
  const entries = mergeHistoryEntries(existing, incoming);
  await wsMkdir(workspaceRoot, ".proman");
  await wsWriteText(
    workspaceRoot,
    [".proman", "history.json"],
    JSON.stringify({ entries }, null, 2)
  );
}

export function historyForTask(entries: HistoryEntry[], taskId: string, limit = 20): HistoryEntry[] {
  if (!isSafeId(taskId) && !/^t_|^plan_|^md_/.test(taskId)) {
    /* still allow filtering by id string */
  }
  return entries.filter((e) => e.taskId === taskId).slice(-limit);
}
