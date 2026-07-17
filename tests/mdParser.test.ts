import { describe, expect, it } from "vitest";
import { mergeParsed, parseMarkdownToTree } from "../src/core/mdParser";

describe("parseMarkdownToTree", () => {
  it("builds plan_N hierarchy with descriptions and meta", () => {
    const md = [
      "---",
      "type: plan",
      "title: Demo",
      "---",
      "# Epic",
      "",
      "Эпик описание",
      "",
      "## Feature",
      "",
      "- [ ] Task A",
      "Оценка: 2 SP",
      "depends on Feature",
      "- [x] Task B",
    ].join("\n");

    const r = parseMarkdownToTree(md, "docs/plan.md");
    expect(r.meta.type).toBe("plan");
    expect(r.roots).toEqual(["plan_1"]);
    expect(r.tasks.plan_1.title).toBe("Epic");
    expect(r.tasks.plan_1.description).toContain("Эпик описание");
    expect(r.tasks.plan_1.children).toContain("plan_2");
    expect(r.tasks.plan_3.title).toBe("Task A");
    expect(r.tasks.plan_3.estimateSp).toBe(2);
    expect(r.tasks.plan_3.dependsOn).toContain("plan_2");
    expect(r.tasks.plan_4.status).toBe("done");
    expect(r.nextCounter).toBe(5);
  });

  it("uses md_ ids when not a plan doc", () => {
    const r = parseMarkdownToTree("# Only\n", "notes/todo.md");
    expect(Object.keys(r.tasks)[0]).toMatch(/^md_/);
  });

  it("parses plain bullets under a heading", () => {
    const r = parseMarkdownToTree("# Epic\n- Plain item\n", "docs/plan.md", {
      idStyle: "plan",
    });
    expect(r.tasks.plan_2.title).toBe("Plain item");
    expect(r.tasks.plan_2.status).toBe("todo");
  });

  it("creates fallback root for empty body", () => {
    const r = parseMarkdownToTree("---\ntype: plan\ntitle: Empty\n---\n\n", "empty.md");
    expect(r.roots).toHaveLength(1);
    expect(r.tasks[r.roots[0]].title).toBe("Empty");
  });
});

describe("mergeParsed", () => {
  it("merges roots and tasks", () => {
    const a = parseMarkdownToTree("---\ntype: plan\n---\n# A\n", "a.md", { startCounter: 1 });
    const b = parseMarkdownToTree("---\ntype: plan\n---\n# B\n", "b.md", { startCounter: a.nextCounter });
    const m = mergeParsed([a, b]);
    expect(m.roots).toEqual(["plan_1", "plan_2"]);
    expect(Object.keys(m.tasks)).toHaveLength(2);
  });
});
