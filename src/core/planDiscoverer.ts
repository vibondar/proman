import { parseMarkdownToTree } from "./mdParser";
import { isPlanDocument } from "./planFrontmatter";
import { sanitizeImportBasename } from "./proposalOps";
import { ProjectStore } from "./store";
import { resolveInside } from "./pathSafety";
import { wsMkdir, wsWriteUri } from "./workspaceIo";
import { titleFromSource, treeSlugFromSource } from "./forest";
import { t } from "../i18n";
import * as path from "path";
import * as vscode from "vscode";

/** Reject oversized planning docs (DoS / memory). */
export const MAX_MD_IMPORT_BYTES = 2 * 1024 * 1024;

export function isMdImportTooLarge(byteLength: number): boolean {
  return byteLength > MAX_MD_IMPORT_BYTES;
}

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

async function readMdForImport(
  uri: vscode.Uri
): Promise<{ data: Uint8Array } | { skipped: "large" | "error" }> {
  try {
    const st = await vscode.workspace.fs.stat(uri);
    if (isMdImportTooLarge(st.size)) return { skipped: "large" };
    return { data: await vscode.workspace.fs.readFile(uri) };
  } catch {
    return { skipped: "error" };
  }
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
        const raw = await readMdForImport(uri);
        if ("skipped" in raw) continue;
        const text = Buffer.from(raw.data).toString("utf8");
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

    let totalTasks = 0;
    let planCounter = 1;
    let skippedLarge = 0;
    let firstImported = true;
    for (let i = 0; i < uris.length; i++) {
      const uri = uris[i];
      if (!uri) continue;
      const loaded = await readMdForImport(uri);
      if ("skipped" in loaded) {
        if (loaded.skipped === "large") skippedLarge++;
        continue;
      }
      const raw = loaded.data;
      const text = Buffer.from(raw).toString("utf8");
      const rel = vscode.workspace.asRelativePath(uri);
      const parsed = parseMarkdownToTree(text, rel, {
        startCounter: isPlanDocument(text) ? planCounter : 1,
      });
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

      const treeId = treeSlugFromSource(rel);
      const title = titleFromSource(rel);
      this.store.mergeImportTree({
        treeId,
        title,
        sourceFile: rel,
        roots: parsed.roots,
        tasks: parsed.tasks,
        // Set planningDir only for the first successfully imported file in this batch
        planningDir: firstImported ? planningDir : undefined,
      });
      firstImported = false;
      totalTasks += Object.keys(parsed.tasks).length;
    }
    if (skippedLarge > 0) {
      void vscode.window.showWarningMessage(
        t(
          "Proman: skipped {0} markdown file(s) larger than {1} MB",
          skippedLarge,
          String(MAX_MD_IMPORT_BYTES / (1024 * 1024))
        )
      );
    }
    this.store.applyBlockedStatuses();
    await this.store.save();
    return totalTasks;
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
        const loaded = await readMdForImport(uri);
        if ("skipped" in loaded) continue;
        if (isPlanDocument(Buffer.from(loaded.data).toString("utf8"))) planFiles.push(uri);
      } catch {
        /* skip */
      }
    }
    const rel = vscode.workspace.asRelativePath(dir);
    return this.importUris(planFiles.length ? planFiles : files, rel);
  }
}
