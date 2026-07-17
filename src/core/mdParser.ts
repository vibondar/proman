import { TaskNode, TaskStatus } from "./types";
import { extractFrontmatter } from "./planFrontmatter";
import { enrichAllTasks } from "./taskMeta";

export interface ParsedMdResult {
  roots: string[];
  tasks: Record<string, TaskNode>;
  /** Next free numeric id suffix (for multi-file plan_N sequences) */
  nextCounter: number;
  meta: { type?: string; title?: string };
}

export interface ParseMarkdownOptions {
  /** Starting number for plan_N / md_…_N (default 1) */
  startCounter?: number;
  /**
   * Force id style. Default: "plan" if frontmatter type=plan, else "md".
   */
  idStyle?: "plan" | "md";
}

function statusFromCheckbox(line: string): TaskStatus | null {
  const m = line.match(/^\s*[-*]\s+\[([ xX])\]\s+(.*)$/);
  if (!m) return null;
  return m[1].toLowerCase() === "x" ? "done" : "todo";
}

function stripCheckbox(line: string): string {
  return line.replace(/^\s*[-*]\s+\[[ xX]\]\s+/, "").trim();
}

function parseDepends(text: string): string[] {
  const refs: string[] = [];
  const patterns = [
    /depends\s+on\s+[#"]?([^,"\n]+)/gi,
    /blocked\s+by\s+[#"]?([^,"\n]+)/gi,
    /зависит\s+от\s+["«]?([^"»,\n]+)/gi,
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      refs.push(m[1].trim());
    }
  }
  return refs;
}

function makeId(style: "plan" | "md", sourcePath: string, n: number): string {
  if (style === "plan") return `plan_${n}`;
  const prefix = sourcePath.replace(/[^a-zA-Z0-9]/g, "_").slice(-24) || "doc";
  return `md_${prefix}_${n}`;
}

/**
 * Plan Parser + Tree Builder:
 * - strips frontmatter (type: plan)
 * - headings → nested tasks, - [ ] → leaf tasks
 * - description = text immediately under heading/item
 * - ids: plan_1, plan_2… for plan docs; md_…_n otherwise
 */
export function parseMarkdownToTree(
  content: string,
  sourcePath: string,
  options: ParseMarkdownOptions = {}
): ParsedMdResult {
  const { meta, body } = extractFrontmatter(content);
  const isPlan = meta.type?.toLowerCase() === "plan";
  const idStyle = options.idStyle ?? (isPlan ? "plan" : "md");
  let counter = Math.max(1, options.startCounter ?? 1) - 1;

  const tasks: Record<string, TaskNode> = {};
  const roots: string[] = [];
  const stack: { level: number; id: string; kind: "heading" | "item" }[] = [];
  const titleToId = new Map<string, string>();

  const ensureTask = (
    title: string,
    level: number,
    status: TaskStatus,
    description: string,
    kind: "heading" | "item"
  ): string => {
    counter++;
    const id = makeId(idStyle, sourcePath, counter);
    const task: TaskNode = {
      id,
      title,
      description,
      status,
      children: [],
      dependsOn: [],
      source: `md:${sourcePath}`,
    };
    tasks[id] = task;
    titleToId.set(title.toLowerCase(), id);

    while (stack.length && stack[stack.length - 1].level >= level) {
      stack.pop();
    }
    if (stack.length === 0) {
      roots.push(id);
    } else {
      tasks[stack[stack.length - 1].id].children.push(id);
    }
    stack.push({ level, id, kind });
    return id;
  };

  const currentHeadingLevel = (): number => {
    for (let i = stack.length - 1; i >= 0; i--) {
      if (stack[i].kind === "heading") return stack[i].level;
    }
    return 0;
  };

  const lines = body.split(/\r?\n/);
  let pendingDesc: string[] = [];

  const flushDesc = (id: string | undefined) => {
    if (!id || !pendingDesc.length) {
      pendingDesc = [];
      return;
    }
    const text = pendingDesc.join("\n").trim();
    if (text) {
      tasks[id].description = [tasks[id].description, text].filter(Boolean).join("\n");
      for (const ref of parseDepends(text)) {
        (tasks[id] as TaskNode & { _depTitles?: string[] })._depTitles = [
          ...((tasks[id] as TaskNode & { _depTitles?: string[] })._depTitles ?? []),
          ref,
        ];
      }
    }
    pendingDesc = [];
  };

  let lastId: string | undefined;

  for (const line of lines) {
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      flushDesc(lastId);
      const level = heading[1].length;
      const title = heading[2].trim();
      lastId = ensureTask(title, level, "todo", "", "heading");
      continue;
    }

    const cb = statusFromCheckbox(line);
    if (cb !== null) {
      flushDesc(lastId);
      const title = stripCheckbox(line);
      const level = currentHeadingLevel() + 1;
      lastId = ensureTask(title, level, cb, "", "item");
      continue;
    }

    if (line.trim() === "") continue;
    if (/^\s*[-*]\s+/.test(line) && !/^\s*[-*]\s+\[/.test(line)) {
      flushDesc(lastId);
      const title = line.replace(/^\s*[-*]\s+/, "").trim();
      const level = currentHeadingLevel() + 1;
      lastId = ensureTask(title, level, "todo", "", "item");
      continue;
    }

    pendingDesc.push(line);
  }
  flushDesc(lastId);

  for (const t of Object.values(tasks)) {
    const extra = (t as TaskNode & { _depTitles?: string[] })._depTitles;
    if (!extra) continue;
    for (const title of extra) {
      const id = titleToId.get(title.toLowerCase());
      if (id && id !== t.id && !t.dependsOn.includes(id)) {
        t.dependsOn.push(id);
      }
    }
    delete (t as TaskNode & { _depTitles?: string[] })._depTitles;
  }

  if (roots.length === 0) {
    counter++;
    const id = makeId(idStyle, sourcePath, counter);
    tasks[id] = {
      id,
      title: meta.title || sourcePath.split(/[/\\]/).pop() || "Imported",
      description: body.slice(0, 500),
      status: "todo",
      children: [],
      dependsOn: [],
      source: `md:${sourcePath}`,
    };
    roots.push(id);
  }

  return {
    roots,
    tasks: enrichAllTasks(tasks),
    nextCounter: counter + 1,
    meta: {
      type: meta.type,
      title: meta.title,
    },
  };
}

export function mergeParsed(parts: ParsedMdResult[]): ParsedMdResult {
  const roots: string[] = [];
  const tasks: Record<string, TaskNode> = {};
  let nextCounter = 1;
  for (const p of parts) {
    Object.assign(tasks, p.tasks);
    roots.push(...p.roots);
    nextCounter = Math.max(nextCounter, p.nextCounter);
  }
  return { roots, tasks, nextCounter, meta: {} };
}
