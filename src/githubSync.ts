import * as vscode from "vscode";
import { ProjectStore } from "./core/store";
import {
  createGithubIssue,
  defaultGithubConfig,
  detectGithubOwnerRepo,
  getGithubAccessToken,
  isGithubIssuesEnabled,
  listClosedIssues,
} from "./core/githubApi";
import {
  githubIssueUrl,
  parseGithubIssueId,
  upsertGithubIssueInDescription,
} from "./core/githubIssueLink";
import { normalizeProjectMeta } from "./core/projectMeta";

async function authToken(opts?: { createIfNone?: boolean }): Promise<string | null> {
  return getGithubAccessToken(async () => {
    const session = await vscode.authentication.getSession("github", ["repo"], {
      createIfNone: opts?.createIfNone ?? true,
      silent: opts?.createIfNone === false,
    });
    return session ? { accessToken: session.accessToken } : undefined;
  });
}

export async function enableGithubIssues(store: ProjectStore): Promise<void> {
  if (!store.current) await store.ensureInitialized();
  const root = store.workspaceRoot;
  if (!root) throw new Error("Нет workspace");

  const detected = await detectGithubOwnerRepo(root);
  const owner = await vscode.window.showInputBox({
    prompt: "GitHub owner (org или user)",
    value: detected?.owner ?? store.current?.meta.github?.owner ?? "",
    placeHolder: "acme",
  });
  if (!owner?.trim()) return;
  const repo = await vscode.window.showInputBox({
    prompt: "GitHub repository",
    value: detected?.repo ?? store.current?.meta.github?.repo ?? "",
    placeHolder: "my-app",
  });
  if (!repo?.trim()) return;

  store.current!.meta.github = defaultGithubConfig(owner.trim(), repo.trim());
  store.current!.meta = normalizeProjectMeta(store.current!.meta);
  await store.save();
  void vscode.window.showInformationMessage(
    `Proman: GitHub Issues → ${owner.trim()}/${repo.trim()}. При создании задачи появится Issue; закрытие Issue → done.`
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
      { label: "Сменить owner/repo…", action: "repo" as const },
      { label: "Отключить GitHub Issues", action: "off" as const },
      { label: "Синхронизировать закрытые Issues сейчас", action: "sync" as const },
    ],
    { title: "Proman · GitHub Issues" }
  );
  if (!pick) return;
  if (pick.action === "off") {
    delete store.current!.meta.github;
    await store.save();
    void vscode.window.showInformationMessage("Proman: GitHub Issues отключены");
    return;
  }
  if (pick.action === "repo") {
    await enableGithubIssues(store);
    return;
  }
  if (pick.action === "sync") {
    const n = await syncClosedGithubIssues(store, { interactive: true });
    void vscode.window.showInformationMessage(
      n > 0 ? `Proman: отмечено done по Issues: ${n}` : "Proman: новых закрытых Issues нет"
    );
    return;
  }
  if (pick.action === "createOnAdd") {
    gh!.createOnAdd = gh!.createOnAdd === false;
  } else {
    gh!.closeToDone = gh!.closeToDone === false;
  }
  await store.save();
  void vscode.window.showInformationMessage("Proman: GitHub config обновлён");
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

  const token = await authToken({ createIfNone: true });
  if (!token) {
    void vscode.window.showWarningMessage(
      "Proman: нет GitHub-сессии — Issue не создан. Войдите в GitHub в Cursor."
    );
    return null;
  }

  try {
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
    void vscode.window.showInformationMessage(
      `Proman: Issue #${issue.number} создан`,
      "Открыть"
    ).then((choice) => {
      if (choice === "Открыть") {
        void vscode.env.openExternal(vscode.Uri.parse(issue.html_url));
      }
    });
    return issue.number;
  } catch (e) {
    void vscode.window.showWarningMessage(
      `Proman: не удалось создать Issue — ${e instanceof Error ? e.message : String(e)}`
    );
    return null;
  }
}

/**
 * For tasks with «GitHub: #N»: if Issue is closed on GitHub → status done.
 * Returns number of tasks updated.
 * @param interactive — if false, skip when no existing GitHub session (no login popup).
 */
export async function syncClosedGithubIssues(
  store: ProjectStore,
  opts?: { interactive?: boolean }
): Promise<number> {
  const state = store.current;
  const gh = state?.meta.github;
  if (!state || !isGithubIssuesEnabled(gh) || gh!.closeToDone === false) return 0;

  const linked = Object.values(state.tasks)
    .map((t) => ({ task: t, issue: parseGithubIssueId(t.description) }))
    .filter(
      (x): x is { task: (typeof state.tasks)[string]; issue: number } =>
        x.issue != null &&
        x.task.status !== "done" &&
        x.task.status !== "error"
    );
  if (!linked.length) return 0;

  const interactive = opts?.interactive !== false;
  const token = await authToken({ createIfNone: interactive });
  if (!token) return 0;

  let updated = 0;
  try {
    // Prefer bulk list of recently closed issues
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
        `📬 Proman: ${updated} задач(и) → done (Issues закрыты на GitHub)`
      );
    }
  } catch (e) {
    void vscode.window.showWarningMessage(
      `Proman GitHub sync: ${e instanceof Error ? e.message : String(e)}`
    );
  }
  return updated;
}

export function githubLinkHint(
  store: ProjectStore,
  taskId: string
): string | undefined {
  const state = store.current;
  const task = state?.tasks[taskId];
  const gh = state?.meta.github;
  if (!task || !gh) return undefined;
  const n = parseGithubIssueId(task.description);
  if (!n) return undefined;
  return githubIssueUrl(gh.owner, gh.repo, n);
}
