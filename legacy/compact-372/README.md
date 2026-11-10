# Peri PR #372 compact/context e2e 历史快照

本目录归档 `KonghaYao/peri#372` 中尚未随 v2 world 迁移进入本仓的 e2e 历史内容，用于追溯与差异比对，不参与构建、测试或 CI。

## 来源

- 源 PR：`KonghaYao/peri#372`（compact/context）
- head：`45c8f45e9ad2216e6be72583b704e7acd783cd87`（2026-11-09）
- 合并基线：`2b6de62c98f1c81b28964e363013651c3da168d0`
- 导出日期：2026-11-10（Asia/Shanghai）
- 导出范围：该 PR 相对基线变更的 159 个 e2e 路径
  - `fixtures/replay-v2/**`：158 个修改文件，保留原相对路径
  - `scripts/refresh-cassettes.mjs`：1 个新增文件

注意：PR head 的 `e2e/fixtures/replay-v2/` 共 327 个文件；本目录只保存 PR 实际改动的 158 个夹具，未包含其余 169 个未改动文件，因此不是可直接运行的完整语料集。

## 快照性质

本目录是 `peri-e2e` v2 world 迁移前的 v1 夹具/生成器快照（夹具格式仍为 Peri 的 replay-v2 cassette）：cassette 请求、封存值与 `refresh-cassettes.mjs` 生成逻辑均保持 PR head 原样。

- 已被本仓 main 的 v2 world 迁移取代：main 为 `7827cd5a0c28f12306d2ccf736d46736b11675a3`，即 PR #1 `feat/replay-world-v2` 的合并结果（迁移提交 `2ad625c`、`2709a5a`、`75a6278`）。
- 迁移来源：Peri #375 的工作区 `/tmp/peri-ws-pr2`，分支 `feat/replay-world-migration`（导出时 HEAD `d790877d5`）；该分支以 `45c8f45e9` 为基线。
- 与 main 对照：同相对路径的 61 个文件内容均不同，98 个路径在 v2 布局中不存在，0 个相同。不要用本目录覆盖 v2 数据。

## 未接入 CI

`legacy/` 未被 `package.json`、vitest 配置、lefthook 或 CI 引用，仅作历史留存。`scripts/refresh-cassettes.mjs` 依赖 Peri 仓库的 `e2e/llm-replay/*` 与生产 prompt 源文件，单独在本仓不可执行。

## 完整性与安全

- 导出文件数：159（不含本 README）。
- 与 PR #372 head 全量 blob SHA 比对：159/159 一致，0 差异。
- 无 `.git`、`.env*`、`results`、`recordings`、`node_modules`、submodule/gitlink 或符号链接。
- 安全扫描未发现 API key、私钥、Authorization/Bearer 值或本机绝对路径。
