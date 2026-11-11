import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { runReplayScenario } from "../../helpers/llm-replay-suite.js";
import { agentProvider, expectResult, resultText, text, tool, tools, type Reply } from "./agents-fixture.js";
import {
  ShellBindings, absent, assertExited, assertStartedOnce, configureShell, fileReady, finished,
  gatedCommand, processExists, releaseShell, requestText, resultFromBody, startShellTui,
} from "./async-shell-fixture.js";


it("H06 two parallel Shells settle in reverse order with the correct actual log and task", { timeout: 120_000 }, async () => {
  const specs = ["a", "b"].map(alias => ({ id: `H06-${alias}`, alias, command: gatedCommand(`h06-${alias}`, `printf 'H06_${alias.toUpperCase()}_OUTPUT\\n'; printf '${alias}\\n' > h06-${alias}.result`) }));
  let binding: ShellBindings;
  await runReplayScenario({ id: "H06", title: "同会话并行 Shell 反序完成，任务身份、真实 Read 和通知不串线", configVersion: "shell-reverse-1",
    configure: configureShell,
    upstream: async () => agentProvider((call, body): Reply => {
      if (call.execution === "start" && call.call === "reason:1") return tools(...specs.map(spec => tool(spec.id, "Bash", { command: spec.command, run_in_background: true })));
      if (call.execution === "start" && call.call === "reason:2") {
        for (const spec of specs) expectResult(body, spec.id, "Background task started: mcp-");
        return text("H06_TWO_RUNNING");
      }
      const alias = ["reason:3", "reason:4"].includes(call.call) ? "b" : ["reason:5", "reason:6"].includes(call.call) ? "a" : undefined;
      if (alias && ["reason:3", "reason:5"].includes(call.call)) {
        const result = resultFromBody(body, binding.task(alias))!; expect(result.state).toBe("succeeded");
        return tools(tool(`H06-read-${alias}`, "Read", { file_path: result.stdout! }));
      }
      if (alias && ["reason:4", "reason:6"].includes(call.call)) {
        expectResult(body, `H06-read-${alias}`, `H06_${alias.toUpperCase()}_OUTPUT`);
        return text(`H06_${alias.toUpperCase()}_VERIFIED`);
      }
      throw new Error(`unexpected H06 ${JSON.stringify(call)}`);
    }),
    runOptions(ctx) { binding = new ShellBindings(ctx, specs); return { onRequest: binding.onRequest }; },
    async run(ctx) {
      const tui = await startShellTui(ctx); ctx.identity.arm(ctx.sessionIds.root!, "start"); await tui.prompt("Run both H06 shells in parallel.");
      await finished(ctx, tui, "H06_TWO_RUNNING");
      const pids = [Number(await fileReady(ctx, "h06-a.pid")), Number(await fileReady(ctx, "h06-b.pid"))];
      expect(new Set(binding.tasks.values()).size).toBe(2); expect(new Set(pids).size).toBe(2);
      for (const alias of ["b", "a"]) {
        await releaseShell(ctx, `h06-${alias}`);
        await finished(ctx, tui, `H06_${alias.toUpperCase()}_VERIFIED`);
        expect(await fileReady(ctx, `h06-${alias}.result`)).toBe(`${alias}\n`);
        expect(binding.output(alias).state).toBe("succeeded");
        expect(await readFile(binding.output(alias).stdout!, "utf8")).toBe(`H06_${alias.toUpperCase()}_OUTPUT\n`);
        const readRequest = ctx.requests.find(call => call.context.execution === "start" && call.context.call === (alias === "b" ? "reason:4" : "reason:6"))!;
        expect(resultText(JSON.parse(readRequest.request.body.toString()), `H06-read-${alias}`)).toContain(`H06_${alias.toUpperCase()}_OUTPUT`);
        await assertStartedOnce(ctx, `h06-${alias}`);
        if (alias === "b") { expect(await processExists(pids[0]!)).toBe(true); await absent(ctx, "h06-a.result"); }
      }
      await assertExited(pids);
      expect(binding.output("a").stdout).not.toBe(binding.output("b").stdout);
      ctx.identity.finish(ctx.sessionIds.root!);
      const completions = ctx.requests.filter(call => ["reason:3", "reason:5"].includes(call.context.call)).map(call => call.context.call);
      expect(completions).toEqual(["reason:3", "reason:5"]);
      ctx.observe("reverse-process-completion", { pids, tasks: Object.fromEntries(binding.tasks), completions });
      await tui.save("both-shells-completed-in-reverse-order");
    },
  });
});

it("H09 positive background timeout kills the process and reports timed_out without late writes", { timeout: 120_000 }, async () => {
  const command = gatedCommand("h09", "printf 'H09_FORBIDDEN_LATE_WRITE\\n' > h09.late");
  const spec = { id: "H09-bash", alias: "h09", command }; let binding: ShellBindings;
  await runReplayScenario({ id: "H09", title: "后台 Shell 正超时产生真实 timed_out，并阻止超时后的迟写", configVersion: "shell-timeout-1",
    configure: configureShell,
    upstream: async () => agentProvider((call, body): Reply => {
      if (call.execution === "start" && call.call === "reason:1") return tools(tool(spec.id, "Bash", { command, run_in_background: true, timeout: 3000 }));
      if (call.execution === "start" && call.call === "reason:2") { expectResult(body, spec.id, "Background task started:"); return text("H09_TIMEOUT_ARMED"); }
      if (call.execution === "start" && call.call === "reason:3") { expect(resultFromBody(body, binding.task("h09"))!.state).toBe("timed_out"); return text("H09_TIMEOUT_VERIFIED"); }
      throw new Error(`unexpected H09 ${JSON.stringify(call)}`);
    }),
    runOptions(ctx) { binding = new ShellBindings(ctx, [spec]); return { onRequest: binding.onRequest }; },
    async run(ctx) {
      const tui = await startShellTui(ctx); ctx.identity.arm(ctx.sessionIds.root!, "start");
      await tui.prompt("Run H09 with a real background deadline.");
      const pid = Number(await fileReady(ctx, "h09.pid")); expect(await processExists(pid)).toBe(true);
      await finished(ctx, tui, "H09_TIMEOUT_VERIFIED"); ctx.identity.finish(ctx.sessionIds.root!);
      await assertExited([pid]); await releaseShell(ctx, "h09"); await absent(ctx, "h09.late");
      await assertStartedOnce(ctx, "h09");
      const output = binding.output("h09"); expect(output.state).toBe("timed_out"); expect(output.exitCode).toBe("unknown");
      expect(requestText(JSON.parse(ctx.requests.at(-1)!.request.body.toString()))).toContain(`task_id: ${binding.task("h09")}`);
      ctx.observe("real-timeout", { pid, state: output.state, noLateWrite: true }); await tui.save("real-background-timeout");
    },
  });
});
