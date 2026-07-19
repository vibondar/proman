# ADR: semantic merge of Proman tree tasks

Status: accepted  
Applies to: `mergeTreeByTaskId` (`src/core/treeMerge.ts`), command **Proman: Resolve Proman Merge**

## Context

Git merge of `trees/<slug>.json` is still ordinary git. Semantic merge is a **human-triggered** helper: merge two already-valid JSON snapshots (ours / theirs), optionally with a base for delete detection. It does not run silently on every pull.

## Sides

| Name | Meaning |
|------|---------|
| **ours** | Local / “keep my side” snapshot |
| **theirs** | Incoming / other side |
| **base** | Optional common ancestor (pre-divergence). Without base, deletes cannot be detected. |

## Field strategies

| Field | Strategy | Notes |
|-------|----------|--------|
| `id` | identity key | Tasks matched by `task.id` only |
| `status` | prefer-progress | Rank: `done` > `error` > `needs_rework` > `in_progress` > `blocked` > `new` > `todo`. Higher rank wins. Tie → **ours** |
| `title` | prefer-nonempty → ours | Empty loses to non-empty; both nonempty and differ → **ours** |
| `description` | prefer-nonempty → ours | Same as title |
| `assignee` | prefer-nonempty → ours | |
| `impactHint` | prefer-nonempty → ours | |
| `source` | ours-wins | Prefer **ours** when both set |
| `estimateSp` / `estimateHours` | prefer-defined → max | If both defined, take **max** |
| `tags` / `code` / `tests` | **union** | Order: ours first, then theirs-only; dedupe |
| `changedFiles` | **union** by `path` | Prefer ours’ `kind` on same path |
| `children` | **union** | Ours order first, then theirs-only ids that still exist after merge |
| `dependsOn` | **union** | Same as children; drop ids missing from merged task map |

Tree bundle meta: `id` / `title` / `sourceFile` from **ours** (must be same tree id or refuse). `roots` recomputed: task ids not referenced as anyone’s child. `edges` from `edgesFromTasks`.

## Deletes

| Situation | Result |
|-----------|--------|
| No `base` | **Presence wins**: any id in ours or theirs is kept (a delete on one side cannot be inferred) |
| In `base`, missing from **ours**, present in **theirs** | Treated as **ours deleted** → **omit** (human already chose to run merge) |
| In `base`, present in **ours**, missing from **theirs** | Treated as **theirs deleted** → **omit** |
| In `base`, missing from both | Omit |
| Not in `base`, only on one side | Keep (add) |

**Out of scope:** automatic structural delete without the Resolve command; CRDT; silent merge on pull.

## Safety

- Inputs must be valid JSON **without** conflict markers (`detectPromanFileProblem === ok`).
- Output must pass `sanitizeLoadedTreeBundle` for `trees/<id>.json`.
- Write only under `.proman/trees/<safeId>.json`.
