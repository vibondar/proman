import * as vscode from "vscode";
import * as path from "path";
import {
  DependencyEdge,
  ProjectMeta,
  ProjectState,
  TaskNode,
  TaskStatus,
  TreeBundle,
  TreeProgress,
} from "./types";
import { enrichAllTasks, enrichTaskFromDescription, upsertMetaInDescription } from "./taskMeta";
import { isSafeId, resolvePlanningDir } from "./pathSafety";
import {
  wsDeleteTreeJson,
  wsMkdir,
  wsReadDir,
  wsReadText,
  wsWriteText,
  wsWriteTreeJson,
} from "./workspaceIo";
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
import {
  applyFlatProgressToTrees,
  edgesFromTasks,
  emptyTreeBundle,
  findTree,
  findTreeIdForTask,
  flattenForest,
  LEGACY_TREE_ID,
  legacyToForest,
  mergeTreePreserveProgress,
  namespaceTaskIds,
  projectStateFromForest,
  syncMetaTrees,
} from "./forest";
import {
  loadTreeBundlesFromTexts,
  PromanFileProblem,
  tryParsePromanJson,
} from "./promanConflict";

const PROMAN_DIR = ".proman";
/** Cap user-facing task titles (webview / tree safety). */
const MAX_TASK_TITLE_LEN = 500;

function clampTaskTitle(title: string): string {
  const trimmed = title.trim() || "New task";
  return trimmed.length > MAX_TASK_TITLE_LEN
    ? trimmed.slice(0, MAX_TASK_TITLE_LEN)
    : trimmed;
}

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
    trees: [],
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
  /** Wall clock of last local mutation / successful load|save — used to absorb newer MCP flat writes. */
  private lastLocalMutationMs = 0;
  /** Optional: suppress file watcher while we write .proman/ */
  onBeforeWriteDisk?: () => void;
  /**
   * Problems from the last `load()` (conflict markers / invalid JSON under `.proman/`).
   * Cleared at the start of each load. Paths are relative to `.proman/`.
   */
  lastLoadProblems: PromanFileProblem[] = [];
  /** Serialize disk writes so overlapping save() calls cannot reorder. */
  private saveChain: Promise<void> = Promise.resolve();

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
    this.lastLoadProblems = [];
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
      if (!metaText) {
        this.log("load: .proman files missing");
        this.state = null;
        this.onDidChangeEmitter.fire(null);
        return null;
      }
      const metaParsed = tryParsePromanJson(metaText);
      if (!metaParsed.ok) {
        // Fail-closed: cannot trust project without meta.
        this.lastLoadProblems.push({ path: "project.json", kind: metaParsed.kind });
        this.log(`load: project.json ${metaParsed.kind}`);
        this.state = null;
        this.onDidChangeEmitter.fire(null);
        return null;
      }
      const meta = normalizeProjectMeta(metaParsed.data as ProjectMeta);

      const dirEntries = await wsReadDir(root, PROMAN_DIR, "trees");
      const treeFiles =
        dirEntries?.filter(
          ([name, type]) => type === vscode.FileType.File && name.endsWith(".json")
        ) ?? [];

      let trees: TreeBundle[] | null = null;

      if (treeFiles.length > 0) {
        const entries: { fileName: string; text: string }[] = [];
        for (const [name] of treeFiles) {
          const text = await wsReadText(root, PROMAN_DIR, "trees", name);
          if (!text) continue;
          entries.push({ fileName: name, text });
        }
        const loaded = loadTreeBundlesFromTexts(entries);
        this.lastLoadProblems.push(...loaded.problems);
        for (const p of loaded.problems) {
          this.log(`load: ${p.kind} ${p.path}`);
        }
        trees = loaded.trees.length ? loaded.trees : null;
      } else {
        const treeText = await wsReadText(root, PROMAN_DIR, "tree.json");
        if (treeText) {
          const treeParsed = tryParsePromanJson(treeText);
          if (!treeParsed.ok) {
            this.lastLoadProblems.push({ path: "tree.json", kind: treeParsed.kind });
            this.log(`load: tree.json ${treeParsed.kind}`);
          } else {
            const tree = treeParsed.data as {
              roots: string[];
              tasks: Record<string, TaskNode>;
            };
            let edges: DependencyEdge[] = [];
            const edgesText = await wsReadText(root, PROMAN_DIR, "edges.json");
            if (edgesText) {
              const edgesParsed = tryParsePromanJson(edgesText);
              if (edgesParsed.ok) {
                edges = edgesParsed.data as DependencyEdge[];
              }
            } else {
              edges = edgesFromTasks(tree.tasks ?? {});
            }
            trees = legacyToForest(meta, tree.roots ?? [], tree.tasks ?? {}, edges);
          }
        }
      }

      if (!trees) {
        this.log("load: .proman trees missing");
        this.state = null;
        this.onDidChangeEmitter.fire(null);
        return null;
      }

      // Heal forest from flat tree.json (MCP may update only the snapshot).
      // Never heal-write when flat or any tree file had conflict/corrupt problems.
      const flatText = await wsReadText(root, PROMAN_DIR, "tree.json");
      let healed = false;
      let flatOk = true;
      if (flatText) {
        const flatParsed = tryParsePromanJson(flatText);
        if (!flatParsed.ok) {
          flatOk = false;
          if (!this.lastLoadProblems.some((p) => p.path === "tree.json")) {
            this.lastLoadProblems.push({ path: "tree.json", kind: flatParsed.kind });
          }
          this.log(`load: skip heal — tree.json ${flatParsed.kind}`);
        } else {
          const flat = flatParsed.data as { tasks?: Record<string, TaskNode> };
          healed = applyFlatProgressToTrees(trees, flat.tasks);
        }
      }

      this.state = projectStateFromForest(meta, trees);
      this.lastLocalMutationMs = Date.now();

      const hasTreeProblems = this.lastLoadProblems.some((p) => p.path.startsWith("trees/"));
      if (healed && flatOk && !hasTreeProblems) {
        this.log("load: healed trees/* from tree.json progress");
        try {
          this.onBeforeWriteDisk?.();
          for (const tree of this.state.trees) {
            await wsWriteTreeJson(root, tree.id, JSON.stringify(tree, null, 2));
          }
          await wsWriteText(
            root,
            [PROMAN_DIR, "tree.json"],
            JSON.stringify({ roots: this.state.roots, tasks: this.state.tasks }, null, 2)
          );
        } catch (e) {
          this.log(`load: heal write failed ${e instanceof Error ? e.message : String(e)}`);
        }
      }

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
        `load: ok trees=${this.state.trees.length} roots=${this.state.roots.length} tasks=${Object.keys(this.state.tasks).length}` +
          (this.lastLoadProblems.length
            ? ` problems=${this.lastLoadProblems.length}`
            : "")
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
    this.ensureActiveTree();
    await this.save();
    return this.state;
  }

  async save(): Promise<void> {
    const next = this.saveChain.then(() => this.saveUnlocked());
    // Keep the chain alive even if a save fails so later writes still run.
    this.saveChain = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }

  private async saveUnlocked(): Promise<void> {
    const folder = this.folder;
    if (!this.state || !folder) {
      if (this.state && !folder) {
        throw new Error("Failed to save .proman/: no workspace folder");
      }
      return;
    }
    await this.absorbNewerFlatProgressFromDisk();
    this.rebuildFlat();
    this.state.meta.updatedAt = new Date().toISOString();
    this.state.meta = syncMetaTrees(normalizeProjectMeta(this.state.meta), this.state.trees);
    const root = folder.uri.fsPath;
    this.onBeforeWriteDisk?.();
    await wsMkdir(root, PROMAN_DIR, "prompts");
    await wsMkdir(root, PROMAN_DIR, "imports");
    await wsMkdir(root, PROMAN_DIR, "comments");
    await wsMkdir(root, PROMAN_DIR, "trees");

    let okTrees = true;
    const safeTrees = this.state.trees.filter((t) => isSafeId(t.id));
    if (safeTrees.length !== this.state.trees.length) {
      this.log("save: dropping trees with unsafe ids");
      this.state.trees = safeTrees;
      this.rebuildFlat();
    }
    for (const tree of this.state.trees) {
      const ok = await wsWriteTreeJson(root, tree.id, JSON.stringify(tree, null, 2));
      if (!ok) okTrees = false;
    }

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
    if (!okMeta || !okTree || !okEdges || !okTrees) {
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
    this.lastLocalMutationMs = Date.now();
    this.log(
      `save: ok trees=${this.state.trees.length} roots=${this.state.roots.length} tasks=${Object.keys(this.state.tasks).length}`
    );
    this.snapshotAssignees();
    const statusCommit = this.pendingStatusCommit;
    this.pendingStatusCommit = null;
    this.onDidChangeEmitter.fire(this.state);

    if (statusCommit) {
      void this.maybeAutoCommitStatus(statusCommit);
    }
  }

  /**
   * If MCP/agent wrote a newer `.proman/tree.json` than our last local mutation,
   * pull progress into in-memory trees so we do not clobber it on save.
   */
  private async absorbNewerFlatProgressFromDisk(): Promise<void> {
    if (!this.state || !this.folder) return;
    const root = this.folder.uri.fsPath;
    const flatPath = path.join(root, PROMAN_DIR, "tree.json");
    try {
      const st = await vscode.workspace.fs.stat(vscode.Uri.file(flatPath));
      if (st.mtime <= this.lastLocalMutationMs) return;
      const treeText = await wsReadText(root, PROMAN_DIR, "tree.json");
      if (!treeText) return;
      const flat = JSON.parse(treeText) as { tasks?: Record<string, TaskNode> };
      if (applyFlatProgressToTrees(this.state.trees, flat.tasks)) {
        this.log("save: absorbed newer progress from tree.json");
        this.rebuildFlat();
      }
    } catch {
      /* missing or unreadable — ignore */
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

  private rebuildFlat(): void {
    if (!this.state) return;
    const flat = flattenForest(this.state.trees);
    this.state.roots = flat.roots;
    this.state.tasks = flat.tasks;
    this.state.edges = flat.edges;
    this.state.meta = syncMetaTrees(this.state.meta, this.state.trees);
  }

  private syncTaskToTree(taskId: string): void {
    if (!this.state) return;
    const task = this.state.tasks[taskId];
    if (!task) return;
    const treeId = findTreeIdForTask(this.state.trees, taskId);
    if (!treeId) return;
    const tree = findTree(this.state.trees, treeId);
    if (!tree) return;
    tree.tasks[taskId] = { ...task };
    tree.edges = edgesFromTasks(tree.tasks);
    tree.updatedAt = new Date().toISOString();
  }

  /** After flat structural mutation: push flat tasks/roots back into owning tree. */
  private syncTreeStructureFromFlat(treeId: string): void {
    if (!this.state) return;
    const tree = findTree(this.state.trees, treeId);
    if (!tree) return;
    const nextTasks: Record<string, TaskNode> = {};
    for (const id of Object.keys(tree.tasks)) {
      const flat = this.state.tasks[id];
      if (flat) nextTasks[id] = { ...flat };
    }
    // Include any new flat tasks that are children of tree tasks or tree roots
    const visit = (id: string) => {
      const flat = this.state!.tasks[id];
      if (!flat || nextTasks[id]) return;
      nextTasks[id] = { ...flat };
      for (const c of flat.children) visit(c);
    };
    for (const r of [...tree.roots, ...this.state.roots]) {
      if (tree.tasks[r] || nextTasks[r] || this.state.tasks[r]) visit(r);
    }
    // Prefer roots that still belong to this tree
    const roots = this.state.roots.filter((id) => nextTasks[id]);
    const orphanRoots = Object.keys(nextTasks).filter((id) => {
      const referenced = Object.values(nextTasks).some((t) => t.children.includes(id));
      return !referenced && !roots.includes(id);
    });
    tree.tasks = nextTasks;
    tree.roots = [...roots.filter((id) => nextTasks[id]), ...orphanRoots.filter((id) => !roots.includes(id))];
    // If filter emptied roots but tasks remain, keep previous roots that still exist
    if (!tree.roots.length && Object.keys(nextTasks).length) {
      tree.roots = Object.keys(nextTasks).filter((id) => {
        const referenced = Object.values(nextTasks).some((t) => t.children.includes(id));
        return !referenced;
      });
    }
    tree.edges = edgesFromTasks(tree.tasks);
    tree.updatedAt = new Date().toISOString();
  }

  private ensureActiveTree(): string {
    if (!this.state) throw new Error("Project not initialized");
    if (!this.state.trees.length) {
      const bundle = emptyTreeBundle(LEGACY_TREE_ID, this.state.meta.name || "Main");
      this.state.trees.push(bundle);
      this.state.meta.activeTreeId = bundle.id;
      this.rebuildFlat();
      return bundle.id;
    }
    if (
      !this.state.meta.activeTreeId ||
      !this.state.trees.some((t) => t.id === this.state!.meta.activeTreeId)
    ) {
      const first = this.state.trees[0];
      if (!first) {
        const bundle = emptyTreeBundle(LEGACY_TREE_ID, this.state.meta.name || "Main");
        this.state.trees.push(bundle);
        this.state.meta.activeTreeId = bundle.id;
        this.rebuildFlat();
        return bundle.id;
      }
      this.state.meta.activeTreeId = first.id;
    }
    return this.state.meta.activeTreeId!;
  }

  listTrees(): TreeBundle[] {
    return this.state?.trees ?? [];
  }

  getTree(treeId: string): TreeBundle | undefined {
    if (!this.state) return undefined;
    return findTree(this.state.trees, treeId);
  }

  setActiveTree(treeId: string): void {
    if (!this.state) throw new Error("Project not initialized");
    if (!isSafeId(treeId) || !findTree(this.state.trees, treeId)) {
      throw new Error(`Tree ${treeId} not found`);
    }
    this.state.meta.activeTreeId = treeId;
    this.state.meta = syncMetaTrees(this.state.meta, this.state.trees);
  }

  /**
   * Remove a tree from the forest and delete its JSON on disk.
   * Progress in that tree is discarded (caller must warn the user).
   */
  async deleteTree(treeId: string): Promise<void> {
    if (!this.state) throw new Error("Project not initialized");
    if (!isSafeId(treeId) || !findTree(this.state.trees, treeId)) {
      throw new Error(`Tree ${treeId} not found`);
    }
    this.state.trees = this.state.trees.filter((t) => t.id !== treeId);
    if (this.state.meta.activeTreeId === treeId) {
      this.state.meta.activeTreeId = this.state.trees[0]?.id;
    }
    this.rebuildFlat();
    const folder = this.folder;
    if (folder) {
      await wsDeleteTreeJson(folder.uri.fsPath, treeId);
    }
    await this.save();
  }

  progress(rootId?: string, treeId?: string): TreeProgress {
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
    if (rootId) {
      visit(rootId);
    } else if (treeId) {
      const tree = findTree(this.state.trees, treeId);
      if (tree) for (const r of tree.roots) visit(r);
    } else {
      for (const r of this.state.roots) visit(r);
    }
    return counts;
  }

  addTask(
    parentId: string | null,
    title: string,
    opts?: Partial<TaskNode> & { treeId?: string }
  ): TaskNode {
    if (!this.state) throw new Error("Project not initialized");
    const treeId = parentId
      ? findTreeIdForTask(this.state.trees, parentId) ?? this.ensureActiveTree()
      : opts?.treeId && findTree(this.state.trees, opts.treeId)
        ? opts.treeId
        : this.state.meta.activeTreeId && findTree(this.state.trees, this.state.meta.activeTreeId)
          ? this.state.meta.activeTreeId
          : this.ensureActiveTree();
    const tree = findTree(this.state.trees, treeId);
    if (!tree) throw new Error(`Tree ${treeId} not found`);

    const hasExisting = Object.keys(tree.tasks).length > 0;
    const task: TaskNode = {
      id: newId(),
      title: clampTaskTitle(title),
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
    tree.tasks[task.id] = task;
    if (parentId && tree.tasks[parentId]) {
      tree.tasks[parentId].children.push(task.id);
    } else {
      tree.roots.push(task.id);
    }
    tree.edges = edgesFromTasks(tree.tasks);
    tree.updatedAt = new Date().toISOString();
    this.rebuildFlat();
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
        | "changedFiles"
      >
    >
  ): TaskNode {
    if (!this.state) throw new Error("Project not initialized");
    const task = this.state.tasks[taskId];
    if (!task) throw new Error(`Task ${taskId} not found`);

    const prevStatus = task.status;
    const prevAssignee = task.assignee;

    if (patch.title !== undefined) {
      patch = { ...patch, title: clampTaskTitle(patch.title) };
    }
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

    this.syncTaskToTree(taskId);
    this.lastLocalMutationMs = Date.now();
    return task;
  }

  deleteTask(taskId: string, mode: "promote" | "cascade"): void {
    if (!this.state) throw new Error("Project not initialized");
    const treeId = findTreeIdForTask(this.state.trees, taskId);
    const tree = treeId ? findTree(this.state.trees, treeId) : undefined;
    const task = tree?.tasks[taskId] ?? this.state.tasks[taskId];
    if (!task) return;

    const parentId = this.findParent(taskId);
    const children = [...task.children];
    const tasks = tree?.tasks ?? this.state.tasks;
    const roots = tree ? tree.roots : this.state.roots;

    if (mode === "cascade") {
      const stack = [...children];
      while (stack.length) {
        const id = stack.pop()!;
        const t = tasks[id];
        if (!t) continue;
        stack.push(...t.children);
        delete tasks[id];
      }
    } else {
      if (parentId && tasks[parentId]) {
        const parent = tasks[parentId];
        const idx = parent.children.indexOf(taskId);
        if (idx >= 0) parent.children.splice(idx, 1, ...children);
      } else {
        const idx = roots.indexOf(taskId);
        if (idx >= 0) roots.splice(idx, 1, ...children);
      }
    }

    if (parentId && tasks[parentId] && mode === "cascade") {
      tasks[parentId].children = tasks[parentId].children.filter((id) => id !== taskId);
    } else if (!parentId && mode === "cascade") {
      if (tree) tree.roots = tree.roots.filter((id) => id !== taskId);
      else this.state.roots = this.state.roots.filter((id) => id !== taskId);
    } else if (mode === "promote") {
      if (parentId && tasks[parentId]) {
        tasks[parentId].children = tasks[parentId].children.filter((id) => id !== taskId);
      } else if (tree) {
        tree.roots = tree.roots.filter((id) => id !== taskId);
      } else {
        this.state.roots = this.state.roots.filter((id) => id !== taskId);
      }
    }

    for (const t of Object.values(tasks)) {
      t.dependsOn = t.dependsOn.filter((id) => id !== taskId && tasks[id]);
      t.children = t.children.filter((id) => tasks[id]);
    }
    delete tasks[taskId];

    if (tree) {
      tree.edges = edgesFromTasks(tree.tasks);
      tree.updatedAt = new Date().toISOString();
      this.rebuildFlat();
    } else {
      this.syncEdgesFromDepends();
    }
  }

  moveTask(taskId: string, newParentId: string | null, index?: number): void {
    if (!this.state) throw new Error("Project not initialized");
    if (!this.state.tasks[taskId]) return;
    if (newParentId === taskId) return;
    if (newParentId && this.isDescendant(taskId, newParentId)) {
      throw new Error("Cannot move a node into its own descendant");
    }

    const treeId =
      findTreeIdForTask(this.state.trees, taskId) ??
      (newParentId ? findTreeIdForTask(this.state.trees, newParentId) : undefined) ??
      this.ensureActiveTree();
    const tree = findTree(this.state.trees, treeId);
    if (!tree || !tree.tasks[taskId]) {
      // Fallback: mutate flat then sync
      const oldParent = this.findParent(taskId);
      if (oldParent) {
        const parent = this.state.tasks[oldParent];
        if (parent) {
          parent.children = parent.children.filter((id) => id !== taskId);
        }
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
      this.syncTreeStructureFromFlat(treeId);
      this.rebuildFlat();
      return;
    }

    const oldParent = Object.entries(tree.tasks).find(([, t]) => t.children.includes(taskId))?.[0];
    if (oldParent) {
      const parentNode = tree.tasks[oldParent];
      if (parentNode) {
        parentNode.children = parentNode.children.filter((id) => id !== taskId);
      }
    } else {
      tree.roots = tree.roots.filter((id) => id !== taskId);
    }

    if (newParentId && tree.tasks[newParentId]) {
      const list = tree.tasks[newParentId].children;
      if (index === undefined || index < 0 || index > list.length) list.push(taskId);
      else list.splice(index, 0, taskId);
    } else {
      if (index === undefined || index < 0 || index > tree.roots.length) {
        tree.roots.push(taskId);
      } else {
        tree.roots.splice(index, 0, taskId);
      }
    }
    tree.edges = edgesFromTasks(tree.tasks);
    tree.updatedAt = new Date().toISOString();
    this.rebuildFlat();
  }

  mergeImportTree(opts: {
    treeId: string;
    title: string;
    sourceFile?: string;
    roots: string[];
    tasks: Record<string, TaskNode>;
    planningDir?: string;
  }): void {
    if (!this.state) throw new Error("Project not initialized");
    if (!isSafeId(opts.treeId)) {
      throw new Error(`Unsafe tree id: ${opts.treeId}`);
    }
    const namespaced = namespaceTaskIds(opts.treeId, {
      roots: opts.roots,
      tasks: opts.tasks,
    });
    const existing = findTree(this.state.trees, opts.treeId);
    const merged = mergeTreePreserveProgress(existing, namespaced);
    const now = new Date().toISOString();
    const bundle: TreeBundle = {
      id: opts.treeId,
      title: opts.title,
      sourceFile: opts.sourceFile ?? existing?.sourceFile,
      roots: merged.roots,
      tasks: enrichAllTasks(merged.tasks),
      edges: edgesFromTasks(merged.tasks),
      updatedAt: now,
    };
    if (existing) {
      Object.assign(existing, bundle);
    } else {
      this.state.trees.push(bundle);
    }
    if (opts.planningDir) {
      const root = this.workspaceRoot;
      if (root) {
        const resolved = resolvePlanningDir(root, opts.planningDir);
        if (resolved) {
          this.state.meta.planningDir = path.relative(root, resolved) || ".";
        }
      }
    }
    if (!this.state.meta.activeTreeId) {
      this.state.meta.activeTreeId = opts.treeId;
    }
    this.rebuildFlat();
  }

  /** @deprecated Prefer mergeImportTree — merges into active/legacy tree. */
  replaceFromImport(data: {
    roots: string[];
    tasks: Record<string, TaskNode>;
    planningDir?: string;
  }): void {
    if (!this.state) throw new Error("Project not initialized");
    const treeId =
      (this.state.meta.activeTreeId && findTree(this.state.trees, this.state.meta.activeTreeId)
        ? this.state.meta.activeTreeId
        : undefined) ?? LEGACY_TREE_ID;
    this.mergeImportTree({
      treeId,
      title: this.state.meta.name || "Main",
      roots: data.roots,
      tasks: data.tasks,
      planningDir: data.planningDir,
    });
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
    for (const tree of this.state.trees) {
      for (const id of Object.keys(tree.tasks)) {
        if (this.state.tasks[id]) tree.tasks[id] = { ...this.state.tasks[id] };
      }
      tree.edges = edgesFromTasks(tree.tasks);
    }
  }

  applyBlockedStatuses(): void {
    if (!this.state) return;
    const touched = new Set<string>();
    for (const t of Object.values(this.state.tasks)) {
      if (t.status === "done" || t.status === "needs_rework" || t.status === "error") {
        continue;
      }
      const unmet = t.dependsOn.some((id) => {
        const d = this.state!.tasks[id];
        return d && d.status !== "done";
      });
      if (unmet) {
        if (t.status !== "blocked") {
          t.status = "blocked";
          touched.add(t.id);
        }
      } else if (t.status === "blocked") {
        t.status = "todo";
        touched.add(t.id);
      }
    }
    for (const id of touched) this.syncTaskToTree(id);
  }

  upsertTasks(nodes: TaskNode[], parentId: string | null = null): void {
    if (!this.state) throw new Error("Project not initialized");
    const treeId = parentId
      ? findTreeIdForTask(this.state.trees, parentId) ?? this.ensureActiveTree()
      : this.state.meta.activeTreeId && findTree(this.state.trees, this.state.meta.activeTreeId)
        ? this.state.meta.activeTreeId
        : this.ensureActiveTree();
    const tree = findTree(this.state.trees, treeId);
    if (!tree) throw new Error(`Tree ${treeId} not found`);

    for (const node of nodes) {
      const existing = tree.tasks[node.id] ?? this.state.tasks[node.id];
      const exists = Boolean(existing);
      let status = node.status ?? (existing ? existing.status : "new");
      if (!exists && (!node.status || node.status === "todo")) {
        status = "new";
      }
      tree.tasks[node.id] = {
        ...node,
        status,
        children: node.children ?? [],
        dependsOn: node.dependsOn ?? [],
      };
      if (parentId && tree.tasks[parentId]) {
        if (!tree.tasks[parentId].children.includes(node.id)) {
          tree.tasks[parentId].children.push(node.id);
        }
      } else if (!tree.roots.includes(node.id)) {
        const referenced = Object.values(tree.tasks).some((t) => t.children.includes(node.id));
        if (!referenced) tree.roots.push(node.id);
      }
    }
    tree.edges = edgesFromTasks(tree.tasks);
    tree.updatedAt = new Date().toISOString();
    this.rebuildFlat();
  }

  getTask(taskId: string): TaskNode | undefined {
    return this.state?.tasks[taskId];
  }

  setStatus(
    taskId: string,
    status: TaskStatus,
    opts?: { changedFiles?: TaskNode["changedFiles"] }
  ): void {
    const patch: Parameters<ProjectStore["updateTask"]>[1] = { status };
    if (opts?.changedFiles) {
      patch.changedFiles = opts.changedFiles;
    }
    this.updateTask(taskId, patch);
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
