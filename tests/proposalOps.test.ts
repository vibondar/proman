import { describe, expect, it } from "vitest";
import { parseStructureOps, sanitizeImportBasename } from "../src/core/proposalOps";

describe("parseStructureOps", () => {
  it("rejects non-array / empty / oversized", () => {
    expect(parseStructureOps({})).toEqual({ ok: false, error: "ops must be an array" });
    expect(parseStructureOps([])).toEqual({ ok: false, error: "ops must not be empty" });
    expect(parseStructureOps(Array(51).fill({ op: "setStatus", taskId: "a", status: "todo" }))).toEqual({
      ok: false,
      error: "ops: max 50 per proposal",
    });
  });

  it("parses upsert / setStatus / setDepends / delete", () => {
    const r = parseStructureOps([
      {
        op: "upsert",
        parentId: null,
        tasks: [{ id: "t1", title: "One", status: "todo", children: [], dependsOn: [] }],
      },
      { op: "setStatus", taskId: "t1", status: "done" },
      { op: "setDepends", taskId: "t1", dependsOn: ["t2", "../evil"] },
      { op: "delete", taskId: "t1", mode: "cascade" },
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.ops).toHaveLength(4);
    expect(r.ops[2]).toEqual({ op: "setDepends", taskId: "t1", dependsOn: ["t2"] });
    expect(r.ops[3]).toEqual({ op: "delete", taskId: "t1", mode: "cascade" });
  });

  it("rejects unsafe ids and unknown ops", () => {
    expect(
      parseStructureOps([{ op: "upsert", tasks: [{ id: "../x", title: "Bad" }] }]).ok
    ).toBe(false);
    expect(parseStructureOps([{ op: "hack" }]).ok).toBe(false);
    expect(parseStructureOps([{ op: "setStatus", taskId: "t1", status: "nope" }]).ok).toBe(false);
  });
});

describe("sanitizeImportBasename", () => {
  it("keeps safe basenames and strips paths", () => {
    expect(sanitizeImportBasename("plan.md")).toBe("plan.md");
    expect(sanitizeImportBasename("docs/../evil.md")).toBe("evil.md");
    expect(sanitizeImportBasename("../../etc/passwd")).toBe("passwd");
  });

  it("rejects empty / dots / null bytes", () => {
    expect(sanitizeImportBasename("")).toBeNull();
    expect(sanitizeImportBasename(".")).toBeNull();
    expect(sanitizeImportBasename("..")).toBeNull();
    expect(sanitizeImportBasename("a\0b.md")).toBeNull();
  });
});
