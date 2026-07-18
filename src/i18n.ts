import * as vscode from "vscode";
import { TaskStatus } from "./core/types";

/** English message is the source key; Russian lives in l10n/bundle.l10n.ru.json */
export function t(
  message: string,
  ...args: Array<string | number | boolean>
): string {
  return vscode.l10n.t(message, ...args);
}

export function statusLabelL10n(status: TaskStatus): string {
  switch (status) {
    case "todo":
      return t("todo");
    case "new":
      return t("new");
    case "in_progress":
      return t("in progress");
    case "done":
      return t("done");
    case "needs_rework":
      return t("needs rework");
    case "error":
      return t("error");
    case "blocked":
      return t("blocked");
  }
}

/** Strings for the task detail webview (resolved on the extension host). */
export function detailPanelUi() {
  return {
    missing: t("Task not found. Select a node in the Proman tree."),
    loading: t("Loading…"),
    title: t("Title"),
    status: t("Status"),
    statusTodo: t("todo"),
    statusNew: t("new (blue)"),
    statusInProgress: t("in progress"),
    statusDone: t("done (green)"),
    statusRework: t("needs rework (yellow)"),
    statusError: t("error (red)"),
    statusBlocked: t("blocked"),
    estimateSp: t("Estimate SP"),
    hours: t("Hours"),
    assignee: t("Assignee"),
    assignToMe: t("Assign to me"),
    pickAssignee: t("Choose assignee…"),
    tags: t("Tags (space-separated)"),
    description: t("Description"),
    dependsOn: t("Depends on (Cmd/Ctrl + click)"),
    blocksNone: t("Blocks nobody"),
    blocks: t("Blocks: {0}"),
    save: t("Save"),
    addChild: t("Add subtask"),
    runAgent: t("Run in Agent"),
    copyPrompt: t("Copy prompt"),
    delete: t("Delete"),
    comments: t("Comments ({0})"),
    noComments: t("No comments yet"),
    newComment: t("New comment"),
    commentPlaceholder: t("Comment text…"),
    addComment: t("Add comment"),
    history: t("History"),
    historyEmpty: t("History is empty"),
    you: t("you: @{0}"),
    userUnset: t("user not set"),
    branchProgress: t("branch: {0}/{1}"),
    promptChild: t("Subtask title"),
    confirmDelete: t(
      "Delete with subtasks?\nOK = cascade, Cancel = promote children"
    ),
    histStatus: t("status: {0} → {1}"),
    histAssignee: t("assignment: {0} → {1}"),
    histComment: t("comment: {0}"),
    me: t("me"),
    enterManually: t("Enter manually…"),
    clearAssignee: t("Clear assignment"),
    assignTitle: t("Assign task"),
    assigneePrompt: t("Assignee (without @)"),
    filesHeading: t("Files ({0})"),
    filesEmpty: t("No files recorded for this task yet"),
    fileCreated: t("created"),
    fileModified: t("modified"),
    fileFromPlan: t("from plan"),
    fileFromSubtask: t("subtask: {0}"),
  };
}
