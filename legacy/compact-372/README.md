# Peri PR #372 compact/context 完整 v1 e2e 快照

本目录是 `KonghaYao/peri#372` head 的完整 `e2e/` 树快照，用于追溯 v1 录放夹具、测试、辅助代码与生成器。它不参与构建、测试或 CI。

## 来源

- 源 PR：`KonghaYao/peri#372`（compact/context）
- head：`45c8f45e9ad2216e6be72583b704e7acd783cd87`（2026-11-09）
- 导出日期：2026-11-10（Asia/Shanghai）
- 范围：该 head 的完整 e2e 树，非仅 PR diff；按下方排除项裁剪。

## 文件数与分类

导出 438 个 e2e 文件，另加本 README，共 439 个文件。

| 分类 | 数量 | 说明 |
| --- | ---: | --- |
| `fixtures/` | 336 | `replay-v2` 327、`autonomy-delegation` 8、`mcp-skill-fixture.mjs` 1 |
| `tests/` | 52 | scenarios、replay-v2、tool-cards、subagent 等 |
| `helpers/` | 17 | |
| `llm-replay/` | 18 | |
| `scripts/` | 4 | 含 `refresh-cassettes.mjs` |
| `config/` | 1 | |
| 根文件 | 10 | `package.json`、`package-lock.json`、tsconfig、vitest 配置、`.gitignore`、`README.e2e.md` |

`e2e/README.md` 因与本溯源 README 同名，按原字节保存为 `README.e2e.md`；其 blob SHA 仍与源文件一致。

## 排除项

- `e2e/.env.example`：按 `.env*` 规则排除。
- `e2e/tui-tester`：gitlink，指向 `tui-tester@1d73f75510232aea4ec589e7dc563f9fcb23ee04`，未导出。
- 源树中不存在 `results/`、`recordings/`、`node_modules/`、`.git/` 内容。

## 快照性质

这是 `peri-e2e` v2 world 迁移前的 v1 e2e 快照（夹具格式仍为 Peri 的 replay-v2 cassette）：cassette 请求、封存值、测试与生成器均保持 PR head 原样。

- 已被本仓 main 的 v2 world 迁移取代：main 为 `7827cd5a0c28f12306d2ccf736d46736b11675a3`，即 PR #1 `feat/replay-world-v2` 的合并结果（迁移提交 `2ad625c`、`2709a5a`、`75a6278`）。
- 迁移来源：Peri #375 的工作区 `/tmp/peri-ws-pr2`，分支 `feat/replay-world-migration`（导出时 HEAD `d790877d5`）；该分支以 `45c8f45e9` 为基线。
- 与 main 对照：同相对路径的 61 个文件内容均不同，98 个路径在 v2 布局中不存在，0 个相同。不要用本目录覆盖 v2 数据。

## 未接入 CI

`legacy/` 未被 `package.json`、vitest 配置、lefthook 或 CI 引用，仅作历史留存。源 `e2e/README.md` 的构建与运行步骤面向 Peri 仓库根目录，单独在本仓不可直接执行。

## 完整性与安全

- 与 PR #372 head 全量 blob SHA 比对：438/438 一致，0 差异。
- 无 `.env*`、`results`、`recordings`、`node_modules`、submodule/gitlink 或符号链接。
- 未发现 API key、私钥或真实 Authorization/Bearer 凭据。
- `llm-replay/proxy.test.mjs` 中的 `Bearer fixture-private` 是测试用假值。
- fixtures 中的 `/tmp/peri-wire-e2e-*` 是录制时的临时根路径；未发现 `/Users`、`/home`、`/private/tmp`、`/var/folders` 等本机用户路径。
