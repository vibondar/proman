import * as vscode from "vscode";
import * as path from "path";
import { ProjectStore } from "./core/store";

/**
 * Watch .proman/tree.json so Agent MCP status writes refresh the sidebar automatically.
 */
export function startTreeFileWatcher(
  store: ProjectStore,
  onReload: () => void
): vscode.Disposable {
  let watcher: vscode.FileSystemWatcher | undefined;
  let timer: NodeJS.Timeout | undefined;
  let ignoreUntil = 0;

  const attach = () => {
    watcher?.dispose();
    const root = store.workspaceRoot;
    if (!root) return;
    const treeFile = path.join(root, ".proman", "tree.json");
    const pattern = new vscode.RelativePattern(path.dirname(treeFile), "{tree,edges,project}.json");
    watcher = vscode.workspace.createFileSystemWatcher(pattern);

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

    watcher.onDidChange(schedule);
    watcher.onDidCreate(schedule);
  };

  attach();
  const folderSub = vscode.workspace.onDidChangeWorkspaceFolders(() => attach());

  // When we save from the extension, skip echo for a short window (optional)
  const markSelfWrite = () => {
    ignoreUntil = Date.now() + 400;
  };

  return {
    dispose: () => {
      watcher?.dispose();
      folderSub.dispose();
      if (timer) clearTimeout(timer);
    },
    // exposed for store hooks if needed later
    markSelfWrite,
  } as vscode.Disposable & { markSelfWrite: () => void };
}
