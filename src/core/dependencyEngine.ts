import {
  ImpactAction,
  ImpactItem,
  ImpactPreview,
  ProjectState,
  TaskNode,
  TaskStatus,
} from "./types";

function cloneState(state: ProjectState): ProjectState {
  return JSON.parse(JSON.stringify(state)) as ProjectState;
}

function findCycles(tasks: Record<string, TaskNode>): string[][] {
  const cycles: string[][] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];

  const dfs = (id: string) => {
    if (visited.has(id)) return;
    if (visiting.has(id)) {
      const idx = stack.indexOf(id);
      if (idx >= 0) cycles.push(stack.slice(idx).concat(id));
      return;
    }
    visiting.add(id);
    stack.push(id);
    const t = tasks[id];
    for (const dep of t?.dependsOn ?? []) {
      if (tasks[dep]) dfs(dep);
    }
    stack.pop();
    visiting.delete(id);
    visited.add(id);
  };

  for (const id of Object.keys(tasks)) dfs(id);
  return cycles;
}

function applyAction(state: ProjectState, action: ImpactAction): void {
  const newId = () =>
    `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

  switch (action.kind) {
    case "add": {
      const task: TaskNode = {
        id: newId(),
        title: action.title.trim() || "Новая задача",
        description: "",
        status: "todo",
        children: [],
        dependsOn: action.dependsOn ?? [],
        source: "manual",
      };
      state.tasks[task.id] = task;
      if (action.parentId && state.tasks[action.parentId]) {
        state.tasks[action.parentId].children.push(task.id);
      } else {
        state.roots.push(task.id);
      }
      break;
    }
    case "delete": {
      const task = state.tasks[action.taskId];
      if (!task) return;
      const parentId =
        Object.entries(state.tasks).find(([, t]) => t.children.includes(action.taskId))?.[0] ??
        null;
      const children = [...task.children];

      if (action.mode === "cascade") {
        const stack = [...children];
        while (stack.length) {
          const id = stack.pop()!;
          const t = state.tasks[id];
          if (!t) continue;
          stack.push(...t.children);
          delete state.tasks[id];
        }
        if (parentId) {
          state.tasks[parentId].children = state.tasks[parentId].children.filter(
            (id) => id !== action.taskId
          );
        } else {
          state.roots = state.roots.filter((id) => id !== action.taskId);
        }
      } else {
        if (parentId) {
          const p = state.tasks[parentId];
          const idx = p.children.indexOf(action.taskId);
          if (idx >= 0) p.children.splice(idx, 1, ...children);
          p.children = p.children.filter((id) => id !== action.taskId);
        } else {
          const idx = state.roots.indexOf(action.taskId);
          if (idx >= 0) state.roots.splice(idx, 1, ...children);
          state.roots = state.roots.filter((id) => id !== action.taskId);
        }
      }
      for (const t of Object.values(state.tasks)) {
        t.dependsOn = t.dependsOn.filter((id) => id !== action.taskId && state.tasks[id]);
        t.children = t.children.filter((id) => state.tasks[id]);
      }
      delete state.tasks[action.taskId];
      break;
    }
    case "updateDepends": {
      const t = state.tasks[action.taskId];
      if (t) t.dependsOn = action.dependsOn;
      break;
    }
    case "setStatus": {
      const t = state.tasks[action.taskId];
      if (t) t.status = action.status;
      break;
    }
  }
}

function computeBlocked(tasks: Record<string, TaskNode>): Map<string, TaskStatus> {
  const next = new Map<string, TaskStatus>();
  for (const t of Object.values(tasks)) {
    if (t.status === "done" || t.status === "needs_rework" || t.status === "error") {
      next.set(t.id, t.status);
      continue;
    }
    const unmet = t.dependsOn.some((id) => {
      const d = tasks[id];
      return d && d.status !== "done";
    });
    if (unmet) next.set(t.id, "blocked");
    else if (t.status === "blocked") next.set(t.id, "todo");
    else next.set(t.id, t.status);
  }
  return next;
}

export class DependencyEngine {
  preview(state: ProjectState, action: ImpactAction): ImpactPreview {
    const before = cloneState(state);
    const after = cloneState(state);
    applyAction(after, action);

    const cycles = findCycles(after.tasks);
    if (cycles.length) {
      return {
        ok: false,
        error: "Обнаружен цикл зависимостей",
        affected: [],
        cycles,
      };
    }

    const beforeBlocked = computeBlocked(before.tasks);
    const afterBlocked = computeBlocked(after.tasks);
    const affected: ImpactItem[] = [];

    const allIds = new Set([...Object.keys(before.tasks), ...Object.keys(after.tasks)]);
    for (const id of allIds) {
      const b = before.tasks[id];
      const a = after.tasks[id];
      if (!b && a) {
        affected.push({
          taskId: id,
          title: a.title,
          change: "Будет добавлена",
          suggestedStatus: afterBlocked.get(id),
        });
        continue;
      }
      if (b && !a) {
        affected.push({
          taskId: id,
          title: b.title,
          change: "Будет удалена",
        });
        continue;
      }
      if (!b || !a) continue;

      const sb = beforeBlocked.get(id);
      const sa = afterBlocked.get(id);
      if (sb !== sa) {
        affected.push({
          taskId: id,
          title: a.title,
          change: `Статус: ${sb} → ${sa}`,
          suggestedStatus: sa,
        });
      } else if (JSON.stringify(b.dependsOn) !== JSON.stringify(a.dependsOn)) {
        affected.push({
          taskId: id,
          title: a.title,
          change: "Изменятся зависимости",
          suggestedStatus: sa,
        });
      }
    }

    // Who depended on deleted / new deps
    if (action.kind === "add" && action.dependsOn?.length) {
      for (const depId of action.dependsOn) {
        const dep = after.tasks[depId];
        if (dep) {
          affected.push({
            taskId: depId,
            title: dep.title,
            change: "Будет блокировать новую задачу, пока не done",
          });
        }
      }
    }

    // Deduplicate by taskId+change
    const seen = new Set<string>();
    const unique = affected.filter((item) => {
      const key = `${item.taskId}:${item.change}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    return { ok: true, affected: unique };
  }

  detectCycles(state: ProjectState): string[][] {
    return findCycles(state.tasks);
  }

  /** Human-readable impact of feature A on feature B */
  describeRelation(state: ProjectState, aId: string, bId: string): string {
    const a = state.tasks[aId];
    const b = state.tasks[bId];
    if (!a || !b) return "Задачи не найдены";
    if (a.dependsOn.includes(bId)) {
      return `"${a.title}" зависит от "${b.title}" — пока B не done, A будет blocked`;
    }
    if (b.dependsOn.includes(aId)) {
      return `"${b.title}" зависит от "${a.title}" — добавление/задержка A сдвигает B`;
    }
    // Indirect
    const reaches = (from: string, to: string, seen = new Set<string>()): boolean => {
      if (from === to) return true;
      if (seen.has(from)) return false;
      seen.add(from);
      const t = state.tasks[from];
      return (t?.dependsOn ?? []).some((d) => reaches(d, to, seen));
    };
    if (reaches(aId, bId)) {
      return `"${a.title}" транзитивно зависит от "${b.title}"`;
    }
    if (reaches(bId, aId)) {
      return `"${b.title}" транзитивно зависит от "${a.title}" — изменения A повлияют на B`;
    }
    return `"${a.title}" и "${b.title}" напрямую не связаны зависимостями`;
  }
}
