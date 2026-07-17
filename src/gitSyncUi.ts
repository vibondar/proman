import * as vscode from "vscode";
import { ProjectStore } from "./core/store";
import { gitPull, gitPush, isGitRepo } from "./core/gitSync";
import { defaultGitSync, isGitSyncEnabled } from "./core/projectMeta";
import { syncClosedGithubIssues } from "./githubSync";

export async function enableGitSync(store: ProjectStore): Promise<void> {
  if (!store.current) await store.ensureInitialized();
  const root = store.workspaceRoot;
  if (!root) throw new Error("Нет workspace");
  if (!(await isGitRepo(root))) {
    throw new Error("Папка workspace не является git-репозиторием");
  }
  const autoCommit = await vscode.window.showQuickPick(
    [
      { label: "Авто-коммит при смене статуса", description: "рекомендуется", value: true },
      { label: "Без авто-коммита", description: "только ручной Pull/Push", value: false },
    ],
    { title: "Proman Git sync · autoCommit" }
  );
  if (!autoCommit) return;
  const autoPush = await vscode.window.showQuickPick(
    [
      { label: "Не пушить автоматически", description: "autoPush: false", value: false },
      { label: "Пушить после авто-коммита", description: "autoPush: true", value: true },
    ],
    { title: "Proman Git sync · autoPush" }
  );
  if (!autoPush) return;

  store.current!.meta.sync = defaultGitSync({
    autoCommit: autoCommit.value,
    autoPush: autoPush.value,
  });
  await store.save();
  void vscode.window.showInformationMessage(
    `Proman: Git sync включён (autoCommit=${autoCommit.value}, autoPush=${autoPush.value}). Закоммитьте .proman/ в репозиторий.`
  );
}

export async function configureGitSync(store: ProjectStore): Promise<void> {
  if (!store.current) await store.ensureInitialized();
  if (!isGitSyncEnabled(store.current!.meta)) {
    await enableGitSync(store);
    return;
  }
  const sync = store.current!.meta.sync!;
  const pick = await vscode.window.showQuickPick(
    [
      {
        label: `autoCommit: ${sync.autoCommit ? "on" : "off"}`,
        description: "переключить",
        action: "autoCommit" as const,
      },
      {
        label: `autoPush: ${sync.autoPush ? "on" : "off"}`,
        description: "переключить",
        action: "autoPush" as const,
      },
      { label: "Отключить Git sync", action: "off" as const },
    ],
    { title: "Proman · настройка sync" }
  );
  if (!pick) return;
  if (pick.action === "off") {
    delete store.current!.meta.sync;
  } else if (pick.action === "autoCommit") {
    sync.autoCommit = !sync.autoCommit;
  } else {
    sync.autoPush = !sync.autoPush;
  }
  await store.save();
  void vscode.window.showInformationMessage("Proman: sync обновлён");
}

export async function runGitPull(
  store: ProjectStore,
  refreshUi: () => void
): Promise<void> {
  const root = store.workspaceRoot;
  if (!root) {
    void vscode.window.showWarningMessage("Proman: нет workspace");
    return;
  }
  if (!(await isGitRepo(root))) {
    void vscode.window.showWarningMessage("Proman: workspace не git-репозиторий");
    return;
  }
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Proman: git pull…" },
    async () => {
      const r = await gitPull(root);
      if (!r.ok) {
        void vscode.window.showErrorMessage(`Proman pull: ${r.error ?? r.stderr}`);
        return;
      }
      await store.load();
      refreshUi();
      const closed = await syncClosedGithubIssues(store, { interactive: false });
      if (closed) refreshUi();
      void vscode.window.showInformationMessage(
        `Proman: pull OK${r.stdout.trim() ? " — " + r.stdout.trim().split("\n").slice(-1)[0] : ""}`
      );
    }
  );
}

export async function runGitPush(store: ProjectStore): Promise<void> {
  const root = store.workspaceRoot;
  if (!root) {
    void vscode.window.showWarningMessage("Proman: нет workspace");
    return;
  }
  if (!(await isGitRepo(root))) {
    void vscode.window.showWarningMessage("Proman: workspace не git-репозиторий");
    return;
  }
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Proman: git push…" },
    async () => {
      const r = await gitPush(root);
      if (!r.ok) {
        void vscode.window.showErrorMessage(`Proman push: ${r.error ?? r.stderr}`);
        return;
      }
      void vscode.window.showInformationMessage("Proman: push OK");
    }
  );
}
