import * as vscode from "vscode";
import { actorsEqual } from "../core/actor";
import { getMetaCurrentUser } from "../core/projectMeta";
import { ProjectStore } from "../core/store";
import { subtreeEstimateSp } from "../core/taskMeta";
import { TaskNode, TaskStatus } from "../core/types";
import { statusLabelL10n, t } from "../i18n";


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

export class PromanSectionItem extends vscode.TreeItem {
  readonly kind = "section" as const;
  constructor(
    public readonly treeId: string,
    title: string,
    taskCount: number,
    sourceFile?: string
  ) {
    super(title, vscode.TreeItemCollapsibleState.Expanded);
    this.id = `section:${treeId}`;
    this.contextValue = "promanTreeSection";
    this.iconPath = new vscode.ThemeIcon("list-tree");
    this.description = String(taskCount);
    this.tooltip = sourceFile
      ? `${title}\n${sourceFile}\n${taskCount} tasks`
      : `${title}\n${taskCount} tasks`;
  }
}

export type PromanNode = PromanSectionItem | PromanTreeItem;

export class PromanTreeItem extends vscode.TreeItem {
  readonly kind = "task" as const;
  constructor(
    public readonly task: TaskNode,
    collapsible: vscode.TreeItemCollapsibleState,
    public readonly highlight: HighlightRole = "none",
    public readonly rollupSp = 0,
    public readonly treeId?: string
  ) {
    super(task.title, collapsible);
    this.id = task.id;

    const statusText = statusLabelL10n(task.status);
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
      spLabel ? t("estimate: {0}", spLabel) : "",
      assignee ? `assignee: ${assignee}` : "",
      task.tags?.length
        ? t("tags: {0}", task.tags.map((tag) => `#${tag}`).join(" "))
        : "",
      task.code?.length ? t("code: {0}", task.code.join(", ")) : "",
      task.tests?.length ? t("tests: {0}", task.tests.join(", ")) : "",
      highlight === "match" ? t("highlight: search match") : "",
      highlight === "path" ? t("highlight: path to match") : "",
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

export class PromanTreeProvider implements vscode.TreeDataProvider<PromanNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<
    PromanNode | undefined | null | void
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private selectedId: string | null = null;
  private filterQuery = "";
  /** Show only tasks assigned to project currentUser (+ ancestors). */
  private myTasksOnly = false;
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

  isMyTasksOnly(): boolean {
    return this.myTasksOnly;
  }

  hasPathHighlight(): boolean {
    return this.matchIds.size > 0 || this.pathIds.size > 0;
  }

  setFilterQuery(query: string): void {
    this.filterQuery = query.trim();
    this.rebuildVisibleAndHighlight();
    this.refresh();
  }

  setMyTasksOnly(on: boolean): void {
    this.myTasksOnly = on;
    this.rebuildVisibleAndHighlight();
    this.refresh();
  }

  toggleMyTasksOnly(): boolean {
    this.setMyTasksOnly(!this.myTasksOnly);
    return this.myTasksOnly;
  }

  clearFilter(): void {
    this.filterQuery = "";
    this.myTasksOnly = false;
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
    if (!this.store.current) return 0;
    if (!this.filterQuery && !this.myTasksOnly) return 0;
    return Object.values(this.store.current.tasks).filter((t) => this.taskMatchesFilters(t))
      .length;
  }

  refresh(): void {
    if (this.filterQuery || this.myTasksOnly) {
      this.rebuildVisibleAndHighlight();
    }
    this._onDidChangeTreeData.fire();
  }

  private taskMatchesFilters(task: TaskNode): boolean {
    if (this.filterQuery && !taskMatchesQuery(task, this.filterQuery)) return false;
    if (this.myTasksOnly) {
      const me = getMetaCurrentUser(this.store.current?.meta);
      if (!me || !actorsEqual(task.assignee, me)) return false;
    }
    return true;
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
    collapsible: vscode.TreeItemCollapsibleState,
    treeId?: string
  ): PromanTreeItem {
    const state = this.store.current;
    const rollup = state ? subtreeEstimateSp(state.tasks, task.id) : 0;
    return new PromanTreeItem(task, collapsible, this.roleFor(task.id), rollup, treeId);
  }

  getTreeItem(element: PromanNode): vscode.TreeItem {
    return element;
  }

  getParent(element: PromanNode): PromanNode | undefined {
    const state = this.store.current;
    if (!state) return undefined;
    if (element.kind === "section") return undefined;
    const parentId = Object.values(state.tasks).find((t) =>
      t.children.includes(element.task.id)
    )?.id;
    if (!parentId) {
      const treeId =
        element.treeId ??
        state.trees.find((tr) => tr.tasks[element.task.id])?.id;
      if (!treeId) return undefined;
      const tree = state.trees.find((tr) => tr.id === treeId);
      if (!tree) return undefined;
      return new PromanSectionItem(
        tree.id,
        tree.title,
        Object.keys(tree.tasks).length,
        tree.sourceFile
      );
    }
    const parent = state.tasks[parentId];
    if (!parent) return undefined;
    const treeId =
      element.treeId ?? state.trees.find((tr) => tr.tasks[parentId])?.id;
    return this.makeItem(parent, vscode.TreeItemCollapsibleState.Expanded, treeId);
  }

  getChildren(element?: PromanNode): PromanNode[] {
    const state = this.store.current;
    if (!state) return [];

    if (!element) {
      const trees = state.trees.length
        ? state.trees
        : [
            {
              id: "main",
              title: state.meta.name || "Main",
              roots: state.roots,
              tasks: state.tasks,
              edges: state.edges,
              updatedAt: state.meta.updatedAt,
            },
          ];
      return trees
        .filter((tr) => {
          if (!this.visibleIds) return true;
          return Object.keys(tr.tasks).some((id) => this.visibleIds!.has(id));
        })
        .map(
          (tr) =>
            new PromanSectionItem(
              tr.id,
              tr.title,
              Object.keys(tr.tasks).length,
              tr.sourceFile
            )
        );
    }

    if (element.kind === "section") {
      const tree = state.trees.find((tr) => tr.id === element.treeId);
      const roots = tree?.roots ?? state.roots;
      const tasks = tree?.tasks ?? state.tasks;
      return roots
        .map((id) => tasks[id] ?? state.tasks[id])
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
          return this.makeItem(task, collapsible, element.treeId);
        });
    }

    const task = element.task;
    return task.children
      .map((id) => state.tasks[id])
      .filter(Boolean)
      .filter((t) => !this.visibleIds || this.visibleIds.has(t.id))
      .map((t) => {
        const filteredChildren = t.children.filter(
          (id) => !this.visibleIds || this.visibleIds.has(id)
        );
        const collapsible =
          filteredChildren.length > 0
            ? vscode.TreeItemCollapsibleState.Expanded
            : vscode.TreeItemCollapsibleState.None;
        return this.makeItem(t, collapsible, element.treeId);
      });
  }

  /** Build item for reveal() */
  itemForId(taskId: string): PromanTreeItem | undefined {
    const state = this.store.current;
    const task = state?.tasks[taskId];
    if (!task || !state) return undefined;
    const treeId = state.trees.find((tr) => tr.tasks[taskId])?.id;
    const hasKids = task.children.some((id) => !this.visibleIds || this.visibleIds.has(id));
    return this.makeItem(
      task,
      hasKids
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.None,
      treeId
    );
  }

  private rebuildVisibleAndHighlight(): void {
    const state = this.store.current;
    if (!state || (!this.filterQuery && !this.myTasksOnly)) {
      this.visibleIds = null;
      // Keep focus path highlight if set without text/my filter
      return;
    }

    const parentOf = buildParentMap(state);
    const visible = new Set<string>();
    const matches = new Set<string>();
    const paths = new Set<string>();

    for (const t of Object.values(state.tasks)) {
      if (!this.taskMatchesFilters(t)) continue;
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
        tooltip: t("Search match"),
        propagate: false,
      };
    }
    if (hl === "path") {
      return {
        badge: "›",
        color: new vscode.ThemeColor(PATH_COLOR),
        tooltip: t("Path to match"),
        propagate: false,
      };
    }
    if (isEpic) {
      return {
        badge: "Σ",
        color: new vscode.ThemeColor(EPIC_SP_COLOR),
        tooltip: t("Sum of SP for child tasks"),
        propagate: false,
      };
    }

    const colorId = STATUS_COLOR[status];
    if (!colorId) return undefined;
    return {
      color: new vscode.ThemeColor(colorId),
      tooltip: statusLabelL10n(status),
      propagate: true,
    };
  }
}
