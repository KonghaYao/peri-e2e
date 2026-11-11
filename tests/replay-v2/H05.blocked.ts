/**
 * 产品阻塞用例：固定 Peri pin 上无法通过，未进入默认回放（文件后缀不是 .test.ts）。
 * 原因与证据见 config/replay-blocked.json 与 PR 描述；恢复时先修复产品行为并重录 v2 fixture。
 */
import { readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { runReplayScenario } from "../../helpers/llm-replay-suite.js";
import { agentProvider, expectResult, resultText, text, tool, tools, type Reply } from "./agents-fixture.js";
import {
  ShellBindings, absent, assertExited, assertStartedOnce, configureShell, fileReady, finished,
  gatedCommand, processExists, programStatuses, releaseShell, requestText, resultFromBody, shellCall, startShellTui,
} from "./async-shell-fixture.js";

it("H05 Tasks panel cancels the selected Shell process group; same command can start a fresh task", { timeout: 150_000 }, async () => {
  const child = "( for i in {1..6000}; do [ -f h05.release ] && break; sleep 0.01; done; [ -f h05.release ] && printf 'H05_CHILD_SIDE_EFFECT\\n' > h05.child-result ) & printf '%s\\n' \"$!\" > h05.child; ";
  const command = "printf 'H05_BEFORE_CANCEL\\n'; printf 'H05_CANCEL_STDERR\\n' >&2; " + child + gatedCommand("h05", "printf 'H05_PARENT_SIDE_EFFECT\\n' > h05.result; wait");
  const specs = [{ id: "H05-old", alias: "old", command }, { id: "H05-new", alias: "new", command }];
  let binding: ShellBindings;
  await runReplayScenario({ id: "H05", title: "真实任务面板取消进程组，同名命令再次启动不受旧终态污染", configVersion: "shell-panel-cancel-1",
    configure: configureShell,
    upstream: async () => agentProvider((call, body): Reply => {
      if (["start", "restart"].includes(call.execution) && call.call === "reason:1") return tools(tool(call.execution === "start" ? "H05-old" : "H05-new", "Bash", { command, run_in_background: true }));
      if (["start", "restart"].includes(call.execution) && call.call === "reason:2") {
        expectResult(body, call.execution === "start" ? "H05-old" : "H05-new", "Background task started: mcp-");
        return text(call.execution === "start" ? "H05_CANCEL_TARGET_READY" : "H05_NEW_TASK_READY");
      }
      if (call.execution === "start" && call.call === "reason:3") {
        const result = resultFromBody(body, binding.task("old"))!;
        expect(result.state).toBe("cancelled");
        return tools(tool("H05-read-cancelled", "Read", { file_path: result.stdout! }));
      }
      if (call.execution === "start" && call.call === "reason:4") {
        expectResult(body, "H05-read-cancelled", "H05_BEFORE_CANCEL");
        return text("H05_OLD_CANCELLED");
      }
      if (call.execution === "restart" && call.call === "reason:3") {
        expect(resultFromBody(body, binding.task("new"))!.state).toBe("succeeded");
        return text("H05_NEW_COMPLETED");
      }
      throw new Error(`unexpected H05 ${JSON.stringify(call)}`);
    }),
    runOptions(ctx) { binding = new ShellBindings(ctx, specs); return { onRequest: binding.onRequest,
      gates: [{ identity: shellCall("reason:3"), afterBytes: 0 }] }; },
    async run(ctx) {
      const tui = await startShellTui(ctx);
      ctx.identity.arm(ctx.sessionIds.root!, "start"); await tui.prompt("Start H05 cancellable shell.");
      await finished(ctx, tui, "H05_CANCEL_TARGET_READY");
      const oldPids = [Number(await fileReady(ctx, "h05.pid")), Number(await fileReady(ctx, "h05.child"))];
      for (const pid of oldPids) expect(await processExists(pid)).toBe(true);
      await tui.command("tasks");
      const panel = await tui.waitFor(ctx.checked((screen: string) => screen.includes("Background") && screen.includes(binding.task("old"))), "specific live task selected in Tasks panel");
      const selected = panel.split("\n").find(line => line.includes(binding.task("old")))!;
      expect(selected).toMatch(/[›❯>▶]/u);
      await tui.save("selected-cancellation-target");
      await tui.key("Enter");
      await ctx.run.waitReached(shellCall("reason:3"), { timeout: 30_000 });
      await tui.waitFor(ctx.checked((screen: string) => screen.includes("Task cancelled:") && screen.includes(binding.task("old"))), "actual cancellation feedback names the stopped task");
      await tui.save("cancelled-task-feedback");
      ctx.run.release(shellCall("reason:3"));
      await finished(ctx, tui, "H05_OLD_CANCELLED");
      await assertExited(oldPids);
      expect(binding.output("old").state).toBe("cancelled");
      expect(await readFile(binding.output("old").stdout!, "utf8")).toBe("H05_BEFORE_CANCEL\n");
      expect(await readFile(binding.output("old").stderr!, "utf8")).toBe("H05_CANCEL_STDERR\n");
      const cancelledRead = ctx.requests.find(call => call.context.execution === "start" && call.context.call === "reason:4")!;
      expect(resultText(JSON.parse(cancelledRead.request.body.toString()), "H05-read-cancelled")).toContain("H05_BEFORE_CANCEL");
      ctx.identity.finish(ctx.sessionIds.root!);
      await releaseShell(ctx, "h05");
      await absent(ctx, "h05.result"); await absent(ctx, "h05.child-result");
      await unlink(path.join(ctx.world.work, "h05.release"));
      await unlink(path.join(ctx.world.work, "h05.pid")); await unlink(path.join(ctx.world.work, "h05.child"));
      ctx.identity.arm(ctx.sessionIds.root!, "restart"); await tui.prompt("Start the exact same H05 command again.");
      await finished(ctx, tui, "H05_NEW_TASK_READY");
      const newPids = [Number(await fileReady(ctx, "h05.pid")), Number(await fileReady(ctx, "h05.child"))];
      expect(newPids.some(pid => oldPids.includes(pid))).toBe(false);
      expect(binding.task("new")).not.toBe(binding.task("old"));
      expect(await readFile(path.join(ctx.world.work, "h05.starts"), "utf8")).toBe("started\nstarted\n");
      const statuses = await programStatuses(tui, "old-cancelled-new-running"); expect(statuses.at(-1)).toBe("idle");
      await releaseShell(ctx, "h05"); await finished(ctx, tui, "H05_NEW_COMPLETED");
      ctx.identity.finish(ctx.sessionIds.root!); await assertExited(newPids);
      expect(binding.output("new").state).toBe("succeeded");
      expect(await fileReady(ctx, "h05.result")).toBe("H05_PARENT_SIDE_EFFECT\n");
      expect(await fileReady(ctx, "h05.child-result")).toBe("H05_CHILD_SIDE_EFFECT\n");
      expect(ctx.requests.filter(call => call.context.execution === "start" && call.context.call === "reason:3")).toHaveLength(1);
      ctx.observe("selected-cancel-restart", { oldTask: binding.task("old"), newTask: binding.task("new"), oldPids, newPids, selected });
      await tui.save("fresh-task-completed");
    },
  });
});
