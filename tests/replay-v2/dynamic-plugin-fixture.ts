/**
 * P01 夹具：插件声明的 Dynamic HTTP MCP + 只使用 ToolSearch / ToolInvoke 的模型脚本。
 *
 * 端口写进录制 seed，所以必须固定：录制与回放使用同一个 URL，seed 才能逐字节恢复。
 * MCP 服务只属于本测试，不经过模型回放代理；回放时它仍真实执行，业务结果与计数
 * 不是 cassette 伪造出来的。
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export const P01_PLUGIN_NAME = "fixture-plugin";
export const P01_MARKETPLACE = "fixture-marketplace";
export const P01_PLUGIN_ID = `${P01_PLUGIN_NAME}@${P01_MARKETPLACE}`;
export const P01_SERVER_KEY = `plugin:${P01_PLUGIN_NAME}:fixture`;
export const P01_MCP_PORT = 18749;
export const P01_MCP_URL = `http://127.0.0.1:${P01_MCP_PORT}/mcp`;
/** 相对进程 cwd（world.work）解析；录制世界的绝对根路径不能写进 seed。 */
export const P01_RELATIVE_INSTALL_PATH = `../home/.claude/plugins/cache/${P01_MARKETPLACE}/${P01_PLUGIN_NAME}/1.0.0`;
export const P01_BUSINESS_TOOL = "mcp__plugin_fixture-plugin_fixture__echo";
export const P01_ECHO_RESULT = "FIXTURE_ECHO";
export const P01_BUSINESS_CASE = "P01_BUSINESS_CASE";
export const P01_REUSE_CASE = "P01_REUSE_CASE";
export const P01_BUSINESS_DONE = "P01_BUSINESS_DONE";
export const P01_REUSE_DONE = "P01_REUSE_DONE";
export const P01_MCP_SESSION_ID = "p01-fixture-session";

interface RpcRequest { jsonrpc: "2.0"; id?: string | number; method: string; params?: any }

export interface McpState {
  requests: Array<{ http: string; rpc?: string }>;
  errors: string[];
  connections: number;
  openSockets: number;
  initializes: number;
  toolsLists: number;
  deletes: number;
  businessCalls: Array<{ tool: string; arguments: Record<string, unknown> }>;
  businessResults: string[];
}

export interface DynamicMcpFixture {
  state: McpState;
  waitFor(predicate: (state: McpState) => boolean, description: string, timeoutMs?: number): Promise<McpState>;
  waitForClosed(timeoutMs?: number): Promise<McpState>;
  close(): Promise<void>;
}

const ECHO_SCHEMA = {
  type: "object",
  properties: {
    text: { type: "string", description: "Text echoed back by the fixture MCP server" },
  },
  required: ["text"],
  additionalProperties: false,
};

function jsonRpcError(response: ServerResponse, status: number, id: RpcRequest["id"], code: number, message: string): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify({ jsonrpc: "2.0", id: id ?? null, error: { code, message } }));
}

function jsonRpcResult(response: ServerResponse, id: RpcRequest["id"], result: unknown, headers: Record<string, string> = {}): void {
  response.writeHead(200, { "content-type": "application/json", ...headers });
  response.end(JSON.stringify({ jsonrpc: "2.0", id: id ?? null, result }));
}

export async function startDynamicMcpFixture(port = P01_MCP_PORT): Promise<DynamicMcpFixture> {
  const state: McpState = {
    requests: [], errors: [], connections: 0, openSockets: 0, initializes: 0,
    toolsLists: 0, deletes: 0, businessCalls: [], businessResults: [],
  };
  // 业务调用只能出现在动态 Loader 建连之后；否则说明连接语义被破坏。
  let initialized = false;

  const server = createServer((request, response) => {
    void handle(request, response).catch((error) => {
      state.errors.push(String(error));
      if (!response.headersSent) response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32603, message: "fixture failure" } }));
    });
  });
  server.on("connection", (socket) => {
    state.connections += 1;
    state.openSockets += 1;
    socket.on("close", () => { state.openSockets -= 1; });
  });

  async function readBody(request: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString("utf8");
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const entry: { http: string; rpc?: string } = { http: request.method ?? "?" };
    state.requests.push(entry);
    if (request.method === "DELETE") {
      state.deletes += 1;
      response.writeHead(204);
      response.end();
      return;
    }
    // Streamable HTTP 的 GET 是 server→client SSE 流；本夹具不提供，405 让客户端跳过。
    if (request.method === "GET") {
      response.writeHead(405, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "sse stream is not provided" }));
      return;
    }
    if (request.method !== "POST") {
      response.writeHead(405, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "method not allowed" }));
      return;
    }
    const raw = await readBody(request);
    let message: RpcRequest;
    try {
      message = JSON.parse(raw) as RpcRequest;
    } catch {
      jsonRpcError(response, 400, undefined, -32700, "parse error");
      return;
    }
    entry.rpc = message.method;
    switch (message.method) {
      case "server/discover":
        // 现代协议探测一律拒绝；rmcp 只有收到可关联的 JSON-RPC error 才回退 legacy initialize。
        jsonRpcError(response, 404, message.id, -32601, "server/discover is not supported by this fixture");
        return;
      case "initialize": {
        state.initializes += 1;
        initialized = true;
        const requested = message.params?.protocolVersion;
        jsonRpcResult(response, message.id, {
          protocolVersion: typeof requested === "string" && requested.length > 0 ? requested : "2025-06-18",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "p01-echo", version: "1.0.0" },
        }, { "mcp-session-id": P01_MCP_SESSION_ID });
        return;
      }
      case "notifications/initialized":
        response.writeHead(202);
        response.end();
        return;
      case "tools/list":
        if (!initialized) {
          jsonRpcError(response, 400, message.id, -32000, "session is not initialized");
          return;
        }
        state.toolsLists += 1;
        jsonRpcResult(response, message.id, {
          tools: [{
            name: "echo",
            description: "Echo a caller-provided text; used by the dynamic plugin E2E business loop.",
            inputSchema: ECHO_SCHEMA,
          }],
        });
        return;
      case "tools/call": {
        if (!initialized) {
          jsonRpcError(response, 400, message.id, -32000, "session is not initialized");
          return;
        }
        const tool = String(message.params?.name ?? "");
        if (tool !== "echo") {
          jsonRpcError(response, 200, message.id, -32602, `unknown tool: ${tool}`);
          return;
        }
        const args = (message.params?.arguments ?? {}) as Record<string, unknown>;
        state.businessCalls.push({ tool, arguments: args });
        const text = `${P01_ECHO_RESULT}:${String(args.text ?? "")}`;
        state.businessResults.push(text);
        jsonRpcResult(response, message.id, {
          content: [{ type: "text", text }],
          isError: false,
        });
        return;
      }
      case "resources/list":
        jsonRpcResult(response, message.id, { resources: [] });
        return;
      case "prompts/list":
        jsonRpcResult(response, message.id, { prompts: [] });
        return;
      case "ping":
        jsonRpcResult(response, message.id, {});
        return;
      default:
        jsonRpcError(response, 200, message.id, -32601, `method not found: ${message.method}`);
    }
  }

  await new Promise<void>((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      server.off("listening", onListening);
      reject(new Error(error.code === "EADDRINUSE"
        ? `P01 MCP fixture port ${port} is already in use; the recorded seed pins this URL`
        : `P01 MCP fixture failed to listen: ${error.message}`));
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });

  const waitFor = async (predicate: (value: McpState) => boolean, description: string, timeoutMs = 15_000): Promise<McpState> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate(state)) return state;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`${description}: timed out after ${timeoutMs}ms; state=${JSON.stringify(state)}`);
  };

  return {
    state,
    waitFor,
    waitForClosed: (timeoutMs = 10_000) => waitFor((value) => value.openSockets === 0, "MCP sockets closed", timeoutMs),
    close: () => new Promise<void>((resolve, reject) => {
      server.closeAllConnections();
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

/**
 * 写入插件安装 seed：manifest 声明 dynamic HTTP MCP，settings 启用该插件。
 *
 * `install_path` 必须相对 cwd：seed 不允许包含录制世界的绝对根路径；Peri 按进程 cwd
 * （world.work）解析相对路径，两种模式得到同一份插件目录。
 */
export async function writeDynamicPluginSeed(world: { home: string }): Promise<void> {
  const pluginsDir = path.join(world.home, ".claude", "plugins");
  const installDir = path.join(pluginsDir, "cache", P01_MARKETPLACE, P01_PLUGIN_NAME, "1.0.0");
  await mkdir(path.join(installDir, ".claude-plugin"), { recursive: true });
  await writeFile(path.join(installDir, ".claude-plugin", "plugin.json"), JSON.stringify({
    name: P01_PLUGIN_NAME,
    version: "1.0.0",
    description: "Dynamic HTTP MCP fixture plugin",
    mcpServers: {
      fixture: { url: P01_MCP_URL, dynamic: true },
    },
  }));
  await writeFile(path.join(pluginsDir, "installed_plugins.json"), JSON.stringify({
    version: 2,
    plugins: [{
      id: P01_PLUGIN_ID,
      name: P01_PLUGIN_NAME,
      marketplace: P01_MARKETPLACE,
      version: "1.0.0",
      install_path: P01_RELATIVE_INSTALL_PATH,
      scope: "User",
      origin: "PeriInstalled",
    }],
  }));
  await writeFile(path.join(world.home, ".claude", "settings.json"), JSON.stringify({
    enabledPlugins: [P01_PLUGIN_ID],
  }));
}

interface ModelRequest { tools?: Array<{ name?: string }>; messages?: any[] }
interface ToolResult { type: string; tool_use_id: string; is_error?: boolean; content: unknown }

function resultBlocks(body: ModelRequest): ToolResult[] {
  return (body.messages ?? []).flatMap((message: any) => Array.isArray(message.content)
    ? message.content.filter((block: any) => block.type === "tool_result")
    : []);
}

function resultText(result: ToolResult): string {
  if (typeof result.content === "string") return result.content;
  if (!Array.isArray(result.content)) return JSON.stringify(result.content);
  return result.content.map((block: any) => typeof block?.text === "string" ? block.text : "").join("\n");
}

function findResult(body: ModelRequest, id: string): ToolResult {
  const matches = resultBlocks(body).filter((block) => block.tool_use_id === id);
  if (matches.length !== 1) throw new Error(`expected exactly one tool result for ${id}, got ${matches.length}`);
  return matches[0]!;
}

function messageText(body: ModelRequest): string {
  return (body.messages ?? []).flatMap((message: any) => Array.isArray(message.content)
    ? message.content.map((block: any) => typeof block?.text === "string" ? block.text : "")
    : typeof message.content === "string" ? [message.content] : []).join("\n");
}

function parseResult(body: ModelRequest, id: string): any {
  const text = resultText(findResult(body, id));
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`tool result ${id} is not JSON: ${text.slice(0, 500)}`, { cause: error });
  }
}

function sse(event: string, data: unknown): string { return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`; }

type ModelReply = { text: string } | { tool: string; input: Record<string, unknown> };

function reply(id: string, content: ModelReply): string {
  let payload = sse("message_start", { type: "message_start", message: { id, type: "message", role: "assistant", model: "fixture-model",
    content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 20, output_tokens: 0 } } });
  if ("tool" in content) {
    payload += sse("content_block_start", { type: "content_block_start", index: 0,
      content_block: { type: "tool_use", id, name: content.tool, input: {} } })
      + sse("content_block_delta", { type: "content_block_delta", index: 0,
        delta: { type: "input_json_delta", partial_json: JSON.stringify(content.input) } })
      + sse("content_block_stop", { type: "content_block_stop", index: 0 });
  } else {
    payload += sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })
      + sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: content.text } })
      + sse("content_block_stop", { type: "content_block_stop", index: 0 });
  }
  return payload
    + sse("message_delta", { type: "message_delta", delta: { stop_reason: "tool" in content ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 10 } })
    + sse("message_stop", { type: "message_stop" });
}

export interface DynamicModelFixture {
  url: string;
  requests: ModelRequest[];
  errors: string[];
  close(): Promise<void>;
}

/**
 * 录制用模型脚本：每一轮只返回 ToolSearch / ToolInvoke，业务执行全部由真实 Peri 完成。
 * 请求顺序与工具结果在脚本内逐步核对，任何一步不符合预期都让录制失败而不是写坏 cassette。
 */
export async function startDynamicModelFixture(): Promise<DynamicModelFixture> {
  const requests: ModelRequest[] = [];
  const errors: string[] = [];
  let main = 0;
  let loaderName: string | undefined;

  const server = createServer((request, response) => {
    void handle(request, response).catch((error) => {
      errors.push(String(error));
      if (!response.headersSent) response.writeHead(500, { "content-type": "text/event-stream" });
      response.end();
    });
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as ModelRequest;
    requests.push(body);
    if (request.headers["x-peri-replay-context"] || request.headers["x-peri-replay-target"]) {
      throw new Error("private replay metadata leaked upstream");
    }
    const toolNames = (body.tools ?? []).map((tool) => String(tool.name ?? ""));
    if (!toolNames.includes("ToolSearch") || !toolNames.includes("ToolInvoke")) {
      throw new Error(`P01 reason request lacks canonical proxy tools: ${JSON.stringify(toolNames)}`);
    }
    if (toolNames.includes("SearchExtraTools") || toolNames.includes("ExecuteExtraTool")) {
      throw new Error("legacy proxy names must not appear in the model tool schema");
    }
    let payload: string;
    switch (main) {
      case 0: {
        const text = messageText(body);
        if (!text.includes(P01_BUSINESS_CASE)) throw new Error("P01 business case missing from first reason");
        if (!text.includes(`The selected plugin is ${P01_PLUGIN_NAME}.`)) {
          throw new Error(`plugin guidance missing from first reason: ${text.slice(0, 800)}`);
        }
        loaderName = /LoadMCP__[A-Za-z0-9_]+/u.exec(text)?.[0];
        if (!loaderName) throw new Error(`plugin guidance does not name a Loader: ${text.slice(0, 800)}`);
        payload = reply("p01-search-loader", { tool: "ToolSearch", input: { query: `select:${loaderName}` } });
        break;
      }
      case 1: {
        const results = parseResult(body, "p01-search-loader").results;
        if (!Array.isArray(results) || !results.some((entry: any) => entry?.name === loaderName)) {
          throw new Error(`Loader not discoverable through ToolSearch: ${JSON.stringify(results)}`);
        }
        payload = reply("p01-invoke-loader", { tool: "ToolInvoke", input: { name: loaderName, arguments: {} } });
        break;
      }
      case 2: {
        const loaded = parseResult(body, "p01-invoke-loader");
        if (loaded?.status !== "ready") throw new Error(`Loader did not report ready: ${JSON.stringify(loaded)}`);
        if (loaded?.server !== P01_SERVER_KEY) throw new Error(`Loader bound an unexpected server: ${JSON.stringify(loaded)}`);
        if (loaded?.available_tool_count !== 1) throw new Error(`Loader reported an unexpected tool count: ${JSON.stringify(loaded)}`);
        if (!(loaded?.session_tool_count >= 1)) throw new Error(`Loader admitted no session tool: ${JSON.stringify(loaded)}`);
        payload = reply("p01-search-business", { tool: "ToolSearch", input: { query: `select:${P01_BUSINESS_TOOL}` } });
        break;
      }
      case 3: {
        const results = parseResult(body, "p01-search-business").results;
        const business = Array.isArray(results) ? results.find((entry: any) => entry?.name === P01_BUSINESS_TOOL) : undefined;
        const parameters = business?.parameters;
        if (parameters?.type !== "object" || parameters?.properties?.text?.type !== "string") {
          throw new Error(`business tool schema is not fully available after Loader: ${JSON.stringify(business)}`);
        }
        payload = reply("p01-invoke-business", { tool: "ToolInvoke",
          input: { name: P01_BUSINESS_TOOL, arguments: { text: "P01_ECHO_INPUT" } } });
        break;
      }
      case 4: {
        const result = findResult(body, "p01-invoke-business");
        if (!resultText(result).includes(`${P01_ECHO_RESULT}:P01_ECHO_INPUT`)) {
          throw new Error(`business call did not return the real MCP result: ${resultText(result)}`);
        }
        payload = reply("p01-business-done", { text: P01_BUSINESS_DONE });
        break;
      }
      case 5: {
        if (!messageText(body).includes(P01_REUSE_CASE)) throw new Error("P01 reuse case missing");
        payload = reply("p01-search-business-reuse", { tool: "ToolSearch", input: { query: `select:${P01_BUSINESS_TOOL}` } });
        break;
      }
      case 6: {
        const results = parseResult(body, "p01-search-business-reuse").results;
        if (!Array.isArray(results) || !results.some((entry: any) => entry?.name === P01_BUSINESS_TOOL)) {
          throw new Error(`loaded business tool is not searchable in the reused session: ${JSON.stringify(results)}`);
        }
        payload = reply("p01-invoke-business-reuse", { tool: "ToolInvoke",
          input: { name: P01_BUSINESS_TOOL, arguments: { text: "P01_REUSE_INPUT" } } });
        break;
      }
      case 7: {
        const result = findResult(body, "p01-invoke-business-reuse");
        if (!resultText(result).includes(`${P01_ECHO_RESULT}:P01_REUSE_INPUT`)) {
          throw new Error(`reused session did not return the real MCP result: ${resultText(result)}`);
        }
        payload = reply("p01-reuse-done", { text: P01_REUSE_DONE });
        break;
      }
      default:
        throw new Error(`unexpected extra P01 reason request: ${main}`);
    }
    main += 1;
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(payload);
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("P01 model fixture did not listen");
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    errors,
    close: () => new Promise<void>((resolve, reject) => {
      server.closeAllConnections();
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}
