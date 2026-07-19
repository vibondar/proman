import * as vscode from "vscode";
import * as path from "path";
import { resolveInside, resolveTreeJsonPath } from "./pathSafety";

/**
 * Workspace-scoped IO via vscode.workspace.fs (respects trust / workspace APIs).
 * All writes resolve through resolveInside(workspaceRoot, …).
 */

/** Reject oversized `.proman/` reads (DoS / memory) — same cap as MD import. */
export const MAX_PROMAN_READ_BYTES = 2 * 1024 * 1024;

export function isPromanReadTooLarge(byteLength: number): boolean {
  return byteLength > MAX_PROMAN_READ_BYTES;
}

export async function wsExists(workspaceRoot: string, ...parts: string[]): Promise<boolean> {
  const full = resolveInside(workspaceRoot, ...parts);
  if (!full) return false;
  try {
    await vscode.workspace.fs.stat(vscode.Uri.file(full));
    return true;
  } catch {
    return false;
  }
}

export async function wsReadText(
  workspaceRoot: string,
  ...parts: string[]
): Promise<string | null> {
  const full = resolveInside(workspaceRoot, ...parts);
  if (!full) return null;
  try {
    const uri = vscode.Uri.file(full);
    const st = await vscode.workspace.fs.stat(uri);
    if (isPromanReadTooLarge(st.size)) return null;
    const data = await vscode.workspace.fs.readFile(uri);
    return Buffer.from(data).toString("utf8");
  } catch {
    return null;
  }
}

export async function wsWriteText(
  workspaceRoot: string,
  parts: string[],
  text: string
): Promise<boolean> {
  const full = resolveInside(workspaceRoot, ...parts);
  if (!full) return false;
  const dir = path.dirname(full);
  const dirInside = resolveInside(workspaceRoot, path.relative(workspaceRoot, dir) || ".");
  if (!dirInside) return false;
  await vscode.workspace.fs.createDirectory(vscode.Uri.file(dirInside));
  await vscode.workspace.fs.writeFile(vscode.Uri.file(full), Buffer.from(text, "utf8"));
  return true;
}

/** Write tree JSON only under `.proman/trees/<safeId>.json`. */
export async function wsWriteTreeJson(
  workspaceRoot: string,
  treeId: string,
  text: string
): Promise<boolean> {
  const full = resolveTreeJsonPath(workspaceRoot, treeId);
  if (!full) return false;
  await wsMkdir(workspaceRoot, ".proman", "trees");
  await vscode.workspace.fs.writeFile(vscode.Uri.file(full), Buffer.from(text, "utf8"));
  return true;
}

/** Delete `.proman/trees/<safeId>.json` if present. */
export async function wsDeleteTreeJson(
  workspaceRoot: string,
  treeId: string
): Promise<boolean> {
  const full = resolveTreeJsonPath(workspaceRoot, treeId);
  if (!full) return false;
  try {
    await vscode.workspace.fs.delete(vscode.Uri.file(full));
    return true;
  } catch {
    return false;
  }
}

export async function wsMkdir(workspaceRoot: string, ...parts: string[]): Promise<boolean> {
  const full = resolveInside(workspaceRoot, ...parts);
  if (!full) return false;
  await vscode.workspace.fs.createDirectory(vscode.Uri.file(full));
  return true;
}

export async function wsReadDir(
  workspaceRoot: string,
  ...parts: string[]
): Promise<Array<[string, vscode.FileType]> | null> {
  const full = resolveInside(workspaceRoot, ...parts);
  if (!full) return null;
  try {
    return await vscode.workspace.fs.readDirectory(vscode.Uri.file(full));
  } catch {
    return null;
  }
}

/** Read any file URI (e.g. extension bundle) via workspace.fs */
export async function wsReadUri(uri: vscode.Uri): Promise<Uint8Array> {
  return vscode.workspace.fs.readFile(uri);
}

export async function wsWriteUri(uri: vscode.Uri, data: Uint8Array): Promise<void> {
  const parent = vscode.Uri.joinPath(uri, "..");
  await vscode.workspace.fs.createDirectory(parent);
  await vscode.workspace.fs.writeFile(uri, data);
}
