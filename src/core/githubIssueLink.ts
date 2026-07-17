/**
 * Link Proman tasks ↔ GitHub Issues via a line in the task description:
 *   GitHub: #42
 */

const LINE_RE = /(?:^|\n)\s*(?:GitHub(?:-Issue)?|GH)\s*:\s*#?(\d+)\s*(?=\n|$)/i;
const URL_RE = /github\.com\/[^/\s]+\/[^/\s]+\/issues\/(\d+)/i;

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
  return `https://github.com/${owner}/${repo}/issues/${issueNumber}`;
}

export function parseGithubRemoteUrl(url: string): { owner: string; repo: string } | null {
  const cleaned = url.trim().replace(/\.git$/i, "");
  let m = cleaned.match(/github\.com[:/]([^/]+)\/([^/]+)$/i);
  if (m) return { owner: m[1], repo: m[2] };
  m = cleaned.match(/https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+)/i);
  if (m) return { owner: m[1], repo: m[2] };
  return null;
}
