import * as vscode from "vscode";
import * as path from "path";
import { ProjectStore } from "./core/store";
import { gitPull, gitPush, isGitRepo, looksLikeGitConflict } from "./core/gitSync";
import { defaultGitSync, isGitSyncEnabled } from "./core/projectMeta";
import { syncClosedGithubIssues } from "./githubSync";
import { GithubIssuesConfig, SyncConfig } from "./core/types";
import { sanitizeErrorMessage } from "./core/githubIssueLink";
import { PromanFileProblem } from "./core/promanConflict";
import { mergeTreeByTaskId, parseTreeBundleJson } from "./core/treeMerge";
import { wsWriteTreeJson } from "./core/workspaceIo";
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

function formatProblemList(problems: PromanFileProblem[], max = 5): string {
  const paths = problems.map((p) => p.path);
  const shown = paths.slice(0, max).join(", ");
  return paths.length > max ? `${shown}, …` : shown;
}

/**
 * After load/pull: warn if `.proman/` has conflict markers or invalid JSON.
 * Partial forest may still be loaded; conflicted files are not written over.
 */
export async function notifyPromanLoadProblems(
  store: ProjectStore,
  refreshUi: () => void
): Promise<boolean> {
  const problems = store.lastLoadProblems;
  if (!problems.length) return false;

  const conflicts = problems.filter((p) => p.kind === "conflict_markers");
  const invalid = problems.filter((p) => p.kind === "invalid_json");

  let message: string;
  let hint: string;
  if (conflicts.length && !invalid.length) {
    message = t(
      "Proman: merge conflict markers in .proman ({0}): {1}",
      conflicts.length,
      formatProblemList(conflicts)
    );
    hint = t("Resolve conflict markers in git, then Reload.");
  } else if (invalid.length && !conflicts.length) {
    message = t(
      "Proman: invalid JSON in .proman ({0}): {1}",
      invalid.length,
      formatProblemList(invalid)
    );
    hint = t("Fix or restore the JSON file, then Reload.");
  } else {
    message = t(
      "Proman: .proman file problems ({0}): {1}",
      problems.length,
      formatProblemList(problems)
    );
    hint = t("Resolve conflict markers in git, then Reload.");
  }

  const openFile = t("Open file");
  const reload = t("Reload");
  const scm = t("Open Source Control");
  const choice = await vscode.window.showWarningMessage(
    `${message}\n${hint}`,
    openFile,
    reload,
    scm
  );

  if (choice === openFile) {
    const first = problems[0];
    const root = store.workspaceRoot;
    if (first && root) {
      const full = path.join(root, ".proman", ...first.path.split("/"));
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(full));
      await vscode.window.showTextDocument(doc);
    }
  } else if (choice === reload) {
    await store.load();
    refreshUi();
    if (store.lastLoadProblems.length) {
      await notifyPromanLoadProblems(store, refreshUi);
    } else {
      void vscode.window.showInformationMessage(t("Proman: tree reloaded OK"));
    }
  } else if (choice === scm) {
    await vscode.commands.executeCommand("workbench.view.scm");
  }
  return true;
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
        const detail = sanitizeErrorMessage(r.error ?? r.stderr);
        if (looksLikeGitConflict(r)) {
          void vscode.window.showErrorMessage(
            t(
              "Proman pull CONFLICT: {0}. Resolve markers (often under .proman/), then Reload.",
              detail
            )
          );
        } else {
          void vscode.window.showErrorMessage(t("Proman pull: {0}", detail));
        }
        return;
      }
      await store.load();

      const after = snapshotSyncMeta(store);
      if (syncMetaChanged(before, after)) {
        // Do not offer Keep/Revert over unresolved merge conflicts in .proman/
        if (!store.lastLoadProblems.length) {
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
      }

      refreshUi();
      const hadProblems = await notifyPromanLoadProblems(store, refreshUi);
      if (!hadProblems) {
        const closed = await syncClosedGithubIssues(store, { interactive: false });
        if (closed) refreshUi();
        void vscode.window.showInformationMessage(t("Proman: pull OK"));
      }
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

async function readTreeUri(
  uri: vscode.Uri,
  label: string
): Promise<{ ok: true; tree: import("./core/types").TreeBundle } | { ok: false }> {
  const raw = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8");
  const name = uri.path.split("/").pop() ?? "tree.json";
  const parsed = parseTreeBundleJson(raw, name);
  if (!parsed.ok) {
    void vscode.window.showErrorMessage(t("Proman merge ({0}): {1}", label, parsed.error));
    return { ok: false };
  }
  return { ok: true, tree: parsed.tree };
}

/**
 * Advanced: semantic merge of two valid tree JSON snapshots (no conflict markers).
 * Writes result to `.proman/trees/<id>.json` and reloads.
 */
export async function resolvePromanMerge(
  store: ProjectStore,
  refreshUi: () => void
): Promise<void> {
  const root = store.workspaceRoot;
  if (!root) {
    void vscode.window.showWarningMessage(t("Proman: no workspace"));
    return;
  }

  const oursPick = await vscode.window.showOpenDialog({
    canSelectMany: false,
    openLabel: t("Ours (local)"),
    title: t("Proman merge · pick ours JSON"),
    filters: { JSON: ["json"] },
  });
  const oursUri = oursPick?.[0];
  if (!oursUri) return;

  const theirsPick = await vscode.window.showOpenDialog({
    canSelectMany: false,
    openLabel: t("Theirs (incoming)"),
    title: t("Proman merge · pick theirs JSON"),
    filters: { JSON: ["json"] },
  });
  const theirsUri = theirsPick?.[0];
  if (!theirsUri) return;

  const useBase = t("Pick base (optional)");
  const skipBase = t("No base");
  const baseChoice = await vscode.window.showQuickPick(
    [
      { label: skipBase, id: "skip" as const },
      { label: useBase, id: "base" as const },
    ],
    { title: t("Proman merge · base for deletes?") }
  );
  if (!baseChoice) return;

  let baseTree: import("./core/types").TreeBundle | undefined;
  if (baseChoice.id === "base") {
    const basePick = await vscode.window.showOpenDialog({
      canSelectMany: false,
      openLabel: t("Base"),
      title: t("Proman merge · pick base JSON"),
      filters: { JSON: ["json"] },
    });
    const baseUri = basePick?.[0];
    if (!baseUri) return;
    const baseParsed = await readTreeUri(baseUri, "base");
    if (!baseParsed.ok) return;
    baseTree = baseParsed.tree;
  }

  const oursParsed = await readTreeUri(oursUri, "ours");
  if (!oursParsed.ok) return;
  const theirsParsed = await readTreeUri(theirsUri, "theirs");
  if (!theirsParsed.ok) return;

  const merged = mergeTreeByTaskId(oursParsed.tree, theirsParsed.tree, {
    base: baseTree,
  });
  if (!merged.ok) {
    void vscode.window.showErrorMessage(t("Proman merge failed: {0}", merged.error));
    return;
  }

  const confirm = t("Write merged tree");
  const cancel = t("Cancel");
  const sure = await vscode.window.showWarningMessage(
    t(
      "Write merged “{0}” ({1} tasks) to .proman/trees/? This overwrites the section file.",
      merged.tree.title || merged.tree.id,
      Object.keys(merged.tree.tasks).length
    ),
    confirm,
    cancel
  );
  if (sure !== confirm) return;

  store.onBeforeWriteDisk?.();
  const ok = await wsWriteTreeJson(
    root,
    merged.tree.id,
    JSON.stringify(merged.tree, null, 2)
  );
  if (!ok) {
    void vscode.window.showErrorMessage(t("Proman: failed to write tree file"));
    return;
  }

  await store.load();
  refreshUi();
  const hadProblems = await notifyPromanLoadProblems(store, refreshUi);
  if (!hadProblems) {
    void vscode.window.showInformationMessage(
      t("Proman: merge written for “{0}”", merged.tree.title || merged.tree.id)
    );
  }
}
