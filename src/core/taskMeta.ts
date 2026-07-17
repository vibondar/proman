import { TaskNode } from "./types";

export interface TaskMeta {
  estimateSp?: number;
  estimateHours?: number;
  tags?: string[];
  code?: string[];
  tests?: string[];
  assignee?: string;
}

/** Parse Оценка / Теги / Код / Тесты / Assignee from free-text description. */
export function parseTaskMeta(description: string): TaskMeta {
  if (!description) return {};
  const meta: TaskMeta = {};

  const estLine = description.match(/(?:^|\n)\s*(?:Оценка|Estimate)\s*:\s*([^\n]+)/i);
  if (estLine) {
    const sp = estLine[1].match(/(\d+(?:\.\d+)?)\s*SP\b/i);
    if (sp) meta.estimateSp = Number(sp[1]);
    const hours = estLine[1].match(
      /(\d+(?:\.\d+)?)\s*(?:часа|часов|час|ч\.?|hours?|h)(?=\s|$|\/|,)/i
    );
    if (hours) meta.estimateHours = Number(hours[1]);
  }

  const tagsLine = description.match(/(?:^|\n)\s*(?:Теги|Tags)\s*:\s*([^\n]+)/i);
  if (tagsLine) {
    const tags = [...tagsLine[1].matchAll(/#([\w-]+)/g)].map((m) => m[1].toLowerCase());
    if (tags.length) meta.tags = [...new Set(tags)];
  }

  const codePaths: string[] = [];
  const testPaths: string[] = [];
  for (const line of description.split(/\r?\n/)) {
    const code = line.match(/^\s*(?:Код|Code)\s*:\s*(.+)$/i);
    if (code) {
      codePaths.push(
        ...code[1]
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      );
      continue;
    }
    const tests = line.match(/^\s*(?:Тесты|Tests)\s*:\s*(.+)$/i);
    if (tests) {
      testPaths.push(
        ...tests[1]
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      );
    }
  }
  if (codePaths.length) meta.code = [...new Set(codePaths)];
  if (testPaths.length) meta.tests = [...new Set(testPaths)];

  const assignee = description.match(
    /(?:^|\n)\s*(?:Assignee|Исполнитель|Ответственный)\s*:\s*@?([^\n]+)/i
  );
  if (assignee) {
    meta.assignee = assignee[1].trim().replace(/^@/, "");
  }

  return meta;
}

/** Fill structured fields from description when missing. */
export function enrichTaskFromDescription(task: TaskNode): TaskNode {
  const m = parseTaskMeta(task.description || "");
  return {
    ...task,
    estimateSp: task.estimateSp ?? m.estimateSp,
    estimateHours: task.estimateHours ?? m.estimateHours,
    tags: task.tags?.length ? task.tags : m.tags,
    code: task.code?.length ? task.code : m.code,
    tests: task.tests?.length ? task.tests : m.tests,
    assignee: task.assignee ?? m.assignee,
  };
}

export function enrichAllTasks(tasks: Record<string, TaskNode>): Record<string, TaskNode> {
  const out: Record<string, TaskNode> = {};
  for (const [id, t] of Object.entries(tasks)) {
    out[id] = enrichTaskFromDescription(t);
  }
  return out;
}

/**
 * Sum SP in subtree. Leaves contribute their estimateSp;
 * parents with children use sum of children (ignore parent's own SP to avoid double-count).
 */
export function subtreeEstimateSp(
  tasks: Record<string, TaskNode>,
  rootId: string
): number {
  const t = tasks[rootId];
  if (!t) return 0;
  if (!t.children?.length) return t.estimateSp ?? 0;
  let sum = 0;
  for (const id of t.children) sum += subtreeEstimateSp(tasks, id);
  return sum;
}

/** Sync structured meta back into description lines (keeps other prose). */
export function upsertMetaInDescription(
  description: string,
  meta: Partial<TaskMeta>
): string {
  let lines = (description || "").split(/\r?\n/);
  const setLine = (labels: RegExp, value: string | undefined) => {
    const idx = lines.findIndex((l) => labels.test(l));
    if (!value) {
      if (idx >= 0) lines.splice(idx, 1);
      return;
    }
    const line = value;
    if (idx >= 0) lines[idx] = line;
    else lines.push(line);
  };

  if (meta.estimateSp != null || meta.estimateHours != null) {
    const sp = meta.estimateSp != null ? `${meta.estimateSp} SP` : "";
    const h = meta.estimateHours != null ? `${meta.estimateHours} часа` : "";
    const joined = [sp, h].filter(Boolean).join(" / ");
    if (joined) setLine(/^\s*(?:Оценка|Estimate)\s*:/i, `Оценка: ${joined}`);
  } else {
    setLine(/^\s*(?:Оценка|Estimate)\s*:/i, undefined);
  }
  if (meta.tags) {
    setLine(
      /^\s*(?:Теги|Tags)\s*:/i,
      meta.tags.length ? `Теги: ${meta.tags.map((t) => `#${t.replace(/^#/, "")}`).join(" ")}` : undefined
    );
  }
  if (meta.assignee !== undefined) {
    setLine(
      /^\s*(?:Assignee|Исполнитель|Ответственный)\s*:/i,
      meta.assignee ? `Assignee: ${meta.assignee.replace(/^@/, "")}` : undefined
    );
  }
  if (meta.code) {
    // replace all Code lines with one
    lines = lines.filter((l) => !/^\s*(?:Код|Code)\s*:/i.test(l));
    if (meta.code.length) lines.push(`Код: ${meta.code.join(", ")}`);
  }
  if (meta.tests) {
    lines = lines.filter((l) => !/^\s*(?:Тесты|Tests)\s*:/i.test(l));
    if (meta.tests.length) lines.push(`Тесты: ${meta.tests.join(", ")}`);
  }
  return lines.join("\n").trim();
}
