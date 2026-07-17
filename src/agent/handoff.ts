import * as vscode from "vscode";
import { ProjectStore } from "../core/store";
import { DependencyEngine } from "../core/dependencyEngine";

export class AgentHandoff {
  constructor(
    private readonly store: ProjectStore,
    private readonly deps: DependencyEngine
  ) {}

  buildTaskPrompt(taskId: string): string {
    const state = this.store.current;
    if (!state) throw new Error("Проект Proman не инициализирован");
    const task = state.tasks[taskId];
    if (!task) throw new Error("Задача не найдена");

    const blockers = task.dependsOn
      .map((id) => state.tasks[id])
      .filter(Boolean)
      .map((t) => `- [${t!.status}] ${t!.title} (${t!.id})`)
      .join("\n");

    const blocked = Object.values(state.tasks)
      .filter((t) => t.dependsOn.includes(taskId))
      .map((t) => `- [${t.status}] ${t.title} (${t.id})`)
      .join("\n");

    const children = task.children
      .map((id) => state.tasks[id])
      .filter(Boolean)
      .map((t) => `- [${t!.status}] ${t!.title}`)
      .join("\n");

    const relations = Object.values(state.tasks)
      .filter((t) => t.id !== taskId && (t.dependsOn.includes(taskId) || task.dependsOn.includes(t.id)))
      .map((t) => this.deps.describeRelation(state, taskId, t.id))
      .join("\n");

    return `# Proman: выполнить задачу

Ты работаешь в проекте через расширение Proman. Источник правды — дерево задач.

## Задача
- **id:** \`${task.id}\`
- **title:** ${task.title}
- **status:** ${task.status}
- **source:** ${task.source}

### Описание
${task.description || "(нет)"}

### Подзадачи
${children || "(нет)"}

### Зависит от
${blockers || "(нет)"}

### Блокирует
${blocked || "(нет)"}

### Влияние на связанные фичи
${relations || task.impactHint || "(нет явных связей)"}

## Инструкции
1. Сначала при необходимости вызови MCP/команду \`proman_get_task\` с taskId=\`${task.id}\` для актуального снимка.
2. Реализуй изменения в кодовой базе **только в рамках этой задачи**.
3. Учитывай зависимости: не ломай задачи из «Блокирует».
4. По завершении вызови \`proman_set_task_status\` с одним из:
   - \`done\` — готово
   - \`needs_rework\` — сделано, но нужна доработка
   - \`error\` — ошибка / не удалось
   - \`in_progress\` — остались хвосты
5. Если обнаружил влияние на другую фичу — \`proman_report_impact\` с кратким текстом.

Начни с краткого плана, затем правь код.
`;
  }

  buildEnrichPrompt(): string {
    const state = this.store.current;
    const planning = state?.meta.planningDir ?? "(не задана — используй .proman/imports и docs)";
    return `# Proman: уточнить дерево задач из MD

В workspace есть planning-документы (директория: \`${planning}\`).

1. Вызови \`proman_list_planning_files\` и прочитай указанные MD.
2. Вызови \`proman_get_tree\` — текущее дерево (могло быть построено парсером).
3. Уточни иерархию, статусы и зависимости (dependsOn).
4. Верни обновлённые узлы через \`proman_upsert_tasks\` (массив TaskNode: id, title, description, status, children, dependsOn, source).
5. Не удаляй вручную добавленные задачи со source=manual без необходимости.

Схема TaskNode:
\`\`\`json
{
  "id": "string",
  "title": "string",
  "description": "string",
  "status": "todo|new|in_progress|done|needs_rework|error|blocked",
  "children": ["id"],
  "dependsOn": ["id"],
  "source": "md:path"
}
\`\`\`
`;
  }

  async savePrompt(taskId: string | "enrich", body: string): Promise<vscode.Uri> {
    const proman = this.store.promanUri;
    if (!proman) throw new Error("Нет workspace");
    const dir = vscode.Uri.joinPath(proman, "prompts");
    await vscode.workspace.fs.createDirectory(dir);
    const file = vscode.Uri.joinPath(dir, `${taskId}.md`);
    await vscode.workspace.fs.writeFile(file, Buffer.from(body, "utf8"));
    return file;
  }

  async runTask(taskId: string): Promise<void> {
    await this.store.ensureInitialized();
    this.store.setStatus(taskId, "in_progress");
    await this.store.save();

    const prompt = this.buildTaskPrompt(taskId);
    const file = await this.savePrompt(taskId, prompt);
    await vscode.env.clipboard.writeText(prompt);

    const opened = await this.tryOpenCursorAgent(prompt);
    if (!opened) {
      await vscode.window.showTextDocument(file);
      const pick = await vscode.window.showInformationMessage(
        "Промпт скопирован в буфер. Откройте Cursor Agent (Chat) и вставьте его. Tools: MCP proman_*.",
        "Открыть Chat"
      );
      if (pick === "Открыть Chat") {
        await this.tryOpenCursorAgent(prompt);
      }
    } else {
      vscode.window.showInformationMessage(
        "Промпт задачи скопирован. Вставьте в Agent (Cmd+V), если чат пуст."
      );
    }
  }

  async enrichFromMd(): Promise<void> {
    await this.store.ensureInitialized();
    const prompt = this.buildEnrichPrompt();
    const file = await this.savePrompt("enrich", prompt);
    await vscode.env.clipboard.writeText(prompt);
    const opened = await this.tryOpenCursorAgent(prompt);
    if (!opened) {
      await vscode.window.showTextDocument(file);
      vscode.window.showInformationMessage(
        "Промпт обогащения скопирован. Вставьте в Cursor Agent."
      );
    }
  }

  async copyPrompt(taskId: string): Promise<void> {
    const prompt = this.buildTaskPrompt(taskId);
    await this.savePrompt(taskId, prompt);
    await vscode.env.clipboard.writeText(prompt);
    vscode.window.showInformationMessage("Промпт скопирован в буфер обмена");
  }

  private async tryOpenCursorAgent(_prompt: string): Promise<boolean> {
    const candidates = [
      "composer.newAgentChat",
      "composer.createNewComposer",
      "aichat.newchataction",
      "workbench.action.chat.open",
      "workbench.panel.chat.view.copilot.focus",
    ];
    for (const cmd of candidates) {
      try {
        await vscode.commands.executeCommand(cmd);
        return true;
      } catch {
        /* try next */
      }
    }
    return false;
  }
}
