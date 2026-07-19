/**
 * Machine-readable markers in Agent prompts.
 * Tree spin (in_progress) must start only after the agent sees a marker
 * and calls proman_set_task_status — not when the prompt is merely pasted.
 */

export const PROMAN_TASK_RUN_PREFIX = "PROMAN_TASK_RUN:";
export const PROMAN_DRIVE_RUN_PREFIX = "PROMAN_DRIVE_RUN:";

const TASK_RUN_RE = /\bPROMAN_TASK_RUN:([a-zA-Z0-9][a-zA-Z0-9_-]{0,127})\b/;
const DRIVE_RUN_RE = /\bPROMAN_DRIVE_RUN:([a-zA-Z0-9][a-zA-Z0-9_-]{0,127})\b/;

export function taskRunMarker(taskId: string): string {
  return `${PROMAN_TASK_RUN_PREFIX}${taskId}`;
}

export function driveRunMarker(treeId: string): string {
  return `${PROMAN_DRIVE_RUN_PREFIX}${treeId}`;
}

export function parseTaskRunId(text: string): string | undefined {
  const m = text.match(TASK_RUN_RE);
  return m?.[1];
}

export function parseDriveRunId(text: string): string | undefined {
  const m = text.match(DRIVE_RUN_RE);
  return m?.[1];
}

/** True when the message is an armed Proman task/drive handoff. */
export function hasPromanRunMarker(text: string): boolean {
  return Boolean(parseTaskRunId(text) || parseDriveRunId(text));
}
