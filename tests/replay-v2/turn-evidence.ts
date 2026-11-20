import { DatabaseSync } from "node:sqlite";
import path from "node:path";

interface TurnWorld { home: string }
interface TurnTui { waitFor(predicate: (screen: string) => boolean, description: string, timeoutMs?: number): Promise<string> }

export interface TurnReplyOptions {
  timeoutMs?: number;
  /** 复用调用方的 healthy/checked 谓词（例如代理错误时立即失败）。 */
  predicate?: (screen: string) => boolean;
  role?: string | null;
}

/**
 * 应用把本轮回复落库才算完成；屏幕只证明用户看过。footer 文案是排版实现，
 * 不能作为“本轮完成”的唯一证据，因此这里等 DB 中的 assistant 消息再返回。
 */
export function replyPersisted(world: TurnWorld, sessionId: string, marker: string, role: string | null = "assistant"): boolean {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path.join(world.home, ".peri/threads/threads.db"), { readOnly: true });
    const rows = role
      ? db.prepare("SELECT content FROM messages WHERE thread_id = ? AND role = ?").all(sessionId, role)
      : db.prepare("SELECT content FROM messages WHERE thread_id = ?").all(sessionId);
    return rows.some((row) => String((row as { content: unknown }).content).includes(marker));
  } catch {
    // 会话库可能尚未建立或正被应用写入；下一轮轮询继续。
    return false;
  } finally {
    try { db?.close(); } catch { /* read-only close is best effort */ }
  }
}

export async function waitForTurnReply(
  tui: TurnTui,
  world: TurnWorld,
  sessionId: string | (() => string),
  marker: string,
  description: string,
  options: TurnReplyOptions = {},
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const screen = await tui.waitFor(
    (value) => (options.predicate ? options.predicate(value) : true) && value.includes(marker),
    `${description}: expected reply visible`,
    timeoutMs,
  );
  const resolved = typeof sessionId === "function" ? sessionId() : sessionId;
  if (!resolved) throw new Error(`${description}: session id is not resolved yet`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (replyPersisted(world, resolved, marker, options.role ?? "assistant")) return screen;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`${description}: assistant reply "${marker}" was not persisted for session ${resolved}`);
}
