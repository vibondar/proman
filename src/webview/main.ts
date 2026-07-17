import type {
  HostToWebview,
  ImpactPreview,
  ProjectState,
  TaskNode,
  TaskStatus,
  TreeProgress,
  WebviewToHost,
} from "../core/types";

declare function acquireVsCodeApi(): {
  postMessage(msg: WebviewToHost): void;
  getState(): unknown;
  setState(state: unknown): void;
};

const vscode = acquireVsCodeApi();

let state: ProjectState | null = null;
let progress: TreeProgress | null = null;
let impact: ImpactPreview | null = null;
let selectedId: string | null = null;
const expanded = new Set<string>();

function post(msg: WebviewToHost): void {
  vscode.postMessage(msg);
}

function statusLabel(s: TaskStatus): string {
  switch (s) {
    case "todo":
      return "todo";
    case "new":
      return "новая";
    case "in_progress":
      return "в работе";
    case "done":
      return "готово";
    case "needs_rework":
      return "доработка";
    case "error":
      return "ошибка";
    case "blocked":
      return "blocked";
  }
}

function renderTree(
  ids: string[],
  tasks: Record<string, TaskNode>,
  depth: number
): string {
  return ids
    .map((id) => {
      const t = tasks[id];
      if (!t) return "";
      const hasChildren = t.children.length > 0;
      const isOpen = expanded.has(id) || depth < 1;
      if (depth < 1) expanded.add(id);
      const sel = selectedId === id ? "selected" : "";
      const twisty = hasChildren ? (isOpen ? "▼" : "▶") : "·";
      const childHtml =
        hasChildren && isOpen
          ? `<div class="children">${renderTree(t.children, tasks, depth + 1)}</div>`
          : "";
      const depBadge = t.dependsOn.length
        ? `<span class="badge">dep:${t.dependsOn.length}</span>`
        : "";
      return `<div class="node" data-id="${id}">
        <div class="node-row ${sel}" data-action="select" data-id="${id}">
          <span class="twisty" data-action="toggle" data-id="${id}">${twisty}</span>
          <span class="status-dot ${t.status}" title="${statusLabel(t.status)}"></span>
          <span class="title ${t.status === "done" ? "done" : ""}">${escapeHtml(t.title)}</span>
          ${depBadge}
        </div>
        ${childHtml}
      </div>`;
    })
    .join("");
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderDetail(): string {
  if (!state || !selectedId || !state.tasks[selectedId]) {
    return `<div class="detail"><p class="empty">Выберите задачу в дереве</p></div>`;
  }
  const t = state.tasks[selectedId];
  const depOptions = Object.values(state.tasks)
    .filter((x) => x.id !== t.id)
    .map(
      (x) =>
        `<option value="${x.id}" ${t.dependsOn.includes(x.id) ? "selected" : ""}>${escapeHtml(x.title)}</option>`
    )
    .join("");

  const blockedBy = t.dependsOn
    .map((id) => state!.tasks[id])
    .filter(Boolean)
    .map((x) => escapeHtml(x!.title))
    .join(", ");

  return `<div class="detail">
    <h3>${escapeHtml(t.title)}</h3>
    <label>Статус</label>
    <select id="status">
      ${(
        ["todo", "new", "in_progress", "done", "needs_rework", "error", "blocked"] as TaskStatus[]
      )
        .map(
          (s) =>
            `<option value="${s}" ${t.status === s ? "selected" : ""}>${statusLabel(s)}</option>`
        )
        .join("")}
    </select>
    <label>Название</label>
    <input id="title" value="${escapeHtml(t.title)}" />
    <label>Описание</label>
    <textarea id="desc">${escapeHtml(t.description)}</textarea>
    <label>Зависит от (Ctrl/Cmd+клик)</label>
    <select id="depends" multiple size="4">${depOptions}</select>
    ${blockedBy ? `<p class="depends-hint">Блокируется: ${blockedBy}</p>` : ""}
    ${t.impactHint ? `<p class="depends-hint">Impact: ${escapeHtml(t.impactHint)}</p>` : ""}
    <p class="depends-hint">source: ${escapeHtml(t.source)}</p>
    <div class="row-actions">
      <button data-action="save">Сохранить</button>
      <button data-action="add-child">+ Подзадача</button>
      <button data-action="run-agent">Выполнить в Agent</button>
      <button data-action="copy-prompt" class="secondary">Копировать промпт</button>
      <button data-action="delete" class="danger">Удалить</button>
    </div>
  </div>`;
}

function renderImpact(): string {
  if (!impact) return "";
  if (!impact.ok) {
    return `<div class="impact error">
      <h3>Влияние</h3>
      <p>${escapeHtml(impact.error ?? "Ошибка")}</p>
      ${
        impact.cycles
          ? `<ul>${impact.cycles.map((c) => `<li>${escapeHtml(c.join(" → "))}</li>`).join("")}</ul>`
          : ""
      }
    </div>`;
  }
  if (!impact.affected.length) return "";
  return `<div class="impact">
    <h3>Влияние на план</h3>
    <ul>
      ${impact.affected
        .map(
          (a) =>
            `<li><strong>${escapeHtml(a.title)}</strong> — ${escapeHtml(a.change)}</li>`
        )
        .join("")}
    </ul>
  </div>`;
}

function render(): void {
  const app = document.getElementById("app");
  if (!app) return;

  try {
    const pct =
      progress && progress.total
        ? Math.round((progress.done / progress.total) * 100)
        : 0;

    const treeHtml =
      state && state.roots.length
        ? renderTree(state.roots, state.tasks, 0)
        : `<div class="empty">Нет задач. Нажмите «Импорт MD» или добавьте корневую задачу.${
            state ? ` (roots: ${state.roots.length}, tasks: ${Object.keys(state.tasks).length})` : " (state=null)"
          }</div>`;

    app.innerHTML = `
    <div class="toolbar">
      <button data-action="add-root">+ Задача</button>
      <button data-action="import" class="secondary">Импорт MD</button>
      <button data-action="enrich" class="secondary">Уточнить через Agent</button>
      <button data-action="recalc" class="secondary">Пересчёт</button>
    </div>
    <div class="progress-bar">
      <div class="meta">${
        progress
          ? `${progress.done}/${progress.total} готово · ${progress.inProgress} в работе · ${progress.blocked} blocked · ${pct}%`
          : "Проект не загружен"
      }</div>
      <div class="progress-track"><div class="progress-fill" style="width:${pct}%"></div></div>
    </div>
    <div class="tree">${treeHtml}</div>
    ${renderImpact()}
    ${renderDetail()}
  `;
  } catch (err) {
    app.innerHTML = `<div class="empty">Ошибка отрисовки: ${escapeHtml(
      err instanceof Error ? err.message : String(err)
    )}</div>`;
  }
}

function onClick(e: Event): void {
  const el = (e.target as HTMLElement).closest("[data-action]") as HTMLElement | null;
  if (!el) return;
  const action = el.dataset.action;
  const id = el.dataset.id;

  switch (action) {
    case "toggle":
      if (!id) return;
      if (expanded.has(id)) expanded.delete(id);
      else expanded.add(id);
      render();
      break;
    case "select":
      if (!id) return;
      selectedId = id;
      post({ type: "selectTask", taskId: id });
      render();
      break;
    case "add-root": {
      const title = prompt("Название задачи");
      if (!title) return;
      post({ type: "addTask", parentId: null, title });
      break;
    }
    case "add-child": {
      if (!selectedId) return;
      const title = prompt("Название подзадачи");
      if (!title) return;
      post({ type: "addTask", parentId: selectedId, title });
      break;
    }
    case "save": {
      if (!selectedId || !state) return;
      const title = (document.getElementById("title") as HTMLInputElement).value;
      const description = (document.getElementById("desc") as HTMLTextAreaElement).value;
      const status = (document.getElementById("status") as HTMLSelectElement)
        .value as TaskStatus;
      const dependsSelect = document.getElementById("depends") as HTMLSelectElement;
      const dependsOn = Array.from(dependsSelect.selectedOptions).map(
        (o: HTMLOptionElement) => o.value
      );
      post({
        type: "previewImpact",
        action: { kind: "updateDepends", taskId: selectedId, dependsOn },
      });
      post({
        type: "updateTask",
        taskId: selectedId,
        patch: { title, description, status, dependsOn },
      });
      break;
    }
    case "delete": {
      if (!selectedId) return;
      const cascade = confirm(
        "Удалить с подзадачами? OK = каскад, Отмена = поднять детей к родителю"
      );
      post({
        type: "deleteTask",
        taskId: selectedId,
        mode: cascade ? "cascade" : "promote",
      });
      selectedId = null;
      break;
    }
    case "run-agent":
      if (selectedId) post({ type: "runInAgent", taskId: selectedId });
      break;
    case "copy-prompt":
      if (selectedId) post({ type: "copyPrompt", taskId: selectedId });
      break;
    case "import":
      post({ type: "importMd" });
      break;
    case "enrich":
      post({ type: "enrichMd" });
      break;
    case "recalc":
      post({ type: "recalculate" });
      break;
  }
}

window.addEventListener("message", (event: MessageEvent<HostToWebview>) => {
  const msg = event.data;
  switch (msg.type) {
    case "state":
      state = msg.state;
      progress = msg.progress;
      render();
      break;
    case "impact":
      impact = msg.impact;
      render();
      break;
    case "toast":
      // host also shows notifications; keep impact area for errors
      break;
    case "ready":
      break;
  }
});

document.addEventListener("click", onClick);
post({ type: "ready" });
render();
