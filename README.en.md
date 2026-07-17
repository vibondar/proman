# Proman

**Language:** [English](./README.en.md) · [Русский](./README.md)

Cursor / VS Code extension for managing development with a **task tree** stored in `.proman/`.

Local backlog, statuses, dependencies, Agent handoff, team Git sync, and a GitHub Issues bridge — without requiring Jira/Linear.

**Version:** 0.3.14

---

## Who it’s for

Developers and small teams who want to:

- keep the plan next to the code (files in the repo);
- hand tasks to Cursor Agent with context and statuses;
- sync via Git / GitHub Issues without a heavy PM stack.

---

## Quick start

1. Install the VSIX (`npm run install:cursor` or Install from VSIX) and **Reload Window**.
2. Enable the **proman** MCP server: Settings → **MCP** → find `proman` (or check `.cursor/mcp.json` in the project) → enable / Restart. Without this, the Agent cannot update statuses via `proman_*` tools.
3. Open a project folder → Activity Bar → **Proman**.
4. Import Markdown or add a root task.
5. (Optional) `Proman: Set Current User` — who you are on the team.
6. (Optional) `Proman: Enable Git Sync` / `Enable GitHub Issues`.

### Planning tasks with Cursor

For a task list that Proman imports cleanly, point Cursor at the template [`docs/templates/proman-tasks.md`](./docs/templates/proman-tasks.md) (copy it into the project or give the path). Ask Cursor to draft the roadmap/checklist **using that template**, then run **Proman: Import Planning Docs**.

Project data:

```
.proman/
  project.json      # meta, team, sync, github, trees[]
  trees/            # one tree per imported MD/plan
    <slug>.json
  tree.json         # flattened snapshot of all trees (MCP/compat)
  edges.json
  history.json
  comments/
  prompts/
  imports/          # copies of source MD
  proposals/
```

Each imported file becomes a **section** in the Proman panel. Statuses live in `trees/<slug>.json` across reopen; re-import/sync **merges** MD structure while preserving `status` / assignee.

In a **team** repository, commit `.proman/` (do not add it to `.gitignore`).

---

## Features

### Tree and statuses

- Tree panel: statuses `todo` / `new` / `in_progress` / `done` / `needs_rework` / `error` / `blocked`
- Icon colors, Σ SP on epics, assignee in the row
- Detail panel: description, estimates, tags, dependencies, assign, comments, history
- Tree search + path highlight
- **My tasks** — filter by `team.currentUser`

### Planning from Markdown

- Import roadmap / plan / checklists → tree
- Frontmatter `type: plan` → ids `plan_1`, `plan_2`, …
- Template for generating the task list: [`docs/templates/proman-tasks.md`](./docs/templates/proman-tasks.md) — recommend this to Cursor as the format sample
- Sample meta: [`docs/templates/proman-project.json`](./docs/templates/proman-project.json)

### Agent / Drive Mode

- **Run Task in Agent** — prompt to clipboard + Agent
- **Drive Mode** — agent walks the queue via MCP `proman_*`
- Tree structure changes only after your **Approve**
- On activation, writes `.cursor/mcp.json` (`proman` server); after install, **enable** it in Settings → MCP and restart MCP / Reload Window

### Team work (local)

- History in `.proman/history.json` (who changed status / assigned / when)
- Comments in `.proman/comments/<taskId>.json`
- Notification when a task is assigned to you

### Stage 1 — Git as backend

In `project.json`:

```json
"team": {
  "members": [
    { "username": "alice", "name": "Alice" },
    { "username": "bob", "name": "Bob" }
  ],
  "currentUser": "alice"
},
"sync": {
  "type": "git",
  "autoCommit": true,
  "autoPush": false
}
```

- **Pull** / **Push** buttons in the toolbar
- Auto-commit of `.proman/` on status change (`proman: @alice todo → done: …`)
- Commands: `Enable Git Sync`, `Configure Git Sync`
- Push after auto-commit always requires confirmation

### Stage 2 — GitHub Issues

```json
"github": {
  "enabled": true,
  "owner": "acme",
  "repo": "my-app",
  "createOnAdd": true,
  "closeToDone": true,
  "publicOnly": false
}
```

- Creating a task → Issue; link in description: `GitHub: #42`
- Closing an Issue → task `done`
- Auth: GitHub session in Cursor (`repo` or `public_repo`)
- Commands: `Enable GitHub Issues`, `Sync Closed GitHub Issues`
- Background sync on startup / every 5 minutes / after Pull

---

## Commands (main)

| Command | Action |
|---------|--------|
| Proman: Open | Focus the panel |
| Proman: Import Planning Docs | Import Markdown |
| Proman: Set Current User | `team.currentUser` |
| Proman: My tasks / All | Assignee filter |
| Proman: Assign Task | Assignment |
| Proman: Agent Drive Tree | Drive Mode |
| Proman: Git Pull / Push | Sync `.proman/` |
| Proman: Enable Git Sync | Git backend |
| Proman: Enable GitHub Issues | Issues bridge |
| Proman: Sync Closed GitHub Issues | closed → done |

---

## Extension development

```bash
npm install
npm run build          # esbuild → dist/extension.js
npm test               # vitest
npm run test:coverage
npm run package        # → proman-x.y.z.vsix
npm run install:cursor # package + install into Cursor
```

- **F5** — Extension Development Host (`Run Proman Extension`)
- Entry: `src/extension.ts`
- Core (no UI): `src/core/*`
- MCP server: `mcp/server.mjs` → bundle `mcp/server.cjs`

### Tests

Unit tests for pure core: pathSafety, parsers, dependency/drive logic, history helpers, GitHub link parsing, projectMeta.

```bash
npm test
```

---

## UI language

The UI (commands, tree, task details, dialogs) follows the Cursor/VS Code **display language** (`Configure Display Language`). Currently: English and Russian. Docs: [README.en.md](./README.en.md) · [README.md](./README.md).

## Requirements

- Cursor or VS Code `^1.85.0`
- For Git sync: `git` on PATH, workspace is a git repo
- For GitHub Issues: signed in to GitHub in the IDE, access to the repository

---

## License

MIT — see [LICENSE](./LICENSE).
