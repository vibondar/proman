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
  applyFlatProgressToTrees,
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

function task(
  partial: Partial<TaskNode> & { id: string; title: string }
): TaskNode {
  return {
    description: "",
    status: "todo",
    children: [],
    dependsOn: [],
    source: "md:test",
    ...partial,
  };
}

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

describe("security: flat→trees progress heal", () => {
  it("does not invent tasks from flat that are absent in trees", () => {
    const trees: TreeBundle[] = [
      {
        id: "plan_a",
        title: "A",
        roots: ["plan_a__t1"],
        tasks: {
          plan_a__t1: task({ id: "plan_a__t1", title: "T1", status: "todo" }),
        },
        edges: [],
        updatedAt: "",
      },
    ];
    const flat = {
      plan_a__t1: task({ id: "plan_a__t1", title: "T1", status: "done" }),
      plan_a__injected: task({
        id: "plan_a__injected",
        title: "evil",
        status: "done",
      }),
      "../etc/passwd": task({ id: "../etc/passwd", title: "x", status: "done" }),
    };
    expect(applyFlatProgressToTrees(trees, flat)).toBe(true);
    expect(Object.keys(trees[0].tasks)).toEqual(["plan_a__t1"]);
    expect(trees[0].tasks.plan_a__t1.status).toBe("done");
  });

  it("does not cross-write progress into another tree", () => {
    const trees: TreeBundle[] = [
      {
        id: "alpha",
        title: "A",
        roots: ["alpha__t"],
        tasks: { alpha__t: task({ id: "alpha__t", title: "A", status: "todo" }) },
        edges: [],
        updatedAt: "",
      },
      {
        id: "beta",
        title: "B",
        roots: ["beta__t"],
        tasks: { beta__t: task({ id: "beta__t", title: "B", status: "todo" }) },
        edges: [],
        updatedAt: "",
      },
    ];
    applyFlatProgressToTrees(trees, {
      alpha__t: task({ id: "alpha__t", title: "A", status: "done" }),
    });
    expect(trees[0].tasks.alpha__t.status).toBe("done");
    expect(trees[1].tasks.beta__t.status).toBe("todo");
  });

  it("skips bundles with unsafe tree ids", () => {
    const trees = [
      {
        id: "../evil",
        title: "X",
        roots: ["t"],
        tasks: { t: task({ id: "t", title: "T", status: "todo" }) },
        edges: [],
        updatedAt: "",
      },
    ] as TreeBundle[];
    expect(
      applyFlatProgressToTrees(trees, {
        t: task({ id: "t", title: "T", status: "done" }),
      })
    ).toBe(false);
    expect(trees[0].tasks.t.status).toBe("todo");
  });

  it("rejects invalid status and caps assignee/impact payloads", () => {
    const trees: TreeBundle[] = [
      {
        id: "safe",
        title: "S",
        roots: ["safe__t"],
        tasks: {
          safe__t: task({ id: "safe__t", title: "T", status: "todo" }),
        },
        edges: [],
        updatedAt: "",
      },
    ];
    expect(
      applyFlatProgressToTrees(trees, {
        safe__t: {
          ...task({ id: "safe__t", title: "T" }),
          status: "rm -rf /" as TaskNode["status"],
          assignee: `@${"a".repeat(500)}`,
          impactHint: "h".repeat(5000),
        },
      })
    ).toBe(true);
    expect(trees[0].tasks.safe__t.status).toBe("todo");
    expect(trees[0].tasks.safe__t.assignee?.length).toBe(200);
    expect(trees[0].tasks.safe__t.impactHint?.length).toBe(2000);
  });

  it("ignores prototype-pollution keys in flat map", () => {
    const trees: TreeBundle[] = [
      {
        id: "safe",
        title: "S",
        roots: ["safe__t"],
        tasks: {
          safe__t: task({ id: "safe__t", title: "T", status: "todo" }),
        },
        edges: [],
        updatedAt: "",
      },
    ];
    const flat = Object.create(null) as Record<string, TaskNode>;
    flat["__proto__"] = task({ id: "__proto__", title: "p", status: "done" });
    flat.constructor = task({ id: "constructor", title: "c", status: "done" });
    flat.safe__t = task({ id: "safe__t", title: "T", status: "done" });
    applyFlatProgressToTrees(trees, flat);
    expect(trees[0].tasks.safe__t.status).toBe("done");
    expect(Object.prototype.hasOwnProperty.call(trees[0].tasks, "__proto__")).toBe(
      false
    );
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
