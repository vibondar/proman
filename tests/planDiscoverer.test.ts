import { describe, expect, it } from "vitest";
import {
  isMdImportTooLarge,
  MAX_MD_IMPORT_BYTES,
} from "../src/core/planDiscoverer";

describe("isMdImportTooLarge", () => {
  it("allows files at the limit and rejects above", () => {
    expect(isMdImportTooLarge(MAX_MD_IMPORT_BYTES)).toBe(false);
    expect(isMdImportTooLarge(MAX_MD_IMPORT_BYTES + 1)).toBe(true);
    expect(isMdImportTooLarge(0)).toBe(false);
  });
});
