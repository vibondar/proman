import { GithubIssuesConfig } from "./types";
import {
  assertValidGithubOwnerRepo,
  isValidGithubName,
  parseGithubRemoteUrl,
  sanitizeErrorMessage,
} from "./githubIssueLink";
import { gitRemoteOriginUrl } from "./gitSync";

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

function reposPath(owner: string, repo: string, suffix: string): string {
  const { owner: o, repo: r } = assertValidGithubOwnerRepo(owner, repo);
  return `/repos/${encodeURIComponent(o)}/${encodeURIComponent(r)}${suffix}`;
}

export async function githubApi<T>(
  token: string,
  method: string,
  path: string,
  body?: unknown
): Promise<T> {
  if (!path.startsWith("/")) {
    throw new Error("GitHub API path must be absolute");
  }
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
    throw new Error(
      `GitHub API ${res.status}: ${sanitizeErrorMessage(text, 200)}`
    );
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
  return githubApi<GithubIssue>(token, "POST", reposPath(owner, repo, "/issues"), {
    title: title.slice(0, 256),
    body: body.slice(0, 65536),
  });
}

export async function listClosedIssues(
  token: string,
  owner: string,
  repo: string,
  opts?: { since?: string; perPage?: number }
): Promise<GithubIssue[]> {
  const perPage = Math.min(100, Math.max(1, opts?.perPage ?? 100));
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
    `${reposPath(owner, repo, "/issues")}?${params.toString()}`
  );
  return items.filter((i) => !i.pull_request);
}

export async function getGithubIssue(
  token: string,
  owner: string,
  repo: string,
  issueNumber: number
): Promise<GithubIssue> {
  if (!Number.isInteger(issueNumber) || issueNumber < 1) {
    throw new Error("Invalid issue number");
  }
  return githubApi<GithubIssue>(
    token,
    "GET",
    reposPath(owner, repo, `/issues/${issueNumber}`)
  );
}

/** Parse owner/repo from git remote origin (github.com). */
export async function detectGithubOwnerRepo(
  cwd: string
): Promise<{ owner: string; repo: string } | null> {
  const url = await gitRemoteOriginUrl(cwd);
  if (!url) return null;
  return parseGithubRemoteUrl(url);
}

export function isGithubIssuesEnabled(cfg: GithubIssuesConfig | undefined): boolean {
  return Boolean(
    cfg?.enabled &&
      isValidGithubName(cfg.owner) &&
      isValidGithubName(cfg.repo)
  );
}

export function defaultGithubConfig(
  owner: string,
  repo: string,
  partial?: Partial<GithubIssuesConfig>
): GithubIssuesConfig {
  const { owner: o, repo: r } = assertValidGithubOwnerRepo(owner, repo);
  return {
    enabled: true,
    owner: o,
    repo: r,
    createOnAdd: partial?.createOnAdd ?? true,
    closeToDone: partial?.closeToDone ?? true,
    publicOnly: partial?.publicOnly ?? false,
  };
}

/** VS Code GitHub auth scopes: public_repo for public-only, repo for private. */
export function githubAuthScopes(publicOnly: boolean | undefined): string[] {
  return publicOnly ? ["public_repo"] : ["repo"];
}
