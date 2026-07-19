import { describe, expect, it } from "vitest";
import { sanitizeLoadedTreeBundle } from "../src/core/forest";
import { mergeTreeByTaskId, parseTreeBundleJson } from "../src/core/treeMerge";
import { TaskNode, TreeBundle } from "../src/core/types";

function task(id: string, opts: Partial<TaskNode> = {}): TaskNode {
  return {
    id,
    title: opts.title ?? id,
    description: opts.description ?? "",
    status: opts.status ?? "todo",
    children: opts.children ?? [],
    dependsOn: opts.dependsOn ?? [],
    source: opts.source ?? "test",
    assignee: opts.assignee,
    tags: opts.tags,
  };
}

function bundle(
  id: string,
  tasks: Record<string, TaskNode>,
  roots?: string[]
): TreeBundle {
  return {
    id,
    title: id,
    roots: roots ?? Object.keys(tasks).filter((tid) => {
      return !Object.values(tasks).some((t) => t.children.includes(tid));
    }),
    tasks,
    edges: [],
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("mergeTreeByTaskId", () => {
  it("merges disjoint status edits", () => {
    const ours = bundle("main", {
      a: task("a", { status: "done" }),
      b: task("b", { status: "todo" }),
    });
    const theirs = bundle("main", {
      a: task("a", { status: "todo" }),
      b: task("b", { status: "in_progress" }),
    });
    const r = mergeTreeByTaskId(ours, theirs);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.tree.tasks.a?.status).toBe("done");
    expect(r.tree.tasks.b?.status).toBe("in_progress");
    expect(sanitizeLoadedTreeBundle(r.tree, "main.json")).toBeTruthy();
  });

  it("resolves title+status conflict with prefer-progress and ours title", () => {
    const ours = bundle("main", {
      a: task("a", { title: "Ours", status: "todo" }),
    });
    const theirs = bundle("main", {
      a: task("a", { title: "Theirs", status: "done" }),
    });
    const r = mergeTreeByTaskId(ours, theirs);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.tree.tasks.a?.status).toBe("done");
    expect(r.tree.tasks.a?.title).toBe("Ours");
  });

  it("unions dependsOn", () => {
    const ours = bundle("main", {
      a: task("a", { dependsOn: ["b"] }),
      b: task("b"),
      c: task("c"),
    });
    const theirs = bundle("main", {
      a: task("a", { dependsOn: ["c"] }),
      b: task("b"),
      c: task("c"),
    });
    const r = mergeTreeByTaskId(ours, theirs);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.tree.tasks.a?.dependsOn).toEqual(["b", "c"]);
  });

  it("without base, presence wins (deleted side reappears)", () => {
    const ours = bundle("main", { a: task("a"), b: task("b") });
    const theirs = bundle("main", { a: task("a") });
    const r = mergeTreeByTaskId(ours, theirs);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Object.keys(r.tree.tasks).sort()).toEqual(["a", "b"]);
  });

  it("with base, respects deletes", () => {
    const base = bundle("main", { a: task("a"), b: task("b"), c: task("c") });
    const ours = bundle("main", { a: task("a"), c: task("c") }); // deleted b
    const theirs = bundle("main", { a: task("a"), b: task("b") }); // deleted c
    const r = mergeTreeByTaskId(ours, theirs, { base });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Object.keys(r.tree.tasks).sort()).toEqual(["a"]);
  });

  it("refuses mismatched tree ids", () => {
    const r = mergeTreeByTaskId(bundle("a", { x: task("x") }), bundle("b", { x: task("x") }));
    expect(r.ok).toBe(false);
  });
});

describe("parseTreeBundleJson", () => {
  it("rejects conflict markers", () => {
    const r = parseTreeBundleJson("<<<<<<< HEAD\n{}\n>>>>>>> x\n", "main.json");
    expect(r.ok).toBe(false);
  });

  it("accepts sanitized valid tree", () => {
    const text = JSON.stringify(
      bundle("main", {
        main__root: task("main__root", { title: "Root" }),
      })
    );
    // id must match filename stem — use matching ids
    const okBundle = {
      id: "main",
      title: "main",
      roots: ["t1"],
      tasks: {
        t1: task("t1", { title: "Root" }),
      },
      edges: [],
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const r = parseTreeBundleJson(JSON.stringify(okBundle), "main.json");
    expect(r.ok).toBe(true);
  });
});
