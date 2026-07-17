import * as vscode from "vscode";
import { ProjectStore } from "./core/store";
import { DependencyEngine } from "./core/dependencyEngine";
import { AgentHandoff } from "./agent/handoff";
import { MdImporter, PlanDiscoverer } from "./core/planDiscoverer";
import { HostToWebview, ImpactAction, WebviewToHost } from "./core/types";
import { t } from "./i18n";

export class PromanSidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "proman.sidebar";
  private view?: vscode.WebviewView;
  private selectedTaskId: string | null = null;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly store: ProjectStore,
    private readonly deps: DependencyEngine,
    private readonly handoff: AgentHandoff,
    private readonly importer: MdImporter,
    private readonly onImportRequest: () => Promise<void>,
    private readonly onSetPlanningDir: () => Promise<void>,
    private readonly onEnrich: () => Promise<void>
  ) {
    store.onDidChange(() => this.pushState());
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this.view = webviewView;
    const { webview } = webviewView;
    webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, "dist"),
        vscode.Uri.joinPath(this.context.extensionUri, "media"),
      ],
    };
    webview.html = this.getHtml(webview);

    webview.onDidReceiveMessage(async (msg: WebviewToHost) => {
      try {
        await this.handleMessage(msg);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        this.post({ type: "toast", level: "error", message });
        void vscode.window.showErrorMessage(`Proman: ${message}`);
      }
    });

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        void this.refreshFromDisk();
      }
    });

    void this.refreshFromDisk();
  }

  async refreshFromDisk(): Promise<void> {
    await this.store.load();
    this.pushState();
  }

  reveal(): void {
    void vscode.commands.executeCommand("proman.sidebar.focus");
  }

  private post(msg: HostToWebview): void {
    if (!this.view) return;
    // Structured clone can fail on exotic objects — send a plain JSON copy
    const payload = JSON.parse(JSON.stringify(msg)) as HostToWebview;
    void this.view.webview.postMessage(payload);
  }

  pushState(): void {
    const state = this.store.current;
    this.post({
      type: "state",
      state,
      progress: state ? this.store.progress() : null,
    });
  }

  private async handleMessage(msg: WebviewToHost): Promise<void> {
    switch (msg.type) {
      case "ready":
        await this.refreshFromDisk();
        break;
      case "selectTask":
        this.selectedTaskId = msg.taskId;
        break;
      case "addTask": {
        await this.store.ensureInitialized();
        const action: ImpactAction = {
          kind: "add",
          parentId: msg.parentId,
          title: msg.title,
        };
        const impact = this.deps.preview(this.store.current!, action);
        this.post({ type: "impact", impact });
        this.store.addTask(msg.parentId, msg.title);
        this.store.applyBlockedStatuses();
        await this.store.save();
        break;
      }
      case "updateTask": {
        await this.store.ensureInitialized();
        if (msg.patch.dependsOn) {
          const action: ImpactAction = {
            kind: "updateDepends",
            taskId: msg.taskId,
            dependsOn: msg.patch.dependsOn,
          };
          const impact = this.deps.preview(this.store.current!, action);
          this.post({ type: "impact", impact });
          if (!impact.ok) {
            this.post({ type: "toast", level: "error", message: impact.error ?? t("Cycle") });
            return;
          }
        }
        if (msg.patch.status) {
          this.store.setStatus(msg.taskId, msg.patch.status);
        } else {
          this.store.updateTask(msg.taskId, msg.patch);
          this.store.applyBlockedStatuses();
        }
        await this.store.save();
        break;
      }
      case "deleteTask": {
        await this.store.ensureInitialized();
        const action: ImpactAction = {
          kind: "delete",
          taskId: msg.taskId,
          mode: msg.mode,
        };
        const impact = this.deps.preview(this.store.current!, action);
        this.post({ type: "impact", impact });
        this.store.deleteTask(msg.taskId, msg.mode);
        this.store.applyBlockedStatuses();
        await this.store.save();
        break;
      }
      case "moveTask": {
        await this.store.ensureInitialized();
        this.store.moveTask(msg.taskId, msg.newParentId, msg.index);
        await this.store.save();
        break;
      }
      case "previewImpact": {
        if (!this.store.current) return;
        const impact = this.deps.preview(this.store.current, msg.action);
        this.post({ type: "impact", impact });
        break;
      }
      case "confirmImpact": {
        if (!this.store.current) return;
        const impact = this.deps.preview(this.store.current, msg.action);
        this.post({ type: "impact", impact });
        if (!impact.ok) {
          this.post({ type: "toast", level: "error", message: impact.error ?? t("Error") });
          return;
        }
        await this.applyAction(msg.action);
        break;
      }
      case "runInAgent":
        await this.handoff.runTask(msg.taskId);
        this.pushState();
        break;
      case "copyPrompt":
        await this.handoff.copyPrompt(msg.taskId);
        break;
      case "importMd":
        await this.onImportRequest();
        break;
      case "setPlanningDir":
        await this.onSetPlanningDir();
        break;
      case "enrichMd":
        await this.onEnrich();
        break;
      case "recalculate": {
        if (!this.store.current) return;
        const cycles = this.deps.detectCycles(this.store.current);
        if (cycles.length) {
          this.post({
            type: "toast",
            level: "error",
            message: t("Cycles: {0}", cycles.map((c) => c.join("→")).join("; ")),
          });
        }
        this.store.applyBlockedStatuses();
        await this.store.save();
        this.post({ type: "toast", level: "info", message: t("Dependencies recalculated") });
        break;
      }
    }
  }

  private async applyAction(action: ImpactAction): Promise<void> {
    await this.store.ensureInitialized();
    switch (action.kind) {
      case "add":
        this.store.addTask(action.parentId, action.title, {
          dependsOn: action.dependsOn,
        });
        break;
      case "delete":
        this.store.deleteTask(action.taskId, action.mode);
        break;
      case "updateDepends":
        this.store.updateTask(action.taskId, { dependsOn: action.dependsOn });
        break;
      case "setStatus":
        this.store.setStatus(action.taskId, action.status);
        break;
    }
    this.store.applyBlockedStatuses();
    await this.store.save();
  }

  getSelectedTaskId(): string | null {
    return this.selectedTaskId;
  }

  private getHtml(webview: vscode.Webview): string {
    const jsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "dist", "webview.js")
    );
    const cssUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "dist", "webview.css")
    );
    const nonce = getNonce();
    return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce};" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="stylesheet" href="${cssUri}" />
  <title>Proman</title>
</head>
<body>
  <div id="app"></div>
  <script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
  }
}

function getNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let n = "";
  for (let i = 0; i < 32; i++) n += chars.charAt(Math.floor(Math.random() * chars.length));
  return n;
}

export async function runOnboarding(
  store: ProjectStore,
  importer: MdImporter
): Promise<void> {
  await store.waitForWorkspace();
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    vscode.window.showWarningMessage(
      t(
        "Proman: open a project folder (File → Open Folder), then run “Proman: Import Planning Docs”."
      )
    );
    return;
  }

  const existing = await store.load();
  if (existing && existing.roots.length > 0) return;

  // Prefer known roadmap without forcing empty project
  const roadmap = vscode.Uri.joinPath(folder.uri, "docs", "ROADMAP.md");
  try {
    await vscode.workspace.fs.stat(roadmap);
    if (!existing || existing.roots.length === 0) {
      const count = await importer.importUris([roadmap], "docs");
      vscode.window.showInformationMessage(
        t("Proman: loaded docs/ROADMAP.md ({0} nodes)", count)
      );
      return;
    }
  } catch {
    /* no default roadmap */
  }

  const auto = vscode.workspace
    .getConfiguration("proman")
    .get<boolean>("autoDiscoverOnOpen", true);
  if (!auto) {
    await store.ensureInitialized();
    return;
  }

  const discoverer = new PlanDiscoverer(folder);
  const candidates = await discoverer.discover();

  type PickItem = vscode.QuickPickItem & {
    action: "candidate" | "empty" | "pick" | "skip";
    index?: number;
  };
  const items: PickItem[] = [
    ...candidates.map((c, index) => ({
      label: `$(file-directory) ${c.label}`,
      description: c.description,
      action: "candidate" as const,
      index,
    })),
    { label: t("$(add) Start with an empty tree"), action: "empty" },
    { label: t("$(folder-opened) Pick a folder manually…"), action: "pick" },
    { label: t("Later"), action: "skip" },
  ];

  const choice = await vscode.window.showQuickPick(items, {
    title: t("Proman: find planning documents?"),
    placeHolder: t("Choose a development plan source"),
  });
  if (!choice || choice.action === "skip") {
    await store.ensureInitialized();
    return;
  }
  if (choice.action === "empty") {
    await store.ensureInitialized();
    return;
  }
  if (choice.action === "pick") {
    const uris = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: true,
      canSelectMany: true,
      filters: { Markdown: ["md"] },
      openLabel: t("Import into Proman"),
    });
    if (!uris?.length) {
      await store.ensureInitialized();
      return;
    }
    let count = 0;
    const files: vscode.Uri[] = [];
    let planningDir: string | undefined;
    for (const u of uris) {
      try {
        const st = await vscode.workspace.fs.stat(u);
        if (st.type & vscode.FileType.Directory) {
          count += await importer.importDirectory(u);
          planningDir = vscode.workspace.asRelativePath(u);
        } else {
          files.push(u);
        }
      } catch {
        files.push(u);
      }
    }
    if (files.length) count += await importer.importUris(files, planningDir);
    vscode.window.showInformationMessage(t("Proman: imported tasks: {0}", count));
    return;
  }
  if (choice.action === "candidate" && choice.index !== undefined) {
    const c = candidates[choice.index];
    const count = await importer.importUris(
      c.uris,
      c.directory ? vscode.workspace.asRelativePath(c.directory) : undefined
    );
    vscode.window.showInformationMessage(t("Proman: imported tasks: {0}", count));
  }
}
