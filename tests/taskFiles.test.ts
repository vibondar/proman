import { describe, expect, it } from "vitest";
import {
  collectDoneTaskFiles,
  resolveTaskFilePath,
  sanitizeTaskFiles,
} from "../src/core/taskFiles";
import { ProjectState, TaskNode } from "../src/core/types";

function task(partial: Partial<TaskNode> & { id: string; title: string }): TaskNode {
  return {
    description: "",
    status: "todo",
    children: [],
    dependsOn: [],
    source: "md:test",
    ...partial,
  };
}

describe("sanitizeTaskFiles", () => {
  const root = "/tmp/proman-ws";

  it("keeps relative paths inside workspace", () => {
    const files = sanitizeTaskFiles(root, [
      { path: "src/a.ts", kind: "created" },
      "tests/a.test.ts",
    ]);
    expect(files).toEqual([
      { path: "src/a.ts", kind: "created" },
      { path: "tests/a.test.ts" },
    ]);
  });

  it("rejects traversal, null bytes, and escape", () => {
    expect(
      sanitizeTaskFiles(root, [
        "../etc/passwd",
        "src/../../etc/passwd",
        "a\0b.ts",
        "",
        { path: "/etc/passwd", kind: "modified" },
      ])
    ).toEqual([]);
  });

  it("dedupes and caps at 100", () => {
    const raw = Array.from({ length: 120 }, (_, i) => `f${i}.ts`);
    raw.push("f0.ts");
    const files = sanitizeTaskFiles(root, raw);
    expect(files).toHaveLength(100);
    expect(files[0].path).toBe("f0.ts");
  });

  it("accepts absolute path still under workspace", () => {
    const files = sanitizeTaskFiles(root, [`${root}/src/x.ts`]);
    expect(files).toEqual([{ path: "src/x.ts" }]);
  });
});

describe("collectDoneTaskFiles", () => {
  it("returns empty for non-done tasks", () => {
    const state: ProjectState = {
      meta: { name: "t", createdAt: "", updatedAt: "" },
      trees: [],
      roots: ["p"],
      tasks: {
        p: task({ id: "p", title: "P", status: "in_progress", changedFiles: [{ path: "a.ts" }] }),
      },
      edges: [],
    };
    expect(collectDoneTaskFiles(state, "p")).toEqual([]);
  });

  it("rolls up done children and falls back to code/tests", () => {
    const state: ProjectState = {
      meta: { name: "t", createdAt: "", updatedAt: "" },
      trees: [],
      roots: ["p"],
      tasks: {
        p: task({
          id: "p",
          title: "Parent",
          status: "done",
          children: ["c1", "c2"],
          changedFiles: [{ path: "src/parent.ts", kind: "modified" }],
        }),
        c1: task({
          id: "c1",
          title: "Child one",
          status: "done",
          changedFiles: [{ path: "src/child.ts", kind: "created" }],
        }),
        c2: task({
          id: "c2",
          title: "Child two",
          status: "todo",
          code: ["src/skipped.ts"],
        }),
        // nested under c1 would need children on c1 - add sibling with plan fallback only on parent empty case
      },
      edges: [],
    };
    const rows = collectDoneTaskFiles(state, "p");
    expect(rows.map((r) => r.path).sort()).toEqual(["src/child.ts", "src/parent.ts"]);
    const child = rows.find((r) => r.path === "src/child.ts");
    expect(child?.fromTaskTitle).toBe("Child one");
    expect(child?.kind).toBe("created");
  });

  it("uses code/tests fallback when changedFiles empty", () => {
    const state: ProjectState = {
      meta: { name: "t", createdAt: "", updatedAt: "" },
      trees: [],
      roots: ["p"],
      tasks: {
        p: task({
          id: "p",
          title: "P",
          status: "done",
          code: ["src/from-plan.ts"],
          tests: ["tests/from-plan.test.ts"],
        }),
      },
      edges: [],
    };
    const rows = collectDoneTaskFiles(state, "p");
    expect(rows.every((r) => r.fromPlan)).toBe(true);
    expect(rows.map((r) => r.path).sort()).toEqual([
      "src/from-plan.ts",
      "tests/from-plan.test.ts",
    ]);
  });
});

describe("resolveTaskFilePath", () => {
  it("resolves safe paths and rejects escape", () => {
    expect(resolveTaskFilePath("/tmp/ws", "src/a.ts")).toBe("/tmp/ws/src/a.ts");
    expect(resolveTaskFilePath("/tmp/ws", "../x")).toBeNull();
  });
});
