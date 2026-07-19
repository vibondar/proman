import * as vscode from "vscode";
import { AgentHandoff } from "./agent/handoff";
import { DependencyEngine } from "./core/dependencyEngine";
import { exportTreeToMarkdown, suggestedExportBasename } from "./core/mdExport";
import { getMetaCurrentUser } from "./core/projectMeta";
import { ProjectStore } from "./core/store";
import { TaskStatus } from "./core/types";
import { startDriveMode } from "./driveUi";
import {
  configureGithubIssues,
  createIssueForTask,
  enableGithubIssues,
  syncClosedGithubIssues,
} from "./githubSync";
import {
  configureGitSync,
  enableGitSync,
  notifyPromanLoadProblems,
  resolvePromanMerge,
  runGitPull,
  runGitPush,
} from "./gitSyncUi";
import { t } from "./i18n";
import { PromanMcpServer } from "./mcp/promanMcp";
import {
  PromanNode,
  PromanTreeItem,
  PromanTreeProvider,
} from "./tree/promanTree";
import { runTreeSearch } from "./tree/treeSearch";
import { resolveDriveTreeId, resolveTaskId } from "./tree/utils";

export interface RegisterCommandsDeps {
  context: vscode.ExtensionContext;
  store: ProjectStore;
  deps: DependencyEngine;
  handoff: AgentHandoff;
  mcp: PromanMcpServer;
  tree: PromanTreeProvider;
  treeView: vscode.TreeView<PromanNode>;
  output: vscode.OutputChannel;
  refreshUi: () => void;
  openDetails: (taskId: string) => void;
  importPlanning: () => Promise<void>;
  setPlanningDir: () => Promise<void>;
}

export function registerAllCommands(d: RegisterCommandsDeps): void {
  const taskId = (arg?: PromanNode | PromanTreeItem | string) =>
    resolveTaskId(arg, () => d.tree.getSelectedId());

  registerWorkspaceCommands(d);
  registerTreeViewCommands(d, taskId);
  registerUserCommands(d);
  registerGitAndGithubCommands(d);
  registerTaskMutationCommands(d, taskId);
  registerStatusCommands(d, taskId);
  registerAgentCommands(d, taskId);
}

function registerWorkspaceCommands(d: RegisterCommandsDeps): void {
  const { context, store, handoff, mcp, treeView, refreshUi, output } = d;
  context.subscriptions.push(
    vscode.commands.registerCommand("proman.open", () =>
      vscode.commands.executeCommand("proman.tree.focus")
    ),
    vscode.commands.registerCommand("proman.importPlanningDocs", () => d.importPlanning()),
    vscode.commands.registerCommand("proman.setPlanningDirectory", () => d.setPlanningDir()),
    vscode.commands.registerCommand("proman.enrichTreeFromMd", () => handoff.enrichFromMd()),
    vscode.commands.registerCommand("proman.driveTree", async (item?: PromanNode) => {
      // Scope = tree section header (not the first epic/task node inside it).
      const treeId = resolveDriveTreeId(
        item,
        treeView.selection[0],
        store.current?.meta.activeTreeId
      );
      const trees = store.current?.trees ?? [];
      if (!treeId && trees.length > 1) {
        vscode.window.showWarningMessage(
          t("Select a task tree section header, then start Drive")
        );
        return;
      }
      const resolved = treeId ?? trees[0]?.id;
      const title = resolved ? store.getTree(resolved)?.title : undefined;
      await startDriveMode(mcp, resolved, title);
    }),
    vscode.commands.registerCommand("proman.stopDrive", () => {
      mcp.getDrive().stop();
      vscode.window.showInformationMessage(t("Proman Drive Mode stopped"));
    }),
    vscode.commands.registerCommand("proman.selectTask", (id: string) => d.openDetails(id)),
    vscode.commands.registerCommand("proman.reloadTree", async () => {
      const loaded = await store.load();
      refreshUi();
      const n = loaded ? Object.keys(loaded.tasks).length : 0;
      output.appendLine(`reloadTree: ${n} tasks`);
      const hadProblems = await notifyPromanLoadProblems(store, refreshUi);
      if (!hadProblems) {
        vscode.window.showInformationMessage(
          n > 0
            ? t("Proman: loaded {0} tasks", n)
            : t("Proman: nothing on disk — import MD")
        );
      }
    }),
    vscode.commands.registerCommand("proman.recalculateDependencies", async () => {
      if (!store.current) await store.ensureInitialized();
      const cycles = d.deps.detectCycles(store.current!);
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
    })
  );
}

function registerTreeViewCommands(
  d: RegisterCommandsDeps,
  taskId: (arg?: PromanNode | PromanTreeItem | string) => string | undefined
): void {
  const { context, store, tree, treeView, refreshUi, openDetails } = d;
  context.subscriptions.push(
    vscode.commands.registerCommand("proman.openTaskDetails", (item?: PromanTreeItem) => {
      const id = taskId(item);
      if (!id) {
        vscode.window.showWarningMessage(t("Select a task in the tree"));
        return;
      }
      openDetails(id);
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
    })
  );
}

function registerUserCommands(d: RegisterCommandsDeps): void {
  const { context, store, refreshUi } = d;
  context.subscriptions.push(
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
          ? t("Proman: signed in as @{0}", name.trim().replace(/^@+/, ""))
          : t("Proman: current user cleared")
      );
    })
  );
}

function registerGitAndGithubCommands(d: RegisterCommandsDeps): void {
  const { context, store, refreshUi } = d;
  const showErr = (e: unknown) =>
    vscode.window.showErrorMessage(
      t("Proman: {0}", e instanceof Error ? e.message : String(e))
    );

  context.subscriptions.push(
    vscode.commands.registerCommand("proman.gitPull", () => runGitPull(store, refreshUi)),
    vscode.commands.registerCommand("proman.gitPush", () => runGitPush(store)),
    vscode.commands.registerCommand("proman.resolveMerge", () =>
      resolvePromanMerge(store, refreshUi)
    ),
    vscode.commands.registerCommand("proman.enableGitSync", () =>
      enableGitSync(store).catch(showErr)
    ),
    vscode.commands.registerCommand("proman.configureGitSync", () =>
      configureGitSync(store).catch(showErr)
    ),
    vscode.commands.registerCommand("proman.enableGithubIssues", () =>
      enableGithubIssues(store).catch(showErr)
    ),
    vscode.commands.registerCommand("proman.configureGithubIssues", () =>
      configureGithubIssues(store).catch(showErr)
    ),
    vscode.commands.registerCommand("proman.syncGithubIssues", async () => {
      const n = await syncClosedGithubIssues(store, { interactive: true });
      refreshUi();
      if (n === 0) {
        void vscode.window.showInformationMessage(
          t("Proman: no tasks to update from closed Issues")
        );
      }
    })
  );
}

function registerTaskMutationCommands(
  d: RegisterCommandsDeps,
  taskId: (arg?: PromanNode | PromanTreeItem | string) => string | undefined
): void {
  const { context, store, deps, tree, refreshUi, openDetails } = d;

  context.subscriptions.push(
    vscode.commands.registerCommand("proman.assignTask", async (item?: PromanTreeItem) => {
      const id = taskId(item) ?? tree.getSelectedId();
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
      const parentId = taskId(item);
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
      const id = taskId(item);
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
      const section = item?.kind === "section" ? item : undefined;
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
      const section = item?.kind === "section" ? item : undefined;
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
    })
  );
}

function registerStatusCommands(
  d: RegisterCommandsDeps,
  taskId: (arg?: PromanNode | PromanTreeItem | string) => string | undefined
): void {
  const { context, store, refreshUi } = d;
  const set = (status: TaskStatus) => (item?: PromanTreeItem) =>
    setStatus(store, taskId(item), status, refreshUi);

  context.subscriptions.push(
    vscode.commands.registerCommand("proman.setStatusTodo", set("todo")),
    vscode.commands.registerCommand("proman.setStatusInProgress", set("in_progress")),
    vscode.commands.registerCommand("proman.setStatusDone", set("done")),
    vscode.commands.registerCommand("proman.setStatusNeedsRework", set("needs_rework")),
    vscode.commands.registerCommand("proman.setStatusError", set("error")),
    vscode.commands.registerCommand("proman.setStatusNew", set("new"))
  );
}

function registerAgentCommands(
  d: RegisterCommandsDeps,
  taskId: (arg?: PromanNode | PromanTreeItem | string) => string | undefined
): void {
  const { context, handoff, refreshUi } = d;
  context.subscriptions.push(
    vscode.commands.registerCommand("proman.runTaskInAgent", async (item?: PromanTreeItem) => {
      const id = taskId(item);
      if (!id) {
        vscode.window.showWarningMessage(t("Select a task"));
        return;
      }
      await handoff.runTask(id);
      refreshUi();
    }),
    vscode.commands.registerCommand("proman.copyAgentPrompt", async (item?: PromanTreeItem) => {
      const id = taskId(item);
      if (!id) {
        vscode.window.showWarningMessage(t("Select a task"));
        return;
      }
      await handoff.copyPrompt(id);
    })
  );
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
