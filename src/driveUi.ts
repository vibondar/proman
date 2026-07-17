import * as vscode from "vscode";
import {
  applyProposalToDisk,
  StructureProposal,
  writeProposal,
} from "./core/driveEngine";
import { parseStructureOps } from "./core/proposalOps";
import { wsMkdir, wsReadUri } from "./core/workspaceIo";
import { PromanMcpServer } from "./mcp/promanMcp";
import { t } from "./i18n";

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
          vscode.window.showErrorMessage(
            t("Proman: invalid proposal — {0}", opsCheck.error)
          );
          return;
        }
        proposal.ops = opsCheck.ops;
        handling = true;
        const accept = t("Accept");
        const reject = t("Reject");
        const choice = await vscode.window.showInformationMessage(
          t("Proman Agent proposes a tree change:\n{0}", proposal.summary),
          { modal: true, detail: proposal.rationale || undefined },
          accept,
          reject
        );
        const rootDir = storeWorkspaceRoot();
        if (!rootDir) return;
        if (choice === accept) {
          await applyProposalToDisk(rootDir, proposal);
          proposal.status = "accepted";
          await writeProposal(rootDir, proposal);
          await onApplied();
          vscode.window.showInformationMessage(t("Proman: agent proposal accepted"));
        } else if (choice === reject) {
          proposal.status = "rejected";
          await writeProposal(rootDir, proposal);
          vscode.window.showInformationMessage(t("Proman: proposal rejected"));
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
  const openPrompt = t("Open prompt");
  const stopDrive = t("Stop Drive");
  const pick = await vscode.window.showInformationMessage(
    t(
      "Drive Mode: prompt is on the clipboard. Paste into Agent (Cmd+V) and send. Statuses are written to the tree; structure only after Approve."
    ),
    openPrompt,
    stopDrive
  );
  if (pick === openPrompt) await vscode.window.showTextDocument(file);
  if (pick === stopDrive) drive.stop();
}
