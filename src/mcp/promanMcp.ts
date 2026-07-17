import * as vscode from "vscode";
import * as path from "path";
import {
  nextActionable,
  readProposal,
  StructureProposal,
  writeProposal,
} from "../core/driveEngine";
import { ProjectStore } from "../core/store";
import { DependencyEngine } from "../core/dependencyEngine";
import { TaskNode, TaskStatus } from "../core/types";
import { resolvePlanningDir } from "../core/pathSafety";
import { parseStructureOps } from "../core/proposalOps";
import { wsMkdir, wsReadUri, wsWriteUri } from "../core/workspaceIo";

export class DriveSession {
  active = false;
  startedAt: string | null = null;

  constructor(
    private readonly store: ProjectStore,
    private readonly deps: DependencyEngine
  ) {}

  start(): void {
    this.active = true;
    this.startedAt = new Date().toISOString();
  }

  stop(): void {
    this.active = false;
  }

  buildDrivePrompt(): string {
    const state = this.store.current;
    if (!state) throw new Error("Проект не инициализирован");
    const next = nextActionable(state);
    const progress = this.store.progress();
    const queuePreview = next.queue
      .slice(0, 8)
      .map((q) => `- [${q.status}] ${q.title} (\`${q.id}\`)`)
      .join("\n");

    return `# Proman Drive Mode — агент ведёт дерево (human-in-the-loop)

Ты **оркестратор разработки** по дереву Proman. Источник правды — дерево в \`.proman/\`, не чат.

## Состояние
- Прогресс: ${progress.done}/${progress.total} done, ${progress.inProgress} in_progress, ${progress.blocked} blocked
- Режим Drive: активен
- Следующая задача: ${
      next.task
        ? `**${next.task.title}** (\`${next.task.id}\`) — ${next.reason}`
        : "нет (дерево закрыто или всё blocked)"
    }

### Очередь (разблокированные)
${queuePreview || "(пусто)"}

## Обязательный протокол (каждый цикл)
1. \`proman_next_actionable\` — узнать текущую цель (не угадывай).
2. Если задачи нет — кратко резюмируй прогресс и **остановись**, спроси человека что дальше.
3. \`proman_set_task_status\` → \`in_progress\` для выбранной задачи.
4. \`proman_get_task\` — контекст, зависимости, impact.
5. Реализуй **только эту задачу** в коде. Не расползайся по дереву.
6. По завершении выбери статус:
   - \`done\` — готово (зелёный)
   - \`needs_rework\` — сделано, но нужна доработка (жёлтый)
   - \`error\` — ошибка / блокер в реализации (красный)
   - или оставь \`in_progress\` + спроси человека, если неуверен.
7. Если затронул другую фичу — \`proman_report_impact\`.
8. Вернись к п.1 (следующая задача), пока человек не скажет стоп.

### Статусы (цвет в дереве Proman)
- \`todo\` — обычный цвет (исходные задачи из MD)
- \`new\` — синий (добавлены после формирования дерева)
- \`in_progress\` — в работе
- \`done\` — зелёный
- \`needs_rework\` — жёлтый
- \`error\` — красный
- \`blocked\` — ждут зависимости (ставит система)

## Структура дерева — только с approve человека
- **Не** вызывай «тихо» массовый upsert/delete.
- Любое изменение структуры (новые узлы, удаление, смена dependsOn, дробление задачи) — только через:
  \`proman_propose_structure_change\` с summary + rationale + ops.
- Дождись \`proman_get_proposal_status\`: \`accepted\` / \`rejected\`.
- Статусы задач (\`set_task_status\`) — можно сразу, без proposal (это ход выполнения).

## Участие разработчика
- Если риск регресса, неоднозначность требований или ломаются зависимости — **спроси** в чате и жди ответа.
- Не помечай done без реальных изменений или явного «оставить как есть» от человека.
- После 1–3 закрытых задач можно кратко отчитаться и спросить: продолжать цикл?

## Tools
Используй MCP-сервер **proman** (Cursor Settings → Tools & MCP → proman должен быть зелёным).
Tools: proman_get_tree, proman_get_task, proman_next_actionable, proman_set_task_status,
proman_report_impact, proman_propose_structure_change, proman_get_proposal_status.

Если MCP недоступен: скажи человеку включить сервер proman в Settings → MCP и сделать Reload Window.
Не выдумывай статусы — читай \`.proman/tree.json\`.

Начни сейчас: вызови \`proman_next_actionable\` и покажи человеку план на первую задачу (1–3 пункта), затем приступай.
`;
  }

  async startDriveHandoff(): Promise<vscode.Uri> {
    await this.store.ensureInitialized();
    this.start();
    const prompt = this.buildDrivePrompt();
    const proman = this.store.promanUri!;
    const dir = vscode.Uri.joinPath(proman, "prompts");
    await vscode.workspace.fs.createDirectory(dir);
    const file = vscode.Uri.joinPath(dir, "drive.md");
    await vscode.workspace.fs.writeFile(file, Buffer.from(prompt, "utf8"));
    await vscode.env.clipboard.writeText(prompt);
    return file;
  }
}

export class PromanMcpServer {
  private drive: DriveSession;

  constructor(
    private readonly store: ProjectStore,
    private readonly deps: DependencyEngine
  ) {
    this.drive = new DriveSession(store, deps);
  }

  getDrive(): DriveSession {
    return this.drive;
  }

  listTools() {
    return [
      {
        name: "proman_get_tree",
        description: "Snapshot of Proman task tree",
        inputSchema: {
          type: "object",
          properties: { rootId: { type: "string" } },
        },
      },
      {
        name: "proman_get_task",
        description: "Task + dependencies + impact",
        inputSchema: {
          type: "object",
          properties: { taskId: { type: "string" } },
          required: ["taskId"],
        },
      },
      {
        name: "proman_next_actionable",
        description:
          "Next unblocked todo/new/in_progress/needs_rework task for Drive Mode (prefer in_progress, then needs_rework)",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "proman_set_task_status",
        description:
          "Set task status: todo|new|in_progress|done|needs_rework|error|blocked (no human approve needed)",
        inputSchema: {
          type: "object",
          properties: {
            taskId: { type: "string" },
            status: {
              type: "string",
              enum: ["todo", "new", "in_progress", "done", "needs_rework", "error", "blocked"],
            },
          },
          required: ["taskId", "status"],
        },
      },
      {
        name: "proman_report_impact",
        description: "Write impactHint on a task",
        inputSchema: {
          type: "object",
          properties: {
            taskId: { type: "string" },
            impactHint: { type: "string" },
          },
          required: ["taskId", "impactHint"],
        },
      },
      {
        name: "proman_propose_structure_change",
        description:
          "Propose tree structure change for HUMAN approval (upsert/delete/depends). Does not apply until accepted.",
        inputSchema: {
          type: "object",
          properties: {
            summary: { type: "string" },
            rationale: { type: "string" },
            ops: { type: "array", description: "Array of ops: upsert|delete|setStatus|setDepends" },
          },
          required: ["summary", "ops"],
        },
      },
      {
        name: "proman_get_proposal_status",
        description: "Check human decision on a structure proposal",
        inputSchema: {
          type: "object",
          properties: { proposalId: { type: "string" } },
          required: ["proposalId"],
        },
      },
      {
        name: "proman_list_planning_files",
        description: "List MD files in planningDir",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "proman_drive_status",
        description: "Whether Drive Mode session is active in the IDE",
        inputSchema: { type: "object", properties: {} },
      },
    ];
  }

  async callTool(
    name: string,
    args: Record<string, unknown>
  ): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
    try {
      switch (name) {
        case "proman_get_tree":
          return this.ok(this.getTree(args.rootId as string | undefined));
        case "proman_get_task":
          return this.ok(this.getTask(String(args.taskId)));
        case "proman_next_actionable":
          return this.ok(this.nextActionable());
        case "proman_set_task_status":
          await this.setStatus(String(args.taskId), args.status as TaskStatus);
          return this.ok({ ok: true });
        case "proman_report_impact":
          await this.reportImpact(String(args.taskId), String(args.impactHint));
          return this.ok({ ok: true });
        case "proman_propose_structure_change": {
          const parsed = parseStructureOps(args.ops);
          if (!parsed.ok) return this.fail(parsed.error);
          return this.ok(
            await this.proposeStructure(
              String(args.summary ?? ""),
              String(args.rationale ?? ""),
              parsed.ops
            )
          );
        }
        case "proman_get_proposal_status":
          return this.ok(await this.proposalStatus(String(args.proposalId)));
        case "proman_list_planning_files":
          return this.ok(await this.listPlanningFiles());
        case "proman_drive_status":
          return this.ok({
            active: this.drive.active,
            startedAt: this.drive.startedAt,
          });
        // legacy alias kept for old prompts
        case "proman_upsert_tasks": {
          const parsed = parseStructureOps([
            {
              op: "upsert",
              tasks: args.tasks,
              parentId: (args.parentId as string) ?? null,
            },
          ]);
          if (!parsed.ok) return this.fail(parsed.error);
          return this.ok(
            await this.proposeStructure(
              "Legacy upsert via proman_upsert_tasks",
              "Wrapped as proposal for human approve",
              parsed.ops
            )
          );
        }
        default:
          return {
            content: [{ type: "text", text: `Unknown tool: ${name}` }],
            isError: true,
          };
      }
    } catch (e) {
      return {
        content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }],
        isError: true,
      };
    }
  }

  private ok(data: unknown): {
    content: Array<{ type: "text"; text: string }>;
    isError?: boolean;
  } {
    return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
  }

  private fail(message: string): {
    content: Array<{ type: "text"; text: string }>;
    isError?: boolean;
  } {
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ error: message }, null, 2) }],
      isError: true,
    };
  }

  private getTree(rootId?: string) {
    const state = this.store.current;
    if (!state) return { error: "no project" };
    if (!rootId) {
      return { meta: state.meta, roots: state.roots, tasks: state.tasks, progress: this.store.progress() };
    }
    const tasks: Record<string, TaskNode> = {};
    const collect = (id: string) => {
      const t = state.tasks[id];
      if (!t) return;
      tasks[id] = t;
      for (const c of t.children) collect(c);
    };
    collect(rootId);
    return { rootId, tasks, progress: this.store.progress(rootId) };
  }

  private getTask(taskId: string) {
    const state = this.store.current;
    if (!state) return { error: "no project" };
    const task = state.tasks[taskId];
    if (!task) return { error: "not found" };
    const blockers = task.dependsOn.map((id) => state.tasks[id]).filter(Boolean);
    const blocked = Object.values(state.tasks).filter((t) => t.dependsOn.includes(taskId));
    const relations = blocked.map((b) => this.deps.describeRelation(state, taskId, b.id));
    return { task, blockers, blocked, relations, impactHint: task.impactHint };
  }

  private nextActionable() {
    const state = this.store.current;
    if (!state) return { error: "no project" };
    const result = nextActionable(state);
    return {
      reason: result.reason,
      task: result.task,
      queue: result.queue,
      driveActive: this.drive.active,
    };
  }

  private async setStatus(taskId: string, status: TaskStatus) {
    await this.store.ensureInitialized();
    this.store.setStatus(taskId, status);
    await this.store.save();
  }

  private async reportImpact(taskId: string, impactHint: string) {
    await this.store.ensureInitialized();
    this.store.updateTask(taskId, { impactHint });
    await this.store.save();
  }

  private async proposeStructure(
    summary: string,
    rationale: string,
    ops: StructureProposal["ops"]
  ) {
    const root = this.store.workspaceRoot;
    if (!root) throw new Error("no workspace");
    const id = `p_${Date.now().toString(36)}`;
    const proposal: StructureProposal = {
      id,
      createdAt: new Date().toISOString(),
      summary: summary || "Structure change",
      rationale,
      status: "pending",
      ops,
    };
    await writeProposal(root, proposal);

    // Human-in-the-loop in IDE
    const choice = await vscode.window.showInformationMessage(
      `Proman Agent предлагает изменить дерево:\n${proposal.summary}`,
      { modal: true, detail: rationale || undefined },
      "Принять",
      "Отклонить",
      "Открыть JSON"
    );

    if (choice === "Открыть JSON") {
      const file = vscode.Uri.file(path.join(root, ".proman", "proposals", `${id}.json`));
      await vscode.window.showTextDocument(file);
      const again = await vscode.window.showInformationMessage(
        "Принять предложение агента?",
        "Принять",
        "Отклонить"
      );
      return this.resolveProposal(id, again === "Принять");
    }
    if (choice === "Принять") return this.resolveProposal(id, true);
    return this.resolveProposal(id, false);
  }

  private async resolveProposal(proposalId: string, accept: boolean) {
    const root = this.store.workspaceRoot!;
    const proposal = await readProposal(root, proposalId);
    if (!proposal) return { error: "proposal not found", proposalId };

    if (!accept) {
      proposal.status = "rejected";
      await writeProposal(root, proposal);
      return { proposalId, status: "rejected" };
    }

    // Apply via live store
    const state = this.store.current;
    if (!state) return { error: "no project" };

    for (const op of proposal.ops) {
      if (op.op === "upsert") {
        this.store.upsertTasks(op.tasks, op.parentId ?? null);
      } else if (op.op === "delete") {
        this.store.deleteTask(op.taskId, op.mode);
      } else if (op.op === "setStatus") {
        this.store.setStatus(op.taskId, op.status);
      } else if (op.op === "setDepends") {
        this.store.updateTask(op.taskId, { dependsOn: op.dependsOn });
      }
    }
    this.store.applyBlockedStatuses();
    await this.store.save();

    proposal.status = "accepted";
    await writeProposal(root, proposal);
    return { proposalId, status: "accepted", appliedOps: proposal.ops.length };
  }

  private async proposalStatus(proposalId: string) {
    const root = this.store.workspaceRoot;
    if (!root) return { error: "no workspace" };
    const p = await readProposal(root, proposalId);
    if (!p) return { error: "not found", proposalId };
    return { proposalId, status: p.status, summary: p.summary };
  }

  private async listPlanningFiles() {
    const state = this.store.current;
    const root = this.store.workspaceRoot;
    if (!state?.meta.planningDir || !root) return [];
    const resolved = resolvePlanningDir(root, state.meta.planningDir);
    if (!resolved) return [];
    const dir = vscode.Uri.file(resolved);
    try {
      const files = await vscode.workspace.findFiles(
        new vscode.RelativePattern(dir, "**/*.md"),
        null,
        100
      );
      return files.map((f) => vscode.workspace.asRelativePath(f));
    } catch {
      return [];
    }
  }

  registerWithCursor(context: vscode.ExtensionContext): void {
    const cursor = (vscode as unknown as { cursor?: { mcp?: { registerServer?: Function } } })
      .cursor;
    if (cursor?.mcp?.registerServer) {
      try {
        cursor.mcp.registerServer({
          name: "proman",
          version: "0.3.0",
          tools: this.listTools(),
          callTool: (name: string, args: Record<string, unknown>) => this.callTool(name, args),
        });
      } catch (e) {
        console.warn("Proman: cursor.mcp.registerServer failed", e);
      }
    }

    // Intentionally NOT registering proman.mcpCall — other extensions must not invoke tools.
    // Agent uses stdio MCP (mcp/server.cjs) only.

    void this.ensureMcpConfig(context);
  }

  private async ensureMcpConfig(context: vscode.ExtensionContext): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) return;

    const bundled = vscode.Uri.joinPath(context.extensionUri, "mcp", "server.cjs");
    const bundledFallback = vscode.Uri.joinPath(context.extensionUri, "mcp", "server.mjs");
    let sourceUri = bundled;
    try {
      await vscode.workspace.fs.stat(bundled);
    } catch {
      try {
        await vscode.workspace.fs.stat(bundledFallback);
        sourceUri = bundledFallback;
      } catch {
        console.warn("Proman: bundled MCP server missing");
        return;
      }
    }

    const root = folder.uri.fsPath;
    await wsMkdir(root, ".proman");
    const localServer = path.join(root, ".proman", "mcp-server.cjs");
    const localUri = vscode.Uri.file(localServer);
    const serverBytes = await wsReadUri(sourceUri);
    await wsWriteUri(localUri, serverBytes);

    const mcpUri = vscode.Uri.joinPath(folder.uri, ".cursor", "mcp.json");
    let config: { mcpServers?: Record<string, unknown> } = {};
    let fileExists = false;
    try {
      await vscode.workspace.fs.stat(mcpUri);
      fileExists = true;
      const raw = await wsReadUri(mcpUri);
      config = JSON.parse(Buffer.from(raw).toString("utf8"));
    } catch {
      if (fileExists) {
        console.warn("Proman: could not parse .cursor/mcp.json — leaving file untouched");
        return;
      }
      /* missing — will create */
    }
    config.mcpServers = config.mcpServers ?? {};

    const desired = {
      type: "stdio",
      command: "node",
      args: [localServer],
      env: {
        PROMAN_WORKSPACE: folder.uri.fsPath,
      },
    };

    const existing = config.mcpServers.proman;
    if (existing && !isPromanManagedMcpEntry(existing, localServer, folder.uri.fsPath)) {
      console.warn(
        "Proman: .cursor/mcp.json already has a custom proman entry — not overwriting"
      );
      return;
    }

    config.mcpServers.proman = desired;
    await wsWriteUri(mcpUri, Buffer.from(JSON.stringify(config, null, 2), "utf8"));
    if (!fileExists) {
      console.log("Proman: wrote .cursor/mcp.json");
    }
  }
}

function isPromanManagedMcpEntry(
  entry: unknown,
  localServer: string,
  workspaceRoot: string
): boolean {
  if (!entry || typeof entry !== "object") return false;
  const e = entry as { command?: string; args?: unknown; env?: Record<string, unknown> };
  if (e.command !== "node" || !Array.isArray(e.args) || typeof e.args[0] !== "string") {
    return false;
  }
  const arg = e.args[0] as string;
  const marker = `${path.sep}.proman${path.sep}mcp-server.cjs`;
  const underWorkspace =
    arg === localServer ||
    arg.endsWith(marker) ||
    arg.endsWith("/.proman/mcp-server.cjs");
  if (!underWorkspace) return false;
  // Prefer entries that target this workspace
  const envWs = e.env?.PROMAN_WORKSPACE;
  if (typeof envWs === "string" && envWs !== workspaceRoot) return false;
  return true;
}
