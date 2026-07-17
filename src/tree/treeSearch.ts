import * as vscode from "vscode";
import { ProjectStore } from "../core/store";
import { TaskNode } from "../core/types";
import { statusLabelL10n, t } from "../i18n";
import { PromanTreeItem, PromanTreeProvider } from "./promanTree";

interface TaskQuickPickItem extends vscode.QuickPickItem {
  taskId: string;
}

function breadcrumb(store: ProjectStore, taskId: string): string {
  const state = store.current;
  if (!state) return "";
  const parentOf = new Map<string, string>();
  for (const node of Object.values(state.tasks)) {
    for (const c of node.children) parentOf.set(c, node.id);
  }
  const parts: string[] = [];
  let id: string | undefined = parentOf.get(taskId);
  while (id && parts.length < 4) {
    const node = state.tasks[id];
    if (!node) break;
    parts.unshift(node.title);
    id = parentOf.get(id);
  }
  return parts.join(" › ");
}

function toPickItem(store: ProjectStore, task: TaskNode): TaskQuickPickItem {
  const path = breadcrumb(store, task.id);
  const sp =
    task.children.length > 0
      ? undefined
      : task.estimateSp != null
        ? `${task.estimateSp} SP`
        : undefined;
  const who = task.assignee ? `@${task.assignee.replace(/^@/, "")}` : undefined;
  return {
    label: task.title,
    description: [statusLabelL10n(task.status), sp, who, task.id].filter(Boolean).join(" · "),
    detail: [path, task.description?.slice(0, 120)].filter(Boolean).join(" — ") || undefined,
    taskId: task.id,
  };
}

/**
 * QuickPick: jump to a task. Buttons: filter tree / clear filter.
 */
export async function runTreeSearch(
  store: ProjectStore,
  tree: PromanTreeProvider,
  treeView: vscode.TreeView<PromanTreeItem>,
  openDetails: (taskId: string) => void,
  refreshUi: () => void
): Promise<void> {
  const state = store.current;
  if (!state || !Object.keys(state.tasks).length) {
    vscode.window.showWarningMessage(t("Proman: tree is empty"));
    return;
  }

  const qp = vscode.window.createQuickPick<TaskQuickPickItem>();
  qp.placeholder = t("Search by title, description, id, status…");
  qp.matchOnDescription = true;
  qp.matchOnDetail = true;
  qp.ignoreFocusOut = true;
  const filterQ = tree.getFilterQuery();
  qp.title = filterQ
    ? t("Proman · filter: “{0}”", filterQ)
    : t("Proman · search tree");

  const filterBtn: vscode.QuickInputButton = {
    iconPath: new vscode.ThemeIcon("filter"),
    tooltip: t("Keep only matches for the current query in the tree"),
  };
  const clearBtn: vscode.QuickInputButton = {
    iconPath: new vscode.ThemeIcon("clear-all"),
    tooltip: t("Clear tree filter"),
  };
  qp.buttons = tree.getFilterQuery() ? [filterBtn, clearBtn] : [filterBtn];

  const all = Object.values(state.tasks).map((task) => toPickItem(store, task));
  qp.items = all;

  const disposables: vscode.Disposable[] = [];

  await new Promise<void>((resolve) => {
    disposables.push(
      qp.onDidTriggerButton(async (btn) => {
        if (btn === clearBtn) {
          tree.clearFilter();
          tree.clearPathHighlight();
          await vscode.commands.executeCommand("setContext", "proman.treeFiltered", false);
          refreshUi();
          qp.hide();
          resolve();
          return;
        }
        if (btn === filterBtn) {
          const q = qp.value.trim();
          if (!q) {
            vscode.window.showWarningMessage(t("Enter text to filter"));
            return;
          }
          tree.setFilterQuery(q);
          await vscode.commands.executeCommand("setContext", "proman.treeFiltered", true);
          refreshUi();
          qp.hide();
          resolve();
        }
      }),
      qp.onDidAccept(async () => {
        const picked = qp.selectedItems[0];
        qp.hide();
        if (!picked) {
          resolve();
          return;
        }
        tree.highlightPathTo(picked.taskId);
        refreshUi();
        const item = tree.itemForId(picked.taskId);
        if (item) {
          try {
            await treeView.reveal(item, { expand: true, select: true, focus: true });
          } catch {
            /* reveal may fail if item not in filtered view */
          }
        }
        openDetails(picked.taskId);
        resolve();
      }),
      qp.onDidHide(() => resolve())
    );
    qp.show();
  });

  qp.dispose();
  disposables.forEach((d) => d.dispose());
}
