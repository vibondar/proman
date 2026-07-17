import * as vscode from "vscode";
import {
  applyProposalToDisk,
  StructureProposal,
  writeProposal,
} from "./core/driveEngine";
import { parseStructureOps } from "./core/proposalOps";
import { wsMkdir, wsReadUri } from "./core/workspaceIo";
import { PromanMcpServer } from "./mcp/promanMcp";

/**
 * Watch .proman/proposals for pending items created by disk MCP server
 * and show human approve UI.
 */
export function startProposalWatcher(
  storeWorkspaceRoot: () => string | undefined,
  onApplied: () => Promise<void> | void
): vscode.Disposable {
  let watcher: vscode.FileSystemWatcher | undefined;
  let handling = false;

  const attach = async () => {
    watcher?.dispose();
    const root = storeWorkspaceRoot();
    if (!root) return;
    await wsMkdir(root, ".proman", "proposals");
    const dir = vscode.Uri.joinPath(vscode.Uri.file(root), ".proman", "proposals");
    const pattern = new vscode.RelativePattern(dir, "*.json");
    watcher = vscode.workspace.createFileSystemWatcher(pattern);
    const onCreateOrChange = async (uri: vscode.Uri) => {
      if (handling) return;
      try {
        const bytes = await wsReadUri(uri);
        const proposal = JSON.parse(Buffer.from(bytes).toString("utf8")) as StructureProposal;
        if (proposal.status !== "pending") return;
        const opsCheck = parseStructureOps(proposal.ops);
        if (!opsCheck.ok) {
          vscode.window.showErrorMessage(`Proman: некорректный proposal — ${opsCheck.error}`);
          return;
        }
        proposal.ops = opsCheck.ops;
        handling = true;
        const choice = await vscode.window.showInformationMessage(
          `Proman Agent предлагает изменить дерево:\n${proposal.summary}`,
          { modal: true, detail: proposal.rationale || undefined },
          "Принять",
          "Отклонить"
        );
        const rootDir = storeWorkspaceRoot();
        if (!rootDir) return;
        if (choice === "Принять") {
          await applyProposalToDisk(rootDir, proposal);
          proposal.status = "accepted";
          await writeProposal(rootDir, proposal);
          await onApplied();
          vscode.window.showInformationMessage("Proman: предложение агента принято");
        } else if (choice === "Отклонить") {
          proposal.status = "rejected";
          await writeProposal(rootDir, proposal);
          vscode.window.showInformationMessage("Proman: предложение отклонено");
        }
      } catch {
        /* ignore parse races */
      } finally {
        handling = false;
      }
    };
    watcher.onDidCreate(onCreateOrChange);
    watcher.onDidChange(onCreateOrChange);
  };

  void attach();
  const folderSub = vscode.workspace.onDidChangeWorkspaceFolders(() => void attach());

  return {
    dispose: () => {
      watcher?.dispose();
      folderSub.dispose();
    },
  };
}

async function tryOpenAgent(): Promise<boolean> {
  const candidates = [
    "composer.newAgentChat",
    "composer.createNewComposer",
    "aichat.newchataction",
    "workbench.action.chat.open",
  ];
  for (const cmd of candidates) {
    try {
      await vscode.commands.executeCommand(cmd);
      return true;
    } catch {
      /* next */
    }
  }
  return false;
}

export async function startDriveMode(mcp: PromanMcpServer): Promise<void> {
  const drive = mcp.getDrive();
  const file = await drive.startDriveHandoff();
  await tryOpenAgent();
  const pick = await vscode.window.showInformationMessage(
    "Drive Mode: промпт в буфере. Вставьте в Agent (Cmd+V) и отправьте. Статусы пишутся в дерево; структура — только после Approve.",
    "Открыть промпт",
    "Стоп Drive"
  );
  if (pick === "Открыть промпт") await vscode.window.showTextDocument(file);
  if (pick === "Стоп Drive") drive.stop();
}
