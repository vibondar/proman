import * as vscode from "vscode";
import { ProjectStore } from "../core/store";
import { DependencyEngine } from "../core/dependencyEngine";
import { t } from "../i18n";

export class AgentHandoff {
  constructor(
    private readonly store: ProjectStore,
    private readonly deps: DependencyEngine
  ) {}

  buildTaskPrompt(taskId: string): string {
    const state = this.store.current;
    if (!state) throw new Error("Proman project is not initialized");
    const task = state.tasks[taskId];
    if (!task) throw new Error("Task not found");

    const none = t("(none)");
    const blockers = task.dependsOn
      .map((id) => state.tasks[id])
      .filter(Boolean)
      .map((node) => `- [${node!.status}] ${node!.title} (${node!.id})`)
      .join("\n");

    const blocked = Object.values(state.tasks)
      .filter((node) => node.dependsOn.includes(taskId))
      .map((node) => `- [${node.status}] ${node.title} (${node.id})`)
      .join("\n");

    const children = task.children
      .map((id) => state.tasks[id])
      .filter(Boolean)
      .map((node) => `- [${node!.status}] ${node!.title}`)
      .join("\n");

    const relations = Object.values(state.tasks)
      .filter(
        (node) =>
          node.id !== taskId &&
          (node.dependsOn.includes(taskId) || task.dependsOn.includes(node.id))
      )
      .map((node) => this.deps.describeRelation(state, taskId, node.id))
      .join("\n");

    return t(
      `# Proman: run task

You are working in a project via the Proman extension. The task tree is the source of truth.

## Task
- **id:** \`{0}\`
- **title:** {1}
- **status:** {2}
- **source:** {3}

### Description
{4}

### Subtasks
{5}

### Depends on
{6}

### Blocks
{7}

### Impact on related features
{8}

## Instructions
1. If needed, first call MCP/command \`proman_get_task\` with taskId=\`{0}\` for an up-to-date snapshot.
2. Implement code changes **only within this task**.
3. Respect dependencies: do not break tasks listed under “Blocks”.
4. When finished, call \`proman_set_task_status\` with one of:
   - \`done\` — finished
   - \`needs_rework\` — done but needs rework
   - \`error\` — error / could not complete
   - \`in_progress\` — leftover work remains
5. If you find impact on another feature — \`proman_report_impact\` with a short note.

Start with a brief plan, then edit the code.
`,
      task.id,
      task.title,
      task.status,
      task.source,
      task.description || none,
      children || none,
      blockers || none,
      blocked || none,
      relations || task.impactHint || t("(no explicit links)")
    );
  }

  buildEnrichPrompt(): string {
    const state = this.store.current;
    const planning =
      state?.meta.planningDir ?? t("(not set — use .proman/imports and docs)");
    return (
      t(
        `# Proman: refine the task tree from MD

The workspace has planning documents (directory: \`{0}\`).

1. Call \`proman_list_planning_files\` and read the listed MD files.
2. Call \`proman_get_tree\` — current tree (may have been built by the parser).
3. Refine hierarchy, statuses, and dependencies (dependsOn).
4. Return updated nodes via \`proman_upsert_tasks\` (TaskNode array: id, title, description, status, children, dependsOn, source).
5. Do not delete manually added tasks with source=manual unless necessary.

TaskNode schema:`,
        planning
      ) +
      `
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
`
    );
  }

  async savePrompt(taskId: string | "enrich", body: string): Promise<vscode.Uri> {
    const proman = this.store.promanUri;
    if (!proman) throw new Error("No workspace");
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
      const openChat = t("Open Chat");
      const pick = await vscode.window.showInformationMessage(
        t(
          "Prompt copied to clipboard. Open Cursor Agent (Chat) and paste it. Tools: MCP proman_*."
        ),
        openChat
      );
      if (pick === openChat) {
        await this.tryOpenCursorAgent(prompt);
      }
    } else {
      vscode.window.showInformationMessage(
        t("Task prompt copied. Paste into Agent (Cmd+V) if the chat is empty.")
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
        t("Enrichment prompt copied. Paste into Cursor Agent.")
      );
    }
  }

  async copyPrompt(taskId: string): Promise<void> {
    const prompt = this.buildTaskPrompt(taskId);
    await this.savePrompt(taskId, prompt);
    await vscode.env.clipboard.writeText(prompt);
    vscode.window.showInformationMessage(t("Prompt copied to clipboard"));
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
