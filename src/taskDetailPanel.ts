import * as vscode from "vscode";
import { ProjectStore } from "./core/store";
import { DependencyEngine } from "./core/dependencyEngine";
import { TaskStatus } from "./core/types";
import { AgentHandoff } from "./agent/handoff";

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
  | { type: "addChild"; title: string }
  | { type: "runAgent" }
  | { type: "copyPrompt" };

export class TaskDetailPanel {
  public static current: TaskDetailPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private taskId: string;
  private disposables: vscode.Disposable[] = [];

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
    this.store.onDidChange(() => this.postState());
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
      TaskDetailPanel.current.postState();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      "proman.taskDetail",
      "Proman · Задача",
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
          this.postState();
          break;
        case "save": {
          const impact = this.deps.preview(this.store.current!, {
            kind: "updateDepends",
            taskId: this.taskId,
            dependsOn: msg.dependsOn,
          });
          if (!impact.ok) {
            void vscode.window.showErrorMessage(impact.error ?? "Цикл зависимостей");
            this.postState();
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
                  .map((t) => t.replace(/^#/, "").trim())
                  .filter(Boolean)
              : undefined,
          });
          this.store.setStatus(this.taskId, msg.status);
          await this.store.save();
          this.onChanged();
          this.panel.title = `Proman · ${msg.title}`;
          void vscode.window.showInformationMessage("Proman: задача сохранена");
          this.postState();
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
          this.store.addTask(this.taskId, msg.title);
          await this.store.save();
          this.onChanged();
          this.postState();
          break;
        }
        case "runAgent":
          await this.handoff.runTask(this.taskId);
          this.onChanged();
          this.postState();
          break;
        case "copyPrompt":
          await this.handoff.copyPrompt(this.taskId);
          break;
      }
    } catch (e) {
      void vscode.window.showErrorMessage(
        `Proman: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }

  private postState(): void {
    const state = this.store.current;
    const task = state?.tasks[this.taskId];
    if (!task || !state) {
      void this.panel.webview.postMessage({ type: "missing" });
      return;
    }
    const others = Object.values(state.tasks)
      .filter((t) => t.id !== task.id)
      .map((t) => ({ id: t.id, title: t.title, status: t.status }));
    const blocked = Object.values(state.tasks)
      .filter((t) => t.dependsOn.includes(task.id))
      .map((t) => t.title);
    const relations = others
      .filter((o) => task.dependsOn.includes(o.id) || state.tasks[o.id]?.dependsOn.includes(task.id))
      .map((o) => this.deps.describeRelation(state, task.id, o.id));

    void this.panel.webview.postMessage({
      type: "task",
      task,
      others,
      blocked,
      relations,
      progress: this.store.progress(task.id),
    });
  }

  private html(): string {
    const nonce = String(Date.now());
    return `<!DOCTYPE html>
<html lang="ru">
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
</style>
</head>
<body>
  <div id="root" class="missing">Загрузка…</div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const root = document.getElementById('root');

    function esc(s) {
      return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    function render(data) {
      if (!data || data.type === 'missing') {
        root.innerHTML = '<div class="missing">Задача не найдена. Выберите узел в дереве Proman.</div>';
        return;
      }
      const t = data.task;
      const opts = data.others.map(o =>
        '<option value="'+esc(o.id)+'"'+(t.dependsOn.includes(o.id)?' selected':'')+'>'+esc(o.title)+' ('+o.status+')</option>'
      ).join('');
      root.innerHTML = \`
        <h1 id="heading">\${esc(t.title)}</h1>
        <div class="sub">id: \${esc(t.id)} · source: \${esc(t.source)} · ветка: \${data.progress.done}/\${data.progress.total}</div>
        <label>Название</label>
        <input id="title" value="\${esc(t.title)}" />
        <label>Статус</label>
        <select id="status">
          <option value="todo" \${t.status==='todo'?'selected':''}>todo</option>
          <option value="new" \${t.status==='new'?'selected':''}>новая (синяя)</option>
          <option value="in_progress" \${t.status==='in_progress'?'selected':''}>in_progress</option>
          <option value="done" \${t.status==='done'?'selected':''}>готово (зелёная)</option>
          <option value="needs_rework" \${t.status==='needs_rework'?'selected':''}>доработка (жёлтая)</option>
          <option value="error" \${t.status==='error'?'selected':''}>ошибка (красная)</option>
          <option value="blocked" \${t.status==='blocked'?'selected':''}>blocked</option>
        </select>
        <div class="row meta-row">
          <div>
            <label>Оценка SP</label>
            <input id="estimateSp" type="number" min="0" step="0.5" value="\${t.estimateSp != null ? t.estimateSp : ''}" placeholder="3" />
          </div>
          <div>
            <label>Часы</label>
            <input id="estimateHours" type="number" min="0" step="0.5" value="\${t.estimateHours != null ? t.estimateHours : ''}" placeholder="2" />
          </div>
          <div>
            <label>Assignee</label>
            <input id="assignee" value="\${esc(t.assignee||'')}" placeholder="@alice" />
          </div>
        </div>
        <label>Теги (через пробел)</label>
        <input id="tags" value="\${esc((t.tags||[]).map(function(x){return '#'+x;}).join(' '))}" placeholder="#backend #api" />
        <label>Описание</label>
        <textarea id="desc">\${esc(t.description||'')}</textarea>
        <label>Зависит от (Cmd/Ctrl + клик)</label>
        <select id="depends" multiple>\${opts}</select>
        <div class="hint">\${data.blocked.length ? 'Блокирует: '+esc(data.blocked.join(', ')) : 'Никого не блокирует'}</div>
        <div class="hint">\${(data.relations||[]).map(esc).join('<br/>')}</div>
        \${t.impactHint ? '<div class="hint">Impact: '+esc(t.impactHint)+'</div>' : ''}
        <div class="row">
          <button id="save">Сохранить</button>
          <button class="secondary" id="addChild">+ Подзадача</button>
          <button class="secondary" id="run">Выполнить в Agent</button>
          <button class="secondary" id="copy">Копировать промпт</button>
          <button class="danger" id="del">Удалить</button>
        </div>
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
        const title = prompt('Название подзадачи');
        if (title) vscode.postMessage({ type: 'addChild', title });
      };
      document.getElementById('run').onclick = () => vscode.postMessage({ type: 'runAgent' });
      document.getElementById('copy').onclick = () => vscode.postMessage({ type: 'copyPrompt' });
      document.getElementById('del').onclick = () => {
        const cascade = confirm('Удалить с подзадачами?\\nOK = каскад, Отмена = поднять детей');
        vscode.postMessage({ type: 'delete', mode: cascade ? 'cascade' : 'promote' });
      };
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
