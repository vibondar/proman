import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { openAgentWithPrompt, AgentHandoff } from "../src/agent/handoff";
import { DependencyEngine } from "../src/core/dependencyEngine";
import { ProjectState, TaskNode } from "../src/core/types";
import { ProjectStore } from "../src/core/store";

const stub = vscode as typeof vscode & {
  __test: {
    reset: () => void;
    setCommandHandler: (
      h: (cmd: string, ...args: unknown[]) => Promise<unknown> | unknown
    ) => void;
    getClipboard: () => string;
    getExecuted: () => Array<{ cmd: string; args: unknown[] }>;
  };
};

function task(partial: Partial<TaskNode> & { id: string; title: string }): TaskNode {
  return {
    description: "",
    status: "todo",
    children: [],
    dependsOn: [],
    source: "md:test",
    ...partial,
  };
}

describe("openAgentWithPrompt", () => {
  beforeEach(() => {
    stub.__test.reset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    stub.__test.reset();
  });

  it("writes the full prompt to clipboard before opening chat", async () => {
    const prompt = "# Proman: run task\nDo the thing";
    stub.__test.setCommandHandler(async (cmd) => {
      if (cmd === "workbench.action.chat.open") return;
      throw new Error("no");
    });
    const ok = await openAgentWithPrompt(prompt);
    expect(ok).toBe(true);
    expect(stub.__test.getClipboard()).toBe(prompt);
    const first = stub.__test.getExecuted()[0];
    expect(first.cmd).toBe("workbench.action.chat.open");
    expect(first.args[0]).toEqual({ query: prompt });
  });

  it("falls back to composer.newAgentChat + paste when query open fails", async () => {
    const prompt = "fallback-prompt-body";
    stub.__test.setCommandHandler(async (cmd) => {
      if (
        cmd === "workbench.action.chat.open" ||
        cmd === "cursor.startComposerPrompt"
      ) {
        throw new Error("unsupported");
      }
      if (cmd === "composer.newAgentChat") return;
      if (cmd === "editor.action.clipboardPasteAction") return;
      throw new Error(`unexpected ${cmd}`);
    });

    const pending = openAgentWithPrompt(prompt);
    await vi.advanceTimersByTimeAsync(250);
    const ok = await pending;
    expect(ok).toBe(true);
    expect(stub.__test.getClipboard()).toBe(prompt);
    const cmds = stub.__test.getExecuted().map((e) => e.cmd);
    expect(cmds).toContain("composer.newAgentChat");
    expect(cmds).toContain("editor.action.clipboardPasteAction");
  });

  it("still succeeds if paste command fails (clipboard remains)", async () => {
    stub.__test.setCommandHandler(async (cmd) => {
      if (
        cmd === "workbench.action.chat.open" ||
        cmd === "cursor.startComposerPrompt"
      ) {
        throw new Error("unsupported");
      }
      if (cmd === "composer.newAgentChat") return;
      if (cmd === "editor.action.clipboardPasteAction") {
        throw new Error("no focus");
      }
      throw new Error(`unexpected ${cmd}`);
    });
    const pending = openAgentWithPrompt("keep-me");
    await vi.advanceTimersByTimeAsync(250);
    expect(await pending).toBe(true);
    expect(stub.__test.getClipboard()).toBe("keep-me");
  });

  it("returns false when no open command works", async () => {
    stub.__test.setCommandHandler(async () => {
      throw new Error("none");
    });
    const pending = openAgentWithPrompt("x");
    await vi.advanceTimersByTimeAsync(2000);
    expect(await pending).toBe(false);
  });

  it("never uses prompt text as a command id (injection)", async () => {
    const evil = "composer.newAgentChat; rm -rf /";
    stub.__test.setCommandHandler(async (cmd, ...args) => {
      if (cmd === "workbench.action.chat.open") return;
      throw new Error("no");
    });
    await openAgentWithPrompt(evil);
    for (const e of stub.__test.getExecuted()) {
      expect(e.cmd).not.toBe(evil);
      expect(e.cmd.startsWith("composer.") || e.cmd.startsWith("workbench.") || e.cmd.startsWith("cursor.") || e.cmd.startsWith("aichat.") || e.cmd.startsWith("editor.")).toBe(
        true
      );
    }
    expect(stub.__test.getClipboard()).toBe(evil);
  });
});

describe("AgentHandoff.buildTaskPrompt", () => {
  it("includes task id, title, status and MCP instructions", () => {
    const state: ProjectState = {
      meta: { name: "demo", createdAt: "", updatedAt: "" },
      trees: [],
      roots: ["t1"],
      tasks: {
        t1: task({
          id: "t1",
          title: "Implement auth",
          description: "Wire login",
          status: "todo",
          children: ["t2"],
          dependsOn: [],
        }),
        t2: task({ id: "t2", title: "Sub", status: "todo" }),
      },
      edges: [],
    };
    const store = { current: state } as unknown as ProjectStore;
    const handoff = new AgentHandoff(store, new DependencyEngine());
    const prompt = handoff.buildTaskPrompt("t1");
    expect(prompt).toContain("PROMAN_TASK_RUN:t1");
    expect(prompt).toContain("t1");
    expect(prompt).toContain("Implement auth");
    expect(prompt).toContain("Wire login");
    expect(prompt).toContain("proman_set_task_status");
    expect(prompt).toContain("proman_get_task");
    expect(prompt).toContain("files");
    expect(prompt).toContain("Sub");
    expect(prompt).toMatch(/Gate:/);
  });

  it("throws for unknown task", () => {
    const store = {
      current: {
        meta: { name: "d", createdAt: "", updatedAt: "" },
        trees: [],
        roots: [],
        tasks: {},
        edges: [],
      },
    } as unknown as ProjectStore;
    const handoff = new AgentHandoff(store, new DependencyEngine());
    expect(() => handoff.buildTaskPrompt("missing")).toThrow(/not found/i);
  });
});
