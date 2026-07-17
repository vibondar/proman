import { isSafeId } from "./pathSafety";
import { wsMkdir, wsReadText, wsWriteText } from "./workspaceIo";

export interface TaskComment {
  id: string;
  at: string;
  author: string;
  text: string;
}

export interface TaskCommentsFile {
  taskId: string;
  comments: TaskComment[];
}

export function newCommentId(): string {
  return `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export async function loadComments(
  workspaceRoot: string,
  taskId: string
): Promise<TaskComment[]> {
  if (!isSafeId(taskId)) return [];
  const text = await wsReadText(workspaceRoot, ".proman", "comments", `${taskId}.json`);
  if (!text) return [];
  try {
    const data = JSON.parse(text) as TaskCommentsFile;
    return Array.isArray(data.comments) ? data.comments : [];
  } catch {
    return [];
  }
}

export async function addComment(
  workspaceRoot: string,
  taskId: string,
  author: string,
  text: string
): Promise<TaskComment | null> {
  if (!isSafeId(taskId)) return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  const comments = await loadComments(workspaceRoot, taskId);
  const comment: TaskComment = {
    id: newCommentId(),
    at: new Date().toISOString(),
    author: author.trim().replace(/^@+/, "") || "unknown",
    text: trimmed.slice(0, 4000),
  };
  comments.push(comment);
  await wsMkdir(workspaceRoot, ".proman", "comments");
  const ok = await wsWriteText(
    workspaceRoot,
    [".proman", "comments", `${taskId}.json`],
    JSON.stringify({ taskId, comments } satisfies TaskCommentsFile, null, 2)
  );
  return ok ? comment : null;
}
