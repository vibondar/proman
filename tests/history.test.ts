import { describe, expect, it } from "vitest";
import {
  historyForTask,
  makeHistoryEntry,
  mergeHistoryEntries,
} from "../src/core/history";

describe("history helpers", () => {
  it("merges and caps entries", () => {
    const existing = Array.from({ length: 3 }, (_, i) =>
      makeHistoryEntry({
        actor: "a",
        taskId: "t1",
        kind: "status",
        from: "todo",
        to: "done",
        id: `old_${i}`,
      })
    );
    const incoming = [
      makeHistoryEntry({
        actor: "b",
        taskId: "t2",
        kind: "assignee",
        to: "b",
        id: "new_1",
      }),
    ];
    const merged = mergeHistoryEntries(existing, incoming, 3);
    expect(merged).toHaveLength(3);
    expect(merged[2].id).toBe("new_1");
    expect(merged[0].id).toBe("old_1");
  });

  it("filters by task", () => {
    const entries = [
      makeHistoryEntry({ actor: "a", taskId: "t1", kind: "status", to: "done" }),
      makeHistoryEntry({ actor: "a", taskId: "t2", kind: "comment", message: "hi" }),
      makeHistoryEntry({ actor: "b", taskId: "t1", kind: "assignee", to: "b" }),
    ];
    expect(historyForTask(entries, "t1")).toHaveLength(2);
  });
});
