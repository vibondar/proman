import { describe, expect, it } from "vitest";
import {
  applyBlocked,
  nextActionable,
  writeProposal,
} from "../src/core/driveEngine";
import { ProjectState, TaskNode } from "../src/core/types";

function task(id: string, opts: Partial<TaskNode> = {}): TaskNode {
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
    trees: [
      {
        id: "main",
        title: "main",
        roots,
        tasks,
        edges: [],
        updatedAt: "",
      },
    ],
    roots,
    tasks,
    edges: [],
  };
}

describe("applyBlocked", () => {
  it("marks unmet deps as blocked and unlocks when done", () => {
    const s = state(
      {
        a: task("a", { status: "todo" }),
        b: task("b", { status: "todo", dependsOn: ["a"] }),
      },
      ["a", "b"]
    );
    applyBlocked(s);
    expect(s.tasks.b.status).toBe("blocked");

    s.tasks.a.status = "done";
    applyBlocked(s);
    expect(s.tasks.b.status).toBe("todo");
  });

  it("does not change done / error / needs_rework", () => {
    const s = state(
      {
        a: task("a", { status: "todo" }),
        b: task("b", { status: "done", dependsOn: ["a"] }),
        c: task("c", { status: "error", dependsOn: ["a"] }),
      },
      ["a", "b", "c"]
    );
    applyBlocked(s);
    expect(s.tasks.b.status).toBe("done");
    expect(s.tasks.c.status).toBe("error");
  });
});

describe("nextActionable", () => {
  it("prefers in_progress, then needs_rework, then DFS leaf order", () => {
    const s = state(
      {
        root: task("root", { children: ["leaf1", "leaf2"] }),
        leaf1: task("leaf1", { status: "todo" }),
        leaf2: task("leaf2", { status: "todo" }),
      },
      ["root"]
    );
    expect(nextActionable(s).task?.id).toBe("leaf1");

    s.tasks.leaf2.status = "needs_rework";
    expect(nextActionable(s).reason).toMatch(/needs_rework/);
    expect(nextActionable(s).task?.id).toBe("leaf2");

    s.tasks.leaf1.status = "in_progress";
    expect(nextActionable(s).task?.id).toBe("leaf1");
    expect(nextActionable(s).reason).toMatch(/in_progress/);
  });

  it("skips tasks with unmet dependencies", () => {
    const s = state(
      {
        a: task("a", { status: "todo" }),
        b: task("b", { status: "todo", dependsOn: ["a"] }),
      },
      ["a", "b"]
    );
    expect(nextActionable(s).task?.id).toBe("a");
    expect(nextActionable(s).queue.map((q) => q.id)).not.toContain("b");
  });

  it("returns null when nothing is actionable", () => {
    const s = state({ a: task("a", { status: "done" }) }, ["a"]);
    expect(nextActionable(s).task).toBeNull();
  });
});

describe("writeProposal", () => {
  it("rejects unsafe proposal ids before IO", async () => {
    await expect(
      writeProposal("/tmp/ws", {
        id: "../evil",
        createdAt: "",
        summary: "x",
        rationale: "y",
        status: "pending",
        ops: [{ op: "setStatus", taskId: "t1", status: "todo" }],
      })
    ).rejects.toThrow(/Unsafe proposal id/);
  });
});
