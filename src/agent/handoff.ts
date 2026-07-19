import * as vscode from "vscode";
import { ProjectStore } from "../core/store";
import { DependencyEngine } from "../core/dependencyEngine";
import { t } from "../i18n";
import { taskRunMarker } from "./runMarker";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Open Cursor Agent and put `prompt` into the chat input.
 * Cursor has no stable public API to pass a prompt; clipboard + paste is the
 * supported workaround. Does not auto-send — user reviews and presses Enter.
 */
export async function openAgentWithPrompt(prompt: string): Promise<boolean> {
  await vscode.env.clipboard.writeText(prompt);

  // Prefer commands that accept a query when available (VS Code / newer Cursor).
  const withArgs: Array<[string, unknown]> = [
    ["workbench.action.chat.open", { query: prompt }],
    ["workbench.action.chat.open", prompt],
    ["cursor.startComposerPrompt", prompt],
  ];
  for (const [cmd, arg] of withArgs) {
    try {
      await vscode.commands.executeCommand(cmd, arg);
      return true;
    } catch {
      /* try next */
    }
  }

  const openCmds = [
    "composer.newAgentChat",
    "composer.createNewComposer",
    "aichat.newchataction",
    "workbench.action.chat.open",
    "workbench.panel.chat.view.copilot.focus",
  ];
  for (const cmd of openCmds) {
    try {
      await vscode.commands.executeCommand(cmd);
      // Wait for Agent input to focus, then paste clipboard.
      await delay(200);
      try {
        await vscode.commands.executeCommand("editor.action.clipboardPasteAction");
      } catch {
        /* paste may fail if focus isn't in an input — prompt stays on clipboard */
      }
      return true;
    } catch {
      /* try next */
    }
  }
  return false;
}

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

    const marker = taskRunMarker(task.id);

    return (
      `${marker}\n\n` +
      t(
        `# Proman: run task

You are working in a project via the Proman extension. The task tree is the source of truth.

## Task
- **id:** \`{0}\`
- **title:** {1}
- **status:** {2}
- **source:** {3}
- **run marker:** \`{4}\` (must stay in the user message)

### Description
{5}

### Subtasks
{6}

### Depends on
{7}

### Blocks
{8}

### Impact on related features
{9}

## Instructions
0. **Gate:** Only treat this as a Proman tree run if the user message still contains \`{4}\`. If that marker was removed or the message is unrelated — do **not** call \`proman_set_task_status\` / change tree statuses.
1. First call \`proman_set_task_status\` with taskId=\`{0}\` and status=\`in_progress\` (this starts the tree spinner). Then \`proman_get_task\` for a snapshot.
2. Implement code changes **only within this task**.
3. Respect dependencies: do not break tasks listed under “Blocks”.
4. When finished, call \`proman_set_task_status\` with one of:
   - \`done\` — finished; **include \`files\`**: array of \`{ path, kind?\ }\` for created/modified workspace files (\`kind\`: \`created\`|\`modified\`)
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
        marker,
        task.description || none,
        children || none,
        blockers || none,
        blocked || none,
        relations || task.impactHint || t("(no explicit links)")
      )
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

  /**
   * Run task in Agent:
   * 1) write prompt under .proman/prompts/ (with PROMAN_TASK_RUN marker)
   * 2) open Agent and paste prompt (user sends with Enter)
   * 3) agent sets in_progress via MCP only if the marker is still in the message
   *    — that is what starts the tree spinner
   */
  async runTask(taskId: string): Promise<void> {
    await this.store.ensureInitialized();

    const prompt = this.buildTaskPrompt(taskId);
    const file = await this.savePrompt(taskId, prompt);

    const opened = await openAgentWithPrompt(prompt);
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
        await openAgentWithPrompt(prompt);
      }
    } else {
      vscode.window.showInformationMessage(
        t(
          "Agent opened with the task prompt. Send it to start work (spinner after in_progress). If you delete the prompt, the tree stays unchanged."
        )
      );
    }
  }

  async enrichFromMd(): Promise<void> {
    await this.store.ensureInitialized();
    const prompt = this.buildEnrichPrompt();
    const file = await this.savePrompt("enrich", prompt);
    const opened = await openAgentWithPrompt(prompt);
    if (!opened) {
      await vscode.window.showTextDocument(file);
      vscode.window.showInformationMessage(
        t("Enrichment prompt copied. Paste into Cursor Agent.")
      );
    } else {
      vscode.window.showInformationMessage(
        t("Agent opened with the task prompt. Review and press Enter to send.")
      );
    }
  }

  async copyPrompt(taskId: string): Promise<void> {
    const prompt = this.buildTaskPrompt(taskId);
    await this.savePrompt(taskId, prompt);
    await vscode.env.clipboard.writeText(prompt);
    vscode.window.showInformationMessage(t("Prompt copied to clipboard"));
  }
}
