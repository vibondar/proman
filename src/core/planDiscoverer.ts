import { mergeParsed, parseMarkdownToTree } from "./mdParser";
import { isPlanDocument } from "./planFrontmatter";
import { sanitizeImportBasename } from "./proposalOps";
import { ProjectStore } from "./store";
import { resolveInside } from "./pathSafety";
import { wsMkdir, wsWriteUri } from "./workspaceIo";
import { t } from "../i18n";
import * as path from "path";
import * as vscode from "vscode";

const GLOB_PATTERNS = [
  "**/ROADMAP.md",
  "**/TODO.md",
  "**/PLAN.md",
  "**/AGENTS.md",
  "**/planning/**/*.md",
  "**/docs/roadmap/**/*.md",
  "**/docs/**/plan*.md",
  "**/docs/**/roadmap*.md",
  ".cursor/plans/**/*.md",
];

export interface DiscoverCandidate {
  label: string;
  description: string;
  uris: vscode.Uri[];
  directory?: vscode.Uri;
}

export class PlanDiscoverer {
  constructor(private readonly folder: vscode.WorkspaceFolder) {}

  async discover(): Promise<DiscoverCandidate[]> {
    const found = new Map<string, vscode.Uri>();
    for (const pattern of GLOB_PATTERNS) {
      const uris = await vscode.workspace.findFiles(
        new vscode.RelativePattern(this.folder, pattern),
        "**/node_modules/**",
        50
      );
      for (const u of uris) found.set(u.fsPath, u);
    }

    // Scan markdown for frontmatter type: plan
    const planUris = await this.findPlanTypedFiles();
    for (const u of planUris) found.set(u.fsPath, u);

    const byDir = new Map<string, vscode.Uri[]>();
    for (const uri of found.values()) {
      const dir = vscode.Uri.joinPath(uri, "..").fsPath;
      if (!byDir.has(dir)) byDir.set(dir, []);
      byDir.get(dir)!.push(uri);
    }

    const candidates: DiscoverCandidate[] = [];

    if (planUris.length) {
      candidates.push({
        label: "type: plan (frontmatter)",
        description: t("{0} file(s) with type: plan", planUris.length),
        uris: planUris,
      });
    }

    for (const [dir, uris] of byDir) {
      const rel = vscode.workspace.asRelativePath(dir, false);
      candidates.push({
        label: rel || ".",
        description: t("{0} markdown file(s)", uris.length),
        uris,
        directory: vscode.Uri.file(dir),
      });
    }

    for (const name of ["ROADMAP.md", "TODO.md", "PLAN.md", "AGENTS.md"]) {
      const uri = vscode.Uri.joinPath(this.folder.uri, name);
      try {
        await vscode.workspace.fs.stat(uri);
        candidates.unshift({
          label: name,
          description: t("File in project root"),
          uris: [uri],
        });
      } catch {
        /* missing */
      }
    }

    const seen = new Set<string>();
    return candidates.filter((c) => {
      const key = c.uris.map((u) => u.fsPath).sort().join("|");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  /** Find markdown files whose frontmatter has type: plan */
  private async findPlanTypedFiles(): Promise<vscode.Uri[]> {
    const uris = await vscode.workspace.findFiles(
      new vscode.RelativePattern(this.folder, "**/*.md"),
      "{**/node_modules/**,**/.git/**,**/dist/**,**/.proman/imports/**}",
      300
    );
    const out: vscode.Uri[] = [];
    for (const uri of uris) {
      try {
        const raw = await vscode.workspace.fs.readFile(uri);
        const text = Buffer.from(raw).toString("utf8");
        // Cheap reject before full parse
        if (!text.startsWith("---")) continue;
        if (!isPlanDocument(text)) continue;
        out.push(uri);
      } catch {
        /* skip unreadable */
      }
    }
    return out;
  }
}

export class MdImporter {
  constructor(private readonly store: ProjectStore) {}

  async importUris(uris: vscode.Uri[], planningDir?: string): Promise<number> {
    if (!uris.length) return 0;
    await this.store.ensureInitialized();
    const proman = this.store.promanUri;
    if (proman) {
      await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(proman, "imports"));
    }

    const parts = [];
    let planCounter = 1;
    for (const uri of uris) {
      const raw = await vscode.workspace.fs.readFile(uri);
      const text = Buffer.from(raw).toString("utf8");
      const rel = vscode.workspace.asRelativePath(uri);
      const parsed = parseMarkdownToTree(text, rel, {
        startCounter: isPlanDocument(text) ? planCounter : 1,
      });
      parts.push(parsed);
      if (parsed.meta.type?.toLowerCase() === "plan" || isPlanDocument(text)) {
        planCounter = parsed.nextCounter;
      }

      if (proman && this.store.workspaceRoot) {
        const base = sanitizeImportBasename(uri.path.split("/").pop() ?? "import.md");
        if (base) {
          await wsMkdir(this.store.workspaceRoot, ".proman", "imports");
          const destPath = resolveInside(
            path.join(this.store.workspaceRoot, ".proman"),
            "imports",
            base
          );
          if (destPath) {
            await wsWriteUri(vscode.Uri.file(destPath), raw);
          }
        }
      }
    }
    const merged = mergeParsed(parts);
    this.store.replaceFromImport({
      roots: merged.roots,
      tasks: merged.tasks,
      planningDir,
    });
    this.store.applyBlockedStatuses();
    await this.store.save();
    return Object.keys(merged.tasks).length;
  }

  async importDirectory(dir: vscode.Uri): Promise<number> {
    const files = await vscode.workspace.findFiles(
      new vscode.RelativePattern(dir, "**/*.md"),
      null,
      100
    );
    // Prefer type: plan files in the folder; if any exist, import only those
    const planFiles: vscode.Uri[] = [];
    for (const uri of files) {
      try {
        const raw = await vscode.workspace.fs.readFile(uri);
        if (isPlanDocument(Buffer.from(raw).toString("utf8"))) planFiles.push(uri);
      } catch {
        /* skip */
      }
    }
    const rel = vscode.workspace.asRelativePath(dir);
    return this.importUris(planFiles.length ? planFiles : files, rel);
  }
}
