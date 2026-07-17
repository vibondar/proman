import * as vscode from "vscode";
import { ProjectStore } from "../core/store";
import { subtreeEstimateSp } from "../core/taskMeta";
import { statusLabel, TaskNode, TaskStatus } from "../core/types";

const STATUS_ICON: Record<TaskStatus, string> = {
  todo: "circle-large-outline",
  new: "circle-filled",
  in_progress: "sync~spin",
  done: "pass-filled",
  needs_rework: "warning",
  error: "error",
  blocked: "debug-breakpoint-unsupported",
};

/** Theme colors for icons / decorations */
export const STATUS_COLOR: Record<TaskStatus, string | undefined> = {
  todo: undefined,
  new: "charts.blue",
  in_progress: "charts.orange",
  done: "charts.green",
  needs_rework: "charts.yellow",
  error: "charts.red",
  blocked: "disabledForeground",
};

export type HighlightRole = "match" | "path" | "none";

const PATH_COLOR = "charts.orange";
const MATCH_COLOR = "list.highlightForeground";
const EPIC_SP_COLOR = "charts.blue";

function formatSpLabel(task: TaskNode, rollupSp: number): string | undefined {
  const isEpic = task.children.length > 0;
  if (isEpic && rollupSp > 0) return `Σ ${formatSp(rollupSp)} SP`;
  if (!isEpic && task.estimateSp != null && task.estimateSp > 0) {
    return `${formatSp(task.estimateSp)} SP`;
  }
  return undefined;
}

function formatSp(n: number): string {
  return Number.isInteger(n) ? String(n) : String(n);
}

export class PromanTreeItem extends vscode.TreeItem {
  constructor(
    public readonly task: TaskNode,
    collapsible: vscode.TreeItemCollapsibleState,
    public readonly highlight: HighlightRole = "none",
    public readonly rollupSp = 0
  ) {
    super(task.title, collapsible);
    this.id = task.id;

    const statusText = statusLabel(task.status);
    const spLabel = formatSpLabel(task, rollupSp);
    const isEpicSp = Boolean(task.children.length && rollupSp > 0);
    const assignee = task.assignee ? `@${task.assignee.replace(/^@/, "")}` : undefined;

    const bits: string[] = [];
    if (highlight === "match") bits.push("●");
    if (highlight === "path") bits.push("›");
    bits.push(statusText);
    if (spLabel) bits.push(spLabel);
    if (assignee) bits.push(assignee);
    this.description = bits.join(" · ");

    this.tooltip = [
      task.title,
      task.description,
      `status: ${statusText} (${task.status})`,
      spLabel ? `оценка: ${spLabel}` : "",
      assignee ? `assignee: ${assignee}` : "",
      task.tags?.length ? `теги: ${task.tags.map((t) => `#${t}`).join(" ")}` : "",
      task.code?.length ? `код: ${task.code.join(", ")}` : "",
      task.tests?.length ? `тесты: ${task.tests.join(", ")}` : "",
      highlight === "match" ? "подсветка: совпадение поиска" : "",
      highlight === "path" ? "подсветка: путь к совпадению" : "",
      task.dependsOn.length ? `dependsOn: ${task.dependsOn.length}` : "",
      task.source,
      task.impactHint ? `impact: ${task.impactHint}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    const iconColor =
      highlight === "match"
        ? MATCH_COLOR
        : highlight === "path"
          ? PATH_COLOR
          : isEpicSp
            ? EPIC_SP_COLOR
            : STATUS_COLOR[task.status];
    this.iconPath = iconColor
      ? new vscode.ThemeIcon(STATUS_ICON[task.status], new vscode.ThemeColor(iconColor))
      : new vscode.ThemeIcon(STATUS_ICON[task.status] ?? "circle-outline");

    // query: status|highlight|epicSp — FileDecorationProvider
    const epicFlag = isEpicSp ? "epic" : "";
    this.resourceUri = vscode.Uri.from({
      scheme: "proman-task",
      path: `/${task.id}`,
      query: `${task.status}|${highlight}|${epicFlag}`,
    });
    this.contextValue = "promanTask";
  }
}

function taskMatchesQuery(task: TaskNode, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const hay = [
    task.title,
    task.description,
    task.id,
    task.status,
    task.source,
    task.impactHint ?? "",
    task.assignee ?? "",
    ...(task.tags ?? []).map((t) => `#${t}`),
    ...(task.code ?? []),
    ...(task.tests ?? []),
  ]
    .join("\n")
    .toLowerCase();
  return hay.includes(q);
}

function buildParentMap(state: { roots: string[]; tasks: Record<string, TaskNode> }): Map<string, string | null> {
  const parentOf = new Map<string, string | null>();
  for (const r of state.roots) parentOf.set(r, null);
  for (const t of Object.values(state.tasks)) {
    for (const c of t.children) parentOf.set(c, t.id);
  }
  return parentOf;
}

export class PromanTreeProvider implements vscode.TreeDataProvider<PromanTreeItem> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<
    PromanTreeItem | undefined | null | void
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private selectedId: string | null = null;
  private filterQuery = "";
  /** Task ids that match filter or are ancestors of matches */
  private visibleIds: Set<string> | null = null;
  private matchIds = new Set<string>();
  private pathIds = new Set<string>();

  constructor(private readonly store: ProjectStore) {
    store.onDidChange(() => this.refresh());
  }

  getFilterQuery(): string {
    return this.filterQuery;
  }

  hasPathHighlight(): boolean {
    return this.matchIds.size > 0 || this.pathIds.size > 0;
  }

  setFilterQuery(query: string): void {
    this.filterQuery = query.trim();
    this.rebuildVisibleAndHighlight();
    this.refresh();
  }

  clearFilter(): void {
    this.filterQuery = "";
    this.visibleIds = null;
    this.matchIds.clear();
    this.pathIds.clear();
    this.refresh();
  }

  /** Highlight root→task path (search jump). Does not filter the tree. */
  highlightPathTo(taskId: string): void {
    const state = this.store.current;
    if (!state?.tasks[taskId]) {
      this.matchIds.clear();
      this.pathIds.clear();
      this.refresh();
      return;
    }
    const parentOf = buildParentMap(state);
    this.matchIds = new Set([taskId]);
    this.pathIds = new Set<string>();
    let id: string | null = parentOf.get(taskId) ?? null;
    while (id) {
      this.pathIds.add(id);
      id = parentOf.get(id) ?? null;
    }
    this.refresh();
  }

  clearPathHighlight(): void {
    if (!this.matchIds.size && !this.pathIds.size) return;
    this.matchIds.clear();
    this.pathIds.clear();
    this.refresh();
  }

  getMatchCount(): number {
    if (!this.filterQuery || !this.store.current) return 0;
    return Object.values(this.store.current.tasks).filter((t) =>
      taskMatchesQuery(t, this.filterQuery)
    ).length;
  }

  refresh(): void {
    if (this.filterQuery) {
      this.rebuildVisibleAndHighlight();
    }
    this._onDidChangeTreeData.fire();
  }

  getSelectedId(): string | null {
    return this.selectedId;
  }

  setSelectedId(id: string | null): void {
    this.selectedId = id;
  }

  private roleFor(taskId: string): HighlightRole {
    if (this.matchIds.has(taskId)) return "match";
    if (this.pathIds.has(taskId)) return "path";
    return "none";
  }

  private makeItem(
    task: TaskNode,
    collapsible: vscode.TreeItemCollapsibleState
  ): PromanTreeItem {
    const state = this.store.current;
    const rollup = state ? subtreeEstimateSp(state.tasks, task.id) : 0;
    return new PromanTreeItem(task, collapsible, this.roleFor(task.id), rollup);
  }

  getTreeItem(element: PromanTreeItem): vscode.TreeItem {
    return element;
  }

  getParent(element: PromanTreeItem): PromanTreeItem | undefined {
    const state = this.store.current;
    if (!state) return undefined;
    const parentId = Object.values(state.tasks).find((t) =>
      t.children.includes(element.task.id)
    )?.id;
    if (!parentId) return undefined;
    const parent = state.tasks[parentId];
    if (!parent) return undefined;
    return this.makeItem(parent, vscode.TreeItemCollapsibleState.Expanded);
  }

  getChildren(element?: PromanTreeItem): PromanTreeItem[] {
    const state = this.store.current;
    if (!state) {
      return [];
    }
    const ids = element ? element.task.children : state.roots;
    return ids
      .map((id) => state.tasks[id])
      .filter(Boolean)
      .filter((task) => !this.visibleIds || this.visibleIds.has(task.id))
      .map((task) => {
        const filteredChildren = task.children.filter(
          (id) => !this.visibleIds || this.visibleIds.has(id)
        );
        const collapsible =
          filteredChildren.length > 0
            ? vscode.TreeItemCollapsibleState.Expanded
            : vscode.TreeItemCollapsibleState.None;
        return this.makeItem(task, collapsible);
      });
  }

  /** Build item for reveal() */
  itemForId(taskId: string): PromanTreeItem | undefined {
    const task = this.store.current?.tasks[taskId];
    if (!task) return undefined;
    const hasKids = task.children.some((id) => !this.visibleIds || this.visibleIds.has(id));
    return this.makeItem(
      task,
      hasKids
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.None
    );
  }

  private rebuildVisibleAndHighlight(): void {
    const state = this.store.current;
    if (!state || !this.filterQuery) {
      this.visibleIds = null;
      // Keep focus path highlight if set without filter
      return;
    }

    const parentOf = buildParentMap(state);
    const visible = new Set<string>();
    const matches = new Set<string>();
    const paths = new Set<string>();

    for (const t of Object.values(state.tasks)) {
      if (!taskMatchesQuery(t, this.filterQuery)) continue;
      matches.add(t.id);
      let id: string | null = t.id;
      while (id) {
        visible.add(id);
        if (id !== t.id) paths.add(id);
        id = parentOf.get(id) ?? null;
      }
    }

    // A node that is both match and ancestor of another match stays "match"
    for (const id of matches) paths.delete(id);

    this.visibleIds = visible;
    this.matchIds = matches;
    this.pathIds = paths;
  }
}

/** Colors tree labels via resourceUri on PromanTreeItem */
export class PromanDecorationProvider implements vscode.FileDecorationProvider {
  private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this._onDidChange.event;

  refresh(): void {
    this._onDidChange.fire(undefined);
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== "proman-task") return undefined;
    const [statusRaw, hlRaw, epicRaw] = uri.query.split("|");
    const status = statusRaw as TaskStatus;
    const hl = (hlRaw as HighlightRole) || "none";
    const isEpic = epicRaw === "epic";

    if (hl === "match") {
      return {
        badge: "●",
        color: new vscode.ThemeColor(MATCH_COLOR),
        tooltip: "Совпадение поиска",
        propagate: false,
      };
    }
    if (hl === "path") {
      return {
        badge: "›",
        color: new vscode.ThemeColor(PATH_COLOR),
        tooltip: "Путь к совпадению",
        propagate: false,
      };
    }
    if (isEpic) {
      return {
        badge: "Σ",
        color: new vscode.ThemeColor(EPIC_SP_COLOR),
        tooltip: "Сумма SP по дочерним задачам",
        propagate: false,
      };
    }

    const colorId = STATUS_COLOR[status];
    if (!colorId) return undefined;
    return {
      color: new vscode.ThemeColor(colorId),
      tooltip: statusLabel(status),
      propagate: true,
    };
  }
}
