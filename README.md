# Peri E2E

Peri 的端到端测试套件，独立于 Peri 主仓维护。来源 commit、PR 映射与 fixture
录制说明见 [PROVENANCE.md](PROVENANCE.md)。

## 依赖

- Node.js 与 npm（安装依赖；`postinstall` 会构建 vendored `tui-tester`）
- Python 3 与 Unix PTY（replay-v2 的真实终端驱动）
- 一个已构建的 `peri` 二进制（replay-v2）
- tmux、Peri 源码与 `.env` 中的 judge 凭据（仅 legacy 套件，本地/手动运行）

```bash
npm ci
```

`tui-tester/` 是 MIT 许可的 vendored workspace（见
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)）；不提交 `dist/`，由
`postinstall` / `npm run build:tui-tester` 生成。

## 输入契约

| 变量 | 含义 |
| --- | --- |
| `PERI_BINARY` | 已构建 `peri` 的绝对路径，优先级最高；启动前校验存在且可执行 |
| `PERI_E2E_BINARY` | 兼容旧名；`PERI_BINARY` 未设置时使用 |
| `PERI_SOURCE_ROOT` | Peri checkout 绝对路径；`world:sync` / `world-check` 与 replay 单测中的 world-check 用例必须显式设置。legacy helper 在未设置时才尝试本仓父目录 |
| `PERI_E2E_REPLAY_FIXTURES` | 可选，覆盖 fixture 根目录（默认 `fixtures/replay-v2`） |
| `PERI_E2E_REPLAY_RESULTS` | 可选，覆盖报告根目录（默认 `results/replay-v2/<invocation>`） |
| `PERI_E2E_REPLAY_INVOCATION` | 可选，命名一次回放运行 |

二进制解析顺序：`PERI_BINARY` → `PERI_E2E_BINARY` →
`PERI_SOURCE_ROOT/target/debug/peri`。replay-v2 只需要二进制；legacy 套件、
`world:sync` / `world-check` / `migrate` 还需要 `PERI_SOURCE_ROOT`。没有源码根
时，legacy 套件会在 vitest 配置中显式跳过并告警。

`.env` 从本仓根读取，仅用于 legacy judge；不得提交。

## 离线业务回放

```bash
npm run e2e:replay:check       # tsc 类型检查
PERI_SOURCE_ROOT=/path/to/peri npm run e2e:replay:unit  # llm-replay 模块单测（world-check 用例读 Peri 源码）
npm run e2e:replay:verify      # fixture/world 完整性
PERI_SOURCE_ROOT=/path/to/peri npm run e2e:replay:world-check
PERI_BINARY=/path/to/peri npm run e2e:replay
EXPECTED_REPLAY_SCENARIOS=30 node scripts/check-replay-catalog.mjs
```

`check-replay-catalog.mjs` 要求场景 ID 与封存 fixture 一一对应，零测试、重复 ID、
缺失/多余 fixture 和新增 skip 都会失败。回放后加 `--results <invocation 目录>`
可再核对每个场景都有 `passed` 的 `report.json`，避免 Vitest 对 skip 仍以 0 退出。
30 是当前 world v2 的场景数；接回归档的 64 个增量后必须同步改为 94。

默认只读取封存 fixture。缺录制、配置签名变化、请求漂移、额外/遗漏调用或错误
终态都会失败。回放不会启动 fixture 上游，也不会调用线上模型；实际 Agent、工具、
MCP、ACP、存储和 TUI 继续运行。每次使用新 HOME/work，通过真实 ACP 初始化新的
会话，并用已声明的因果身份绑定动态 ID。默认回放以 3 个 worker 并行执行测试
文件，文件内场景串行；显式录制保持单 worker。

更新录制必须显式执行：

```bash
npm run e2e:replay:record
# 调试一个用例：
PERI_E2E_REPLAY_MODE=record npx vitest run --config vitest.replay-v2.config.ts --testNamePattern S01
```

`CI` 环境拒绝 record。场景使用本地合成模型 fixture，通过这些测试不代表某个线上
模型的质量。每个录制目录保存初始文件 seed、HTTP 原字节 cassette、环境绑定声明
和工具参数派生计划。更新先写入独立临时目录，通过场景和封存校验后才替换旧
fixture。场景目录见 [fixtures/replay-v2/README.md](fixtures/replay-v2/README.md)。

### world:sync 与录制

`world:sync` 把高频 prompt 源文件同步进 world 快照；`--check` 额外校验 cassette
seal 的 `worldRefs`。两者都从 `PERI_SOURCE_ROOT`（或 `--peri-root`）读取 Peri
源码：

```bash
PERI_SOURCE_ROOT=/path/to/peri npm run e2e:replay:world-sync
PERI_SOURCE_ROOT=/path/to/peri npm run e2e:replay:world-check
node scripts/refresh-cassettes.mjs --peri-root /path/to/peri [--check]
```

未映射 leaf 变化不能由 `world:sync` 解释，必须重录或走受控迁移；不要在未审核的
情况下手工重封。

### 本仓 CI

`.github/workflows/ci.yml` 在 PR 与 `main` push 上运行。它从 `.github/peri-rev`
读取固定 Peri commit，checkout 到 `peri-src` 并构建 `peri`，然后依次执行类型检查、
replay 单测（`PERI_SOURCE_ROOT=peri-src`）、fixture verify、world-check、catalog
静态检查和完整 30 场景回放；回放后再用 `check-replay-catalog.mjs --results` 核对
实际执行报告。失败时上传 `results/replay-v2` 作为证据。更新被测版本只需修改
`.github/peri-rev` 并同步 world/fixture 校验。

## 场景接口

业务用例调用 `helpers/llm-replay-suite.ts` 的 `runReplayScenario`：

```ts
await runReplayScenario({
  id: "T01",
  title: "真实文件工具结果可见",
  sessionNames: ["root"],
  configure: async (world) => { /* 初始配置、工作文件；只在显式 record 执行 */ },
  upstream: async (world) => startLocalFixture(world), // 只在 record 启动
  runOptions: (ctx) => ({ gates: [/* 按明确 owner/execution/call 控制字节前缀 */] }),
  run: async (ctx) => {
    ctx.identity.arm(ctx.sessionIds.root!, "turn-1");
    const tui = await ctx.startTui("root");
    await tui.prompt("fixture scenario input");
    // 对真实屏幕、文件和 ACP 完成事实断言；代理发送完不是应用已消费。
    ctx.observe("user-visible-result", { /* 实际观测证据 */ });
  },
});
```

`ctx.requests` 保留当前模式的原始请求，`ctx.checked(predicate)` 在代理错误时尽早
失败。`runOptions.onRequest` 与共享绑定、证据采集串联，不能替换共享行为。
`ctx.bindings` 注册显式 typed 值；重放只使用录制时冻结的精确字段模板，保留其余
全文严格匹配。工具参数中的路径引用按白名单派生到当前 world，原始 cassette 不变。

`configure` 的源码及默认配置有签名；变化后必须重录。闭包值或外部配置变化还应
修改 `configVersion`。seed 中不得写入录制 world 的绝对路径或会话数据库。

## 结果与时延

每场景结果写入 `results/replay-v2/<invocation>/<id>/report.json`，同时保留屏幕
`.txt`、原始 `.pty`、请求 JSON 和 `final-work/`。失败也写报告，保留明确错误。
`observe` 记录证据，不代替断言。

| 字段 | 含义 |
| --- | --- |
| `preparationMs` | 读取/验证 seed、创建隔离环境和真实 ACP 初始化；不含 proxy 启动 |
| `proxyBootMs` | 打开及校验 cassette、启动本地 HTTP 代理 |
| `driverMs` | 场景键盘/ACP 动作、等待和断言 |
| `scenarioMs` | 驱动及完成核验、证据与录制封存；不含最终清理 |
| `cleanupMs` | 关闭进程/代理/fixture、清理录制世界 |
| `totalMs` | 整个 case 的墙钟时延 |

`driverMs` 和 `scenarioMs` 有包含关系，不能相加。真实重试 backoff、受控 gate 和
应用刷新包含在场景时延中，不能把这些时间称为纯模型回放 CPU 开销。

## legacy 套件

`npm test` / `npm run e2e[:l0|l1|l2|release]` 保留原 Peri TUI 分层用例，依赖
`PERI_SOURCE_ROOT`、tmux 与在线 LLM judge。它们不进默认 CI，只在本地按需运行。
