import { describe, expect, it } from "vitest";
import {
  assertValidGithubOwnerRepo,
  isSafeGithubHtmlUrl,
  isValidGithubName,
  parseGithubIssueId,
  parseGithubRemoteUrl,
  sanitizeErrorMessage,
  upsertGithubIssueInDescription,
  githubIssueUrl,
} from "../src/core/githubIssueLink";
import {
  assertPromanOnlyPorcelain,
  sanitizeGitCommitMessage,
} from "../src/core/gitSync";

describe("githubIssueLink", () => {
  it("parses GitHub: #N line", () => {
    expect(parseGithubIssueId("desc\nGitHub: #42\n")).toBe(42);
    expect(parseGithubIssueId("GH: 7")).toBe(7);
    expect(parseGithubIssueId("GitHub-Issue: #99")).toBe(99);
  });

  it("parses github.com issue URL", () => {
    expect(
      parseGithubIssueId("see https://github.com/acme/app/issues/15 for details")
    ).toBe(15);
  });

  it("upserts canonical line", () => {
    const next = upsertGithubIssueInDescription("hello", 3);
    expect(next).toContain("GitHub: #3");
    expect(upsertGithubIssueInDescription(next, 9)).toContain("GitHub: #9");
    expect(upsertGithubIssueInDescription(next, 9).match(/GitHub:/g)?.length).toBe(1);
  });

  it("validates owner/repo names", () => {
    expect(isValidGithubName("acme")).toBe(true);
    expect(isValidGithubName("../x")).toBe(false);
    expect(isValidGithubName("a/b")).toBe(false);
    expect(isValidGithubName("")).toBe(false);
    expect(() => assertValidGithubOwnerRepo("acme", "app")).not.toThrow();
    expect(() => assertValidGithubOwnerRepo("acme", "../etc")).toThrow();
  });

  it("builds issue url with encoding", () => {
    expect(githubIssueUrl("a", "b", 1)).toBe("https://github.com/a/b/issues/1");
  });

  it("accepts only safe html_url", () => {
    expect(isSafeGithubHtmlUrl("https://github.com/a/b/issues/1")).toBe(true);
    expect(isSafeGithubHtmlUrl("https://evil.com/a/b/issues/1")).toBe(false);
    expect(isSafeGithubHtmlUrl("https://github.com/a/b/pull/1")).toBe(false);
    expect(isSafeGithubHtmlUrl("javascript:alert(1)")).toBe(false);
  });

  it("parses ssh and https remotes", () => {
    expect(parseGithubRemoteUrl("git@github.com:acme/app.git")).toEqual({
      owner: "acme",
      repo: "app",
    });
    expect(parseGithubRemoteUrl("https://github.com/acme/app.git")).toEqual({
      owner: "acme",
      repo: "app",
    });
  });

  it("sanitizes errors", () => {
    expect(sanitizeErrorMessage("Bearer ghp_secrettoken123 fail")).not.toContain("secrettoken");
    expect(sanitizeErrorMessage("a\nb\nc")).not.toContain("\n");
  });
});

describe("gitSync helpers", () => {
  it("sanitizes commit messages", () => {
    expect(sanitizeGitCommitMessage("a\nb\0c")).toBe("a b c");
    expect(sanitizeGitCommitMessage("")).toBe("proman");
  });

  it("rejects porcelain paths outside .proman", () => {
    expect(() => assertPromanOnlyPorcelain("M  .proman/tree.json")).not.toThrow();
    expect(() => assertPromanOnlyPorcelain("M  src/evil.ts")).toThrow(/outside/);
    expect(() => assertPromanOnlyPorcelain("M  .proman/../secret")).toThrow();
  });
});
