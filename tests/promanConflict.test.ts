import { describe, expect, it } from "vitest";
import {
  detectPromanFileProblem,
  isPromanJsonScanTarget,
  scanPromanJsonProblems,
} from "../src/core/promanConflict";

describe("detectPromanFileProblem", () => {
  it("accepts valid JSON", () => {
    expect(detectPromanFileProblem('{"id":"a","tasks":{}}')).toBe("ok");
    expect(detectPromanFileProblem("[]")).toBe("ok");
    expect(detectPromanFileProblem("null")).toBe("ok");
  });

  it("detects conflict markers", () => {
    const text = `{
<<<<<<< HEAD
  "id": "ours"
=======
  "id": "theirs"
>>>>>>> feature
}`;
    expect(detectPromanFileProblem(text)).toBe("conflict_markers");
  });

  it("prefers conflict_markers over invalid_json", () => {
    expect(detectPromanFileProblem("<<<<<<< HEAD\nnot json")).toBe("conflict_markers");
  });

  it("detects truncated / invalid JSON", () => {
    expect(detectPromanFileProblem('{"id":')).toBe("invalid_json");
    expect(detectPromanFileProblem("")).toBe("invalid_json");
    expect(detectPromanFileProblem("{")).toBe("invalid_json");
  });
});

describe("isPromanJsonScanTarget", () => {
  it("includes project.json, tree.json, trees/*.json", () => {
    expect(isPromanJsonScanTarget("project.json")).toBe(true);
    expect(isPromanJsonScanTarget("tree.json")).toBe(true);
    expect(isPromanJsonScanTarget("trees/main.json")).toBe(true);
    expect(isPromanJsonScanTarget("trees/foo_bar.json")).toBe(true);
  });

  it("excludes other .proman paths", () => {
    expect(isPromanJsonScanTarget("history.json")).toBe(false);
    expect(isPromanJsonScanTarget("comments/a.json")).toBe(false);
    expect(isPromanJsonScanTarget("trees/nested/x.json")).toBe(false);
    expect(isPromanJsonScanTarget("edges.json")).toBe(false);
  });
});

describe("scanPromanJsonProblems", () => {
  it("reports only problem targets", () => {
    const problems = scanPromanJsonProblems({
      "project.json": '{"name":"ok"}',
      "tree.json": "<<<<<<< HEAD\n{}\n>>>>>>> x\n",
      "trees/a.json": '{"id":',
      "history.json": "<<<<<<< HEAD\n",
    });
    expect(problems).toEqual([
      { path: "tree.json", kind: "conflict_markers" },
      { path: "trees/a.json", kind: "invalid_json" },
    ]);
  });
});
