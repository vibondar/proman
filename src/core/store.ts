import * as vscode from "vscode";
import * as path from "path";
import {
  DependencyEdge,
  ProjectMeta,
  ProjectState,
  TaskNode,
  TaskStatus,
  TreeProgress,
} from "./types";
import { enrichAllTasks, enrichTaskFromDescription, upsertMetaInDescription } from "./taskMeta";
import { resolvePlanningDir } from "./pathSafety";
import { wsMkdir, wsReadText, wsWriteText } from "./workspaceIo";
import { appendHistory, HistoryEntry, loadHistory, makeHistoryEntry } from "./history";
import { actorsEqual, displayActor, normalizeActor } from "./actor";
import {
  formatStatusCommitMessage,
  getMetaCurrentUser,
  isGitSyncEnabled,
  listTeamUsernames,
  normalizeProjectMeta,
  setMetaCurrentUser,
} from "./projectMeta";
import { gitCommitProman, isGitRepo } from "./gitSync";
import { sanitizeErrorMessage } from "./githubIssueLink";
import { t } from "../i18n";

const PROMAN_DIR = ".proman";

export interface AssignmentEvent {
  taskId: string;
  title: string;
  assignee: string;
  actor: string;
}

function emptyState(name: string): ProjectState {
  const now = new Date().toISOString();
  return {
    meta: { name, createdAt: now, updatedAt: now },
    roots: [],
    tasks: {},
    edges: [],
  };
}

function newId(): string {
  return `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export class ProjectStore {
  private state: ProjectState | null = null;
  private readonly onDidChangeEmitter = new vscode.EventEmitter<ProjectState | null>();
  readonly onDidChange = this.onDidChangeEmitter.event;
  private log: (msg: string) => void = () => undefined;
  private pendingHistory: HistoryEntry[] = [];
  private onAssigned: ((e: AssignmentEvent) => void) | undefined;
  /** Last known assignees — used to detect assignments after disk reload. */
  private prevAssignees = new Map<string, string | undefined>();
  /** Queue auto git-commit after save when status changed. */
  private pendingStatusCommit: { taskId: string; title: string; from?: string; to: string } | null =
    null;
  private gitBusy = false;

  constructor(private readonly context: vscode.ExtensionContext) {}

  setLogger(fn: (msg: string) => void): void {
    this.log = fn;
  }

  setAssignmentListener(fn: (e: AssignmentEvent) => void): void {
    this.onAssigned = fn;
  }

  private snapshotAssignees(): void {
    this.prevAssignees.clear();
    if (!this.state) return;
    for (const t of Object.values(this.state.tasks)) {
      this.prevAssignees.set(t.id, t.assignee);
    }
  }

  private notifyIfAssignedToMe(
    task: TaskNode,
    prevAssignee: string | undefined,
    actor: string
  ): void {
    const me = getMetaCurrentUser(this.state?.meta);
    if (!me || !task.assignee) return;
    if (!actorsEqual(task.assignee, me)) return;
    if (actorsEqual(prevAssignee, me)) return;
    this.onAssigned?.({
      taskId: task.id,
      title: task.title,
      assignee: displayActor(task.assignee),
      actor: displayActor(actor),
    });
  }

  /** Always resolve live — workspace may be unavailable at activate() time. */
  private get folder(): vscode.WorkspaceFolder | undefined {
    return vscode.workspace.workspaceFolders?.[0];
  }

  get workspaceRoot(): string | undefined {
    return this.folder?.uri.fsPath;
  }

  get promanUri(): vscode.Uri | undefined {
    const folder = this.folder;
    if (!folder) return undefined;
    return vscode.Uri.joinPath(folder.uri, PROMAN_DIR);
  }

  get current(): ProjectState | null {
    return this.state;
  }

  currentUser(): string {
    return displayActor(getMetaCurrentUser(this.state?.meta));
  }

  hasCurrentUser(): boolean {
    return Boolean(normalizeActor(getMetaCurrentUser(this.state?.meta)));
  }

  setCurrentUser(name: string): void {
    if (!this.state) throw new Error("Project not initialized");
    setMetaCurrentUser(this.state.meta, name);
  }

  private actorName(): string {
    return this.hasCurrentUser() ? this.currentUser() : "unknown";
  }

  private queueHistory(
    partial: Omit<HistoryEntry, "id" | "at" | "actor"> & { actor?: string }
  ): void {
    this.pendingHistory.push(
      makeHistoryEntry({
        ...partial,
        actor: partial.actor ?? this.actorName(),
      })
    );
  }

  async waitForWorkspace(timeoutMs = 8000): Promise<vscode.WorkspaceFolder | undefined> {
    if (this.folder) return this.folder;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        sub.dispose();
        resolve(this.folder);
      }, timeoutMs);
      const sub = vscode.workspace.onDidChangeWorkspaceFolders(() => {
        if (this.folder) {
          clearTimeout(timer);
          sub.dispose();
          resolve(this.folder);
        }
      });
    });
  }

  async load(): Promise<ProjectState | null> {
    const folder = this.folder;
    if (!folder) {
      this.log("load: no workspace folder");
      this.state = null;
      this.onDidChangeEmitter.fire(null);
      return null;
    }
    const root = folder.uri.fsPath;
    this.log(`load: reading ${PROMAN_DIR}/project.json`);
    try {
      const metaText = await wsReadText(root, PROMAN_DIR, "project.json");
      const treeText = await wsReadText(root, PROMAN_DIR, "tree.json");
      if (!metaText || !treeText) {
        this.log("load: .proman files missing");
        this.state = null;
        this.onDidChangeEmitter.fire(null);
        return null;
      }
      const meta = normalizeProjectMeta(JSON.parse(metaText) as ProjectMeta);
      const tree = JSON.parse(treeText) as {
        roots: string[];
        tasks: Record<string, TaskNode>;
      };
      let edges: DependencyEdge[] = [];
      const edgesText = await wsReadText(root, PROMAN_DIR, "edges.json");
      if (edgesText) {
        edges = JSON.parse(edgesText) as DependencyEdge[];
      } else {
        edges = this.edgesFromTasks(tree.tasks ?? {});
      }
      this.state = {
        meta,
        roots: tree.roots ?? [],
        tasks: enrichAllTasks(tree.tasks ?? {}),
        edges,
      };
      const me = getMetaCurrentUser(this.state.meta);
      if (me && this.prevAssignees.size > 0) {
        const hist = await loadHistory(root);
        for (const t of Object.values(this.state.tasks)) {
          const prev = this.prevAssignees.get(t.id);
          if (actorsEqual(t.assignee, me) && !actorsEqual(prev, me)) {
            const last = [...hist]
              .reverse()
              .find(
                (e) =>
                  e.taskId === t.id &&
                  e.kind === "assignee" &&
                  actorsEqual(e.to, me)
              );
            this.onAssigned?.({
              taskId: t.id,
              title: t.title,
              assignee: displayActor(t.assignee),
              actor: displayActor(last?.actor),
            });
          }
        }
      }
      this.snapshotAssignees();
      this.log(
        `load: ok roots=${this.state.roots.length} tasks=${Object.keys(this.state.tasks).length}`
      );
      this.onDidChangeEmitter.fire(this.state);
      return this.state;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.log(`load: error ${msg}`);
      this.state = null;
      this.onDidChangeEmitter.fire(null);
      return null;
    }
  }

  async ensureInitialized(name?: string): Promise<ProjectState> {
    if (this.state) return this.state;
    const folder = this.folder;
    if (!folder) {
      throw new Error("No open workspace — open a project folder");
    }
    const projectName = name ?? path.basename(folder.uri.fsPath);
    this.state = emptyState(projectName);
    await this.save();
    return this.state;
  }

  async save(): Promise<void> {
    const folder = this.folder;
    if (!this.state || !folder) {
      if (this.state && !folder) {
        throw new Error("Failed to save .proman/: no workspace folder");
      }
      return;
    }
    this.state.meta.updatedAt = new Date().toISOString();
    this.state.meta = normalizeProjectMeta(this.state.meta);
    const root = folder.uri.fsPath;
    await wsMkdir(root, PROMAN_DIR, "prompts");
    await wsMkdir(root, PROMAN_DIR, "imports");
    await wsMkdir(root, PROMAN_DIR, "comments");
    const okMeta = await wsWriteText(
      root,
      [PROMAN_DIR, "project.json"],
      JSON.stringify(this.state.meta, null, 2)
    );
    const okTree = await wsWriteText(
      root,
      [PROMAN_DIR, "tree.json"],
      JSON.stringify({ roots: this.state.roots, tasks: this.state.tasks }, null, 2)
    );
    const okEdges = await wsWriteText(
      root,
      [PROMAN_DIR, "edges.json"],
      JSON.stringify(this.state.edges, null, 2)
    );
    if (!okMeta || !okTree || !okEdges) {
      throw new Error("Failed to save .proman/ (path outside workspace?)");
    }
    if (this.pendingHistory.length) {
      const batch = this.pendingHistory.splice(0, this.pendingHistory.length);
      try {
        await appendHistory(root, batch);
      } catch (e) {
        this.log(`history: ${e instanceof Error ? e.message : String(e)}`);
        this.pendingHistory.unshift(...batch);
      }
    }
    this.log(
      `save: ok roots=${this.state.roots.length} tasks=${Object.keys(this.state.tasks).length}`
    );
    this.snapshotAssignees();
    const statusCommit = this.pendingStatusCommit;
    this.pendingStatusCommit = null;
    this.onDidChangeEmitter.fire(this.state);

    if (statusCommit) {
      void this.maybeAutoCommitStatus(statusCommit);
    }
  }

  private async maybeAutoCommitStatus(info: {
    taskId: string;
    title: string;
    from?: string;
    to: string;
  }): Promise<void> {
    const root = this.workspaceRoot;
    const meta = this.state?.meta;
    if (!root || !meta || !isGitSyncEnabled(meta) || !meta.sync?.autoCommit) return;
    if (this.gitBusy) return;
    if (!(await isGitRepo(root))) {
      this.log("git sync: not a git repo — skip auto-commit");
      return;
    }
    this.gitBusy = true;
    try {
      const message = formatStatusCommitMessage(
        this.actorName(),
        info.title,
        info.from,
        info.to
      );
      const result = await gitCommitProman(root, message);
      if (!result.ok) {
        this.log(`git auto-commit failed: ${result.error ?? result.stderr}`);
        void vscode.window.showWarningMessage(
          t(
            "Proman git: auto-commit failed — {0}",
            sanitizeErrorMessage(result.error ?? result.stderr)
          )
        );
        return;
      }
      if (result.committed) {
        this.log(`git auto-commit: ${message}`);
        if (meta.sync.autoPush) {
          const pushBtn = t("Push");
          const laterBtn = t("Not now");
          void vscode.window
            .showWarningMessage(
              t(
                "Proman: auto-commit of .proman is ready. Push to remote? (comments/assignee will go to git)"
              ),
              pushBtn,
              laterBtn
            )
            .then(async (choice) => {
              if (choice !== pushBtn) return;
              const { gitPush } = await import("./gitSync");
              const push = await gitPush(root);
              if (!push.ok) {
                void vscode.window.showWarningMessage(
                  t(
                    "Proman push: {0}",
                    sanitizeErrorMessage(push.error ?? push.stderr)
                  )
                );
              } else {
                void vscode.window.showInformationMessage(t("Proman: push OK"));
              }
            });
        }
      }
    } finally {
      this.gitBusy = false;
    }
  }

  progress(rootId?: string): TreeProgress {
    const counts: TreeProgress = { done: 0, total: 0, inProgress: 0, blocked: 0, todo: 0 };
    if (!this.state) return counts;
    const visit = (id: string) => {
      const t = this.state!.tasks[id];
      if (!t) return;
      counts.total++;
      if (t.status === "done") counts.done++;
      else if (t.status === "in_progress") counts.inProgress++;
      else if (t.status === "blocked") counts.blocked++;
      else counts.todo++; // todo | new | needs_rework | error
      for (const c of t.children) visit(c);
    };
    if (rootId) visit(rootId);
    else for (const r of this.state.roots) visit(r);
    return counts;
  }

  addTask(parentId: string | null, title: string, opts?: Partial<TaskNode>): TaskNode {
    if (!this.state) throw new Error("Project not initialized");
    const hasExisting = Object.keys(this.state.tasks).length > 0;
    const task: TaskNode = {
      id: newId(),
      title: title.trim() || "New task",
      description: opts?.description ?? "",
      status: opts?.status ?? (hasExisting ? "new" : "todo"),
      children: [],
      dependsOn: opts?.dependsOn ?? [],
      source: opts?.source ?? "manual",
      impactHint: opts?.impactHint,
      assignee: opts?.assignee,
    };
    if (task.assignee) {
      task.description = upsertMetaInDescription(task.description, { assignee: task.assignee });
    }
    this.state.tasks[task.id] = task;
    if (parentId && this.state.tasks[parentId]) {
      this.state.tasks[parentId].children.push(task.id);
    } else {
      this.state.roots.push(task.id);
    }
    this.syncEdgesFromDepends();
    return task;
  }

  updateTask(
    taskId: string,
    patch: Partial<
      Pick<
        TaskNode,
        | "title"
        | "description"
        | "status"
        | "dependsOn"
        | "impactHint"
        | "source"
        | "estimateSp"
        | "estimateHours"
        | "tags"
        | "code"
        | "tests"
        | "assignee"
      >
    >
  ): TaskNode {
    if (!this.state) throw new Error("Project not initialized");
    const task = this.state.tasks[taskId];
    if (!task) throw new Error(`Task ${taskId} not found`);

    const prevStatus = task.status;
    const prevAssignee = task.assignee;

    Object.assign(task, patch);
    if ("estimateSp" in patch && (patch.estimateSp === undefined || patch.estimateSp === null)) {
      delete task.estimateSp;
    }
    if ("estimateHours" in patch && (patch.estimateHours === undefined || patch.estimateHours === null)) {
      delete task.estimateHours;
    }
    if ("assignee" in patch && !patch.assignee) {
      delete task.assignee;
    }
    if (patch.description !== undefined) {
      const enriched = enrichTaskFromDescription(task);
      Object.assign(task, {
        estimateSp: enriched.estimateSp,
        estimateHours: enriched.estimateHours,
        tags: enriched.tags,
        code: enriched.code,
        tests: enriched.tests,
        assignee: enriched.assignee,
      });
    }
    const metaTouched =
      patch.description !== undefined ||
      "estimateSp" in patch ||
      "estimateHours" in patch ||
      "assignee" in patch ||
      "tags" in patch ||
      "code" in patch ||
      "tests" in patch;
    if (metaTouched) {
      task.description = upsertMetaInDescription(task.description, {
        estimateSp: task.estimateSp,
        estimateHours: task.estimateHours,
        assignee: task.assignee,
        tags: task.tags,
        code: task.code,
        tests: task.tests,
      });
    }
    if (patch.dependsOn) this.syncEdgesFromDepends();

    if ("status" in patch && patch.status && patch.status !== prevStatus) {
      this.queueHistory({
        taskId,
        kind: "status",
        from: prevStatus,
        to: patch.status,
      });
      this.pendingStatusCommit = {
        taskId,
        title: task.title,
        from: prevStatus,
        to: patch.status,
      };
    }

    const nextAssignee = task.assignee;
    if (!actorsEqual(prevAssignee, nextAssignee)) {
      const actor = this.actorName();
      this.queueHistory({
        taskId,
        kind: "assignee",
        from: prevAssignee,
        to: nextAssignee,
        actor,
      });
      this.notifyIfAssignedToMe(task, prevAssignee, actor);
    }

    return task;
  }

  deleteTask(taskId: string, mode: "promote" | "cascade"): void {
    if (!this.state) throw new Error("Project not initialized");
    const task = this.state.tasks[taskId];
    if (!task) return;

    const parentId = this.findParent(taskId);
    const children = [...task.children];

    if (mode === "cascade") {
      const stack = [...children];
      while (stack.length) {
        const id = stack.pop()!;
        const t = this.state.tasks[id];
        if (!t) continue;
        stack.push(...t.children);
        delete this.state.tasks[id];
      }
    } else {
      if (parentId && this.state.tasks[parentId]) {
        const parent = this.state.tasks[parentId];
        const idx = parent.children.indexOf(taskId);
        if (idx >= 0) parent.children.splice(idx, 1, ...children);
      } else {
        const idx = this.state.roots.indexOf(taskId);
        if (idx >= 0) this.state.roots.splice(idx, 1, ...children);
      }
    }

    if (parentId && this.state.tasks[parentId] && mode === "cascade") {
      this.state.tasks[parentId].children = this.state.tasks[parentId].children.filter(
        (id) => id !== taskId
      );
    } else if (!parentId && mode === "cascade") {
      this.state.roots = this.state.roots.filter((id) => id !== taskId);
    } else if (mode === "promote") {
      if (parentId && this.state.tasks[parentId]) {
        this.state.tasks[parentId].children = this.state.tasks[parentId].children.filter(
          (id) => id !== taskId
        );
      } else {
        this.state.roots = this.state.roots.filter((id) => id !== taskId);
      }
    }

    for (const t of Object.values(this.state.tasks)) {
      t.dependsOn = t.dependsOn.filter((id) => id !== taskId && this.state!.tasks[id]);
      t.children = t.children.filter((id) => this.state!.tasks[id]);
    }
    delete this.state.tasks[taskId];
    this.syncEdgesFromDepends();
  }

  moveTask(taskId: string, newParentId: string | null, index?: number): void {
    if (!this.state) throw new Error("Project not initialized");
    if (!this.state.tasks[taskId]) return;
    if (newParentId === taskId) return;
    if (newParentId && this.isDescendant(taskId, newParentId)) {
      throw new Error("Cannot move a node into its own descendant");
    }

    const oldParent = this.findParent(taskId);
    if (oldParent) {
      this.state.tasks[oldParent].children = this.state.tasks[oldParent].children.filter(
        (id) => id !== taskId
      );
    } else {
      this.state.roots = this.state.roots.filter((id) => id !== taskId);
    }

    if (newParentId && this.state.tasks[newParentId]) {
      const list = this.state.tasks[newParentId].children;
      if (index === undefined || index < 0 || index > list.length) list.push(taskId);
      else list.splice(index, 0, taskId);
    } else {
      if (index === undefined || index < 0 || index > this.state.roots.length) {
        this.state.roots.push(taskId);
      } else {
        this.state.roots.splice(index, 0, taskId);
      }
    }
  }

  replaceFromImport(data: {
    roots: string[];
    tasks: Record<string, TaskNode>;
    planningDir?: string;
  }): void {
    if (!this.state) throw new Error("Project not initialized");
    this.state.roots = data.roots;
    this.state.tasks = enrichAllTasks(data.tasks);
    if (data.planningDir) {
      const root = this.workspaceRoot;
      if (root) {
        const resolved = resolvePlanningDir(root, data.planningDir);
        if (resolved) {
          this.state.meta.planningDir = path.relative(root, resolved) || ".";
        }
      }
    }
    this.syncEdgesFromDepends();
  }

  setPlanningDir(dir: string): void {
    if (!this.state) throw new Error("Project not initialized");
    const root = this.workspaceRoot;
    if (!root) throw new Error("No workspace");
    const resolved = resolvePlanningDir(root, dir);
    if (!resolved) {
      throw new Error("planningDir must be inside the workspace");
    }
    const rel = path.relative(root, resolved);
    this.state.meta.planningDir = rel || ".";
  }

  findParent(taskId: string): string | null {
    if (!this.state) return null;
    for (const [id, t] of Object.entries(this.state.tasks)) {
      if (t.children.includes(taskId)) return id;
    }
    return null;
  }

  private isDescendant(ancestorId: string, maybeDescendantId: string): boolean {
    if (!this.state) return false;
    const stack = [...(this.state.tasks[ancestorId]?.children ?? [])];
    while (stack.length) {
      const id = stack.pop()!;
      if (id === maybeDescendantId) return true;
      stack.push(...(this.state.tasks[id]?.children ?? []));
    }
    return false;
  }

  syncEdgesFromDepends(): void {
    if (!this.state) return;
    const edges: DependencyEdge[] = [];
    for (const t of Object.values(this.state.tasks)) {
      for (const dep of t.dependsOn) {
        if (this.state.tasks[dep]) {
          edges.push({ from: t.id, to: dep, kind: "dependsOn" });
          edges.push({ from: dep, to: t.id, kind: "blocks" });
        }
      }
    }
    this.state.edges = edges;
  }

  private edgesFromTasks(tasks: Record<string, TaskNode>): DependencyEdge[] {
    const edges: DependencyEdge[] = [];
    for (const t of Object.values(tasks)) {
      for (const dep of t.dependsOn) {
        edges.push({ from: t.id, to: dep, kind: "dependsOn" });
        edges.push({ from: dep, to: t.id, kind: "blocks" });
      }
    }
    return edges;
  }

  applyBlockedStatuses(): void {
    if (!this.state) return;
    for (const t of Object.values(this.state.tasks)) {
      if (t.status === "done" || t.status === "needs_rework" || t.status === "error") {
        continue;
      }
      const unmet = t.dependsOn.some((id) => {
        const d = this.state!.tasks[id];
        return d && d.status !== "done";
      });
      if (unmet) {
        if (t.status !== "blocked") t.status = "blocked";
      } else if (t.status === "blocked") {
        t.status = "todo";
      }
    }
  }

  upsertTasks(nodes: TaskNode[], parentId: string | null = null): void {
    if (!this.state) throw new Error("Project not initialized");
    for (const node of nodes) {
      const exists = Boolean(this.state.tasks[node.id]);
      let status = node.status ?? (exists ? this.state.tasks[node.id].status : "new");
      if (!exists && (!node.status || node.status === "todo")) {
        status = "new";
      }
      this.state.tasks[node.id] = {
        ...node,
        status,
        children: node.children ?? [],
        dependsOn: node.dependsOn ?? [],
      };
      if (parentId && this.state.tasks[parentId]) {
        if (!this.state.tasks[parentId].children.includes(node.id)) {
          this.state.tasks[parentId].children.push(node.id);
        }
      } else if (!this.state.roots.includes(node.id) && !this.findParent(node.id)) {
        this.state.roots.push(node.id);
      }
    }
    this.syncEdgesFromDepends();
  }

  getTask(taskId: string): TaskNode | undefined {
    return this.state?.tasks[taskId];
  }

  setStatus(taskId: string, status: TaskStatus): void {
    this.updateTask(taskId, { status });
    this.applyBlockedStatuses();
  }

  listAssignees(): string[] {
    if (!this.state) return [];
    const set = new Set<string>();
    for (const t of Object.values(this.state.tasks)) {
      const a = displayActor(t.assignee);
      if (a !== "unknown") set.add(a);
    }
    for (const u of listTeamUsernames(this.state.meta)) set.add(u);
    if (this.hasCurrentUser()) set.add(this.currentUser());
    return [...set].sort((a, b) => a.localeCompare(b));
  }

  recordCommentHistory(taskId: string, author: string, preview: string): void {
    this.queueHistory({
      taskId,
      kind: "comment",
      actor: author,
      message: preview.slice(0, 120),
    });
  }
}
