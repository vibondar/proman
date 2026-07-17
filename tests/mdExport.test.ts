import { describe, expect, it } from "vitest";
import { exportTreeToMarkdown, suggestedExportBasename } from "../src/core/mdExport";
import { parseMarkdownToTree } from "../src/core/mdParser";
import { namespaceTaskIds } from "../src/core/forest";
import { TreeBundle } from "../src/core/types";

function sampleTree(): TreeBundle {
  const local = {
    roots: ["plan_1"],
    tasks: {
      plan_1: {
        id: "plan_1",
        title: "Epic",
        description: "Top level",
        status: "todo" as const,
        children: ["plan_2", "plan_3"],
        dependsOn: [],
        source: "md:plan.md",
      },
      plan_2: {
        id: "plan_2",
        title: "Done leaf",
        description: "Оценка: 1 SP",
        status: "done" as const,
        children: [],
        dependsOn: [],
        source: "md:plan.md",
      },
      plan_3: {
        id: "plan_3",
        title: "WIP leaf",
        description: "Goal: finish",
        status: "in_progress" as const,
        children: [],
        dependsOn: ["plan_2"],
        source: "md:plan.md",
        assignee: "alice",
      },
    },
  };
  const ns = namespaceTaskIds("demo", local);
  return {
    id: "demo",
    title: "Demo Plan",
    sourceFile: "docs/demo.md",
    roots: ns.roots,
    tasks: ns.tasks,
    edges: [],
    updatedAt: new Date().toISOString(),
  };
}

describe("exportTreeToMarkdown", () => {
  it("writes checkboxes and Status for non-todo/done", () => {
    const md = exportTreeToMarkdown(sampleTree());
    expect(md).toContain("type: plan");
    expect(md).toContain("title: Demo Plan");
    expect(md).toContain("# Epic");
    expect(md).toContain("- [x] Done leaf");
    expect(md).toContain("- [ ] WIP leaf");
    expect(md).toContain("Status: in_progress");
    expect(md).toContain("Assignee: @alice");
    expect(md).toContain("Depends on Done leaf");
  });

  it("round-trips progress via parseMarkdownToTree", () => {
    const md = exportTreeToMarkdown(sampleTree());
    const parsed = parseMarkdownToTree(md, "export.md");
    const byTitle = Object.fromEntries(
      Object.values(parsed.tasks).map((t) => [t.title, t])
    );
    expect(byTitle["Done leaf"].status).toBe("done");
    expect(byTitle["WIP leaf"].status).toBe("in_progress");
    expect(byTitle["WIP leaf"].assignee).toBe("alice");
    expect(byTitle["WIP leaf"].dependsOn.length).toBe(1);
  });

  it("suggests basename from sourceFile", () => {
    expect(suggestedExportBasename(sampleTree())).toBe("demo.md");
  });
});
