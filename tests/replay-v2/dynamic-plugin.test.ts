import { expect, it } from "vitest";
import { runReplayScenario, type ReplayScenarioContext } from "../../helpers/llm-replay-suite.js";
import {
  P01_BUSINESS_CASE, P01_BUSINESS_DONE, P01_BUSINESS_TOOL, P01_ECHO_RESULT, P01_PLUGIN_ID,
  P01_PLUGIN_NAME, P01_REUSE_CASE, P01_REUSE_DONE, P01_SERVER_KEY,
  startDynamicMcpFixture, startDynamicModelFixture, writeDynamicPluginSeed,
} from "./dynamic-plugin-fixture.js";

function reasonRequests(ctx: ReplayScenarioContext): any[] {
  return ctx.requests.filter((request: any) => request.context.purpose === "reason");
}

function requestBody(request: any): any { return JSON.parse(request.request.body.toString("utf8")); }

function messageText(body: any): string {
  return (body.messages ?? []).flatMap((message: any) => Array.isArray(message.content)
    ? message.content.map((block: any) => typeof block?.text === "string" ? block.text : "")
    : typeof message.content === "string" ? [message.content] : []).join("\n");
}

function toolNames(body: any): string[] {
  return (body.tools ?? []).map((tool: any) => String(tool.name ?? ""));
}

function resultText(body: any, id: string): string {
  const results = (body.messages ?? []).flatMap((message: any) => Array.isArray(message.content) ? message.content : [])
    .filter((block: any) => block.type === "tool_result" && block.tool_use_id === id);
  if (results.length !== 1) throw new Error(`expected exactly one tool result for ${id}, got ${results.length}`);
  const content = results[0].content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return JSON.stringify(content);
  return content.map((block: any) => typeof block?.text === "string" ? block.text : "").join("\n");
}

function jsonResult(body: any, id: string): any {
  const text = resultText(body, id);
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`tool result ${id} is not JSON: ${text.slice(0, 500)}`, { cause: error });
  }
}

it("P01 选择插件后经 ToolSearch/ToolInvoke 动态加载真实 MCP 并复用连接", { timeout: 180_000 }, async () => {
  await runReplayScenario({
    id: "P01",
    title: "选择插件后按需加载 dynamic HTTP MCP，业务工具返回真实结果并在后续轮次复用连接",
    configure: writeDynamicPluginSeed,
    upstream: startDynamicModelFixture,
    async run(ctx) {
      // MCP 服务不经过模型代理：录制和回放都必须真实执行，计数与结果不是伪造的。
      const mcp = await startDynamicMcpFixture();
      try {
        expect(mcp.state.connections, "会话打开与插件选择都不能提前连接 dynamic MCP").toBe(0);
        const tui = await ctx.startTui("root");

        await tui.command("plugin");
        await tui.waitFor(ctx.checked((screen: string) => screen.includes(`${P01_PLUGIN_NAME} v1.0.0`)),
          "plugin panel lists the installed fixture plugin");
        expect(mcp.state.connections, "选择插件只登记待提交上下文").toBe(0);
        await tui.key("Space");
        await tui.waitFor(ctx.checked((screen: string) => screen.includes(`Added to next task: ${P01_PLUGIN_NAME}`)),
          "pending plugin selection is confirmed");
        await tui.key("Escape");
        await tui.waitFor(ctx.checked((screen: string) => screen.includes(`Plugin: ${P01_PLUGIN_ID}`)),
          "composer shows the pending plugin tag");
        expect(mcp.state.connections, "标签本身不触发 MCP 连接").toBe(0);

        ctx.identity.arm(ctx.sessionIds.root!, "business");
        await tui.prompt(P01_BUSINESS_CASE);
        await tui.waitFor(ctx.checked((screen: string) => screen.includes(P01_BUSINESS_DONE) && screen.includes("Brewed for")),
          "first business turn completed", 90_000);
        ctx.identity.finish(ctx.sessionIds.root!);

        const first = reasonRequests(ctx);
        expect(first, "首轮只有 ToolSearch/ToolInvoke 的五个 Reason 步骤").toHaveLength(5);
        const firstBody = requestBody(first[0]!);
        expect(toolNames(firstBody)).toEqual(expect.arrayContaining(["ToolSearch", "ToolInvoke"]));
        expect(toolNames(firstBody)).not.toContain("SearchExtraTools");
        expect(toolNames(firstBody)).not.toContain("ExecuteExtraTool");
        const guidance = messageText(firstBody);
        expect(guidance).toContain(`The selected plugin is ${P01_PLUGIN_NAME}.`);
        expect(guidance, "指引只使用插件显示名，不暴露 marketplace 来源标识").not.toContain(P01_PLUGIN_ID);
        const loader = /LoadMCP__[A-Za-z0-9_]+/u.exec(guidance)?.[0];
        expect(loader, "模型指引必须给出可调用的 Loader 名称").toBeTruthy();

        const loaderSearch = jsonResult(requestBody(first[1]!), "p01-search-loader");
        expect(loaderSearch.results.map((entry: any) => entry.name)).toContain(loader);
        const loaded = jsonResult(requestBody(first[2]!), "p01-invoke-loader");
        expect(loaded).toMatchObject({ status: "ready", server: P01_SERVER_KEY, reused: false, available_tool_count: 1 });
        expect(loaded.session_tool_count).toBeGreaterThanOrEqual(1);

        const businessSearch = jsonResult(requestBody(first[3]!), "p01-search-business");
        const business = businessSearch.results.find((entry: any) => entry?.name === P01_BUSINESS_TOOL);
        expect(business?.parameters).toMatchObject({ type: "object", properties: { text: { type: "string" } } });
        expect(resultText(requestBody(first[4]!), "p01-invoke-business")).toContain(`${P01_ECHO_RESULT}:P01_ECHO_INPUT`);

        expect(mcp.state.initializes, "动态连接只建立一次").toBe(1);
        expect(mcp.state.toolsLists).toBeGreaterThanOrEqual(1);
        expect(mcp.state.businessCalls).toHaveLength(1);
        expect(mcp.state.businessCalls[0]!.arguments).toEqual({ text: "P01_ECHO_INPUT" });
        expect(mcp.state.businessResults).toEqual([`${P01_ECHO_RESULT}:P01_ECHO_INPUT`]);
        const connectionsAfterFirstTurn = mcp.state.connections;
        expect(connectionsAfterFirstTurn).toBeGreaterThanOrEqual(1);
        expect(mcp.state.openSockets).toBeGreaterThanOrEqual(1);

        // 第二轮不再选择插件，也不再调用 Loader：沿用同一会话目录与连接。
        ctx.identity.arm(ctx.sessionIds.root!, "reuse");
        await tui.prompt(P01_REUSE_CASE);
        await tui.waitFor(ctx.checked((screen: string) => screen.includes(P01_REUSE_DONE) && screen.includes("Brewed for")),
          "reused business turn completed", 90_000);
        ctx.identity.finish(ctx.sessionIds.root!);

        const all = reasonRequests(ctx);
        expect(all, "复用轮不新增 Loader 调用").toHaveLength(8);
        const reuse = all.slice(5);
        const reuseSearch = jsonResult(requestBody(reuse[1]!), "p01-search-business-reuse");
        expect(reuseSearch.results.some((entry: any) => entry?.name === P01_BUSINESS_TOOL)).toBe(true);
        expect(resultText(requestBody(reuse[2]!), "p01-invoke-business-reuse")).toContain(`${P01_ECHO_RESULT}:P01_REUSE_INPUT`);
        expect(mcp.state.initializes, "复用现有连接，不重新 initialize").toBe(1);
        expect(mcp.state.connections, "复用现有连接，不新增 transport").toBe(connectionsAfterFirstTurn);
        expect(mcp.state.businessResults).toEqual([`${P01_ECHO_RESULT}:P01_ECHO_INPUT`, `${P01_ECHO_RESULT}:P01_REUSE_INPUT`]);

        // 关闭会话即关闭 transport：socket 全部释放，不留下后台连接。
        await tui.stop();
        await mcp.waitForClosed(10_000);
        expect(mcp.state.openSockets).toBe(0);
        ctx.observe("dynamic-plugin-loop", {
          loader, server: P01_SERVER_KEY, initializes: mcp.state.initializes,
          connections: mcp.state.connections, businessCalls: mcp.state.businessCalls,
          businessResults: mcp.state.businessResults, openSockets: mcp.state.openSockets,
        });
        await tui.save("dynamic-plugin-loop");
      } finally {
        await mcp.close();
      }
    },
  });
});
