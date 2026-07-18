import * as vscode from "vscode";
import { ProjectStore } from "./core/store";
import { DependencyEngine } from "./core/dependencyEngine";
import { TaskStatus } from "./core/types";
import { AgentHandoff } from "./agent/handoff";
import { addComment, loadComments, TaskComment } from "./core/comments";
import { historyForTask, HistoryEntry, loadHistory } from "./core/history";
import { getMetaCurrentUser } from "./core/projectMeta";
import { collectDoneTaskFiles, resolveTaskFilePath } from "./core/taskFiles";
import { detailPanelUi, t } from "./i18n";

type DetailMsg =
  | { type: "ready" }
  | {
      type: "save";
      title: string;
      description: string;
      status: TaskStatus;
      dependsOn: string[];
      estimateSp?: number | null;
      estimateHours?: number | null;
      assignee?: string;
      tags?: string;
    }
  | { type: "delete"; mode: "promote" | "cascade" }
  | { type: "addChild"; title?: string }
  | { type: "requestDelete" }
  | { type: "runAgent" }
  | { type: "copyPrompt" }
  | { type: "addComment"; text: string }
  | { type: "assignToMe" }
  | { type: "pickAssignee" }
  | { type: "openFile"; path: string };

export class TaskDetailPanel {
  public static current: TaskDetailPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private taskId: string;
  private disposables: vscode.Disposable[] = [];
  private comments: TaskComment[] = [];
  private history: HistoryEntry[] = [];

  private constructor(
    panel: vscode.WebviewPanel,
    taskId: string,
    private readonly store: ProjectStore,
    private readonly deps: DependencyEngine,
    private readonly handoff: AgentHandoff,
    private readonly onChanged: () => void
  ) {
    this.panel = panel;
    this.taskId = taskId;
    this.panel.webview.html = this.html();
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage(
      (msg: DetailMsg) => void this.onMessage(msg),
      null,
      this.disposables
    );
    this.store.onDidChange(() => void this.postState());
  }

  static show(
    context: vscode.ExtensionContext,
    store: ProjectStore,
    deps: DependencyEngine,
    handoff: AgentHandoff,
    taskId: string,
    onChanged: () => void
  ): void {
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;
    if (TaskDetailPanel.current) {
      TaskDetailPanel.current.taskId = taskId;
      TaskDetailPanel.current.panel.reveal(column);
      void TaskDetailPanel.current.postState();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      "proman.taskDetail",
      t("Proman · Task"),
      column,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    TaskDetailPanel.current = new TaskDetailPanel(
      panel,
      taskId,
      store,
      deps,
      handoff,
      onChanged
    );
    context.subscriptions.push(
      new vscode.Disposable(() => TaskDetailPanel.current?.dispose())
    );
  }

  private async onMessage(msg: DetailMsg): Promise<void> {
    try {
      switch (msg.type) {
        case "ready":
          await this.postState();
          break;
        case "save": {
          const impact = this.deps.preview(this.store.current!, {
            kind: "updateDepends",
            taskId: this.taskId,
            dependsOn: msg.dependsOn,
          });
          if (!impact.ok) {
            void vscode.window.showErrorMessage(
              impact.error ?? t("Dependency cycle")
            );
            await this.postState();
            return;
          }
          this.store.updateTask(this.taskId, {
            title: msg.title,
            description: msg.description,
            dependsOn: msg.dependsOn,
            estimateSp: msg.estimateSp ?? undefined,
            estimateHours: msg.estimateHours ?? undefined,
            assignee: msg.assignee?.trim() || undefined,
            tags: msg.tags
              ? msg.tags
                  .split(/[\s,]+/)
                  .map((tag) => tag.replace(/^#/, "").trim())
                  .filter(Boolean)
              : undefined,
          });
          this.store.setStatus(this.taskId, msg.status);
          await this.store.save();
          this.onChanged();
          this.panel.title = `Proman · ${msg.title}`;
          void vscode.window.showInformationMessage(t("Proman: task saved"));
          await this.postState();
          break;
        }
        case "delete": {
          this.store.deleteTask(this.taskId, msg.mode);
          this.store.applyBlockedStatuses();
          await this.store.save();
          this.onChanged();
          this.panel.dispose();
          break;
        }
        case "addChild": {
          // Webviews cannot use window.prompt — ask on the extension host.
          const title =
            (typeof msg.title === "string" && msg.title.trim()) ||
            (await vscode.window.showInputBox({
              prompt: t("Subtask title"),
              placeHolder: t("e.g. Auth refactor"),
            }));
          if (!title?.trim()) return;
          const child = this.store.addTask(this.taskId, title.trim());
          await this.store.save();
          const { createIssueForTask } = await import("./githubSync");
          await createIssueForTask(this.store, child.id);
          this.onChanged();
          await this.postState();
          break;
        }
        case "requestDelete": {
          const mode = await vscode.window.showQuickPick(
            [
              { label: t("Promote children to parent"), mode: "promote" as const },
              { label: t("Delete with children"), mode: "cascade" as const },
            ],
            { title: t("Delete task") }
          );
          if (!mode) return;
          this.store.deleteTask(this.taskId, mode.mode);
          this.store.applyBlockedStatuses();
          await this.store.save();
          this.onChanged();
          this.panel.dispose();
          break;
        }
        case "runAgent":
          await this.handoff.runTask(this.taskId);
          this.onChanged();
          await this.postState();
          break;
        case "copyPrompt":
          await this.handoff.copyPrompt(this.taskId);
          break;
        case "addComment": {
          const root = this.store.workspaceRoot;
          if (!root) throw new Error("No workspace");
          if (!this.store.hasCurrentUser()) {
            void vscode.window.showWarningMessage(
              t(
                "Proman: set the current user first (command “Set Current User”)"
              )
            );
            return;
          }
          const author = this.store.currentUser();
          const comment = await addComment(root, this.taskId, author, msg.text);
          if (!comment) throw new Error("Failed to save comment");
          this.store.recordCommentHistory(this.taskId, author, comment.text);
          await this.store.save();
          this.onChanged();
          await this.postState();
          break;
        }
        case "assignToMe": {
          if (!this.store.hasCurrentUser()) {
            void vscode.window.showWarningMessage(
              t(
                "Proman: set the current user first (command “Set Current User”)"
              )
            );
            return;
          }
          this.store.updateTask(this.taskId, { assignee: this.store.currentUser() });
          await this.store.save();
          this.onChanged();
          await this.postState();
          break;
        }
        case "pickAssignee": {
          const ui = detailPanelUi();
          const known = this.store.listAssignees();
          const picked = await vscode.window.showQuickPick(
            [
              ...(this.store.hasCurrentUser()
                ? [
                    {
                      label: `@${this.store.currentUser()}`,
                      description: ui.me,
                      value: this.store.currentUser(),
                    },
                  ]
                : []),
              ...known
                .filter(
                  (a) =>
                    !this.store.hasCurrentUser() || a !== this.store.currentUser()
                )
                .map((a) => ({ label: `@${a}`, value: a })),
              { label: ui.enterManually, value: "__custom__" },
              { label: ui.clearAssignee, value: "__clear__" },
            ],
            { title: ui.assignTitle }
          );
          if (!picked) return;
          let assignee: string | undefined;
          if (picked.value === "__clear__") {
            assignee = undefined;
          } else if (picked.value === "__custom__") {
            const typed = await vscode.window.showInputBox({
              prompt: ui.assigneePrompt,
              placeHolder: "alice",
            });
            if (typed === undefined) return;
            assignee = typed.trim().replace(/^@+/, "") || undefined;
          } else {
            assignee = picked.value;
          }
          this.store.updateTask(this.taskId, { assignee });
          await this.store.save();
          this.onChanged();
          await this.postState();
          break;
        }
        case "openFile": {
          const root = this.store.workspaceRoot;
          if (!root) throw new Error("No workspace");
          const full = resolveTaskFilePath(root, msg.path);
          if (!full) {
            void vscode.window.showWarningMessage(
              t("Proman: cannot open path outside workspace")
            );
            return;
          }
          const uri = vscode.Uri.file(full);
          try {
            await vscode.window.showTextDocument(uri, { preview: true });
          } catch {
            void vscode.window.showWarningMessage(
              t("Proman: file not found — {0}", msg.path)
            );
          }
          break;
        }
      }
    } catch (e) {
      void vscode.window.showErrorMessage(
        t("Proman: {0}", e instanceof Error ? e.message : String(e))
      );
    }
  }

  private async loadSideData(): Promise<void> {
    const root = this.store.workspaceRoot;
    if (!root) {
      this.comments = [];
      this.history = [];
      return;
    }
    this.comments = await loadComments(root, this.taskId);
    const all = await loadHistory(root);
    this.history = historyForTask(all, this.taskId, 15);
  }

  private async postState(): Promise<void> {
    await this.loadSideData();
    const ui = detailPanelUi();
    const state = this.store.current;
    const task = state?.tasks[this.taskId];
    if (!task || !state) {
      void this.panel.webview.postMessage({ type: "missing", ui });
      return;
    }
    const others = Object.values(state.tasks)
      .filter((node) => node.id !== task.id)
      .map((node) => ({ id: node.id, title: node.title, status: node.status }));
    const blocked = Object.values(state.tasks)
      .filter((node) => node.dependsOn.includes(task.id))
      .map((node) => node.title);
    const relations = others
      .filter(
        (o) =>
          task.dependsOn.includes(o.id) ||
          state.tasks[o.id]?.dependsOn.includes(task.id)
      )
      .map((o) => this.deps.describeRelation(state, task.id, o.id));

    void this.panel.webview.postMessage({
      type: "task",
      ui,
      task,
      others,
      blocked,
      relations,
      progress: this.store.progress(task.id),
      comments: this.comments,
      history: this.history,
      currentUser: getMetaCurrentUser(state.meta) ?? null,
      files: task.status === "done" ? collectDoneTaskFiles(state, task.id) : [],
    });
  }

  private html(): string {
    const nonce = String(Date.now());
    const loading = detailPanelUi().loading;
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
<style>
  :root {
    color-scheme: light dark;
    font-family: var(--vscode-font-family);
    font-size: 13px;
    color: var(--vscode-foreground);
  }
  body { margin: 0; padding: 16px 20px 32px; max-width: 720px; }
  h1 { font-size: 18px; font-weight: 600; margin: 0 0 4px; }
  h2 { font-size: 14px; font-weight: 600; margin: 20px 0 8px; }
  .sub { opacity: 0.7; margin-bottom: 16px; font-size: 12px; }
  label { display: block; margin: 12px 0 4px; opacity: 0.8; font-size: 12px; }
  input, textarea, select {
    width: 100%; box-sizing: border-box;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, rgba(127,127,127,.4));
    padding: 6px 8px; border-radius: 2px;
    font: inherit;
  }
  textarea { min-height: 120px; resize: vertical; }
  textarea#commentText { min-height: 56px; }
  select[multiple] { min-height: 110px; }
  .row { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 16px; }
  .meta-row { margin-top: 0; }
  .meta-row > div { flex: 1; min-width: 100px; }
  button {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none; padding: 6px 12px; cursor: pointer; border-radius: 2px;
  }
  button.secondary {
    background: transparent; color: var(--vscode-foreground);
    border: 1px solid var(--vscode-panel-border, rgba(127,127,127,.4));
  }
  button.danger { background: #a1260d; color: #fff; }
  .hint { margin-top: 8px; font-size: 12px; opacity: 0.75; line-height: 1.4; }
  ul { margin: 4px 0 0; padding-left: 18px; }
  .missing { opacity: 0.7; padding: 24px 0; }
  .comments, .history { margin-top: 4px; }
  .comment, .hist {
    padding: 8px 0;
    border-bottom: 1px solid var(--vscode-panel-border, rgba(127,127,127,.25));
    font-size: 12px; line-height: 1.45;
  }
  .comment .who, .hist .who { font-weight: 600; }
  .comment .when, .hist .when { opacity: 0.6; margin-left: 6px; font-weight: 400; }
  .comment .body { margin-top: 4px; white-space: pre-wrap; }
  .empty { opacity: 0.6; font-size: 12px; }
  .files { list-style: none; margin: 4px 0 0; padding: 0; }
  .files li {
    padding: 4px 0;
    border-bottom: 1px solid var(--vscode-panel-border, rgba(127,127,127,.2));
    font-size: 12px;
    display: flex; flex-wrap: wrap; gap: 6px; align-items: baseline;
  }
  .files a.file-link {
    color: var(--vscode-textLink-foreground);
    cursor: pointer;
    text-decoration: none;
    word-break: break-all;
  }
  .files a.file-link:hover { text-decoration: underline; }
  .files .meta { opacity: 0.65; font-size: 11px; }
</style>
</head>
<body>
  <div id="root" class="missing">${loading.replace(/</g, "&lt;")}</div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const root = document.getElementById('root');
    let ui = {};

    function esc(s) {
      return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    function fmt(template) {
      const args = Array.prototype.slice.call(arguments, 1);
      return String(template || '').replace(/\\{(\\d+)\\}/g, function(_, i) {
        return args[Number(i)] != null ? String(args[Number(i)]) : '';
      });
    }

    function fmtTime(iso) {
      try {
        const d = new Date(iso);
        return d.toLocaleString();
      } catch { return iso; }
    }

    function histLine(h) {
      if (h.kind === 'status') {
        return fmt(ui.histStatus, esc(h.from || '—'), esc(h.to || '—'));
      }
      if (h.kind === 'assignee') {
        return fmt(ui.histAssignee, esc(h.from ? '@'+h.from : '—'), esc(h.to ? '@'+h.to : '—'));
      }
      return fmt(ui.histComment, esc(h.message || ''));
    }

    function render(data) {
      if (data && data.ui) ui = data.ui;
      if (!data || data.type === 'missing') {
        root.innerHTML = '<div class="missing">'+esc(ui.missing || '')+'</div>';
        return;
      }
      const task = data.task;
      const comments = data.comments || [];
      const history = data.history || [];
      const me = data.currentUser;
      const opts = data.others.map(o =>
        '<option value="'+esc(o.id)+'"'+(task.dependsOn.includes(o.id)?' selected':'')+'>'+esc(o.title)+' ('+o.status+')</option>'
      ).join('');
      const commentHtml = comments.length
        ? comments.map(c =>
            '<div class="comment"><span class="who">@'+esc(c.author)+'</span><span class="when">'+esc(fmtTime(c.at))+'</span><div class="body">'+esc(c.text)+'</div></div>'
          ).join('')
        : '<div class="empty">'+esc(ui.noComments)+'</div>';
      const histHtml = history.length
        ? history.slice().reverse().map(h =>
            '<div class="hist"><span class="who">@'+esc(h.actor)+'</span><span class="when">'+esc(fmtTime(h.at))+'</span><div>'+histLine(h)+'</div></div>'
          ).join('')
        : '<div class="empty">'+esc(ui.historyEmpty)+'</div>';
      const files = data.files || [];
      const filesHtml = task.status === 'done'
        ? (files.length
            ? '<ul class="files">'+files.map(function(f) {
                const bits = [];
                if (f.kind === 'created') bits.push(esc(ui.fileCreated));
                else if (f.kind === 'modified') bits.push(esc(ui.fileModified));
                if (f.fromPlan) bits.push(esc(ui.fileFromPlan));
                if (f.fromTaskTitle) bits.push(esc(fmt(ui.fileFromSubtask, f.fromTaskTitle)));
                const meta = bits.length ? ' <span class="meta">('+bits.join(' · ')+')</span>' : '';
                return '<li><a class="file-link" href="#" data-path="'+esc(f.path)+'">'+esc(f.path)+'</a>'+meta+'</li>';
              }).join('')+'</ul>'
            : '<div class="empty">'+esc(ui.filesEmpty)+'</div>')
        : '';
      const filesSection = task.status === 'done'
        ? '<h2>'+esc(fmt(ui.filesHeading, files.length))+'</h2>'+filesHtml
        : '';
      const youBit = me ? fmt(ui.you, esc(me)) : esc(ui.userUnset);
      const branchBit = fmt(ui.branchProgress, data.progress.done, data.progress.total);
      const blocksHint = data.blocked.length
        ? fmt(ui.blocks, esc(data.blocked.join(', ')))
        : esc(ui.blocksNone);
      root.innerHTML = \`
        <h1 id="heading">\${esc(task.title)}</h1>
        <div class="sub">id: \${esc(task.id)} · source: \${esc(task.source)} · \${branchBit} · \${youBit}</div>
        <label>\${esc(ui.title)}</label>
        <input id="title" value="\${esc(task.title)}" />
        <label>\${esc(ui.status)}</label>
        <select id="status">
          <option value="todo" \${task.status==='todo'?'selected':''}>\${esc(ui.statusTodo)}</option>
          <option value="new" \${task.status==='new'?'selected':''}>\${esc(ui.statusNew)}</option>
          <option value="in_progress" \${task.status==='in_progress'?'selected':''}>\${esc(ui.statusInProgress)}</option>
          <option value="done" \${task.status==='done'?'selected':''}>\${esc(ui.statusDone)}</option>
          <option value="needs_rework" \${task.status==='needs_rework'?'selected':''}>\${esc(ui.statusRework)}</option>
          <option value="error" \${task.status==='error'?'selected':''}>\${esc(ui.statusError)}</option>
          <option value="blocked" \${task.status==='blocked'?'selected':''}>\${esc(ui.statusBlocked)}</option>
        </select>
        <div class="row meta-row">
          <div>
            <label>\${esc(ui.estimateSp)}</label>
            <input id="estimateSp" type="number" min="0" step="0.5" value="\${task.estimateSp != null ? task.estimateSp : ''}" placeholder="3" />
          </div>
          <div>
            <label>\${esc(ui.hours)}</label>
            <input id="estimateHours" type="number" min="0" step="0.5" value="\${task.estimateHours != null ? task.estimateHours : ''}" placeholder="2" />
          </div>
          <div>
            <label>\${esc(ui.assignee)}</label>
            <input id="assignee" value="\${esc(task.assignee||'')}" placeholder="@alice" />
          </div>
        </div>
        <div class="row" style="margin-top:8px">
          <button class="secondary" id="assignMe">\${esc(ui.assignToMe)}</button>
          <button class="secondary" id="pickAssignee">\${esc(ui.pickAssignee)}</button>
        </div>
        <label>\${esc(ui.tags)}</label>
        <input id="tags" value="\${esc((task.tags||[]).map(function(x){return '#'+x;}).join(' '))}" placeholder="#backend #api" />
        <label>\${esc(ui.description)}</label>
        <textarea id="desc">\${esc(task.description||'')}</textarea>
        <label>\${esc(ui.dependsOn)}</label>
        <select id="depends" multiple>\${opts}</select>
        <div class="hint">\${blocksHint}</div>
        <div class="hint">\${(data.relations||[]).map(esc).join('<br/>')}</div>
        \${task.impactHint ? '<div class="hint">Impact: '+esc(task.impactHint)+'</div>' : ''}
        <div class="row">
          <button id="save">\${esc(ui.save)}</button>
          <button class="secondary" id="addChild">\${esc(ui.addChild)}</button>
          <button class="secondary" id="run">\${esc(ui.runAgent)}</button>
          <button class="secondary" id="copy">\${esc(ui.copyPrompt)}</button>
          <button class="danger" id="del">\${esc(ui.delete)}</button>
        </div>

        \${filesSection}

        <h2>\${esc(fmt(ui.comments, comments.length))}</h2>
        <div class="comments">\${commentHtml}</div>
        <label>\${esc(ui.newComment)}</label>
        <textarea id="commentText" placeholder="\${esc(ui.commentPlaceholder)}"></textarea>
        <div class="row" style="margin-top:8px">
          <button id="addComment">\${esc(ui.addComment)}</button>
        </div>

        <h2>\${esc(ui.history)}</h2>
        <div class="history">\${histHtml}</div>
      \`;
      document.getElementById('save').onclick = () => {
        const depends = Array.from(document.getElementById('depends').selectedOptions).map(o => o.value);
        const spRaw = document.getElementById('estimateSp').value;
        const hRaw = document.getElementById('estimateHours').value;
        vscode.postMessage({
          type: 'save',
          title: document.getElementById('title').value,
          description: document.getElementById('desc').value,
          status: document.getElementById('status').value,
          dependsOn: depends,
          estimateSp: spRaw === '' ? null : Number(spRaw),
          estimateHours: hRaw === '' ? null : Number(hRaw),
          assignee: document.getElementById('assignee').value,
          tags: document.getElementById('tags').value
        });
      };
      document.getElementById('addChild').onclick = () => {
        vscode.postMessage({ type: 'addChild' });
      };
      document.getElementById('run').onclick = () => vscode.postMessage({ type: 'runAgent' });
      document.getElementById('copy').onclick = () => vscode.postMessage({ type: 'copyPrompt' });
      document.getElementById('del').onclick = () => {
        vscode.postMessage({ type: 'requestDelete' });
      };
      document.getElementById('addComment').onclick = () => {
        const text = document.getElementById('commentText').value;
        if (!text.trim()) return;
        vscode.postMessage({ type: 'addComment', text });
      };
      document.getElementById('assignMe').onclick = () => vscode.postMessage({ type: 'assignToMe' });
      document.getElementById('pickAssignee').onclick = () => vscode.postMessage({ type: 'pickAssignee' });
      root.querySelectorAll('a.file-link').forEach(function(a) {
        a.addEventListener('click', function(ev) {
          ev.preventDefault();
          const p = a.getAttribute('data-path');
          if (p) vscode.postMessage({ type: 'openFile', path: p });
        });
      });
    }

    window.addEventListener('message', e => render(e.data));
    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
  }

  dispose(): void {
    TaskDetailPanel.current = undefined;
    this.panel.dispose();
    while (this.disposables.length) this.disposables.pop()?.dispose();
  }
}
