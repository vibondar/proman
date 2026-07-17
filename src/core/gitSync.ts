import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  error?: string;
}

async function git(cwd: string, args: string[]): Promise<GitResult> {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd,
      maxBuffer: 5 * 1024 * 1024,
      timeout: 120_000,
    });
    return { ok: true, stdout: stdout?.toString() ?? "", stderr: stderr?.toString() ?? "" };
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    return {
      ok: false,
      stdout: err.stdout?.toString() ?? "",
      stderr: err.stderr?.toString() ?? "",
      error: err.stderr?.toString() || err.message || String(e),
    };
  }
}

export async function isGitRepo(cwd: string): Promise<boolean> {
  const r = await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  return r.ok && r.stdout.trim() === "true";
}

export async function gitPull(cwd: string): Promise<GitResult> {
  // Prefer rebase to keep .proman history linear for teams
  const r = await git(cwd, ["pull", "--rebase", "--autostash"]);
  if (r.ok) return r;
  // Fallback without rebase
  return git(cwd, ["pull", "--autostash"]);
}

export async function gitPush(cwd: string): Promise<GitResult> {
  return git(cwd, ["push"]);
}

/**
 * Stage & commit only .proman/ changes. Optionally push.
 * No-op (ok) if nothing to commit.
 */
export async function gitCommitProman(
  cwd: string,
  message: string,
  opts?: { push?: boolean }
): Promise<GitResult & { committed: boolean; pushed: boolean }> {
  const add = await git(cwd, ["add", "-A", "--", ".proman"]);
  if (!add.ok) {
    return { ...add, committed: false, pushed: false };
  }

  const status = await git(cwd, ["status", "--porcelain", "--", ".proman"]);
  if (!status.ok) {
    return { ...status, committed: false, pushed: false };
  }
  if (!status.stdout.trim()) {
    return { ok: true, stdout: "", stderr: "", committed: false, pushed: false };
  }

  const commit = await git(cwd, ["commit", "-m", message, "--", ".proman"]);
  if (!commit.ok) {
    return { ...commit, committed: false, pushed: false };
  }

  let pushed = false;
  if (opts?.push) {
    const push = await gitPush(cwd);
    if (!push.ok) {
      return { ...push, committed: true, pushed: false };
    }
    pushed = true;
  }
  return { ok: true, stdout: commit.stdout, stderr: commit.stderr, committed: true, pushed };
}
