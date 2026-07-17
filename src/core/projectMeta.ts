import { GithubIssuesConfig, ProjectMeta, SyncConfig, TeamConfig, TeamMember } from "./types";
import { displayActor, normalizeActor } from "./actor";
import { isGithubIssuesEnabled } from "./githubApi";

/** Resolve current user from team.currentUser or legacy meta.currentUser. */
export function getMetaCurrentUser(meta: ProjectMeta | null | undefined): string | undefined {
  if (!meta) return undefined;
  const fromTeam = meta.team?.currentUser;
  const raw = fromTeam || meta.currentUser;
  const n = normalizeActor(raw);
  return n ? displayActor(raw) : undefined;
}

export function normalizeProjectMeta(raw: ProjectMeta): ProjectMeta {
  const meta: ProjectMeta = { ...raw };
  const legacyUser = meta.currentUser;
  const team: TeamConfig = {
    members: Array.isArray(meta.team?.members)
      ? meta.team!.members
          .filter((m): m is TeamMember => Boolean(m && typeof m.username === "string"))
          .map((m) => ({
            username: m.username.trim().replace(/^@+/, ""),
            name: typeof m.name === "string" ? m.name : undefined,
          }))
          .filter((m) => m.username)
      : [],
    currentUser: meta.team?.currentUser ?? legacyUser,
  };
  if (team.currentUser) {
    team.currentUser = team.currentUser.trim().replace(/^@+/, "");
  }
  meta.team = team;
  // Keep legacy field in sync for older readers / UI that still peek at it
  if (team.currentUser) meta.currentUser = team.currentUser;
  else delete meta.currentUser;

  if (meta.sync && meta.sync.type === "git") {
    meta.sync = {
      type: "git",
      autoCommit: Boolean(meta.sync.autoCommit),
      autoPush: Boolean(meta.sync.autoPush),
    };
  }

  if (meta.github) {
    const g = meta.github;
    const owner = String(g.owner ?? "").trim();
    const repo = String(g.repo ?? "").trim().replace(/\.git$/i, "");
    const normalized: GithubIssuesConfig = {
      enabled: Boolean(g.enabled),
      owner,
      repo,
      createOnAdd: g.createOnAdd !== false,
      closeToDone: g.closeToDone !== false,
      publicOnly: Boolean(g.publicOnly),
    };
    if (isGithubIssuesEnabled(normalized)) meta.github = normalized;
    else delete meta.github;
  }
  return meta;
}

export function setMetaCurrentUser(meta: ProjectMeta, name: string): void {
  const cleaned = name.trim().replace(/^@+/, "");
  if (!meta.team) meta.team = { members: [] };
  if (!cleaned) {
    delete meta.team.currentUser;
    delete meta.currentUser;
    return;
  }
  meta.team.currentUser = cleaned;
  meta.currentUser = cleaned;
  if (!meta.team.members.some((m) => normalizeActor(m.username) === normalizeActor(cleaned))) {
    meta.team.members.push({ username: cleaned });
  }
}

export function listTeamUsernames(meta: ProjectMeta | null | undefined): string[] {
  if (!meta?.team?.members?.length) return [];
  return meta.team.members.map((m) => displayActor(m.username)).filter(Boolean);
}

export function isGitSyncEnabled(meta: ProjectMeta | null | undefined): boolean {
  return meta?.sync?.type === "git";
}

export function defaultGitSync(partial?: Partial<SyncConfig>): SyncConfig {
  return {
    type: "git",
    autoCommit: partial?.autoCommit ?? true,
    autoPush: partial?.autoPush ?? false,
  };
}

export function formatStatusCommitMessage(
  actor: string,
  taskTitle: string,
  from: string | undefined,
  to: string
): string {
  const who = actor && actor !== "unknown" ? `@${actor}` : "proman";
  const title = taskTitle.trim() || "task";
  if (from) return `proman: ${who} ${from} → ${to}: ${title}`;
  return `proman: ${who} → ${to}: ${title}`;
}
