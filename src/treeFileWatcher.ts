import * as vscode from "vscode";
import * as path from "path";
import { ProjectStore } from "./core/store";

/**
 * Watch .proman/tree.json and .proman/trees/*.json so Agent MCP status writes
 * refresh the sidebar automatically.
 */
export function startTreeFileWatcher(
  store: ProjectStore,
  onReload: () => void
): vscode.Disposable {
  let watchers: vscode.FileSystemWatcher[] = [];
  let timer: NodeJS.Timeout | undefined;
  let ignoreUntil = 0;

  const attach = () => {
    for (const w of watchers) w.dispose();
    watchers = [];
    const root = store.workspaceRoot;
    if (!root) return;
    const pattern = new vscode.RelativePattern(
      path.join(root, ".proman"),
      "{tree,edges,project}.json"
    );
    const treesPattern = new vscode.RelativePattern(
      path.join(root, ".proman", "trees"),
      "*.json"
    );
    const main = vscode.workspace.createFileSystemWatcher(pattern);
    const trees = vscode.workspace.createFileSystemWatcher(treesPattern);
    watchers = [main, trees];

    const schedule = () => {
      if (Date.now() < ignoreUntil) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(async () => {
        try {
          await store.load();
          onReload();
        } catch {
          /* ignore transient write races */
        }
      }, 250);
    };

    for (const w of watchers) {
      w.onDidChange(schedule);
      w.onDidCreate(schedule);
      w.onDidDelete(schedule);
    }
  };

  attach();
  const folderSub = vscode.workspace.onDidChangeWorkspaceFolders(() => attach());

  const markSelfWrite = () => {
    ignoreUntil = Date.now() + 400;
  };

  return {
    dispose: () => {
      for (const w of watchers) w.dispose();
      folderSub.dispose();
      if (timer) clearTimeout(timer);
    },
    markSelfWrite,
  } as vscode.Disposable & { markSelfWrite: () => void };
}
