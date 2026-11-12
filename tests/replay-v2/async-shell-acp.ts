import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect } from "vitest";
import type { ReplayScenarioContext } from "../../helpers/llm-replay-suite.js";
import { replayEnvironment, startReplaySessionPeers } from "../../helpers/llm-replay-tui.js";

/** Queue-backed ACP sessions; every turn is correlated with its actual input and completion. */
export async function shellAcp(ctx: ReplayScenarioContext) {
  const notifications: any[] = [];
  const group = await startReplaySessionPeers({
    world: ctx.world,
    sessionIds: ctx.sessionIds,
    env: replayEnvironment(ctx.world, { proxy: ctx.proxy.url, run: ctx.runId }),
    clientMeta: {
      "peri.userInputQueue": true, "peri.agentEvent": true, "peri.agentEventDone": true, "peri.systemReminder": true,
    },
    notifications,
    serverRequestLabel: "undeclared shell fixture server request",
  });
  const peer = group.peer;
  let nextInput = 1;
  const attempts = new Map<string, { generation: string; inputId: string; offset: number }>();
  const healthy = () => expect(ctx.proxy.snapshot(ctx.runId).errors).toEqual([]);
  const text = (alias: string) => JSON.stringify(notifications.filter(message => message.params?.sessionId === ctx.sessionIds[alias]));
  const events = (alias: string) => notifications.filter(message => message.method === "peri/agent_event" && message.params?.sessionId === ctx.sessionIds[alias])
    .map(message => JSON.parse(message.params.event_json));
  return {
    peer, notifications, text, events,
    async enqueue(alias: string, execution: string, content: string, continued = false) {
      const sessionId = ctx.sessionIds[alias]!;
      const state = await peer.call("session/input/snapshot", { sessionId });
      expect(state.error).toBeUndefined();
      if (!continued) expect(state.result.activeRequestId).toBeUndefined();
      else expect(state.result.activeRequestId).toBeTypeOf("string");
      expect(state.result.items).toEqual([]);
      const inputId = `00000000-0000-0000-0000-${String(nextInput++).padStart(12, "0")}`;
      if (!continued) {
        attempts.set(alias, { generation: state.result.generation, inputId, offset: notifications.length });
        ctx.identity.arm(sessionId, execution);
      }
      const receipt = await peer.call("session/input/enqueue", { sessionId, generation: state.result.generation,
        commandId: `${ctx.runId}-${alias}-${execution}-${inputId}`, inputId, content, originalDraft: content });
      expect(receipt.error, JSON.stringify(receipt)).toBeUndefined();
    },
    async suspended(alias: string, marker: string) {
      const attempt = attempts.get(alias)!;
      await expect.poll(() => {
        healthy();
        const tail = notifications.slice(attempt.offset).filter(message => message.method === "peri/agent_event" && message.params?.sessionId === ctx.sessionIds[alias])
          .map(message => JSON.parse(message.params.event_json));
        return { marker: text(alias).includes(marker), suspended: tail.some(event => event.type === "turn_suspended") };
      }, { timeout: 30_000 }).toEqual({ marker: true, suspended: true });
    },
    async done(alias: string, marker: string) {
      const attempt = attempts.get(alias)!;
      const sessionId = ctx.sessionIds[alias]!;
      await expect.poll(() => {
        healthy();
        const starts = notifications.slice(attempt.offset).filter(message => message.method === "peri/agent_event" && message.params?.sessionId === sessionId)
          .map(message => JSON.parse(message.params.event_json)).filter(event => event.type === "user_input_run_started" && event.value.generation === attempt.generation);
        expect(starts.length).toBeLessThanOrEqual(1);
        const requestId = starts[0]?.value.request_id;
        return notifications.filter(message => message.method === "peri/agent_event_done" && message.params?.sessionId === sessionId && requestId && message.params.requestId === requestId).map(message => message.params.stopReason);
      }, { timeout: 30_000 }).toEqual(["end_turn"]);
      await this.settled(alias, marker);
      ctx.identity.finish(sessionId);
    },
    async settled(alias: string, marker: string) {
      await expect.poll(async () => {
        healthy();
        const state = await peer.call("session/input/snapshot", { sessionId: ctx.sessionIds[alias] });
        expect(state.error).toBeUndefined();
        return { marker: text(alias).includes(marker), active: state.result.activeRequestId ?? null, pending: state.result.items };
      }, { timeout: 40_000 }).toEqual({ marker: true, active: null, pending: [] });
    },
    async tasks(alias: string) {
      const response = await peer.call("session/bg-tasks", { sessionId: ctx.sessionIds[alias] });
      expect(response.error).toBeUndefined();
      expect(response.result.source).toBe("live");
      return response.result;
    },
    async save(name: string) {
      await writeFile(path.join(ctx.world.evidence, `${name}-acp.json`), JSON.stringify({
        notifications, diagnostics: await group.diagnostics(),
      }, null, 2));
    },
    async closeTransport() {
      const exitCodes = await group.closeBestEffort();
      const exitCode = exitCodes.every((code) => code === 0) ? 0 : (exitCodes.find((code) => code !== 0) ?? null);
      ctx.observe("shell-acp-process-exit", { exitCode, exitCodes, graceful: exitCode === 0 });
      return exitCode;
    },
    async close() {
      await group.close();
      ctx.observe("shell-acp-process-exit", { exitCode: 0, graceful: true });
    },
  };
}
