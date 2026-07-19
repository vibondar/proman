# Changelog

All notable changes to Proman are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project uses [Semantic Versioning](https://semver.org/).

## [0.3.16] — 2026-07-19

### Notes
- Release published with a GitHub-signed merge commit (Verified tag target).

### Fixed
- Cap `.proman/` JSON reads at 2MB before parse (DoS guard)
- `progress()` / `isDescendant` / cascade delete: protect against cycles in `children`
- `updateTask`: description enrichment no longer overwrites fields set explicitly in the patch

### Changed
- `deleteTask`: shared helpers for promote/cascade parent/roots updates
- `findParent`: lazy `childToParent` index (invalidated on structural mutations)
- `moveTask`: log a warning when falling back due to tree/flat desync

## [0.3.15] — 2026-07-19

### Added
- `compilerOptions.noUncheckedIndexedAccess` enabled; indexed access hardened across `src/`
- Git sync merge UX: detect conflict markers / invalid JSON under `.proman/`, partial load of valid trees, dialog after pull/load/reload (Open file / Reload / Source Control)
- Hint when `git pull` fails with CONFLICT
- Optional semantic merge by `task.id`: `mergeTreeByTaskId`, ADR `docs/adr/semantic-tree-merge.md`, command **Proman: Resolve Proman Merge**
- Done tasks: clickable list of created/modified files (MCP `files` + subtask rollup)

### Changed
- Epic / parent nodes: icon and label color follow **task status** (no forced blue for Σ nodes)
- Team Git sync strategy and workflow documented in README (ru/en)
- Run in Agent: paste prompt into Agent input
- Task detail: Add subtask / Delete via IDE dialogs
- Heal `tree.json` → `trees/*` sync for MCP status writes

### Fixed
- Silent skip of corrupt/conflicted `trees/*.json` replaced with structured problems + UI warning

## [0.3.14] — 2026-07-17

### Added
- Multi-tree forest: each imported MD becomes a section (`.proman/trees/<slug>.json`)
- Re-import/Sync merges structure and keeps `status` / assignee
- MCP: optional `treeId` on `proman_get_tree` / `proman_next_actionable`

### Changed
- Legacy `tree.json` kept as flat MCP snapshot; old projects migrate automatically

## [0.3.13] — 2026-07-17

### Added
- Task tree, statuses, MD import, detail panel, search, My tasks
- Agent handoff + Drive Mode via MCP `proman_*`
- Local team: history, comments, assignment toasts
- Git sync: Pull/Push, optional auto-commit (push after auto-commit requires confirm)
- GitHub Issues: create on add, closed → done, safe owner/repo/URL checks
- MIT license, bilingual UI (EN/RU), RU + EN README

[0.3.16]: https://github.com/vibondar/proman/releases/tag/v0.3.16
[0.3.15]: https://github.com/vibondar/proman/releases/tag/v0.3.15
[0.3.14]: https://github.com/vibondar/proman/releases/tag/v0.3.14
[0.3.13]: https://github.com/vibondar/proman/releases/tag/v0.3.13-pre
