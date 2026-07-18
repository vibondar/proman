export type TaskStatus =
  | "todo"
  | "new"
  | "in_progress"
  | "done"
  | "needs_rework"
  | "error"
  | "blocked";

export const TASK_STATUSES: TaskStatus[] = [
  "todo",
  "new",
  "in_progress",
  "done",
  "needs_rework",
  "error",
  "blocked",
];

/** Canonical English labels (match statusLabelL10n keys). Use statusLabelL10n for UI. */
export function statusLabel(status: TaskStatus): string {
  switch (status) {
    case "todo":
      return "todo";
    case "new":
      return "new";
    case "in_progress":
      return "in progress";
    case "done":
      return "done";
    case "needs_rework":
      return "needs rework";
    case "error":
      return "error";
    case "blocked":
      return "blocked";
  }
}

export type TaskFileKind = "created" | "modified";

export interface TaskFileChange {
  /** Path relative to workspace root */
  path: string;
  kind?: TaskFileKind;
}

export interface TaskNode {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  children: string[];
  dependsOn: string[];
  source: string;
  impactHint?: string;
  /** Story points (from «Оценка: N SP» or UI) */
  estimateSp?: number;
  /** Hours (from «Оценка: … / N часа») */
  estimateHours?: number;
  /** Tags without # (from «Теги: #a #b») */
  tags?: string[];
  /** Implementation paths (from «Код: …») */
  code?: string[];
  /** Test paths (from «Тесты: …») */
  tests?: string[];
  /** Who owns the task (from «Assignee: …» / «Исполнитель: …») */
  assignee?: string;
  /** Workspace-relative files created/modified while completing this task */
  changedFiles?: TaskFileChange[];
}

export interface DependencyEdge {
  from: string;
  to: string;
  kind: "dependsOn" | "blocks" | "related";
}

export interface TeamMember {
  username: string;
  name?: string;
}

export interface TeamConfig {
  members: TeamMember[];
  currentUser?: string;
}

export interface SyncConfig {
  type: "git";
  autoCommit?: boolean;
  autoPush?: boolean;
}

/** GitHub Issues bridge (этап 2). Связь: строка «GitHub: #N» в description. */
export interface GithubIssuesConfig {
  enabled: boolean;
  owner: string;
  repo: string;
  /** Create Issue when a task is added (default true). */
  createOnAdd?: boolean;
  /** Set task status to done when linked Issue is closed (default true). */
  closeToDone?: boolean;
  /** Use public_repo OAuth scope instead of repo (default false). */
  publicOnly?: boolean;
}

export interface TreeDescriptor {
  id: string;
  title: string;
  /** Relative path or imports basename that produced this tree */
  sourceFile?: string;
  updatedAt?: string;
}

export interface TreeBundle {
  id: string;
  title: string;
  sourceFile?: string;
  roots: string[];
  tasks: Record<string, TaskNode>;
  edges: DependencyEdge[];
  updatedAt: string;
}

export interface ProjectMeta {
  name: string;
  planningDir?: string;
  createdAt: string;
  updatedAt: string;
  /**
   * @deprecated Prefer team.currentUser — kept for backward compatibility.
   */
  currentUser?: string;
  team?: TeamConfig;
  sync?: SyncConfig;
  github?: GithubIssuesConfig;
  /** Registry of task trees (one per imported plan / MD file). */
  trees?: TreeDescriptor[];
  /** Preferred tree for new root tasks / Drive default. */
  activeTreeId?: string;
}

export interface ProjectState {
  meta: ProjectMeta;
  /** Per-import / per-plan trees (source of truth on disk under .proman/trees/). */
  trees: TreeBundle[];
  /**
   * Flattened view of all trees (unique task ids). Kept for engines/UI helpers;
   * persisted also as legacy tree.json for MCP.
   */
  roots: string[];
  tasks: Record<string, TaskNode>;
  edges: DependencyEdge[];
}

export interface ImpactItem {
  taskId: string;
  title: string;
  change: string;
  suggestedStatus?: TaskStatus;
}

export interface ImpactPreview {
  ok: boolean;
  error?: string;
  affected: ImpactItem[];
  cycles?: string[][];
}

export interface TreeProgress {
  done: number;
  total: number;
  inProgress: number;
  blocked: number;
  todo: number;
}

/** Messages: extension host ↔ webview */
export type HostToWebview =
  | { type: "state"; state: ProjectState | null; progress: TreeProgress | null }
  | { type: "impact"; impact: ImpactPreview | null }
  | { type: "toast"; level: "info" | "warn" | "error"; message: string }
  | { type: "ready" };

export type WebviewToHost =
  | { type: "ready" }
  | { type: "addTask"; parentId: string | null; title: string }
  | { type: "updateTask"; taskId: string; patch: Partial<Pick<TaskNode, "title" | "description" | "status" | "dependsOn">> }
  | { type: "deleteTask"; taskId: string; mode: "promote" | "cascade" }
  | { type: "moveTask"; taskId: string; newParentId: string | null; index?: number }
  | { type: "previewImpact"; action: ImpactAction }
  | { type: "confirmImpact"; action: ImpactAction }
  | { type: "runInAgent"; taskId: string }
  | { type: "copyPrompt"; taskId: string }
  | { type: "importMd" }
  | { type: "setPlanningDir" }
  | { type: "enrichMd" }
  | { type: "recalculate" }
  | { type: "selectTask"; taskId: string | null };

export type ImpactAction =
  | { kind: "add"; parentId: string | null; title: string; dependsOn?: string[] }
  | { kind: "delete"; taskId: string; mode: "promote" | "cascade" }
  | { kind: "updateDepends"; taskId: string; dependsOn: string[] }
  | { kind: "setStatus"; taskId: string; status: TaskStatus };
