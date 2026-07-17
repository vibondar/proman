import { describe, expect, it } from "vitest";
import {
  enrichTaskFromDescription,
  parseTaskMeta,
  subtreeEstimateSp,
  upsertMetaInDescription,
} from "../src/core/taskMeta";
import { TaskNode } from "../src/core/types";

const base = (partial: Partial<TaskNode> & Pick<TaskNode, "id" | "title">): TaskNode => ({
  description: "",
  status: "todo",
  children: [],
  dependsOn: [],
  source: "test",
  ...partial,
});

describe("parseTaskMeta", () => {
  it("parses estimate, tags, code, tests, assignee", () => {
    const meta = parseTaskMeta(
      [
        "Описание задачи",
        "Оценка: 3 SP / 2 часа",
        "Теги: #auth #api",
        "Код: src/a.ts, src/b.ts",
        "Тесты: tests/a.test.ts",
        "Assignee: @alice",
      ].join("\n")
    );
    expect(meta).toEqual({
      estimateSp: 3,
      estimateHours: 2,
      tags: ["auth", "api"],
      code: ["src/a.ts", "src/b.ts"],
      tests: ["tests/a.test.ts"],
      assignee: "alice",
    });
  });

  it("returns empty for blank description", () => {
    expect(parseTaskMeta("")).toEqual({});
  });
});

describe("enrichTaskFromDescription", () => {
  it("fills missing fields from description without overwriting", () => {
    const t = enrichTaskFromDescription(
      base({
        id: "t1",
        title: "T",
        description: "Оценка: 5 SP\nТеги: #x\nAssignee: bob",
        estimateSp: 1,
        tags: ["keep"],
      })
    );
    expect(t.estimateSp).toBe(1);
    expect(t.tags).toEqual(["keep"]);
    expect(t.assignee).toBe("bob");
  });
});

describe("subtreeEstimateSp", () => {
  it("sums children and ignores parent SP when nested", () => {
    const tasks: Record<string, TaskNode> = {
      epic: base({ id: "epic", title: "E", estimateSp: 99, children: ["a", "b"] }),
      a: base({ id: "a", title: "A", estimateSp: 2 }),
      b: base({ id: "b", title: "B", estimateSp: 3 }),
    };
    expect(subtreeEstimateSp(tasks, "epic")).toBe(5);
    expect(subtreeEstimateSp(tasks, "a")).toBe(2);
    expect(subtreeEstimateSp(tasks, "missing")).toBe(0);
  });
});

describe("upsertMetaInDescription", () => {
  it("writes and clears meta lines", () => {
    const next = upsertMetaInDescription("проза", {
      estimateSp: 2,
      tags: ["ui"],
      assignee: "carol",
      code: ["src/x.ts"],
      tests: ["tests/x.test.ts"],
    });
    expect(next).toContain("Оценка: 2 SP");
    expect(next).toContain("Теги: #ui");
    expect(next).toContain("Assignee: carol");
    expect(next).toContain("Код: src/x.ts");
    expect(next).toContain("Тесты: tests/x.test.ts");

    const cleared = upsertMetaInDescription(next, {
      tags: [],
      assignee: "",
    });
    expect(cleared).not.toMatch(/Теги:/);
    expect(cleared).not.toMatch(/Assignee:/);
  });
});
