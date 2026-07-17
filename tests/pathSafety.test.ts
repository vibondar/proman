import { describe, expect, it } from "vitest";
import { isSafeId, resolveInside, resolvePlanningDir } from "../src/core/pathSafety";

describe("isSafeId", () => {
  it("accepts alphanumeric ids with _ and -", () => {
    expect(isSafeId("a")).toBe(true);
    expect(isSafeId("plan_1")).toBe(true);
    expect(isSafeId("Task-42")).toBe(true);
  });

  it("rejects empty, traversal, and unsafe chars", () => {
    expect(isSafeId("")).toBe(false);
    expect(isSafeId("../x")).toBe(false);
    expect(isSafeId("a/b")).toBe(false);
    expect(isSafeId("-bad")).toBe(false);
    expect(isSafeId("has space")).toBe(false);
  });
});

describe("resolveInside", () => {
  it("resolves relative parts under root", () => {
    const root = "/tmp/ws";
    expect(resolveInside(root, ".proman", "tree.json")).toBe("/tmp/ws/.proman/tree.json");
  });

  it("rejects path escape via ..", () => {
    expect(resolveInside("/tmp/ws", "..", "etc")).toBeNull();
    expect(resolveInside("/tmp/ws", "a", "..", "..", "etc")).toBeNull();
  });

  it("allows the root itself", () => {
    expect(resolveInside("/tmp/ws")).toBe("/tmp/ws");
  });
});

describe("resolvePlanningDir", () => {
  it("resolves relative planning dir", () => {
    expect(resolvePlanningDir("/tmp/ws", "docs/plans")).toBe("/tmp/ws/docs/plans");
  });

  it("rejects empty and absolute escape", () => {
    expect(resolvePlanningDir("/tmp/ws", "")).toBeNull();
    expect(resolvePlanningDir("/tmp/ws", "/etc")).toBeNull();
  });

  it("accepts absolute path still inside workspace", () => {
    expect(resolvePlanningDir("/tmp/ws", "/tmp/ws/docs")).toBe("/tmp/ws/docs");
  });
});
