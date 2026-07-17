import { describe, expect, it } from "vitest";
import {
  defaultGitSync,
  formatStatusCommitMessage,
  getMetaCurrentUser,
  normalizeProjectMeta,
  setMetaCurrentUser,
} from "../src/core/projectMeta";
import { ProjectMeta } from "../src/core/types";

describe("projectMeta", () => {
  it("migrates legacy currentUser into team", () => {
    const meta = normalizeProjectMeta({
      name: "P",
      createdAt: "",
      updatedAt: "",
      currentUser: "@Alice",
    });
    expect(meta.team?.currentUser).toBe("Alice");
    expect(getMetaCurrentUser(meta)).toBe("Alice");
  });

  it("prefers team.currentUser over legacy", () => {
    const meta = normalizeProjectMeta({
      name: "P",
      createdAt: "",
      updatedAt: "",
      currentUser: "old",
      team: { members: [{ username: "bob", name: "Боб" }], currentUser: "bob" },
    });
    expect(getMetaCurrentUser(meta)).toBe("bob");
  });

  it("setMetaCurrentUser adds member", () => {
    const meta: ProjectMeta = { name: "P", createdAt: "", updatedAt: "" };
    setMetaCurrentUser(meta, "carol");
    expect(meta.team?.currentUser).toBe("carol");
    expect(meta.team?.members.some((m) => m.username === "carol")).toBe(true);
  });

  it("normalizes sync flags", () => {
    const meta = normalizeProjectMeta({
      name: "P",
      createdAt: "",
      updatedAt: "",
      sync: { type: "git", autoCommit: 1 as unknown as boolean, autoPush: 0 as unknown as boolean },
    });
    expect(meta.sync).toEqual({ type: "git", autoCommit: true, autoPush: false });
    expect(defaultGitSync()).toEqual({ type: "git", autoCommit: true, autoPush: false });
  });

  it("formats status commit message", () => {
    expect(formatStatusCommitMessage("alice", "CRUD дерева", "todo", "done")).toBe(
      "proman: @alice todo → done: CRUD дерева"
    );
  });
});
