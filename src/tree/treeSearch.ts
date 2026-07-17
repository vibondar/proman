import * as vscode from "vscode";
import { ProjectStore } from "../core/store";
import { statusLabel, TaskNode } from "../core/types";
import { PromanTreeItem, PromanTreeProvider } from "./promanTree";

interface TaskQuickPickItem extends vscode.QuickPickItem {
  taskId: string;
}

function breadcrumb(store: ProjectStore, taskId: string): string {
  const state = store.current;
  if (!state) return "";
  const parentOf = new Map<string, string>();
  for (const t of Object.values(state.tasks)) {
    for (const c of t.children) parentOf.set(c, t.id);
  }
  const parts: string[] = [];
  let id: string | undefined = parentOf.get(taskId);
  while (id && parts.length < 4) {
    const t = state.tasks[id];
    if (!t) break;
    parts.unshift(t.title);
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
    description: [statusLabel(task.status), sp, who, task.id].filter(Boolean).join(" · "),
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
    vscode.window.showWarningMessage("Proman: дерево пусто");
    return;
  }

  const qp = vscode.window.createQuickPick<TaskQuickPickItem>();
  qp.placeholder = "Поиск по названию, описанию, id, статусу…";
  qp.matchOnDescription = true;
  qp.matchOnDetail = true;
  qp.ignoreFocusOut = true;
  qp.title = tree.getFilterQuery()
    ? `Proman · фильтр: «${tree.getFilterQuery()}»`
    : "Proman · поиск по дереву";

  const filterBtn: vscode.QuickInputButton = {
    iconPath: new vscode.ThemeIcon("filter"),
    tooltip: "Оставить в дереве только совпадения с текущим запросом",
  };
  const clearBtn: vscode.QuickInputButton = {
    iconPath: new vscode.ThemeIcon("clear-all"),
    tooltip: "Сбросить фильтр дерева",
  };
  qp.buttons = tree.getFilterQuery() ? [filterBtn, clearBtn] : [filterBtn];

  const all = Object.values(state.tasks).map((t) => toPickItem(store, t));
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
            vscode.window.showWarningMessage("Введите текст для фильтра");
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
