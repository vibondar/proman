import * as vscode from "vscode";
import { ProjectStore } from "./core/store";
import { DependencyEngine } from "./core/dependencyEngine";
import { AgentHandoff } from "./agent/handoff";
import { MdImporter } from "./core/planDiscoverer";
import { PromanMcpServer } from "./mcp/promanMcp";
import { runOnboarding } from "./onboarding";
import { PromanTreeItem, PromanTreeProvider, PromanDecorationProvider, PromanNode, PromanSectionItem } from "./tree/promanTree";
import { runTreeSearch } from "./tree/treeSearch";
import { TaskDetailPanel } from "./taskDetailPanel";
import { startDriveMode, startProposalWatcher } from "./driveUi";
import { startTreeFileWatcher } from "./treeFileWatcher";
import { TaskStatus } from "./core/types";
import { getMetaCurrentUser } from "./core/projectMeta";
import {
  configureGitSync,
  enableGitSync,
  runGitPull,
  runGitPush,
} from "./gitSyncUi";
import {
  configureGithubIssues,
  createIssueForTask,
  enableGithubIssues,
  syncClosedGithubIssues,
} from "./githubSync";
import { t } from "./i18n";
import { exportTreeToMarkdown, suggestedExportBasename } from "./core/mdExport";

let planningWatcher: vscode.FileSystemWatcher | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel("Proman");
  context.subscriptions.push(output);
  output.appendLine("Proman 0.3.13 activating…");

  const store = new ProjectStore(context);
  store.setLogger((msg) => output.appendLine(msg));
  store.setAssignmentListener((e) => {
    const fromOther = e.actor !== "unknown" && e.actor !== e.assignee;
    const text = fromOther
      ? t("📬 Task “{0}” was assigned to you by @{1}", e.title, e.actor)
      : t("📬 Task “{0}” was assigned to you", e.title);
    void vscode.window.showInformationMessage(text);
  });
  await store.waitForWorkspace();
  output.appendLine(`workspace: ${store.workspaceRoot ?? "(none)"}`);

  const deps = new DependencyEngine();
  const handoff = new AgentHandoff(store, deps);
  const importer = new MdImporter(store);
  const mcp = new PromanMcpServer(store, deps);
  const tree = new PromanTreeProvider(store);
  const decorations = new PromanDecorationProvider();

  const treeView = vscode.window.createTreeView("proman.tree", {
    treeDataProvider: tree,
    showCollapseAll: true,
  });
  context.subscriptions.push(treeView);
  context.subscriptions.push(
    vscode.window.registerFileDecorationProvider(decorations)
  );

  const refreshUi = () => {
    tree.refresh();
    decorations.refresh();
    const state = store.current;
    const n = state ? Object.keys(state.tasks).length : 0;
    const p = store.progress();
    const filter = tree.getFilterQuery();
    const myOnly = tree.isMyTasksOnly();
    const pathHl = tree.hasPathHighlight();
    void vscode.commands.executeCommand("setContext", "proman.treeFiltered", Boolean(filter));
    void vscode.commands.executeCommand("setContext", "proman.pathHighlighted", pathHl);
    void vscode.commands.executeCommand("setContext", "proman.myTasksOnly", myOnly);
    const bits: string[] = [];
    if (myOnly) {
      const me = getMetaCurrentUser(state?.meta);
      bits.push(
        t(
          "👤 Mine ({0}) · {1} tasks",
          me ? "@" + me : "(user?)",
          tree.getMatchCount()
        )
      );
    }
    if (filter) {
      bits.push(t("filter “{0}” · {1} matches", filter, tree.getMatchCount()));
    }
    if (pathHl && !filter && !myOnly) bits.push(t("path highlighted"));
    if (state && n > 0) {
      bits.push(
        t(
          "{0}/{1} done · {2} in progress · {3} blocked",
          p.done,
          p.total,
          p.inProgress,
          p.blocked
        )
      );
    }
    treeView.message = bits.length ? bits.join(" · ") : undefined;
  };

  store.onDidChange(() => refreshUi());

  const openDetails = (taskId: string) => {
    tree.setSelectedId(taskId);
    TaskDetailPanel.show(context, store, deps, handoff, taskId, refreshUi);
  };

  const importPlanning = async () => {
    const uris = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: true,
      canSelectMany: true,
      filters: { Markdown: ["md"] },
      openLabel: t("Import into Proman"),
    });
    if (!uris?.length) return;
    let count = 0;
    const files: vscode.Uri[] = [];
    let planningDir: string | undefined;
    for (const u of uris) {
      try {
        const st = await vscode.workspace.fs.stat(u);
        if (st.type & vscode.FileType.Directory) {
          count += await importer.importDirectory(u);
          planningDir = vscode.workspace.asRelativePath(u);
        } else {
          files.push(u);
        }
      } catch {
        files.push(u);
      }
    }
    if (files.length) count += await importer.importUris(files, planningDir);
    refreshUi();
    vscode.window.showInformationMessage(t("Proman: imported nodes: {0}", count));
    setupPlanningWatcher(store, importer, refreshUi);
  };

  const setPlanningDir = async () => {
    await store.ensureInitialized();
    const uris = await vscode.window.showOpenDialog({
      canSelectFolders: true,
      canSelectFiles: false,
      canSelectMany: false,
      openLabel: t("Planning folder"),
    });
    if (!uris?.[0]) return;
    store.setPlanningDir(vscode.workspace.asRelativePath(uris[0]));
    await store.save();
    setupPlanningWatcher(store, importer, refreshUi);
    vscode.window.showInformationMessage(
      t("Proman: planningDir = {0}", String(store.current?.meta.planningDir))
    );
  };

  const taskIdFromArg = (arg?: PromanNode | PromanTreeItem | string): string | undefined => {
    if (!arg) return tree.getSelectedId() ?? undefined;
    if (typeof arg === "string") return arg;
    if (arg instanceof PromanSectionItem || (arg as PromanNode).kind === "section") {
      return undefined;
    }
    return (arg as PromanTreeItem).task?.id;
  };

  mcp.registerWithCursor(context);

  context.subscriptions.push(
    startProposalWatcher(
      () => store.workspaceRoot,
      async () => {
        await store.load();
        refreshUi();
      }
    )
  );

  context.subscriptions.push(
    treeView.onDidChangeSelection((e) => {
      const item = e.selection[0];
      if (item && item.kind === "task") openDetails(item.task.id);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("proman.open", () =>
      vscode.commands.executeCommand("proman.tree.focus")
    ),
    vscode.commands.registerCommand("proman.importPlanningDocs", () => importPlanning()),
    vscode.commands.registerCommand("proman.setPlanningDirectory", () => setPlanningDir()),
    vscode.commands.registerCommand("proman.enrichTreeFromMd", () => handoff.enrichFromMd()),
    vscode.commands.registerCommand("proman.driveTree", () => startDriveMode(mcp)),
    vscode.commands.registerCommand("proman.stopDrive", () => {
      mcp.getDrive().stop();
      vscode.window.showInformationMessage(t("Proman Drive Mode stopped"));
    }),
    vscode.commands.registerCommand("proman.selectTask", (id: string) => openDetails(id)),
    vscode.commands.registerCommand("proman.openTaskDetails", (item?: PromanTreeItem) => {
      const id = taskIdFromArg(item);
      if (!id) {
        vscode.window.showWarningMessage(t("Select a task in the tree"));
        return;
      }
      openDetails(id);
    }),
    vscode.commands.registerCommand("proman.reloadTree", async () => {
      const loaded = await store.load();
      refreshUi();
      const n = loaded ? Object.keys(loaded.tasks).length : 0;
      output.appendLine(`reloadTree: ${n} tasks`);
      vscode.window.showInformationMessage(
        n > 0
          ? t("Proman: loaded {0} tasks", n)
          : t("Proman: nothing on disk — import MD")
      );
    }),
    vscode.commands.registerCommand("proman.searchTree", () =>
      runTreeSearch(store, tree, treeView, openDetails, refreshUi)
    ),
    vscode.commands.registerCommand("proman.clearTreeSearch", async () => {
      tree.clearFilter();
      tree.clearPathHighlight();
      await vscode.commands.executeCommand("setContext", "proman.treeFiltered", false);
      await vscode.commands.executeCommand("setContext", "proman.myTasksOnly", false);
      refreshUi();
    }),
    vscode.commands.registerCommand("proman.toggleMyTasks", async () => {
      if (!store.current) {
        await store.ensureInitialized();
      }
      if (!tree.isMyTasksOnly() && !store.hasCurrentUser()) {
        const name = await vscode.window.showInputBox({
          prompt: t("Who are you in this project? (team.currentUser in project.json)"),
          placeHolder: "alice",
          value: getMetaCurrentUser(store.current?.meta) ?? "",
        });
        if (!name?.trim()) {
          void vscode.window.showWarningMessage(
            t("Proman: set a user to filter “My tasks”")
          );
          return;
        }
        store.setCurrentUser(name);
        await store.save();
      }
      const on = tree.toggleMyTasksOnly();
      refreshUi();
      void vscode.window.showInformationMessage(
        on ? t("👤 Showing only your tasks") : t("Showing all tasks")
      );
    }),
    vscode.commands.registerCommand("proman.setCurrentUser", async () => {
      if (!store.current) await store.ensureInitialized();
      const members = store.listAssignees();
      const enterManual = t("Enter manually…");
      const picked = await vscode.window.showQuickPick(
        [
          ...members.map((u) => ({
            label: `@${u}`,
            description: store.current?.meta.team?.members.find((m) => m.username === u)?.name,
            value: u,
          })),
          { label: enterManual, value: "__custom__" },
        ],
        {
          title: t("Current user (team.currentUser)"),
          placeHolder: getMetaCurrentUser(store.current?.meta) ?? "alice",
        }
      );
      if (!picked) return;
      let name = picked.value;
      if (name === "__custom__") {
        const typed = await vscode.window.showInputBox({
          prompt: "username",
          placeHolder: "alice",
          value: getMetaCurrentUser(store.current?.meta) ?? "",
        });
        if (typed === undefined) return;
        name = typed;
      }
      store.setCurrentUser(name);
      await store.save();
      refreshUi();
      void vscode.window.showInformationMessage(
        name.trim()
          ? t(
              "Proman: signed in as @{0}",
              name.trim().replace(/^@+/, "")
            )
          : t("Proman: current user cleared")
      );
    }),
    vscode.commands.registerCommand("proman.gitPull", () => runGitPull(store, refreshUi)),
    vscode.commands.registerCommand("proman.gitPush", () => runGitPush(store)),
    vscode.commands.registerCommand("proman.enableGitSync", () =>
      enableGitSync(store).catch((e) =>
        vscode.window.showErrorMessage(
          t("Proman: {0}", e instanceof Error ? e.message : String(e))
        )
      )
    ),
    vscode.commands.registerCommand("proman.configureGitSync", () =>
      configureGitSync(store).catch((e) =>
        vscode.window.showErrorMessage(
          t("Proman: {0}", e instanceof Error ? e.message : String(e))
        )
      )
    ),
    vscode.commands.registerCommand("proman.enableGithubIssues", () =>
      enableGithubIssues(store).catch((e) =>
        vscode.window.showErrorMessage(
          t("Proman: {0}", e instanceof Error ? e.message : String(e))
        )
      )
    ),
    vscode.commands.registerCommand("proman.configureGithubIssues", () =>
      configureGithubIssues(store).catch((e) =>
        vscode.window.showErrorMessage(
          t("Proman: {0}", e instanceof Error ? e.message : String(e))
        )
      )
    ),
    vscode.commands.registerCommand("proman.syncGithubIssues", async () => {
      const n = await syncClosedGithubIssues(store, { interactive: true });
      refreshUi();
      if (n === 0) {
        void vscode.window.showInformationMessage(
          t("Proman: no tasks to update from closed Issues")
        );
      }
    }),
    vscode.commands.registerCommand("proman.assignTask", async (item?: PromanTreeItem) => {
      const id = taskIdFromArg(item) ?? tree.getSelectedId();
      if (!id || !store.current?.tasks[id]) return;
      if (!store.hasCurrentUser()) {
        const name = await vscode.window.showInputBox({
          prompt: t("First say who you are (currentUser)"),
          placeHolder: "alice",
        });
        if (!name?.trim()) return;
        store.setCurrentUser(name);
      }
      const known = store.listAssignees();
      const assignMe = t("Assign to me (@{0})", store.currentUser());
      const enterManual = t("Enter manually…");
      const clearAssignee = t("Clear assignment");
      const picked = await vscode.window.showQuickPick(
        [
          { label: assignMe, value: store.currentUser() },
          ...known
            .filter((a) => a !== store.currentUser())
            .map((a) => ({ label: `@${a}`, value: a })),
          { label: enterManual, value: "__custom__" },
          { label: clearAssignee, value: "__clear__" },
        ],
        { title: t("Assign: {0}", store.current.tasks[id].title) }
      );
      if (!picked) return;
      let assignee: string | undefined;
      if (picked.value === "__clear__") assignee = undefined;
      else if (picked.value === "__custom__") {
        const typed = await vscode.window.showInputBox({
          prompt: t("Assignee"),
          placeHolder: "bob",
        });
        if (typed === undefined) return;
        assignee = typed.trim().replace(/^@+/, "") || undefined;
      } else assignee = picked.value;
      store.updateTask(id, { assignee });
      await store.save();
      refreshUi();
    }),
    vscode.commands.registerCommand("proman.addRootTask", async (item?: PromanNode) => {
      await store.ensureInitialized();
      const section = item?.kind === "section" ? item : undefined;
      if (section) {
        try {
          store.setActiveTree(section.treeId);
        } catch {
          /* ignore */
        }
      }
      const title = await vscode.window.showInputBox({
        prompt: t("Root task title"),
        placeHolder: t("e.g. Auth refactor"),
      });
      if (!title) return;
      const task = store.addTask(
        null,
        title,
        section ? { treeId: section.treeId } : undefined
      );
      await store.save();
      await createIssueForTask(store, task.id);
      refreshUi();
      openDetails(task.id);
    }),
    vscode.commands.registerCommand("proman.addChildTask", async (item?: PromanTreeItem) => {
      const parentId = taskIdFromArg(item);
      if (!parentId) {
        vscode.window.showWarningMessage(t("Select a task"));
        return;
      }
      const title = await vscode.window.showInputBox({ prompt: t("Subtask title") });
      if (!title) return;
      const task = store.addTask(parentId, title);
      await store.save();
      await createIssueForTask(store, task.id);
      refreshUi();
      openDetails(task.id);
    }),
    vscode.commands.registerCommand("proman.deleteTask", async (item?: PromanTreeItem) => {
      const id = taskIdFromArg(item);
      if (!id) return;
      const mode = await vscode.window.showQuickPick(
        [
          { label: t("Promote children to parent"), mode: "promote" as const },
          { label: t("Delete with children"), mode: "cascade" as const },
        ],
        { title: t("Delete task") }
      );
      if (!mode) return;
      if (!store.current) return;
      const impact = deps.preview(store.current, {
        kind: "delete",
        taskId: id,
        mode: mode.mode,
      });
      if (impact.affected.length) {
        const deleteBtn = t("Delete");
        const ok = await vscode.window.showWarningMessage(
          t("Will affect {0} nodes. Continue?", impact.affected.length),
          deleteBtn
        );
        if (ok !== deleteBtn) return;
      }
      store.deleteTask(id, mode.mode);
      store.applyBlockedStatuses();
      await store.save();
      tree.setSelectedId(null);
      refreshUi();
    }),
    vscode.commands.registerCommand("proman.deleteTree", async (item?: PromanNode) => {
      const section =
        item instanceof PromanSectionItem || item?.kind === "section"
          ? (item as PromanSectionItem)
          : undefined;
      if (!section) {
        vscode.window.showWarningMessage(t("Select a task tree section"));
        return;
      }
      if (!store.current) return;
      const bundle = store.getTree(section.treeId);
      if (!bundle) {
        vscode.window.showWarningMessage(t("Tree not found"));
        return;
      }
      const deleteBtn = t("Delete tree");
      const ok = await vscode.window.showWarningMessage(
        t(
          "Delete task tree “{0}”? All progress marked in this tree will not be saved.",
          bundle.title || bundle.id
        ),
        { modal: true },
        deleteBtn
      );
      if (ok !== deleteBtn) return;
      try {
        await store.deleteTree(section.treeId);
        tree.setSelectedId(null);
        refreshUi();
        vscode.window.showInformationMessage(
          t("Proman: deleted tree “{0}”", bundle.title || bundle.id)
        );
      } catch (e) {
        vscode.window.showErrorMessage(
          t("Proman: {0}", e instanceof Error ? e.message : String(e))
        );
      }
    }),
    vscode.commands.registerCommand("proman.exportTreeMd", async (item?: PromanNode) => {
      const section =
        item instanceof PromanSectionItem || item?.kind === "section"
          ? (item as PromanSectionItem)
          : undefined;
      if (!section) {
        vscode.window.showWarningMessage(t("Select a task tree section"));
        return;
      }
      if (!store.current) return;
      const bundle = store.getTree(section.treeId);
      if (!bundle) {
        vscode.window.showWarningMessage(t("Tree not found"));
        return;
      }
      const md = exportTreeToMarkdown(bundle);
      const folder = vscode.workspace.workspaceFolders?.[0];
      const defaultUri = folder
        ? vscode.Uri.joinPath(folder.uri, suggestedExportBasename(bundle))
        : vscode.Uri.file(suggestedExportBasename(bundle));
      const uri = await vscode.window.showSaveDialog({
        defaultUri,
        filters: { Markdown: ["md"] },
        saveLabel: t("Export"),
        title: t("Export tree to Markdown"),
      });
      if (!uri) return;
      await vscode.workspace.fs.writeFile(uri, Buffer.from(md, "utf8"));
      vscode.window.showInformationMessage(
        t("Proman: exported “{0}” with current progress", bundle.title || bundle.id)
      );
      await vscode.window.showTextDocument(uri);
    }),
    vscode.commands.registerCommand("proman.setStatusTodo", (item?: PromanTreeItem) =>
      setStatus(store, taskIdFromArg(item), "todo", refreshUi)
    ),
    vscode.commands.registerCommand("proman.setStatusInProgress", (item?: PromanTreeItem) =>
      setStatus(store, taskIdFromArg(item), "in_progress", refreshUi)
    ),
    vscode.commands.registerCommand("proman.setStatusDone", (item?: PromanTreeItem) =>
      setStatus(store, taskIdFromArg(item), "done", refreshUi)
    ),
    vscode.commands.registerCommand("proman.setStatusNeedsRework", (item?: PromanTreeItem) =>
      setStatus(store, taskIdFromArg(item), "needs_rework", refreshUi)
    ),
    vscode.commands.registerCommand("proman.setStatusError", (item?: PromanTreeItem) =>
      setStatus(store, taskIdFromArg(item), "error", refreshUi)
    ),
    vscode.commands.registerCommand("proman.setStatusNew", (item?: PromanTreeItem) =>
      setStatus(store, taskIdFromArg(item), "new", refreshUi)
    ),
    vscode.commands.registerCommand("proman.recalculateDependencies", async () => {
      if (!store.current) await store.ensureInitialized();
      const cycles = deps.detectCycles(store.current!);
      store.applyBlockedStatuses();
      await store.save();
      refreshUi();
      if (cycles.length) {
        vscode.window.showErrorMessage(
          t("Proman: cycles: {0}", cycles.map((c) => c.join("→")).join("; "))
        );
      } else {
        vscode.window.showInformationMessage(t("Proman: dependencies recalculated"));
      }
    }),
    vscode.commands.registerCommand("proman.runTaskInAgent", async (item?: PromanTreeItem) => {
      const id = taskIdFromArg(item);
      if (!id) {
        vscode.window.showWarningMessage(t("Select a task"));
        return;
      }
      await handoff.runTask(id);
      refreshUi();
    }),
    vscode.commands.registerCommand("proman.copyAgentPrompt", async (item?: PromanTreeItem) => {
      const id = taskIdFromArg(item);
      if (!id) {
        vscode.window.showWarningMessage(t("Select a task"));
        return;
      }
      await handoff.copyPrompt(id);
    })
  );

  await runOnboarding(store, importer);
  const loaded = await store.load();
  output.appendLine(
    loaded
      ? `ready: ${loaded.roots.length} roots, ${Object.keys(loaded.tasks).length} tasks`
      : "ready: no project on disk"
  );
  refreshUi();
  setupPlanningWatcher(store, importer, refreshUi);
  const treeWatcher = startTreeFileWatcher(store, refreshUi);
  store.onBeforeWriteDisk = () => treeWatcher.markSelfWrite();
  context.subscriptions.push(treeWatcher);

  // Background: closed GitHub Issues → done (no login popup)
  void syncClosedGithubIssues(store, { interactive: false }).then((n) => {
    if (n > 0) refreshUi();
  });

  // Periodic soft sync every 5 min
  const ghTimer = setInterval(() => {
    void syncClosedGithubIssues(store, { interactive: false }).then((n) => {
      if (n > 0) refreshUi();
    });
  }, 5 * 60_000);
  context.subscriptions.push({ dispose: () => clearInterval(ghTimer) });

  context.subscriptions.push({
    dispose: () => planningWatcher?.dispose(),
  });
}

async function setStatus(
  store: ProjectStore,
  id: string | undefined,
  status: TaskStatus,
  refreshUi: () => void
): Promise<void> {
  if (!id) return;
  store.setStatus(id, status);
  await store.save();
  refreshUi();
}

function setupPlanningWatcher(
  store: ProjectStore,
  importer: MdImporter,
  refreshUi: () => void
): void {
  planningWatcher?.dispose();
  planningWatcher = undefined;
  const dir = store.current?.meta.planningDir;
  const root = store.workspaceRoot;
  if (!dir || !root) return;

  const pattern = new vscode.RelativePattern(
    vscode.Uri.file(dir.startsWith("/") ? dir : `${root}/${dir}`),
    "**/*.md"
  );
  planningWatcher = vscode.workspace.createFileSystemWatcher(pattern);

  let timer: NodeJS.Timeout | undefined;
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(async () => {
      const syncBtn = t("Sync");
      const laterBtn = t("Later");
      const choice = await vscode.window.showInformationMessage(
        t("Proman: planning files changed. Sync the tree?"),
        syncBtn,
        laterBtn
      );
      if (choice !== syncBtn) return;
      const folder = vscode.Uri.file(dir.startsWith("/") ? dir : `${root}/${dir}`);
      const count = await importer.importDirectory(folder);
      refreshUi();
      vscode.window.showInformationMessage(t("Proman: synced, nodes: {0}", count));
    }, 800);
  };

  planningWatcher.onDidChange(schedule);
  planningWatcher.onDidCreate(schedule);
  planningWatcher.onDidDelete(schedule);
}

export function deactivate(): void {
  planningWatcher?.dispose();
}
