import { describe, expect, it } from "vitest";
import {
  mergeTreePreserveProgress,
  namespaceTaskIds,
  treeSlugFromSource,
  legacyToForest,
  flattenForest,
  projectStateFromForest,
  sanitizeLoadedTreeBundle,
  pullFlatIntoForest,
  isNamespacedUnderTree,
  applyFlatProgressToTrees,
} from "../src/core/forest";
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

describe("forest", () => {
  it("slugs source filenames and disambiguates same basename", () => {
    expect(treeSlugFromSource("My Plan.md")).toBe("my_plan");
    const a = treeSlugFromSource("docs/ROADMAP.md");
    const b = treeSlugFromSource("other/ROADMAP.md");
    expect(a).toMatch(/^roadmap_/);
    expect(b).toMatch(/^roadmap_/);
    expect(a).not.toBe(b);
  });

  it("namespaces task ids with __ separator", () => {
    const namespaced = namespaceTaskIds("roadmap", {
      roots: ["plan_1"],
      tasks: {
        plan_1: task({ id: "plan_1", title: "A", children: ["plan_2"] }),
        plan_2: task({ id: "plan_2", title: "B" }),
      },
    });
    expect(namespaced.roots).toEqual(["roadmap__plan_1"]);
    expect(namespaced.tasks.roadmap__plan_1.children).toEqual(["roadmap__plan_2"]);
    expect(namespaced.tasks.roadmap__plan_2.id).toBe("roadmap__plan_2");
  });

  it("avoids nested prefix collisions between tree ids", () => {
    const a = namespaceTaskIds("plan", {
      roots: ["auth_x"],
      tasks: { auth_x: task({ id: "auth_x", title: "A" }) },
    });
    const b = namespaceTaskIds("plan_auth", {
      roots: ["x"],
      tasks: { x: task({ id: "x", title: "B" }) },
    });
    expect(Object.keys(a.tasks)[0]).toBe("plan__auth_x");
    expect(Object.keys(b.tasks)[0]).toBe("plan_auth__x");
    expect(Object.keys(a.tasks)[0]).not.toBe(Object.keys(b.tasks)[0]);
    expect(isNamespacedUnderTree("plan", "plan__auth_x")).toBe(true);
    expect(isNamespacedUnderTree("plan_auth", "plan__auth_x")).toBe(false);
  });

  it("rejects unsafe tree ids on namespace", () => {
    expect(() =>
      namespaceTaskIds("../../evil", {
        roots: ["a"],
        tasks: { a: task({ id: "a", title: "A" }) },
      })
    ).toThrow(/Unsafe tree id/);
  });

  it("sanitizes loaded bundles: id must match filename", () => {
    const ok = sanitizeLoadedTreeBundle(
      {
        id: "roadmap",
        title: "R",
        roots: ["roadmap__a"],
        tasks: { roadmap__a: task({ id: "roadmap__a", title: "A" }) },
        edges: [],
        updatedAt: "",
      },
      "roadmap.json"
    );
    expect(ok?.id).toBe("roadmap");

    expect(
      sanitizeLoadedTreeBundle(
        {
          id: "../../package",
          title: "X",
          roots: [],
          tasks: {},
          edges: [],
          updatedAt: "",
        },
        "../../package.json"
      )
    ).toBeNull();

    expect(
      sanitizeLoadedTreeBundle(
        {
          id: "evil",
          title: "X",
          roots: [],
          tasks: {},
          edges: [],
          updatedAt: "",
        },
        "roadmap.json"
      )
    ).toBeNull();
  });

  it("pullFlatIntoForest does not steal into shorter tree prefix", () => {
    const state: ProjectState = {
      meta: { name: "t", createdAt: "", updatedAt: "", activeTreeId: "plan" },
      trees: [
        {
          id: "plan",
          title: "plan",
          roots: [],
          tasks: {},
          edges: [],
          updatedAt: "",
        },
        {
          id: "plan_auth",
          title: "plan_auth",
          roots: ["plan_auth__x"],
          tasks: { plan_auth__x: task({ id: "plan_auth__x", title: "X" }) },
          edges: [],
          updatedAt: "",
        },
      ],
      roots: ["plan_auth__x"],
      tasks: { plan_auth__x: task({ id: "plan_auth__x", title: "X", status: "done" }) },
      edges: [],
    };
    pullFlatIntoForest(state);
    expect(state.trees.find((t) => t.id === "plan_auth")?.tasks.plan_auth__x?.status).toBe(
      "done"
    );
    expect(state.trees.find((t) => t.id === "plan")?.tasks.plan_auth__x).toBeUndefined();
  });

  it("preserves status and assignee on merge", () => {
    const existing = {
      id: "roadmap",
      title: "roadmap",
      roots: ["roadmap__a"],
      tasks: {
        roadmap__a: task({
          id: "roadmap__a",
          title: "Old title",
          status: "done",
          assignee: "alice",
        }),
      },
      edges: [],
      updatedAt: new Date().toISOString(),
    };
    const merged = mergeTreePreserveProgress(existing, {
      roots: ["roadmap__a"],
      tasks: {
        roadmap__a: task({ id: "roadmap__a", title: "New title from MD", status: "todo" }),
      },
    });
    expect(merged.tasks.roadmap__a.title).toBe("New title from MD");
    expect(merged.tasks.roadmap__a.status).toBe("done");
    expect(merged.tasks.roadmap__a.assignee).toBe("alice");
  });

  it("keeps manual tasks across merge", () => {
    const existing = {
      id: "t",
      title: "t",
      roots: ["t__a", "t_m"],
      tasks: {
        t__a: task({ id: "t__a", title: "From MD" }),
        t_m: task({ id: "t_m", title: "Manual", source: "manual", status: "in_progress" }),
      },
      edges: [],
      updatedAt: new Date().toISOString(),
    };
    const merged = mergeTreePreserveProgress(existing, {
      roots: ["t__a"],
      tasks: { t__a: task({ id: "t__a", title: "From MD v2" }) },
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

  it("applyFlatProgressToTrees heals stale trees from tree.json snapshot", () => {
    const trees = [
      {
        id: "stomtari_design_align_plan",
        title: "Plan",
        roots: ["stomtari_design_align_plan__plan_1"],
        tasks: {
          stomtari_design_align_plan__plan_1: task({
            id: "stomtari_design_align_plan__plan_1",
            title: "A",
            status: "todo",
          }),
        },
        edges: [],
        updatedAt: "",
      },
    ];
    const flat = {
      stomtari_design_align_plan__plan_1: task({
        id: "stomtari_design_align_plan__plan_1",
        title: "A",
        status: "done",
        assignee: "alice",
      }),
    };
    expect(applyFlatProgressToTrees(trees, flat)).toBe(true);
    expect(trees[0].tasks.stomtari_design_align_plan__plan_1.status).toBe("done");
    expect(trees[0].tasks.stomtari_design_align_plan__plan_1.assignee).toBe("alice");
    expect(applyFlatProgressToTrees(trees, flat)).toBe(false);
  });
});
