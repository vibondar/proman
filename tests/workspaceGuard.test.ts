import { describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({
  window: {
    showWarningMessage: vi.fn(),
  },
}));

vi.mock("../src/i18n", () => ({
  t: (msg: string) => msg,
}));

import * as vscode from "vscode";
import { requireOpenWorkspace } from "../src/workspaceGuard";

describe("requireOpenWorkspace", () => {
  it("returns true when workspaceRoot is set", () => {
    const store = { workspaceRoot: "/tmp/proj" } as any;
    expect(requireOpenWorkspace(store)).toBe(true);
    expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
  });

  it("warns and returns false when no workspace", () => {
    const store = { workspaceRoot: undefined } as any;
    expect(requireOpenWorkspace(store)).toBe(false);
    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      "Proman: open a project folder first (File → Open Folder)."
    );
  });
});
