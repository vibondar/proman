import * as vscode from "vscode";
import { ProjectStore } from "./core/store";
import { findTreeIdForTask } from "./core/forest";
import { DependencyEngine } from "./core/dependencyEngine";
import { AgentHandoff } from "./agent/handoff";
import { MdImporter } from "./core/planDiscoverer";
import { PromanMcpServer } from "./mcp/promanMcp";
import { runOnboarding } from "./onboarding";
import { PromanTreeProvider, PromanDecorationProvider } from "./tree/promanTree";
import { TaskDetailPanel } from "./taskDetailPanel";
import { startProposalWatcher } from "./driveUi";
import { startTreeFileWatcher } from "./treeFileWatcher";
import { getMetaCurrentUser } from "./core/projectMeta";
import { syncClosedGithubIssues } from "./githubSync";
import { notifyPromanLoadProblems } from "./gitSyncUi";
import { t } from "./i18n";
import { registerAllCommands } from "./registerCommands";

let planningWatcher: vscode.FileSystemWatcher | undefined;

/** Soft poll: closed GitHub Issues → task done. */
const GITHUB_SYNC_INTERVAL_MS = 5 * 60 * 1000;
/** Debounce before prompting to re-import planning/*.md changes. */
const PLANNING_WATCHER_DEBOUNCE_MS = 800;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel("Proman");
  context.subscriptions.push(output);
  output.appendLine("Proman 0.3.19 activating…");

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
    // Last selected directory wins as planningDir (directory import also sets it).
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
      if (!item) return;
      const treeId =
        item.kind === "section"
          ? item.treeId
          : item.treeId ??
            (store.current
              ? findTreeIdForTask(store.current.trees, item.task.id)
              : undefined);
      if (treeId && store.current?.meta.activeTreeId !== treeId) {
        try {
          store.setActiveTree(treeId);
        } catch {
          /* ignore */
        }
      }
      if (item.kind === "task") openDetails(item.task.id);
    })
  );

  registerAllCommands({
    context,
    store,
    deps,
    handoff,
    mcp,
    tree,
    treeView,
    output,
    refreshUi,
    openDetails,
    importPlanning,
    setPlanningDir,
  });

  await runOnboarding(store, importer);
  const loaded = await store.load();
  output.appendLine(
    loaded
      ? `ready: ${loaded.roots.length} roots, ${Object.keys(loaded.tasks).length} tasks`
      : "ready: no project on disk"
  );
  if (store.lastLoadProblems.length) {
    output.appendLine(
      `load problems: ${store.lastLoadProblems.map((p) => `${p.kind}:${p.path}`).join(", ")}`
    );
  }
  refreshUi();
  void notifyPromanLoadProblems(store, refreshUi);
  setupPlanningWatcher(store, importer, refreshUi);
  const treeWatcher = startTreeFileWatcher(store, refreshUi);
  store.onBeforeWriteDisk = () => treeWatcher.markSelfWrite();
  context.subscriptions.push(treeWatcher);

  const runGithubSoftSync = async (): Promise<void> => {
    try {
      const n = await syncClosedGithubIssues(store, { interactive: false });
      if (n > 0) refreshUi();
    } catch (err) {
      output.appendLine(
        `GitHub sync failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  };

  // Background: closed GitHub Issues → done (no login popup)
  void runGithubSoftSync();

  const ghTimer = setInterval(() => {
    void runGithubSoftSync();
  }, GITHUB_SYNC_INTERVAL_MS);
  context.subscriptions.push({ dispose: () => clearInterval(ghTimer) });

  context.subscriptions.push({
    dispose: () => planningWatcher?.dispose(),
  });
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
    }, PLANNING_WATCHER_DEBOUNCE_MS);
  };

  planningWatcher.onDidChange(schedule);
  planningWatcher.onDidCreate(schedule);
  planningWatcher.onDidDelete(schedule);
}

export function deactivate(): void {
  planningWatcher?.dispose();
}
