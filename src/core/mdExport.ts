import { TaskNode, TaskStatus, TASK_STATUSES, TreeBundle } from "./types";
import { TREE_ID_SEP } from "./forest";

function yamlScalar(value: string): string {
  if (value === "" || /[:#\[\]{}&*!|>'"%@`]/.test(value) || /^\s|\s$/.test(value)) {
    return JSON.stringify(value);
  }
  return value;
}

function localTaskId(treeId: string, taskId: string): string {
  const prefix = `${treeId}${TREE_ID_SEP}`;
  return taskId.startsWith(prefix) ? taskId.slice(prefix.length) : taskId;
}

function stripExportMetaLines(description: string): string {
  return description
    .split(/\r?\n/)
    .filter((line) => !/^\s*Status\s*:/i.test(line))
    .join("\n")
    .trim();
}

function ensureAssigneeLine(description: string, assignee: string | undefined): string {
  if (!assignee) return description;
  if (/(?:^|\n)\s*(?:Assignee|Исполнитель|Ответственный)\s*:/i.test(description)) {
    return description;
  }
  const line = `Assignee: @${assignee.replace(/^@+/, "")}`;
  return description ? `${line}\n${description}` : line;
}

function headingLevel(depth: number): number {
  return Math.min(6, Math.max(1, depth + 1));
}

function dependsLines(task: TaskNode, tasks: Record<string, TaskNode>): string[] {
  const lines: string[] = [];
  for (const depId of task.dependsOn ?? []) {
    const dep = tasks[depId];
    if (!dep?.title) continue;
    const already =
      new RegExp(`depends\\s+on\\s+${escapeRegExp(dep.title)}`, "i").test(task.description || "") ||
      new RegExp(`зависит\\s+от\\s+[«"]?${escapeRegExp(dep.title)}`, "i").test(
        task.description || ""
      );
    if (!already) lines.push(`Depends on ${dep.title}`);
  }
  return lines;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function descriptionBlock(
  task: TaskNode,
  tasks: Record<string, TaskNode>,
  indent: string
): string[] {
  let body = stripExportMetaLines(task.description || "");
  body = ensureAssigneeLine(body, task.assignee);

  const extras: string[] = [];
  if (task.status !== "todo" && task.status !== "done") {
    extras.push(`Status: ${task.status}`);
  }
  extras.push(...dependsLines(task, tasks));

  const combined = [...extras, ...(body ? body.split(/\r?\n/) : [])].filter(
    (l, i, arr) => {
      if (l.trim() !== "") return true;
      if (i === 0) return false;
      const prev = arr[i - 1];
      return prev !== undefined && prev.trim() !== "";
    }
  );
  if (!combined.length) return [];
  return combined.map((line) => (line.trim() === "" ? "" : `${indent}${line}`));
}

/**
 * Export a tree bundle to planning Markdown.
 * Progress: done → `[x]`; other statuses → `[ ]` plus `Status:` when not todo/done.
 */
export function exportTreeToMarkdown(tree: TreeBundle): string {
  const lines: string[] = [
    "---",
    "type: plan",
    `title: ${yamlScalar(tree.title || tree.id)}`,
    "---",
    "",
  ];

  const walk = (id: string, depth: number) => {
    const task = tree.tasks[id];
    if (!task) return;
    const children = (task.children ?? []).filter((c) => tree.tasks[c]);
    const hasChildren = children.length > 0;

    if (hasChildren || depth === 0) {
      const level = headingLevel(depth);
      lines.push(`${"#".repeat(level)} ${task.title}`);
      lines.push(...descriptionBlock(task, tree.tasks, ""));
      lines.push("");
      for (const child of children) walk(child, depth + 1);
      return;
    }

    const mark = task.status === "done" ? "x" : " ";
    lines.push(`- [${mark}] ${task.title}`);
    lines.push(...descriptionBlock(task, tree.tasks, ""));
    lines.push("");
  };

  for (const root of tree.roots) {
    walk(root, 0);
  }

  // Trailing blank trim
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  lines.push("");
  return lines.join("\n");
}

/** Apply `Status: …` lines from description (used by MD import). */
export function applyStatusFromDescription(task: TaskNode): void {
  const m = (task.description || "").match(/(?:^|\n)\s*Status:\s*([a-z_]+)\s*(?:\n|$)/i);
  const statusRaw = m?.[1];
  if (!statusRaw) return;
  const raw = statusRaw.toLowerCase() as TaskStatus;
  if (!(TASK_STATUSES as string[]).includes(raw)) return;
  // Checkbox `[x]` wins over a conflicting Status line.
  if (task.status === "done" && raw !== "done") return;
  task.status = raw;
}

export function suggestedExportBasename(tree: TreeBundle): string {
  const fromSource = tree.sourceFile
    ? tree.sourceFile.replace(/\\/g, "/").split("/").pop()?.replace(/\.md$/i, "")
    : undefined;
  const base = (fromSource || tree.title || tree.id)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return `${base || "proman-tree"}.md`;
}

/** Exported for tests — local id without tree namespace. */
export function exportLocalId(treeId: string, taskId: string): string {
  return localTaskId(treeId, taskId);
}
