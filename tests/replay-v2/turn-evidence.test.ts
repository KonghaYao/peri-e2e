import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { replyPersisted } from "./turn-evidence.js";

describe("turn evidence", () => {
  it("reads assistant replies from the target session and role only", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "peri-turn-evidence-"));
    try {
      const directory = path.join(home, ".peri/threads");
      await mkdir(directory, { recursive: true });
      const db = new DatabaseSync(path.join(directory, "threads.db"));
      db.exec("CREATE TABLE messages (message_id TEXT, thread_id TEXT, role TEXT, content TEXT)");
      const insert = db.prepare("INSERT INTO messages VALUES (?, ?, ?, ?)");
      insert.run("1", "session-a", "assistant", "reply ALPHA");
      insert.run("2", "session-b", "assistant", "reply ALPHA");
      insert.run("3", "session-a", "user", "prompt ALPHA");
      db.close();

      expect(replyPersisted({ home }, "session-a", "ALPHA")).toBe(true);
      expect(replyPersisted({ home }, "session-a", "ALPHA", "user")).toBe(true);
      expect(replyPersisted({ home }, "session-c", "ALPHA")).toBe(false);
      expect(replyPersisted({ home }, "session-a", "BETA")).toBe(false);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
