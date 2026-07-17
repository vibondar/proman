#!/usr/bin/env node
/**
 * Proman MCP server — official SDK + StdioServerTransport.
 * Run: PROMAN_WORKSPACE=/path/to/project node mcp-server.mjs
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";

const workspace =
  process.env.PROMAN_WORKSPACE || process.env.CURSOR_PROJECT_DIR || process.cwd();

function isSafeId(id) {
  return typeof id === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(id);
}

function resolveInside(root, ...parts) {
  const rootAbs = path.resolve(root);
  const candidate = path.resolve(rootAbs, ...parts);
  const prefix = rootAbs.endsWith(path.sep) ? rootAbs : rootAbs + path.sep;
  if (candidate !== rootAbs && !candidate.startsWith(prefix)) return null;
  return candidate;
}

function resolveTreeJsonPath(treeId) {
  if (!isSafeId(treeId)) return null;
  const treesDir = resolveInside(promanDir(), "trees");
  if (!treesDir) return null;
  const full = resolveInside(promanDir(), "trees", `${treeId}.json`);
  if (!full) return null;
  if (path.dirname(full) !== treesDir) return null;
  return full;
}

function parseTreeFileName(fileName) {
  if (!fileName.endsWith(".json")) return null;
  const id = fileName.slice(0, -".json".length);
  return isSafeId(id) ? id : null;
}

function sanitizeLoadedTree(raw, fileName) {
  const fileId = parseTreeFileName(fileName);
  if (!fileId || !raw || typeof raw !== "object") return null;
  if (typeof raw.id !== "string" || !isSafeId(raw.id) || raw.id !== fileId) return null;
  if (!raw.tasks || typeof raw.tasks !== "object") return null;
  return {
    id: raw.id,
    title: typeof raw.title === "string" && raw.title.trim() ? raw.title.trim() : raw.id,
    sourceFile: typeof raw.sourceFile === "string" ? raw.sourceFile : undefined,
    roots: Array.isArray(raw.roots) ? raw.roots.filter((id) => raw.tasks[id]) : [],
    tasks: raw.tasks,
    edges: Array.isArray(raw.edges) ? raw.edges : [],
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : new Date().toISOString(),
  };
}

function treeNsPrefix(treeId) {
  return `${treeId}__`;
}

function isNamespacedUnderTree(treeId, taskId) {
  if (!isSafeId(treeId) || typeof taskId !== "string") return false;
  const prefix = treeNsPrefix(treeId);
  return taskId.startsWith(prefix) && taskId.length > prefix.length;
}

function resolvePlanningDir(workspaceRoot, planningDir) {
  if (!planningDir || typeof planningDir !== "string") return null;
  if (path.isAbsolute(planningDir)) {
    return resolveInside(workspaceRoot, path.relative(workspaceRoot, planningDir));
  }
  return resolveInside(workspaceRoot, planningDir);
}

function promanDir() {
  return path.join(workspace, ".proman");
}

function loadState() {
  const metaPath = path.join(promanDir(), "project.json");
  if (!fs.existsSync(metaPath)) return null;
  const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
  const treesDir = path.join(promanDir(), "trees");
  const trees = [];
  if (fs.existsSync(treesDir)) {
    for (const name of fs.readdirSync(treesDir)) {
      if (!name.endsWith(".json")) continue;
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(treesDir, name), "utf8"));
        const bundle = sanitizeLoadedTree(raw, name);
        if (bundle) trees.push(bundle);
      } catch {
        /* skip */
      }
    }
  }
  if (trees.length) {
    const tasks = {};
    const roots = [];
    for (const tree of trees) {
      Object.assign(tasks, tree.tasks || {});
      for (const r of tree.roots || []) {
        if (tasks[r] && !roots.includes(r)) roots.push(r);
      }
    }
    return { meta, roots, tasks, edges: [], trees };
  }
  const treePath = path.join(promanDir(), "tree.json");
  if (!fs.existsSync(treePath)) return null;
  const tree = JSON.parse(fs.readFileSync(treePath, "utf8"));
  let edges = [];
  const edgesPath = path.join(promanDir(), "edges.json");
  if (fs.existsSync(edgesPath)) edges = JSON.parse(fs.readFileSync(edgesPath, "utf8"));
  return {
    meta,
    roots: tree.roots || [],
    tasks: tree.tasks || {},
    edges,
    trees: [
      {
        id: "main",
        title: meta.name || "Main",
        roots: tree.roots || [],
        tasks: tree.tasks || {},
        edges,
        updatedAt: meta.updatedAt,
      },
    ],
  };
}

function pullFlatIntoTrees(state) {
  state.trees = (state.trees || []).filter((t) => isSafeId(t.id));
  if (!state.trees.length) {
    state.trees = [
      {
        id: "main",
        title: state.meta?.name || "Main",
        roots: state.roots || [],
        tasks: { ...(state.tasks || {}) },
        edges: state.edges || [],
        updatedAt: new Date().toISOString(),
      },
    ];
    return;
  }
  const claimed = new Set();
  const byLen = [...state.trees].sort((a, b) => b.id.length - a.id.length);
  for (const tree of byLen) {
    const next = {};
    for (const id of Object.keys(tree.tasks || {})) {
      if (state.tasks[id] && !claimed.has(id)) {
        next[id] = state.tasks[id];
        claimed.add(id);
      }
    }
    for (const [id, t] of Object.entries(state.tasks || {})) {
      if (claimed.has(id)) continue;
      if (isNamespacedUnderTree(tree.id, id)) {
        next[id] = t;
        claimed.add(id);
      }
    }
    tree.tasks = next;
    tree.roots = Object.keys(next).filter(
      (id) => !Object.values(next).some((n) => (n.children || []).includes(id))
    );
    tree.updatedAt = new Date().toISOString();
  }
  const orphans = Object.keys(state.tasks || {}).filter((id) => !claimed.has(id));
  if (orphans.length) {
    let tree = state.trees.find((t) => t.id === state.meta?.activeTreeId) || state.trees[0];
    for (const id of orphans) tree.tasks[id] = state.tasks[id];
    tree.roots = Object.keys(tree.tasks).filter(
      (id) => !Object.values(tree.tasks).some((t) => (t.children || []).includes(id))
    );
    tree.updatedAt = new Date().toISOString();
  }
}

function saveState(state) {
  const dir = promanDir();
  fs.mkdirSync(path.join(dir, "proposals"), { recursive: true });
  fs.mkdirSync(path.join(dir, "trees"), { recursive: true });
  state.meta.updatedAt = new Date().toISOString();
  pullFlatIntoTrees(state);
  state.trees = (state.trees || []).filter((t) => isSafeId(t.id));
  state.meta.trees = state.trees.map((t) => ({
    id: t.id,
    title: t.title,
    sourceFile: t.sourceFile,
    updatedAt: t.updatedAt,
  }));
  if (!state.meta.activeTreeId && state.trees[0]) {
    state.meta.activeTreeId = state.trees[0].id;
  }
  fs.writeFileSync(path.join(dir, "project.json"), JSON.stringify(state.meta, null, 2));
  for (const tree of state.trees) {
    const full = resolveTreeJsonPath(tree.id);
    if (!full) continue;
    fs.writeFileSync(full, JSON.stringify(tree, null, 2));
  }
  fs.writeFileSync(
    path.join(dir, "tree.json"),
    JSON.stringify({ roots: state.roots, tasks: state.tasks }, null, 2)
  );
  fs.writeFileSync(path.join(dir, "edges.json"), JSON.stringify(state.edges || [], null, 2));
}

function applyBlocked(state) {
  for (const t of Object.values(state.tasks)) {
    if (t.status === "done" || t.status === "needs_rework" || t.status === "error") continue;
    const unmet = (t.dependsOn || []).some(
      (id) => state.tasks[id] && state.tasks[id].status !== "done"
    );
    if (unmet) t.status = "blocked";
    else if (t.status === "blocked") t.status = "todo";
  }
}

function nextActionable(state, treeId) {
  const queue = [];
  const tree = treeId ? (state.trees || []).find((t) => t.id === treeId) : null;
  const roots = tree ? tree.roots || [] : state.roots;
  const tasks = tree ? { ...state.tasks, ...(tree.tasks || {}) } : state.tasks;
  const visit = (id) => {
    const t = tasks[id] || state.tasks[id];
    if (!t) return;
    for (const c of t.children || []) visit(c);
    if (
      t.status === "todo" ||
      t.status === "new" ||
      t.status === "in_progress" ||
      t.status === "needs_rework"
    ) {
      const unmet = (t.dependsOn || []).filter((d) => (state.tasks[d] || tasks[d])?.status !== "done");
      if (!unmet.length) queue.push({ id: t.id, title: t.title, status: t.status });
    }
  };
  for (const r of roots) visit(r);
  const inProg = queue.find((q) => q.status === "in_progress");
  if (inProg) return { task: state.tasks[inProg.id], reason: "continue in_progress", queue, treeId: treeId || null };
  const rework = queue.find((q) => q.status === "needs_rework");
  if (rework) return { task: state.tasks[rework.id], reason: "needs_rework", queue, treeId: treeId || null };
  if (queue.length) return { task: state.tasks[queue[0].id], reason: "next todo", queue, treeId: treeId || null };
  return { task: null, reason: "none", queue, treeId: treeId || null };
}

function text(data) {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  };
}

function err(message) {
  return {
    content: [{ type: "text", text: JSON.stringify({ error: message }, null, 2) }],
    isError: true,
  };
}

const server = new McpServer({
  name: "proman",
  version: "0.3.3",
});

server.tool(
  "proman_get_tree",
  "Snapshot of Proman task tree(s) from .proman/",
  { treeId: z.string().optional() },
  async ({ treeId }) => {
    const state = loadState();
    if (!state) return err(`no .proman in ${workspace}`);
    if (treeId) {
      const tree = (state.trees || []).find((t) => t.id === treeId);
      if (!tree) return err(`tree not found: ${treeId}`);
      return text({
        meta: state.meta,
        treeId,
        title: tree.title,
        roots: tree.roots,
        tasks: tree.tasks,
        trees: (state.trees || []).map((t) => ({ id: t.id, title: t.title, sourceFile: t.sourceFile })),
        workspace,
      });
    }
    return text({
      meta: state.meta,
      roots: state.roots,
      tasks: state.tasks,
      trees: (state.trees || []).map((t) => ({
        id: t.id,
        title: t.title,
        sourceFile: t.sourceFile,
        roots: t.roots,
      })),
      workspace,
    });
  }
);

server.tool(
  "proman_get_task",
  "Get task with dependencies",
  { taskId: z.string() },
  async ({ taskId }) => {
    const state = loadState();
    if (!state) return err("no project");
    const task = state.tasks[taskId];
    if (!task) return err("not found");
    const blockers = (task.dependsOn || []).map((id) => state.tasks[id]).filter(Boolean);
    const blocked = Object.values(state.tasks).filter((t) =>
      (t.dependsOn || []).includes(taskId)
    );
    return text({ task, blockers, blocked });
  }
);

server.tool(
  "proman_next_actionable",
  "Next unblocked todo/new/in_progress/needs_rework task for Drive Mode (optional treeId)",
  { treeId: z.string().optional() },
  async ({ treeId }) => {
    const state = loadState();
    if (!state) return err("no project");
    const active = treeId || state.meta?.activeTreeId;
    return text({ ...nextActionable(state, active), workspace });
  }
);

server.tool(
  "proman_set_task_status",
  "Set task status: todo|new|in_progress|done|needs_rework|error|blocked. Colors in tree: todo=default, new=blue, done=green, needs_rework=yellow, error=red",
  {
    taskId: z.string(),
    status: z.enum(["todo", "new", "in_progress", "done", "needs_rework", "error", "blocked"]),
  },
  async ({ taskId, status }) => {
    const state = loadState();
    if (!state) return err("no project");
    if (!state.tasks[taskId]) return err("not found");
    state.tasks[taskId].status = status;
    applyBlocked(state);
    saveState(state);
    return text({ ok: true, taskId, status });
  }
);

server.tool(
  "proman_report_impact",
  "Write impactHint on a task",
  { taskId: z.string(), impactHint: z.string() },
  async ({ taskId, impactHint }) => {
    const state = loadState();
    if (!state) return err("no project");
    if (!state.tasks[taskId]) return err("not found");
    state.tasks[taskId].impactHint = impactHint;
    saveState(state);
    return text({ ok: true });
  }
);

const taskNodeSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/),
  title: z.string().min(1).max(500),
  description: z.string().max(20000).optional(),
  status: z
    .enum(["todo", "new", "in_progress", "done", "needs_rework", "error", "blocked"])
    .optional(),
  children: z.array(z.string()).max(200).optional(),
  dependsOn: z.array(z.string()).max(50).optional(),
  source: z.string().max(500).optional(),
  impactHint: z.string().max(2000).optional(),
  estimateSp: z.number().optional(),
  estimateHours: z.number().optional(),
  tags: z.array(z.string()).max(20).optional(),
  code: z.array(z.string()).max(20).optional(),
  tests: z.array(z.string()).max(20).optional(),
  assignee: z.string().max(200).optional(),
});

const structureOpSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("upsert"),
    tasks: z.array(taskNodeSchema).min(1).max(100),
    parentId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/).nullable().optional(),
  }),
  z.object({
    op: z.literal("delete"),
    taskId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/),
    mode: z.enum(["promote", "cascade"]).optional(),
  }),
  z.object({
    op: z.literal("setStatus"),
    taskId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/),
    status: z.enum(["todo", "new", "in_progress", "done", "needs_rework", "error", "blocked"]),
  }),
  z.object({
    op: z.literal("setDepends"),
    taskId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/),
    dependsOn: z.array(z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/)).max(50),
  }),
]);

server.tool(
  "proman_propose_structure_change",
  "Propose tree structure change; human Approves in Proman IDE",
  {
    summary: z.string().max(2000),
    rationale: z.string().max(5000).optional(),
    ops: z.array(structureOpSchema).min(1).max(50),
  },
  async ({ summary, rationale, ops }) => {
    const id = `p_${Date.now().toString(36)}`;
    const proposal = {
      id,
      createdAt: new Date().toISOString(),
      summary: summary || "Structure change",
      rationale: rationale || "",
      status: "pending",
      ops,
    };
    const dir = resolveInside(promanDir(), "proposals");
    if (!dir) return err("proposals path invalid");
    if (!isSafeId(id)) return err("invalid proposal id");
    fs.mkdirSync(dir, { recursive: true });
    const file = resolveInside(dir, `${id}.json`);
    if (!file) return err("proposal file path invalid");
    fs.writeFileSync(file, JSON.stringify(proposal, null, 2));
    fs.writeFileSync(path.join(dir, "LATEST_PENDING"), id, "utf8");
    return text({
      proposalId: id,
      status: "pending",
      message: "Waiting for human Approve in Proman IDE. Poll proman_get_proposal_status.",
    });
  }
);

server.tool(
  "proman_get_proposal_status",
  "pending|accepted|rejected",
  { proposalId: z.string() },
  async ({ proposalId }) => {
    if (!isSafeId(proposalId)) return err("invalid proposalId");
    const file = resolveInside(promanDir(), "proposals", `${proposalId}.json`);
    if (!file || !fs.existsSync(file)) return err("not found");
    const p = JSON.parse(fs.readFileSync(file, "utf8"));
    return text({ proposalId: p.id, status: p.status, summary: p.summary });
  }
);

server.tool(
  "proman_list_planning_files",
  "List markdown files in planningDir (scoped to workspace)",
  {},
  async () => {
    const state = loadState();
    if (!state?.meta?.planningDir) return text([]);
    const dir = resolvePlanningDir(workspace, state.meta.planningDir);
    if (!dir || !fs.existsSync(dir)) return text([]);
    const out = [];
    const walk = (d) => {
      // Stay inside planning dir (and thus workspace)
      if (!resolveInside(dir, path.relative(dir, d) || ".")) return;
      for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, ent.name);
        if (!resolveInside(dir, path.relative(dir, p))) continue;
        if (ent.isDirectory()) walk(p);
        else if (ent.name.endsWith(".md")) out.push(path.relative(workspace, p));
      }
    };
    walk(dir);
    return text(out);
  }
);

const transport = new StdioServerTransport();
server.connect(transport).catch((e) => {
  console.error("proman-mcp failed to start", e);
  process.exit(1);
});
