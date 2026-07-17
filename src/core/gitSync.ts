import { execFile } from "child_process";
import { promisify } from "util";
import { sanitizeErrorMessage } from "./githubIssueLink";

const execFileAsync = promisify(execFile);

export interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  error?: string;
}

/** Single-line commit message for `git commit -m`. */
export function sanitizeGitCommitMessage(message: string): string {
  return String(message || "proman")
    .replace(/[\0\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200) || "proman";
}

function assertAllowedGitArgs(args: string[]): void {
  if (!args.length) throw new Error("git: empty args");
  const [cmd, ...rest] = args;

  if (cmd === "rev-parse" && rest.length === 1 && rest[0] === "--is-inside-work-tree") return;
  if (cmd === "pull" && rest.length === 2 && rest[0] === "--rebase" && rest[1] === "--autostash")
    return;
  if (cmd === "pull" && rest.length === 1 && rest[0] === "--autostash") return;
  if (cmd === "push" && rest.length === 0) return;
  if (cmd === "add" && rest.length === 3 && rest[0] === "-A" && rest[1] === "--" && rest[2] === ".proman")
    return;
  if (
    cmd === "status" &&
    rest.length === 3 &&
    rest[0] === "--porcelain" &&
    rest[1] === "--" &&
    rest[2] === ".proman"
  )
    return;
  if (
    cmd === "commit" &&
    rest.length === 4 &&
    rest[0] === "-m" &&
    typeof rest[1] === "string" &&
    rest[2] === "--" &&
    rest[3] === ".proman"
  )
    return;
  if (cmd === "remote" && rest.length === 2 && rest[0] === "get-url" && rest[1] === "origin")
    return;

  throw new Error(`git: disallowed args: ${cmd}`);
}

/** Paths in porcelain status must stay under .proman/ */
export function assertPromanOnlyPorcelain(porcelain: string): void {
  for (const line of porcelain.split(/\r?\n/)) {
    if (!line.trim()) continue;
    // XY PATH or XY ORIG -> PATH
    const pathPart = line.slice(3).split(" -> ").pop()?.trim() ?? "";
    const normalized = pathPart.replace(/\\/g, "/").replace(/^\.\//, "");
    if (!normalized.startsWith(".proman/") && normalized !== ".proman") {
      throw new Error(`git: unexpected path outside .proman: ${normalized.slice(0, 80)}`);
    }
    if (normalized.includes("..")) {
      throw new Error("git: path traversal in status");
    }
  }
}

async function git(cwd: string, args: string[]): Promise<GitResult> {
  try {
    assertAllowedGitArgs(args);
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd,
      maxBuffer: 5 * 1024 * 1024,
      timeout: 120_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    return { ok: true, stdout: stdout?.toString() ?? "", stderr: stderr?.toString() ?? "" };
  } catch (e: unknown) {
    if (e instanceof Error && e.message.startsWith("git:")) {
      return { ok: false, stdout: "", stderr: "", error: e.message };
    }
    const err = e as { stdout?: string; stderr?: string; message?: string };
    return {
      ok: false,
      stdout: err.stdout?.toString() ?? "",
      stderr: err.stderr?.toString() ?? "",
      error: sanitizeErrorMessage(err.stderr?.toString() || err.message || String(e)),
    };
  }
}

export async function isGitRepo(cwd: string): Promise<boolean> {
  const r = await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  return r.ok && r.stdout.trim() === "true";
}

export async function gitPull(cwd: string): Promise<GitResult> {
  const r = await git(cwd, ["pull", "--rebase", "--autostash"]);
  if (r.ok) return r;
  return git(cwd, ["pull", "--autostash"]);
}

export async function gitPush(cwd: string): Promise<GitResult> {
  return git(cwd, ["push"]);
}

export async function gitRemoteOriginUrl(cwd: string): Promise<string | null> {
  const r = await git(cwd, ["remote", "get-url", "origin"]);
  if (!r.ok) return null;
  const url = r.stdout.trim();
  return url || null;
}

/**
 * Stage & commit only .proman/ changes. Never pushes (caller must confirm).
 * No-op (ok) if nothing to commit.
 */
export async function gitCommitProman(
  cwd: string,
  message: string
): Promise<GitResult & { committed: boolean }> {
  const add = await git(cwd, ["add", "-A", "--", ".proman"]);
  if (!add.ok) {
    return { ...add, committed: false };
  }

  const status = await git(cwd, ["status", "--porcelain", "--", ".proman"]);
  if (!status.ok) {
    return { ...status, committed: false };
  }
  if (!status.stdout.trim()) {
    return { ok: true, stdout: "", stderr: "", committed: false };
  }
  try {
    assertPromanOnlyPorcelain(status.stdout);
  } catch (e) {
    return {
      ok: false,
      stdout: status.stdout,
      stderr: "",
      error: e instanceof Error ? e.message : String(e),
      committed: false,
    };
  }

  const commit = await git(cwd, [
    "commit",
    "-m",
    sanitizeGitCommitMessage(message),
    "--",
    ".proman",
  ]);
  if (!commit.ok) {
    return { ...commit, committed: false };
  }
  return { ok: true, stdout: commit.stdout, stderr: commit.stderr, committed: true };
}
