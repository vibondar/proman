import { describe, expect, it } from "vitest";
import {
  isSafeId,
  parseTreeFileName,
  resolveInside,
  resolvePlanningDir,
  resolveTreeJsonPath,
} from "../src/core/pathSafety";
import {
  isNamespacedUnderTree,
  namespaceTaskIds,
  sanitizeLoadedTreeBundle,
} from "../src/core/forest";
import {
  applyStatusFromDescription,
  exportTreeToMarkdown,
  suggestedExportBasename,
} from "../src/core/mdExport";
import { sanitizeImportBasename } from "../src/core/proposalOps";
import { TaskNode, TreeBundle } from "../src/core/types";
import {
  isSafeGithubHtmlUrl,
  sanitizeErrorMessage,
} from "../src/core/githubIssueLink";
import { sanitizeGitCommitMessage } from "../src/core/gitSync";

describe("security: path / tree ids", () => {
  it("rejects traversal and absolute escape for tree JSON paths", () => {
    const attacks = [
      "../evil",
      "..",
      "a/b",
      "a\\b",
      ".hidden",
      "../../.proman/project",
      "roadmap.json",
      "",
      "has space",
      "x".repeat(200),
    ];
    for (const id of attacks) {
      expect(isSafeId(id), id).toBe(false);
      expect(resolveTreeJsonPath("/tmp/ws", id), id).toBeNull();
      expect(parseTreeFileName(`${id}.json`), id).toBeNull();
    }
  });

  it("allows safe ids even if they look like reserved folder names", () => {
    // `trees` as id → `.proman/trees/trees.json` (still inside trees/)
    expect(isSafeId("trees")).toBe(true);
    expect(resolveTreeJsonPath("/tmp/ws", "trees")).toBe(
      "/tmp/ws/.proman/trees/trees.json"
    );
  });

  it("keeps resolveTreeJsonPath strictly under .proman/trees/", () => {
    const p = resolveTreeJsonPath("/tmp/ws", "ok_tree");
    expect(p).toBe("/tmp/ws/.proman/trees/ok_tree.json");
    expect(p?.startsWith("/tmp/ws/.proman/trees/")).toBe(true);
    expect(p?.includes("..")).toBe(false);
  });

  it("resolveInside blocks escape even with mixed segments", () => {
    expect(resolveInside("/tmp/ws", ".proman", "..", "..", "etc", "passwd")).toBeNull();
    expect(resolveInside("/tmp/ws", "/etc/passwd")).toBeNull();
  });

  it("resolvePlanningDir rejects /etc and empty", () => {
    expect(resolvePlanningDir("/tmp/ws", "/etc")).toBeNull();
    expect(resolvePlanningDir("/tmp/ws", "")).toBeNull();
    expect(resolvePlanningDir("/tmp/ws", "../../../etc")).toBeNull();
  });
});

describe("security: forest load / namespace", () => {
  it("sanitizeLoadedTreeBundle drops id≠filename and unsafe ids", () => {
    expect(
      sanitizeLoadedTreeBundle(
        { id: "a", title: "t", roots: [], tasks: {}, edges: [], updatedAt: "" },
        "b.json"
      )
    ).toBeNull();
    expect(
      sanitizeLoadedTreeBundle(
        {
          id: "../x",
          title: "t",
          roots: [],
          tasks: {},
          edges: [],
          updatedAt: "",
        },
        "../x.json"
      )
    ).toBeNull();
  });

  it("namespace refuses unsafe tree id (blocks delete/write path abuse)", () => {
    expect(() =>
      namespaceTaskIds("../evil", {
        roots: ["t1"],
        tasks: {
          t1: {
            id: "t1",
            title: "T",
            description: "",
            status: "todo",
            children: [],
            dependsOn: [],
          },
        },
      })
    ).toThrow(/Unsafe tree id/);
  });

  it("prefix collision: shorter tree id does not claim longer tree tasks", () => {
    expect(isNamespacedUnderTree("plan", "plan_auth__x")).toBe(false);
    expect(isNamespacedUnderTree("plan", "plan__x")).toBe(true);
    expect(isNamespacedUnderTree("plan_auth", "plan__x")).toBe(false);
  });
});

describe("security: MD export / import status", () => {
  function tree(partial: Partial<TreeBundle> & Pick<TreeBundle, "id" | "tasks" | "roots">): TreeBundle {
    return {
      title: "T",
      edges: [],
      updatedAt: "",
      ...partial,
    };
  }

  it("suggestedExportBasename never contains path separators or traversal", () => {
    const cases: TreeBundle[] = [
      tree({
        id: "t1",
        title: "../../etc/passwd",
        sourceFile: "../../../etc/passwd.md",
        roots: [],
        tasks: {},
      }),
      tree({
        id: "t1",
        title: "a/b\\c",
        sourceFile: "/absolute/path/evil.md",
        roots: [],
        tasks: {},
      }),
      tree({
        id: "t1",
        title: "..",
        sourceFile: "..",
        roots: [],
        tasks: {},
      }),
    ];
    for (const t of cases) {
      const name = suggestedExportBasename(t);
      expect(name).toMatch(/^[a-z0-9-]+\.md$/);
      expect(name).not.toContain("/");
      expect(name).not.toContain("\\");
      expect(name).not.toContain("..");
    }
  });

  it("YAML-escapes hostile titles in frontmatter", () => {
    const md = exportTreeToMarkdown(
      tree({
        id: "t1",
        title: 'x"\n---\ntype: evil\nfoo: bar',
        roots: ["t1__a"],
        tasks: {
          "t1__a": {
            id: "t1__a",
            title: "Leaf",
            description: "",
            status: "todo",
            children: [],
            dependsOn: [],
          },
        },
      })
    );
    const fm = md.split("---")[1] ?? "";
    expect(fm).toContain("type: plan");
    expect(fm).not.toMatch(/^type: evil$/m);
    expect(fm).toContain("title:");
    // Hostile payload must be inside a JSON string, not raw YAML keys
    expect(fm).toMatch(/title:\s*"/);
  });

  it("applyStatusFromDescription ignores invalid / injection statuses", () => {
    const base = (desc: string, status: TaskNode["status"] = "todo"): TaskNode => ({
      id: "a",
      title: "A",
      description: desc,
      status,
      children: [],
      dependsOn: [],
    });

    const bad = base("Status: ../../etc\nStatus: todo; rm -rf /\nStatus: javascript:alert(1)");
    applyStatusFromDescription(bad);
    expect(bad.status).toBe("todo");

    const ok = base("Status: in_progress");
    applyStatusFromDescription(ok);
    expect(ok.status).toBe("in_progress");

    const doneWins = base("Status: error", "done");
    applyStatusFromDescription(doneWins);
    expect(doneWins.status).toBe("done");
  });
});

describe("security: imports / git / github surfaces", () => {
  it("sanitizeImportBasename strips traversal to basename only", () => {
    expect(sanitizeImportBasename("../../etc/passwd")).toBe("passwd");
    expect(sanitizeImportBasename("a\0b.md")).toBeNull();
    expect(sanitizeImportBasename("..")).toBeNull();
  });

  it("git commit message strips nulls and newlines", () => {
    const msg = sanitizeGitCommitMessage("ok\nline2\x00more");
    expect(msg).not.toContain("\0");
    expect(msg).not.toContain("\n");
    expect(msg).toContain("ok");
    expect(msg).toContain("more");
  });

  it("GitHub html_url allowlist blocks open redirects", () => {
    expect(isSafeGithubHtmlUrl("https://github.com/a/b/issues/1")).toBe(true);
    expect(isSafeGithubHtmlUrl("https://evil.com/a/b/issues/1")).toBe(false);
    expect(isSafeGithubHtmlUrl("javascript:alert(1)")).toBe(false);
  });

  it("sanitizeErrorMessage truncates and strips secrets-ish noise", () => {
    const long = "x".repeat(500);
    expect(sanitizeErrorMessage(long, 40).length).toBeLessThanOrEqual(40);
  });
});
