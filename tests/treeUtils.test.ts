import { describe, expect, it } from "vitest";
import { resolveDriveTreeId, resolveTaskId } from "../src/tree/utils";

describe("resolveTaskId", () => {
  it("returns string args and falls back when arg is missing", () => {
    expect(resolveTaskId("t_1", () => "sel")).toBe("t_1");
    expect(resolveTaskId(undefined, () => "sel")).toBe("sel");
    expect(resolveTaskId(undefined, () => null)).toBeUndefined();
  });

  it("ignores section-like nodes", () => {
    expect(resolveTaskId({ kind: "section" }, () => "sel")).toBeUndefined();
  });

  it("reads task id from tree items", () => {
    expect(resolveTaskId({ kind: "task", task: { id: "t_x" } }, () => "sel")).toBe("t_x");
  });
});

describe("resolveDriveTreeId", () => {
  it("prefers section arg over selection and activeTreeId", () => {
    expect(
      resolveDriveTreeId(
        { kind: "section", treeId: "from-arg" },
        { kind: "section", treeId: "from-sel" },
        "active"
      )
    ).toBe("from-arg");
  });

  it("uses selected section when arg is missing", () => {
    expect(
      resolveDriveTreeId(undefined, { kind: "section", treeId: "from-sel" }, "active")
    ).toBe("from-sel");
  });

  it("ignores selected task nodes — only section header scopes Drive", () => {
    expect(
      resolveDriveTreeId(
        { kind: "task", treeId: "task-tree" },
        { kind: "task", treeId: "sel-tree" },
        "active"
      )
    ).toBe("active");
  });

  it("falls back to activeTreeId", () => {
    expect(resolveDriveTreeId(undefined, undefined, "active")).toBe("active");
    expect(resolveDriveTreeId(undefined, undefined, null)).toBeUndefined();
  });
});
