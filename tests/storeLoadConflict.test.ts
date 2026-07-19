import { describe, expect, it } from "vitest";
import {
  loadTreeBundlesFromTexts,
  tryParsePromanJson,
} from "../src/core/promanConflict";

const validTree = (id: string) =>
  JSON.stringify({
    id,
    title: id,
    roots: [`${id}__root`],
    tasks: {
      [`${id}__root`]: {
        id: `${id}__root`,
        title: "Root",
        description: "",
        status: "todo",
        children: [],
        dependsOn: [],
      },
    },
    edges: [],
    updatedAt: "2026-01-01T00:00:00.000Z",
  });

describe("tryParsePromanJson", () => {
  it("returns data for valid JSON", () => {
    const r = tryParsePromanJson('{"a":1}');
    expect(r).toEqual({ ok: true, data: { a: 1 } });
  });

  it("returns conflict_markers without throwing", () => {
    expect(tryParsePromanJson("<<<<<<< HEAD\n{}\n>>>>>>> x\n")).toEqual({
      ok: false,
      kind: "conflict_markers",
    });
  });
});

describe("loadTreeBundlesFromTexts", () => {
  it("loads valid sections and reports conflicted/corrupt ones", () => {
    const { trees, problems } = loadTreeBundlesFromTexts([
      { fileName: "good.json", text: validTree("good") },
      {
        fileName: "bad.json",
        text: `<<<<<<< HEAD\n${validTree("bad")}\n>>>>>>> other\n`,
      },
      { fileName: "trunc.json", text: '{"id":' },
    ]);

    expect(trees.map((t) => t.id)).toEqual(["good"]);
    expect(problems).toEqual([
      { path: "trees/bad.json", kind: "conflict_markers" },
      { path: "trees/trunc.json", kind: "invalid_json" },
    ]);
  });

  it("does not invent trees from empty input", () => {
    expect(loadTreeBundlesFromTexts([])).toEqual({ trees: [], problems: [] });
  });
});
