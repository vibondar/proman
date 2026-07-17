import * as vscode from "vscode";
import { ProjectStore } from "./core/store";
import { MdImporter, PlanDiscoverer } from "./core/planDiscoverer";
import { t } from "./i18n";

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

  const roadmap = vscode.Uri.joinPath(folder.uri, "docs", "ROADMAP.md");
  try {
    await vscode.workspace.fs.stat(roadmap);
    const count = await importer.importUris([roadmap], "docs");
    vscode.window.showInformationMessage(
      t("Proman: loaded docs/ROADMAP.md ({0} nodes)", count)
    );
    return;
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
