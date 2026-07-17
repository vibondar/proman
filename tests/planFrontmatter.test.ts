import { describe, expect, it } from "vitest";
import { extractFrontmatter, isPlanDocument } from "../src/core/planFrontmatter";

describe("extractFrontmatter", () => {
  it("parses type and title, strips quotes", () => {
    const { meta, body } = extractFrontmatter(
      ["---", "type: plan", 'title: "My Plan"', "# comment", "---", "# Body"].join("\n")
    );
    expect(meta).toEqual({ type: "plan", title: "My Plan" });
    expect(body).toBe("# Body");
  });

  it("returns full content when no frontmatter", () => {
    expect(extractFrontmatter("# hi")).toEqual({ meta: {}, body: "# hi" });
  });
});

describe("isPlanDocument", () => {
  it("detects type: plan", () => {
    expect(isPlanDocument("---\ntype: plan\n---\n")).toBe(true);
    expect(isPlanDocument("---\ntype: note\n---\n")).toBe(false);
    expect(isPlanDocument("# no fm")).toBe(false);
  });
});
