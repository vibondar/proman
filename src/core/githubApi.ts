import { execFile } from "child_process";
import { promisify } from "util";
import { GithubIssuesConfig } from "./types";

const execFileAsync = promisify(execFile);

export interface GithubIssue {
  number: number;
  title: string;
  state: "open" | "closed";
  html_url: string;
  pull_request?: unknown;
}

export async function getGithubAccessToken(
  getSession: () => Promise<{ accessToken: string } | undefined>
): Promise<string | null> {
  const session = await getSession();
  return session?.accessToken ?? null;
}

export async function githubApi<T>(
  token: string,
  method: string,
  path: string,
  body?: unknown
): Promise<T> {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "proman-vscode",
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`GitHub API ${res.status}: ${text.slice(0, 300)}`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export async function createGithubIssue(
  token: string,
  owner: string,
  repo: string,
  title: string,
  body: string
): Promise<GithubIssue> {
  return githubApi<GithubIssue>(token, "POST", `/repos/${owner}/${repo}/issues`, {
    title,
    body,
  });
}

export async function listClosedIssues(
  token: string,
  owner: string,
  repo: string,
  opts?: { since?: string; perPage?: number }
): Promise<GithubIssue[]> {
  const perPage = opts?.perPage ?? 100;
  const params = new URLSearchParams({
    state: "closed",
    per_page: String(perPage),
    sort: "updated",
    direction: "desc",
  });
  if (opts?.since) params.set("since", opts.since);
  const items = await githubApi<GithubIssue[]>(
    token,
    "GET",
    `/repos/${owner}/${repo}/issues?${params.toString()}`
  );
  return items.filter((i) => !i.pull_request);
}

export async function getGithubIssue(
  token: string,
  owner: string,
  repo: string,
  issueNumber: number
): Promise<GithubIssue> {
  return githubApi<GithubIssue>(
    token,
    "GET",
    `/repos/${owner}/${repo}/issues/${issueNumber}`
  );
}

/** Parse owner/repo from git remote origin (github.com). */
export async function detectGithubOwnerRepo(
  cwd: string
): Promise<{ owner: string; repo: string } | null> {
  try {
    const { stdout } = await execFileAsync("git", ["remote", "get-url", "origin"], {
      cwd,
      timeout: 10_000,
    });
    return parseGithubRemoteUrl(stdout.toString().trim());
  } catch {
    return null;
  }
}

export function parseGithubRemoteUrl(url: string): { owner: string; repo: string } | null {
  const cleaned = url.trim().replace(/\.git$/i, "");
  // git@github.com:owner/repo
  let m = cleaned.match(/github\.com[:/]([^/]+)\/([^/]+)$/i);
  if (m) return { owner: m[1], repo: m[2] };
  // https://github.com/owner/repo
  m = cleaned.match(/https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+)/i);
  if (m) return { owner: m[1], repo: m[2] };
  return null;
}

export function isGithubIssuesEnabled(cfg: GithubIssuesConfig | undefined): boolean {
  return Boolean(
    cfg?.enabled && cfg.owner?.trim() && cfg.repo?.trim()
  );
}

export function defaultGithubConfig(
  owner: string,
  repo: string,
  partial?: Partial<GithubIssuesConfig>
): GithubIssuesConfig {
  return {
    enabled: true,
    owner,
    repo,
    createOnAdd: partial?.createOnAdd ?? true,
    closeToDone: partial?.closeToDone ?? true,
  };
}
