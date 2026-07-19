/**
 * Detect git merge conflict markers / invalid JSON in `.proman/` files.
 * Pure helpers — no vscode / fs.
 */

import { sanitizeLoadedTreeBundle } from "./forest";
import type { TreeBundle } from "./types";

export type PromanFileProblemKind = "ok" | "conflict_markers" | "invalid_json";

/** Classic git conflict markers at line start. */
const CONFLICT_MARKER_RE = /^(<<<<<<<|=======|>>>>>>>)/m;

/**
 * Classify file text: conflict markers win over JSON parse errors
 * (a conflicted file is often also invalid JSON).
 */
export function detectPromanFileProblem(text: string): PromanFileProblemKind {
  if (CONFLICT_MARKER_RE.test(text)) return "conflict_markers";
  try {
    JSON.parse(text);
    return "ok";
  } catch {
    return "invalid_json";
  }
}

/** Parse `.proman` JSON or return a structured problem (no throw). */
export function tryParsePromanJson(
  text: string
):
  | { ok: true; data: unknown }
  | { ok: false; kind: Exclude<PromanFileProblemKind, "ok"> } {
  const kind = detectPromanFileProblem(text);
  if (kind !== "ok") return { ok: false, kind };
  return { ok: true, data: JSON.parse(text) as unknown };
}

/**
 * Relative paths under `.proman/` that are JSON load targets
 * (`project.json`, `tree.json`, `trees/*.json`).
 */
export function isPromanJsonScanTarget(relUnderProman: string): boolean {
  const normalized = relUnderProman.replace(/\\/g, "/").replace(/^\.?\//, "");
  if (normalized === "project.json" || normalized === "tree.json") return true;
  if (
    normalized.startsWith("trees/") &&
    normalized.endsWith(".json") &&
    !normalized.slice(6).includes("/")
  ) {
    return true;
  }
  return false;
}

export interface PromanFileProblem {
  /** Path relative to `.proman/` (e.g. `trees/main.json`). */
  path: string;
  kind: Exclude<PromanFileProblemKind, "ok">;
}

/**
 * Scan a map of path → file text for problems.
 * Only paths matching {@link isPromanJsonScanTarget} are checked.
 */
export function scanPromanJsonProblems(
  files: Record<string, string>,
  options?: {
    /** If set, only scan when this returns a path under `.proman/` that is a JSON target. */
    toPromanRel?: (path: string) => string | null;
  }
): PromanFileProblem[] {
  const out: PromanFileProblem[] = [];
  for (const [path, text] of Object.entries(files)) {
    const under = options?.toPromanRel ? options.toPromanRel(path) : path;
    if (under === null) continue;
    if (!isPromanJsonScanTarget(under)) continue;
    const kind = detectPromanFileProblem(text);
    if (kind !== "ok") out.push({ path, kind });
  }
  return out;
}

/**
 * Load valid tree bundles from `trees/*.json` texts.
 * Conflicted/corrupt files are omitted from the forest and listed in `problems`.
 * Policy: partial load (safe sections still load).
 */
export function loadTreeBundlesFromTexts(
  entries: { fileName: string; text: string }[]
): { trees: TreeBundle[]; problems: PromanFileProblem[] } {
  const trees: TreeBundle[] = [];
  const problems: PromanFileProblem[] = [];
  for (const { fileName, text } of entries) {
    const path = `trees/${fileName}`;
    const parsed = tryParsePromanJson(text);
    if (!parsed.ok) {
      problems.push({ path, kind: parsed.kind });
      continue;
    }
    const bundle = sanitizeLoadedTreeBundle(parsed.data, fileName);
    if (bundle) trees.push(bundle);
    // unsafe id / filename mismatch: skip without conflict UX (not merge-related)
  }
  return { trees, problems };
}
