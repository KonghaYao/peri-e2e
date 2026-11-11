# 66 个 Peri 业务场景录放语料

这些场景使用真实 Peri 二进制、ACP 与 PTY。初次录制的模型上游是本地可控服务；cassette 保存实际 HTTP 请求与响应，不代表真实商业模型的回答质量。普通重放仅消费已保存的 cassette，不启动模型上游，不允许未匹配时回源。

## 场景与独立断言

| ID | 场景 | 必须核对的行为 |
| --- | --- | --- |
| S01 | 多轮流式文本与内容块顺序 | 文本顺序、后续请求携带前轮回复、完成次数 |
| S02 | 流式工具参数分片 | 完整参数到达后实际 Write，文件字节正确 |
| S03 | 429、503 后重试成功 | 同逻辑调用 attempt 递增、只展示一次完成 |
| S04 | HTTP 错误后继续输入 | 错误可见、新执行成功、身份不复用 |
| S05 | 断流、取消续推理、再输入 | 真实取消终态、旧后缀不进入新执行 |
| S06 | Responses 工具调用闭环 | 真实工具文件、function_call_output、最终回复 |
| T01 | Write 后 Read | 文件内容与模型实际收到的读取结果一致 |
| T02 | Read 后 Edit | 精确替换、旧内容消失、工具卡完成 |
| T03 | Bash 执行 | stdout 与实际文件副作用 |
| T04 | 缺失文件后的工具修复 | 首次错误、Write 补齐、再次 Read 成功 |
| T05 | MCP 资源读取 | 实际 MCP 内容进入下一次模型请求 |
| T06 | Prompt hook 修改工具输入 | hook 有独立录制调用、文件为修改后的结果 |
| A01 | 同步子 Agent | 子任务创建、工具卡、父任务实际消费结果 |
| A02 | 同名子 Agent 并发反序完成 | 父调用锚点区分子任务、结果和工具卡不串线 |
| A03 | 异步子 Agent 回送 | 后台终态、无需新用户输入的结果回送 |
| A04 | 子 Agent resume | 使用本轮真实子会话身份并保留历史 |
| A05 | 子 Agent 工具错误与恢复 | 错误归属、后续工具结果、父任务可继续 |
| A06 | 父子共享文件 | 控制真实读写因果，检查各次读取和最终文件 |
| I01 | 双会话同输入反序请求/响应 | 同 ACP 后端隔离、各自持久历史与 TUI |
| I02 | 一份录制同时重放两次 | 独立 world、绑定、游标与完成状态 |
| I03 | 一会话取消、另一会话继续 | 目标取消、旧 requestId 的迟到 Stop 不影响新执行 |
| U01 | 进程重启后续聊 | 新进程加载原会话、旧回复进入续聊请求 |
| U02 | 同一 TUI 流式期间切换会话 | 旧流随 session/close 取消、目标会话隔离、切回可续聊 |
| U03 | 忙时连续输入排队 | 用户顺序、每项一次、正确历史前缀 |
| U04 | /clear 后新会话 | 新 owner、旧上下文不泄漏 |
| U05 | 长 Markdown 与终端缩放 | 窄屏草稿保留、提交一次、历史内容完整 |
| U06 | 手动 compact 后续聊 | compact 辅助调用、摘要落盘、下一轮使用摘要 |
| U07 | AskUser 单选 | 选项交给原工具，下一次模型请求包含真实回答 |
| U08 | AskUser 多题多选 | 多选集合与题目顺序保持 |
| U09 | 审批拒绝后明确允许 | 拒绝零副作用、下一轮批准恰好执行一次 |

## 第一批接回场景（B/H/M）

来源：`legacy/replay-v3`（commit `19dd2d33166b4fe9abaf6556972879f58bed9d78`，Peri PR #365 导出）。
测试位于 `tests/replay-v2/`，复用当前 world v2、typed identity 与严格请求匹配；除阻塞项外均按 pin `4ba78d7e15f6040e5fa3192492987b17c0d0e2e6` 重录。

### 异步 Agent（B01–B12，12/12 回放通过）

| ID | 场景 | 必须核对的行为 |
| --- | --- | --- |
| B01 | 父挂起保持 working | 异步结果自动处理、只持久化一次、无第二次用户输入 |
| B02 | 双异步 child 逆序完成 | 文件与结果按父调用锚点归属，working 终态准确 |
| B03 | 取消普通父回合 | 不杀 Independent child，结果只自动续跑一次 |
| B04 | Tasks 面板取消 child | Write 不发生、取消可见、父回合继续 |
| B05 | 异步 child 401 | 失败真实回送，父继续且无假成功 |
| B06 | active child resume | Defer 补充消息进入同一执行并送达真实工具 |
| B07 | 已完成 child 后台恢复 | 同线程新执行、历史可读、旧执行不复用 |
| B08 | 无效 Agent 定义 | 明确失败，无幽灵线程或后台任务 |
| B09 | full-async-tools | Agent 缺省与显式 false 均强制后台 |
| B10 | 真实 120 秒 TurnDone | 交接后 child 回调无需用户新输入（慢例，保留生产计时） |
| B11 | 停止自动续跑 | 晚到 child 不复活父回合，显式输入后只消费一次 |
| B12 | 进程重启 | 恢复 child 历史，不恢复旧执行、工具副作用或 working |

### 异步 Shell（H01–H12，10/12 回放通过）

| ID | 场景 | 必须核对的行为 |
| --- | --- | --- |
| H01 | 后台 Shell 完成 | 父回合结束后唤醒、真实 Read、Shell 不占 OSC working |
| H02 | 非零退出 | stderr、exit code 与单次副作用保留 |
| H03 | 大 Unicode 日志 | 超过 2 MiB 完整落盘，通知只带引用，真实读取尾部 |
| H04 | 前台超时提升 | 原进程输出连续，不启动第二份 |
| H05 | Tasks 面板取消进程组 | 阻塞：pin 上取消结果降级为通用 MCP 通知，stdout/stderr 引用与 cancelled 快照丢失 |
| H06 | 并行 Shell 反序完成 | 任务身份、真实 Read 与通知不串线 |
| H07 | 跨会话取消 | 明确拒绝、两任务均完成、TUI 历史隔离 |
| H08 | 忙时 Shell 完成 | 通知恰好一次合入活动执行，无竞争执行 |
| H09 | 后台超时 | 真实 timed_out，阻止超时后的迟写（慢例，保留生产计时） |
| H10 | 关闭会话 | 清理后台进程，重载不复活旧 Shell |
| H11 | full-async-tools | Bash 缺省走后台，显式 false 保持前台 |
| H12 | ACP 取消 | 阻塞：同 H05，取消后缺少 cancelled 快照与输出引用 |

### monitor（M01–M12，10/12 回放通过）

| ID | 场景 | 必须核对的行为 |
| --- | --- | --- |
| M01 | 增量告警与 Tasks 面板 | 运行中告警、任务行、终态未报告命中合并 |
| M02 | stdout 与 EOF | 末行保留，终态空页稳定 |
| M03 | 终态分页 | exclusive cursor 单调，事件无遗漏无重复 |
| M04 | ring 溢出 | 精确报告 7 个丢弃事件并恢复剩余序号 |
| M05 | 超长 Unicode 行 | UTF-8 边界截断，小读预算仍推进完整事件 |
| M06 | monitor_stop | 进程树退出，重复停止幂等 |
| M07 | deadline | 杀掉真实进程，保留事件并失败唤醒 |
| M08 | 非法 regex | 无进程副作用，同会话可恢复 |
| M09 | 30 秒合并窗口 | 真实窗口后再次唤醒，不重复已报告命中（慢例，保留生产计时） |
| M10 | 跨 owner 控制面 | 阻塞：standalone monitor 在 transport EOF 时以 “Workspace shell task cleanup incomplete” 退出 1 |
| M11 | monitor 实例重启 | 阻塞：同 M10，正常 EOF 无法优雅退出；旧 task ID 不复活断言未获通过 |
| M12 | 非零退出 | 失败状态与 stderr 传播，终态仍可读全部事件 |

H05、H12、M10、M11 的原断言保留在 `tests/replay-v2/*.blocked.ts`，不进入默认回放，也不计为通过；阻塞原因见 `config/replay-blocked.json`。默认门禁为 62 个可执行场景，catalog 仍按 66 个 ID 校验。D/J/L 尚未接回。

## world 快照与同步
cassette `formatVersion` 为 2 时，请求正文不再各存一份完整 system prompt。共享快照位于 `world/`：

- `world/system/skills.txt` 对应 `peri-acp/prompts/sections/13_skills.md`，稳定 leaf 为 `sys.skills`；
- `world/system/compact.summary.txt` 对应 compact summary system prompt；
- `world/tools/Agent.*.json` 保存 Agent tool schema（description 与 `send_only`）；
- `world/system/block0.main.txt`、`world/system/block1.*.prefix.txt` / `*.tail.txt`、`world/tools/*.json` 由录制内容按字节拆分；
- 其余无法映射的 system 段（如 T06 hook prompt）走内容寻址 leaf，`world:sync` 会列出这些未映射 leaf。

请求 stub 只保留 messages/参数等 per-request 字节与 leaf/recipe 引用；`rawSha256`、`canonicalSha256` 与 response 哈希仍逐条校验，`requestRules` 的 typed-template pattern 在加载时按录制边界重新展开。cassette seal 的 `requestMeta` 保存每个 stub 的语义摘要与录制时 leaf 哈希序列；只有 stub 未变且变化的 leaf 全部属于 `world:sync` 映射时，加载器才报告 `report.worldDrift`。未映射 leaf（block0/block1/tail、T06 hook prompt 等）变化、stub 字面量/哈希字段变化都会让 verify 非零退出。

高频 prompt 变更流程：

1. `npm --prefix e2e run e2e:replay:world-check` 查看是否有 stale leaf；它同时用 cassette seal 的录制 `worldRefs` 交叉校验当前 world，未映射或缺失 leaf 不一致会直接失败。
2. `npm --prefix e2e run e2e:replay:world-sync` 写入映射 leaf 与 `world/seal.json`。
3. 审核 `git diff --stat`：`13_skills.md` 变化应只出现 2 个文件（skills leaf + seal）；Agent description/`send_only` 为 2 个 Agent leaf + seal；compact summary 为 1 个 leaf + seal。
4. `npm --prefix e2e run e2e:replay:verify` 重新校验 66 cassettes / world seal；映射 leaf 变化会产生 worldDrift，verify 会非零退出，提交前需重录受影响 cassette（或显式重写录制哈希），本地 `e2e:replay` 不受影响。`world:check` 把映射 leaf 差异列为 `recorded.mappedDrift`（`requiresRerecord: true`），只有未映射/缺失 leaf 不一致才判 stale。

限制：单条消息（如 U06 compact 用户指令）和 `summary_user_prompt.md` 不在 world 映射内，变化必须重录；只改 stub 字面量会被 `requestCoreSha256` 拒绝。`world:sync` 只同步上述源文件，未映射的 prompt 内容变化仍需重录。

## 证据与范围

- 每个场景有独立 seed、cassette 和场景清单；初始化通过真实 ACP 创建新会话，重放使用新的临时目录。不会修改数据库表结构或直接伪造历史行。
- 原始录制不可变。环境路径、真实 session/child 身份等动态值只能在已声明的位置按有证据的绑定转换，其余请求内容仍严格匹配。
- 屏幕断言不能命中用户 prompt 回显来冒充模型输出。涉及工具、排队、取消和持久化时必须有对应的状态、文件或请求证据。
- 每个重放 run 必须精确消费预期调用；多余、缺失、身份冲突和未结束调用都使场景失败。协议单测不计入此表的 66 个业务场景。
- 此表定义本录放套件范围。仓库完整 TUI 手工验收目录包含更多场景，本套件不宣称覆盖其中全部条目，也不替代真实模型质量或跨平台验收。

执行结果与耗时以生成的独立 record/replay 报告为准，目录清单本身不代表通过。
