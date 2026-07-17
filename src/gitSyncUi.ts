import * as vscode from "vscode";
import { ProjectStore } from "./core/store";
import { gitPull, gitPush, isGitRepo } from "./core/gitSync";
import { defaultGitSync, isGitSyncEnabled } from "./core/projectMeta";
import { syncClosedGithubIssues } from "./githubSync";
import { GithubIssuesConfig, SyncConfig } from "./core/types";
import { sanitizeErrorMessage } from "./core/githubIssueLink";
import { t } from "./i18n";

type SyncSnapshot = {
  sync?: SyncConfig;
  github?: GithubIssuesConfig;
};

function snapshotSyncMeta(store: ProjectStore): SyncSnapshot {
  const meta = store.current?.meta;
  return {
    sync: meta?.sync ? { ...meta.sync } : undefined,
    github: meta?.github ? { ...meta.github } : undefined,
  };
}

function syncMetaChanged(a: SyncSnapshot, b: SyncSnapshot): boolean {
  return JSON.stringify(a) !== JSON.stringify(b);
}

function restoreSyncMeta(store: ProjectStore, snap: SyncSnapshot): void {
  if (!store.current) return;
  if (snap.sync) store.current.meta.sync = { ...snap.sync };
  else delete store.current.meta.sync;
  if (snap.github) store.current.meta.github = { ...snap.github };
  else delete store.current.meta.github;
}

export async function enableGitSync(store: ProjectStore): Promise<void> {
  if (!store.current) await store.ensureInitialized();
  const root = store.workspaceRoot;
  if (!root) throw new Error("No workspace");
  if (!(await isGitRepo(root))) {
    throw new Error("Workspace folder is not a git repository");
  }
  const autoCommit = await vscode.window.showQuickPick(
    [
      {
        label: t("Auto-commit on status change"),
        description: t("recommended"),
        value: true,
      },
      {
        label: t("No auto-commit"),
        description: t("manual Pull/Push only"),
        value: false,
      },
    ],
    { title: t("Proman Git sync · autoCommit") }
  );
  if (!autoCommit) return;

  let autoPush = false;
  if (autoCommit.value) {
    const pushPick = await vscode.window.showQuickPick(
      [
        {
          label: t("Do not prompt for push"),
          description: t("autoPush: false (safer)"),
          value: false,
        },
        {
          label: t("Prompt for Push after auto-commit"),
          description: t("confirmation required each time"),
          value: true,
        },
      ],
      { title: t("Proman Git sync · autoPush") }
    );
    if (!pushPick) return;
    if (pushPick.value) {
      const enablePush = t("Enable Push prompts");
      const cancel = t("Cancel");
      const sure = await vscode.window.showWarningMessage(
        t(
          "After a status change Proman will offer git push of .proman (comments/assignee go to remote). Enable?"
        ),
        enablePush,
        cancel
      );
      if (sure !== enablePush) {
        autoPush = false;
      } else {
        autoPush = true;
      }
    }
  }

  store.current!.meta.sync = defaultGitSync({
    autoCommit: autoCommit.value,
    autoPush,
  });
  await store.save();
  void vscode.window.showInformationMessage(
    t(
      "Proman: Git sync enabled (autoCommit={0}, autoPush={1}). Commit .proman/ to the repository.",
      String(autoCommit.value),
      String(autoPush)
    )
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
        description: t("toggle"),
        action: "autoCommit" as const,
      },
      {
        label: `autoPush: ${sync.autoPush ? "on" : "off"}`,
        description: t("prompt for push (with confirm)"),
        action: "autoPush" as const,
      },
      { label: t("Disable Git sync"), action: "off" as const },
    ],
    { title: t("Proman · sync settings") }
  );
  if (!pick) return;
  if (pick.action === "off") {
    delete store.current!.meta.sync;
  } else if (pick.action === "autoCommit") {
    sync.autoCommit = !sync.autoCommit;
  } else {
    if (!sync.autoPush) {
      const enable = t("Enable");
      const cancel = t("Cancel");
      const sure = await vscode.window.showWarningMessage(
        t("Enable Push prompts after auto-commit? Each time will require confirm."),
        enable,
        cancel
      );
      if (sure !== enable) return;
      sync.autoPush = true;
    } else {
      sync.autoPush = false;
    }
  }
  await store.save();
  void vscode.window.showInformationMessage(t("Proman: sync updated"));
}

export async function runGitPull(
  store: ProjectStore,
  refreshUi: () => void
): Promise<void> {
  const root = store.workspaceRoot;
  if (!root) {
    void vscode.window.showWarningMessage(t("Proman: no workspace"));
    return;
  }
  if (!(await isGitRepo(root))) {
    void vscode.window.showWarningMessage(t("Proman: workspace is not a git repository"));
    return;
  }

  const pullBtn = t("Pull");
  const cancel = t("Cancel");
  const proceed = await vscode.window.showWarningMessage(
    t("git pull will change the whole workspace (not only .proman/). Continue?"),
    pullBtn,
    cancel
  );
  if (proceed !== pullBtn) return;

  const before = snapshotSyncMeta(store);

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: t("Proman: git pull…") },
    async () => {
      const r = await gitPull(root);
      if (!r.ok) {
        void vscode.window.showErrorMessage(
          t("Proman pull: {0}", sanitizeErrorMessage(r.error ?? r.stderr))
        );
        return;
      }
      await store.load();

      const after = snapshotSyncMeta(store);
      if (syncMetaChanged(before, after)) {
        const keep = t("Keep from disk");
        const revert = t("Revert");
        const choice = await vscode.window.showWarningMessage(
          t(
            "After pull, sync/github settings in project.json changed. Keep from disk or revert local?"
          ),
          keep,
          revert
        );
        if (choice === revert) {
          restoreSyncMeta(store, before);
          await store.save();
        }
      }

      refreshUi();
      const closed = await syncClosedGithubIssues(store, { interactive: false });
      if (closed) refreshUi();
      void vscode.window.showInformationMessage(t("Proman: pull OK"));
    }
  );
}

export async function runGitPush(store: ProjectStore): Promise<void> {
  const root = store.workspaceRoot;
  if (!root) {
    void vscode.window.showWarningMessage(t("Proman: no workspace"));
    return;
  }
  if (!(await isGitRepo(root))) {
    void vscode.window.showWarningMessage(t("Proman: workspace is not a git repository"));
    return;
  }

  const pushBtn = t("Push");
  const cancel = t("Cancel");
  const proceed = await vscode.window.showWarningMessage(
    t("git push will send current workspace commits to remote. Continue?"),
    pushBtn,
    cancel
  );
  if (proceed !== pushBtn) return;

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: t("Proman: git push…") },
    async () => {
      const r = await gitPush(root);
      if (!r.ok) {
        void vscode.window.showErrorMessage(
          t("Proman push: {0}", sanitizeErrorMessage(r.error ?? r.stderr))
        );
        return;
      }
      void vscode.window.showInformationMessage(t("Proman: push OK"));
    }
  );
}
