import { describe, expect, it } from "vitest";
import {
  parseGithubIssueId,
  upsertGithubIssueInDescription,
  githubIssueUrl,
} from "../src/core/githubIssueLink";
import { parseGithubRemoteUrl } from "../src/core/githubIssueLink";

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

  it("builds issue url", () => {
    expect(githubIssueUrl("a", "b", 1)).toBe("https://github.com/a/b/issues/1");
  });
});

describe("parseGithubRemoteUrl", () => {
  it("parses ssh and https", () => {
    expect(parseGithubRemoteUrl("git@github.com:acme/app.git")).toEqual({
      owner: "acme",
      repo: "app",
    });
    expect(parseGithubRemoteUrl("https://github.com/acme/app.git")).toEqual({
      owner: "acme",
      repo: "app",
    });
  });
});
