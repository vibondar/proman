import { describe, expect, it } from "vitest";
import { actorsEqual, displayActor, normalizeActor } from "../src/core/actor";

describe("actor helpers", () => {
  it("normalizes @ and case", () => {
    expect(normalizeActor("@Alice")).toBe("alice");
    expect(normalizeActor("  bob ")).toBe("bob");
    expect(normalizeActor("")).toBe("");
  });

  it("compares actors", () => {
    expect(actorsEqual("@Alice", "alice")).toBe(true);
    expect(actorsEqual("a", "b")).toBe(false);
    expect(actorsEqual("", "")).toBe(false);
  });

  it("displayActor strips @", () => {
    expect(displayActor("@carol")).toBe("carol");
    expect(displayActor(undefined)).toBe("unknown");
  });
});
