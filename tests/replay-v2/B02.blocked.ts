/**
 * 产品阻塞用例：Linux CI 上右侧 child 结果处理后，左侧 child 仍在运行，但 OSC 状态序列为 idle,working,done,idle；
 * “right-done-left-running 应为 working” 断言失败。默认回放不执行本文件。
 * 原因见 config/replay-blocked.json；恢复时先修复状态收敛并重录 v2 fixture。
 */
import { describe, expect, it } from "vitest";
import { runReplayScenario } from "../../helpers/llm-replay-suite.js";
import {
  AgentIdentities, CONFIG_VERSION, assertCanonicalResultOnce, assertChildTrace, assertFile, assertMissingFile,
  assertOsc, backgroundProvider, completed, configureBackground, countRootUserInputs, delegate, expectResult,
  healthy, identity, options, oscStates, persistedTrace, read, requestBody, rootCall, rootPayloads, text, threadState,
  tools, unexpected, waitCall, write,
} from "./async-agent-fixture.js";

  it("B02 two async children finish right then left with separate files, results and live states", async () => {
    let actors: AgentIdentities;
    const left = identity("left", "reason:1"), right = identity("right", "reason:1");
    await runReplayScenario({ id: "B02", title: "双异步 child 逆序完成，结果归属与 working 终态准确", configVersion: CONFIG_VERSION,
      configure: configureBackground,
      upstream: async () => backgroundProvider((call, body) => {
        if (call.owner === "root" && call.call === "reason:1") return tools(delegate("B02-left", "B02_LEFT_WORK", true), delegate("B02-right", "B02_RIGHT_WORK", true));
        if (call.owner === "root" && call.call === "reason:2") return text("B02_PARENT_WAITING");
        if (["left", "right"].includes(call.owner) && call.call === "reason:1") return tools(write(`B02-write-${call.owner}`, `b02-${call.owner}.txt`, `B02_${call.owner.toUpperCase()}_FILE\n`));
        if (["left", "right"].includes(call.owner) && call.call === "reason:2") return text(`B02_${call.owner.toUpperCase()}_REPORT`);
        if (call.owner === "root" && call.call === "reason:3") { expect(JSON.stringify(body.messages)).toContain("B02_RIGHT_REPORT"); expect(JSON.stringify(body.messages)).not.toContain("B02_LEFT_REPORT"); return tools(read("B02-read-right", "b02-right.txt")); }
        if (call.owner === "root" && call.call === "reason:4") { expectResult(body, "B02-read-right", "B02_RIGHT_FILE"); return text("B02_RIGHT_PROCESSED_LEFT_PENDING"); }
        if (call.owner === "root" && call.call === "reason:5") { expect(JSON.stringify(body.messages)).toContain("B02_LEFT_REPORT"); return tools(read("B02-read-left", "b02-left.txt")); }
        if (call.owner === "root" && call.call === "reason:6") { expectResult(body, "B02-read-left", "B02_LEFT_FILE"); return text("B02_BOTH_RESULTS_PROCESSED"); }
        return unexpected(call);
      }),
      runOptions(ctx) { const built = options(ctx, [{ tool: "B02-left", alias: "left", background: true }, { tool: "B02-right", alias: "right", background: true }], [left, right]); actors = built.actors; return built.proxy; },
      async run(ctx) {
        const tui = await ctx.startTui("root", { cols: 140, rows: 65 });
        actors.arm("turn-1"); await tui.prompt("Execute B02.");
        await ctx.run.waitReached(left, { timeout: 30_000 }); await ctx.run.waitReached(right, { timeout: 30_000 });
        await completed(ctx, tui, "B02_PARENT_WAITING");
        await assertOsc(tui, "working", "both-running");
        ctx.run.release(right);
        await completed(ctx, tui, "B02_RIGHT_PROCESSED_LEFT_PENDING");
        await assertOsc(tui, "working", "right-done-left-running");
        await assertMissingFile(ctx, "b02-left.txt");
        await assertFile(ctx, "b02-right.txt", "B02_RIGHT_FILE\n");
        expect(ctx.proxy.snapshot(ctx.runId).calls.find((call: any) => call.identity.owner === "left")?.terminal).toBeNull();
        const lines = (await tui.screen()).split("\n");
        const row = lines.findIndex((line) => /✔\s+agent\s+B02_RIGHT_WORK/u.test(line));
        expect(row, "completed right task has a real clickable bottom row").toBeGreaterThanOrEqual(0);
        const column = lines[row]!.indexOf("B02_RIGHT_WORK") + 1;
        await tui.type(`\x1b[<0;${column};${row + 1}M\x1b[<0;${column};${row + 1}m`);
        const detail = await tui.waitFor(healthy(ctx, (screen) => screen.includes("SubAgent Detail")
          && screen.slice(screen.indexOf("SubAgent Detail")).includes("B02_RIGHT_REPORT")), "clicked right task owns the right child's nested transcript");
        const panel = detail.slice(detail.indexOf("SubAgent Detail"));
        expect(panel).toContain("b02-right.txt"); expect(panel).not.toContain("b02-left.txt");
        await tui.save("right-task-detail-keeps-exact-child-owner"); await tui.key("Escape");
        await tui.waitFor(healthy(ctx, (screen) => !screen.includes("SubAgent Detail")), "task detail closes before releasing left child");
        ctx.run.release(left);
        await completed(ctx, tui, "B02_BOTH_RESULTS_PROCESSED");
        await assertOsc(tui, "done", "both-done");
        for (const alias of ["left", "right"]) {
          await assertFile(ctx, `b02-${alias}.txt`, `B02_${alias.toUpperCase()}_FILE\n`);
          assertChildTrace(ctx, actors, alias, `B02-${alias}`, `b02-${alias}.txt`, `B02_${alias.toUpperCase()}_REPORT`);
          assertCanonicalResultOnce(ctx, `B02_${alias.toUpperCase()}_REPORT`);
        }
        const earlier = JSON.stringify(requestBody(ctx, rootCall("reason:3")).messages);
        expect(earlier).toContain("B02_RIGHT_REPORT"); expect(earlier).not.toContain("B02_LEFT_REPORT");
        expect(persistedTrace(ctx).children).toHaveLength(2);
        expect(countRootUserInputs(ctx)).toBe(1);
        ctx.observe("reverse-async-completion", { completionOrder: ["right", "left"], children: 2, userInputs: 1 });
      },
    });
  });
