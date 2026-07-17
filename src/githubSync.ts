import * as vscode from "vscode";
import { ProjectStore } from "./core/store";
import {
  createGithubIssue,
  defaultGithubConfig,
  detectGithubOwnerRepo,
  getGithubAccessToken,
  githubAuthScopes,
  isGithubIssuesEnabled,
  listClosedIssues,
} from "./core/githubApi";
import {
  assertValidGithubOwnerRepo,
  isSafeGithubHtmlUrl,
  isValidGithubName,
  parseGithubIssueId,
  sanitizeErrorMessage,
  upsertGithubIssueInDescription,
} from "./core/githubIssueLink";
import { normalizeProjectMeta } from "./core/projectMeta";
import { t } from "./i18n";

async function authToken(
  store: ProjectStore,
  opts?: { createIfNone?: boolean }
): Promise<string | null> {
  const publicOnly = Boolean(store.current?.meta.github?.publicOnly);
  const scopes = githubAuthScopes(publicOnly);
  return getGithubAccessToken(async () => {
    const session = await vscode.authentication.getSession("github", scopes, {
      createIfNone: opts?.createIfNone ?? true,
      silent: opts?.createIfNone === false,
    });
    return session ? { accessToken: session.accessToken } : undefined;
  });
}

export async function enableGithubIssues(store: ProjectStore): Promise<void> {
  if (!store.current) await store.ensureInitialized();
  const root = store.workspaceRoot;
  if (!root) throw new Error("No workspace");

  const detected = await detectGithubOwnerRepo(root);
  const owner = await vscode.window.showInputBox({
    prompt: t("GitHub owner (org or user)"),
    value: detected?.owner ?? store.current?.meta.github?.owner ?? "",
    placeHolder: "acme",
    validateInput: (v) => (isValidGithubName(v) ? null : t("Invalid owner")),
  });
  if (!owner?.trim()) return;
  const repo = await vscode.window.showInputBox({
    prompt: t("GitHub repository"),
    value: detected?.repo ?? store.current?.meta.github?.repo ?? "",
    placeHolder: "my-app",
    validateInput: (v) =>
      isValidGithubName(v?.replace(/\.git$/i, "")) ? null : t("Invalid repo name"),
  });
  if (!repo?.trim()) return;

  const visibility = await vscode.window.showQuickPick(
    [
      {
        label: t("Private or needs full access"),
        description: t("OAuth scope: repo"),
        publicOnly: false,
      },
      {
        label: t("Public repository only"),
        description: t("OAuth scope: public_repo (narrower)"),
        publicOnly: true,
      },
    ],
    { title: t("Proman GitHub · access") }
  );
  if (!visibility) return;

  let pair: { owner: string; repo: string };
  try {
    pair = assertValidGithubOwnerRepo(owner, repo);
  } catch (e) {
    void vscode.window.showErrorMessage(
      t("Proman: {0}", e instanceof Error ? e.message : String(e))
    );
    return;
  }

  store.current!.meta.github = defaultGithubConfig(pair.owner, pair.repo, {
    publicOnly: visibility.publicOnly,
  });
  store.current!.meta = normalizeProjectMeta(store.current!.meta);
  await store.save();
  void vscode.window.showInformationMessage(
    t(
      "Proman: GitHub Issues → {0}/{1} ({2}). Do not put secrets in task descriptions.",
      pair.owner,
      pair.repo,
      visibility.publicOnly ? "public_repo" : "repo"
    )
  );
}

export async function configureGithubIssues(store: ProjectStore): Promise<void> {
  if (!store.current) await store.ensureInitialized();
  const gh = store.current!.meta.github;
  if (!isGithubIssuesEnabled(gh)) {
    await enableGithubIssues(store);
    return;
  }
  const pick = await vscode.window.showQuickPick(
    [
      {
        label: `createOnAdd: ${gh!.createOnAdd !== false ? "on" : "off"}`,
        action: "createOnAdd" as const,
      },
      {
        label: `closeToDone: ${gh!.closeToDone !== false ? "on" : "off"}`,
        action: "closeToDone" as const,
      },
      {
        label: `publicOnly: ${gh!.publicOnly ? "on" : "off"}`,
        action: "publicOnly" as const,
      },
      { label: t("Change owner/repo…"), action: "repo" as const },
      { label: t("Disable GitHub Issues"), action: "off" as const },
      { label: t("Sync closed Issues now"), action: "sync" as const },
    ],
    { title: t("Proman · GitHub Issues") }
  );
  if (!pick) return;
  if (pick.action === "off") {
    delete store.current!.meta.github;
    await store.save();
    void vscode.window.showInformationMessage(t("Proman: GitHub Issues disabled"));
    return;
  }
  if (pick.action === "repo") {
    await enableGithubIssues(store);
    return;
  }
  if (pick.action === "sync") {
    const n = await syncClosedGithubIssues(store, { interactive: true });
    void vscode.window.showInformationMessage(
      n > 0
        ? t("Proman: marked done from Issues: {0}", n)
        : t("Proman: no newly closed Issues")
    );
    return;
  }
  if (pick.action === "createOnAdd") {
    gh!.createOnAdd = gh!.createOnAdd === false;
  } else if (pick.action === "closeToDone") {
    gh!.closeToDone = gh!.closeToDone === false;
  } else {
    gh!.publicOnly = !gh!.publicOnly;
  }
  await store.save();
  void vscode.window.showInformationMessage(t("Proman: GitHub config updated"));
}

/** After a task is created — open GitHub Issue and write «GitHub: #N» into description. */
export async function createIssueForTask(
  store: ProjectStore,
  taskId: string
): Promise<number | null> {
  const state = store.current;
  const gh = state?.meta.github;
  if (!state || !isGithubIssuesEnabled(gh) || gh!.createOnAdd === false) return null;
  const task = state.tasks[taskId];
  if (!task) return null;
  if (parseGithubIssueId(task.description)) return parseGithubIssueId(task.description);

  if (task.description?.trim()) {
    const create = t("Create Issue");
    const skip = t("Skip");
    const ok = await vscode.window.showWarningMessage(
      t("Task description will be sent to a GitHub Issue. Do not include secrets/tokens."),
      create,
      skip
    );
    if (ok !== create) return null;
  }

  const token = await authToken(store, { createIfNone: true });
  if (!token) {
    void vscode.window.showWarningMessage(
      t("Proman: no GitHub session — Issue not created. Sign in to GitHub in Cursor.")
    );
    return null;
  }

  try {
    assertValidGithubOwnerRepo(gh!.owner, gh!.repo);
    const body = [
      task.description?.trim() || "",
      "",
      `---`,
      `Created by Proman`,
      `proman-task: ${task.id}`,
    ]
      .filter((l, i, a) => !(l === "" && a[i - 1] === ""))
      .join("\n")
      .trim();

    const issue = await createGithubIssue(
      token,
      gh!.owner,
      gh!.repo,
      task.title,
      body
    );
    const desc = upsertGithubIssueInDescription(task.description, issue.number);
    store.updateTask(taskId, { description: desc });
    await store.save();
    const openBtn = t("Open");
    void vscode.window
      .showInformationMessage(t("Proman: Issue #{0} created", issue.number), openBtn)
      .then((choice) => {
        if (choice === openBtn) {
          if (!isSafeGithubHtmlUrl(issue.html_url)) {
            void vscode.window.showWarningMessage(
              t("Proman: refused to open URL (not github.com/…/issues/N)")
            );
            return;
          }
          void vscode.env.openExternal(vscode.Uri.parse(issue.html_url));
        }
      });
    return issue.number;
  } catch (e) {
    void vscode.window.showWarningMessage(
      t(
        "Proman: failed to create Issue — {0}",
        sanitizeErrorMessage(e instanceof Error ? e.message : String(e))
      )
    );
    return null;
  }
}

/**
 * For tasks with «GitHub: #N»: if Issue is closed on GitHub → status done.
 */
export async function syncClosedGithubIssues(
  store: ProjectStore,
  opts?: { interactive?: boolean }
): Promise<number> {
  const state = store.current;
  const gh = state?.meta.github;
  if (!state || !isGithubIssuesEnabled(gh) || gh!.closeToDone === false) return 0;

  try {
    assertValidGithubOwnerRepo(gh!.owner, gh!.repo);
  } catch {
    return 0;
  }

  const linked = Object.values(state.tasks)
    .map((task) => ({ task, issue: parseGithubIssueId(task.description) }))
    .filter(
      (x): x is { task: (typeof state.tasks)[string]; issue: number } =>
        x.issue != null &&
        x.task.status !== "done" &&
        x.task.status !== "error"
    );
  if (!linked.length) return 0;

  const interactive = opts?.interactive !== false;
  const token = await authToken(store, { createIfNone: interactive });
  if (!token) return 0;

  let updated = 0;
  try {
    const closed = await listClosedIssues(token, gh!.owner, gh!.repo, { perPage: 100 });
    const closedSet = new Set(closed.filter((i) => i.state === "closed").map((i) => i.number));

    for (const { task, issue } of linked) {
      if (!closedSet.has(issue)) continue;
      store.setStatus(task.id, "done");
      updated++;
    }

    if (updated) {
      await store.save();
      void vscode.window.showInformationMessage(
        t("📬 Proman: {0} task(s) → done (Issues closed on GitHub)", updated)
      );
    }
  } catch (e) {
    void vscode.window.showWarningMessage(
      t(
        "Proman GitHub sync: {0}",
        sanitizeErrorMessage(e instanceof Error ? e.message : String(e))
      )
    );
  }
  return updated;
}
