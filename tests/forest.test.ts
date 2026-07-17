import { describe, expect, it } from "vitest";
import {
  mergeTreePreserveProgress,
  namespaceTaskIds,
  treeSlugFromSource,
  legacyToForest,
  flattenForest,
  projectStateFromForest,
} from "../src/core/forest";
import { TaskNode } from "../src/core/types";

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

describe("forest", () => {
  it("slugs source filenames", () => {
    expect(treeSlugFromSource("docs/ROADMAP.md")).toBe("roadmap");
    expect(treeSlugFromSource("My Plan.md")).toBe("my_plan");
  });

  it("namespaces task ids per tree", () => {
    const namespaced = namespaceTaskIds("roadmap", {
      roots: ["plan_1"],
      tasks: {
        plan_1: task({ id: "plan_1", title: "A", children: ["plan_2"] }),
        plan_2: task({ id: "plan_2", title: "B" }),
      },
    });
    expect(namespaced.roots).toEqual(["roadmap_plan_1"]);
    expect(namespaced.tasks.roadmap_plan_1.children).toEqual(["roadmap_plan_2"]);
    expect(namespaced.tasks.roadmap_plan_2.id).toBe("roadmap_plan_2");
  });

  it("preserves status and assignee on merge", () => {
    const existing = {
      id: "roadmap",
      title: "roadmap",
      roots: ["roadmap_a"],
      tasks: {
        roadmap_a: task({
          id: "roadmap_a",
          title: "Old title",
          status: "done",
          assignee: "alice",
        }),
      },
      edges: [],
      updatedAt: new Date().toISOString(),
    };
    const merged = mergeTreePreserveProgress(existing, {
      roots: ["roadmap_a"],
      tasks: {
        roadmap_a: task({ id: "roadmap_a", title: "New title from MD", status: "todo" }),
      },
    });
    expect(merged.tasks.roadmap_a.title).toBe("New title from MD");
    expect(merged.tasks.roadmap_a.status).toBe("done");
    expect(merged.tasks.roadmap_a.assignee).toBe("alice");
  });

  it("keeps manual tasks across merge", () => {
    const existing = {
      id: "t",
      title: "t",
      roots: ["t_a", "t_m"],
      tasks: {
        t_a: task({ id: "t_a", title: "From MD" }),
        t_m: task({ id: "t_m", title: "Manual", source: "manual", status: "in_progress" }),
      },
      edges: [],
      updatedAt: new Date().toISOString(),
    };
    const merged = mergeTreePreserveProgress(existing, {
      roots: ["t_a"],
      tasks: { t_a: task({ id: "t_a", title: "From MD v2" }) },
    });
    expect(merged.tasks.t_m?.status).toBe("in_progress");
    expect(merged.roots).toContain("t_m");
  });

  it("migrates legacy single tree", () => {
    const forest = legacyToForest(
      { name: "Demo", createdAt: "", updatedAt: "" },
      ["a"],
      { a: task({ id: "a", title: "A" }) },
      []
    );
    expect(forest).toHaveLength(1);
    expect(forest[0].id).toBe("main");
    const state = projectStateFromForest(
      { name: "Demo", createdAt: "", updatedAt: "" },
      forest
    );
    expect(state.trees).toHaveLength(1);
    expect(state.tasks.a.title).toBe("A");
    const flat = flattenForest(state.trees);
    expect(flat.roots).toEqual(["a"]);
  });
});
