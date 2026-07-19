import * as vscode from "vscode";
import { ProjectStore } from "./core/store";
import { t } from "./i18n";

/**
 * Welcome / command guard: Proman needs an open workspace folder for .proman/.
 * Returns false after showing a warning when none is open.
 */
export function requireOpenWorkspace(store: ProjectStore): boolean {
  if (store.workspaceRoot) return true;
  void vscode.window.showWarningMessage(
    t("Proman: open a project folder first (File → Open Folder).")
  );
  return false;
}
