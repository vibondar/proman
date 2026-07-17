/**
 * Quick sanity checks for parser + dependency engine (node, no vscode).
 * Run: npx tsx scripts/smoke.mts  OR  node --import tsx scripts/smoke.mts
 */
import { parseMarkdownToTree } from "../src/core/mdParser.ts";
import { DependencyEngine } from "../src/core/dependencyEngine.ts";
import type { ProjectState, TaskNode } from "../src/core/types.ts";

const md = `# Root
## A
- [ ] Task one
- [x] Task two
Depends on "A"
`;

const parsed = parseMarkdownToTree(md, "docs/ROADMAP.md");
console.assert(Object.keys(parsed.tasks).length >= 3, "expected tasks");
console.assert(parsed.roots.length >= 1, "expected roots");
console.log("mdParser: ok", Object.keys(parsed.tasks).length, "tasks");

const tasks: Record<string, TaskNode> = {
  a: {
    id: "a",
    title: "Feature A",
    description: "",
    status: "todo",
    children: [],
    dependsOn: [],
    source: "manual",
  },
  b: {
    id: "b",
    title: "Feature B",
    description: "",
    status: "todo",
    children: [],
    dependsOn: ["a"],
    source: "manual",
  },
};

const state: ProjectState = {
  meta: {
    name: "test",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  roots: ["a", "b"],
  tasks,
  edges: [],
};

const engine = new DependencyEngine();
const impact = engine.preview(state, {
  kind: "setStatus",
  taskId: "a",
  status: "done",
});
console.assert(impact.ok, "impact ok");
console.log("dependencyEngine: ok", impact.affected.length, "affected");
console.log(engine.describeRelation(state, "a", "b"));
