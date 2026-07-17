/**
 * Link Proman tasks ↔ GitHub Issues via a line in the task description:
 *   GitHub: #42
 */

const LINE_RE = /(?:^|\n)\s*(?:GitHub(?:-Issue)?|GH)\s*:\s*#?(\d+)\s*(?=\n|$)/i;
const URL_RE = /github\.com\/[^/\s]+\/[^/\s]+\/issues\/(\d+)/i;

/** GitHub owner / repo segment (no slashes, traversal, or query). */
const GH_NAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?$/;

export function isValidGithubName(name: string | undefined | null): boolean {
  if (!name || typeof name !== "string") return false;
  const n = name.trim();
  if (n.length < 1 || n.length > 100) return false;
  if (n === "." || n === "..") return false;
  return GH_NAME_RE.test(n);
}

export function assertValidGithubOwnerRepo(
  owner: string,
  repo: string
): { owner: string; repo: string } {
  const o = owner.trim();
  const r = repo.trim().replace(/\.git$/i, "");
  if (!isValidGithubName(o) || !isValidGithubName(r)) {
    throw new Error("Invalid GitHub owner/repo (allowed: letters, digits, ._- )");
  }
  return { owner: o, repo: r };
}

export function parseGithubIssueId(description: string | undefined): number | null {
  if (!description) return null;
  const line = description.match(LINE_RE);
  if (line) {
    const n = Number(line[1]);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  const url = description.match(URL_RE);
  if (url) {
    const n = Number(url[1]);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  return null;
}

/** Insert or replace the canonical «GitHub: #N» line. */
export function upsertGithubIssueInDescription(
  description: string,
  issueNumber: number
): string {
  const line = `GitHub: #${issueNumber}`;
  const lines = (description || "").split(/\r?\n/);
  const idx = lines.findIndex((l) => /^\s*(?:GitHub(?:-Issue)?|GH)\s*:/i.test(l));
  if (idx >= 0) lines[idx] = line;
  else lines.push(line);
  return lines.join("\n").trim();
}

export function githubIssueUrl(owner: string, repo: string, issueNumber: number): string {
  const { owner: o, repo: r } = assertValidGithubOwnerRepo(owner, repo);
  if (!Number.isInteger(issueNumber) || issueNumber < 1) {
    throw new Error("Invalid issue number");
  }
  return `https://github.com/${encodeURIComponent(o)}/${encodeURIComponent(r)}/issues/${issueNumber}`;
}

/** Only allow opening github.com / www.github.com http(s) issue URLs. */
export function isSafeGithubHtmlUrl(url: string | undefined | null): boolean {
  if (!url || typeof url !== "string") return false;
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") return false;
    const host = u.hostname.toLowerCase();
    if (host !== "github.com" && host !== "www.github.com") return false;
    return /^\/[^/]+\/[^/]+\/issues\/\d+\/?$/.test(u.pathname);
  } catch {
    return false;
  }
}

export function parseGithubRemoteUrl(url: string): { owner: string; repo: string } | null {
  const cleaned = url.trim().replace(/\.git$/i, "");
  let m = cleaned.match(/github\.com[:/]([^/]+)\/([^/]+)$/i);
  if (!m) {
    m = cleaned.match(/https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+)/i);
  }
  if (!m) return null;
  try {
    return assertValidGithubOwnerRepo(m[1], m[2]);
  } catch {
    return null;
  }
}

/** Short UI-safe error (no long paths / token-looking strings). */
export function sanitizeErrorMessage(raw: string, max = 180): string {
  let s = String(raw || "")
    .replace(/Bearer\s+\S+/gi, "Bearer ***")
    .replace(/ghp_[A-Za-z0-9]+/g, "ghp_***")
    .replace(/gho_[A-Za-z0-9]+/g, "gho_***")
    .replace(/\/\/[^@\s]+@/g, "//***@")
    .replace(/[\r\n]+/g, " ")
    .trim();
  if (s.length > max) s = s.slice(0, max - 1) + "…";
  return s || "unknown error";
}
