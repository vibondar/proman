import { describe, expect, it } from "vitest";
import { DependencyEngine } from "../src/core/dependencyEngine";
import { ProjectState, TaskNode } from "../src/core/types";

function task(
  id: string,
  opts: Partial<TaskNode> & { title?: string } = {}
): TaskNode {
  return {
    id,
    title: opts.title ?? id,
    description: "",
    status: opts.status ?? "todo",
    children: opts.children ?? [],
    dependsOn: opts.dependsOn ?? [],
    source: "test",
  };
}

function state(tasks: Record<string, TaskNode>, roots: string[]): ProjectState {
  return {
    meta: { name: "t", createdAt: "", updatedAt: "" },
    roots,
    tasks,
    edges: [],
  };
}

describe("DependencyEngine", () => {
  const engine = new DependencyEngine();

  it("detects dependency cycles and rejects cyclic preview", () => {
    const s = state(
      {
        a: task("a", { dependsOn: ["b"] }),
        b: task("b"),
      },
      ["a", "b"]
    );
    const preview = engine.preview(s, {
      kind: "updateDepends",
      taskId: "b",
      dependsOn: ["a"],
    });
    expect(preview.ok).toBe(false);
    if (preview.ok) return;
    expect(preview.error).toMatch(/цикл/i);
    expect(engine.detectCycles(state({ a: task("a", { dependsOn: ["b"] }), b: task("b", { dependsOn: ["a"] }) }, ["a", "b"])).length).toBeGreaterThan(0);
  });

  it("previews promote delete and add", () => {
    const s = state(
      {
        p: task("p", { children: ["c"] }),
        c: task("c"),
      },
      ["p"]
    );
    const del = engine.preview(s, { kind: "delete", taskId: "p", mode: "promote" });
    expect(del.ok).toBe(true);

    const add = engine.preview(s, {
      kind: "add",
      title: "New",
      parentId: "p",
      dependsOn: ["c"],
    });
    expect(add.ok).toBe(true);
    if (!add.ok) return;
    expect(add.affected.some((x) => x.change === "Будет добавлена")).toBe(true);
  });

  it("previews add and status impact on dependents", () => {
    const s = state(
      {
        a: task("a", { status: "todo" }),
        b: task("b", { status: "todo", dependsOn: ["a"] }),
      },
      ["a", "b"]
    );
    const preview = engine.preview(s, { kind: "setStatus", taskId: "a", status: "done" });
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    const bChange = preview.affected.find((x) => x.taskId === "b");
    expect(bChange?.suggestedStatus).toBe("todo");
  });

  it("previews cascade delete", () => {
    const s = state(
      {
        p: task("p", { children: ["c"] }),
        c: task("c"),
      },
      ["p"]
    );
    const preview = engine.preview(s, { kind: "delete", taskId: "p", mode: "cascade" });
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.affected.some((x) => x.taskId === "p" && x.change === "Будет удалена")).toBe(
      true
    );
    expect(preview.affected.some((x) => x.taskId === "c")).toBe(true);
  });

  it("describes direct and unrelated relations", () => {
    const s = state(
      {
        a: task("a", { title: "A", dependsOn: ["b"] }),
        b: task("b", { title: "B" }),
        c: task("c", { title: "C" }),
      },
      ["a", "b", "c"]
    );
    expect(engine.describeRelation(s, "a", "b")).toMatch(/зависит от/);
    expect(engine.describeRelation(s, "a", "c")).toMatch(/не связаны/);
  });
});
