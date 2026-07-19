import { describe, expect, it } from "vitest";
import { looksLikeGitConflict, sanitizeGitCommitMessage } from "../src/core/gitSync";

describe("looksLikeGitConflict", () => {
  it("detects CONFLICT in stderr", () => {
    expect(
      looksLikeGitConflict({
        stdout: "",
        stderr: "CONFLICT (content): Merge conflict in .proman/trees/main.json",
      })
    ).toBe(true);
  });

  it("detects lowercase conflict", () => {
    expect(
      looksLikeGitConflict({
        stdout: "Automatic merge failed; fix conflicts and then commit the result.",
        stderr: "",
      })
    ).toBe(true);
  });

  it("ignores unrelated errors", () => {
    expect(
      looksLikeGitConflict({
        stdout: "",
        stderr: "fatal: unable to access 'https://example.com/': Could not resolve host",
        error: "network",
      })
    ).toBe(false);
  });
});

describe("sanitizeGitCommitMessage", () => {
  it("strips newlines and caps length", () => {
    expect(sanitizeGitCommitMessage("a\nb\rc")).toBe("a b c");
    expect(sanitizeGitCommitMessage("x".repeat(300)).length).toBe(200);
  });
});
