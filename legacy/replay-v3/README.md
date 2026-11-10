# Replay v3 legacy export (Peri PR #365)

本目录是 Peri PR #365（Replay v3）`e2e/` 的工作树快照，只作历史归档，**not wired to CI**。

## 来源

| 项 | 值 |
| --- | --- |
| 源 PR | <https://github.com/KonghaYao/peri/pull/365> |
| Head SHA | `5500951b4d9df40f4af40dd7b6bae37dcdbdc50d` |
| 源仓库 / 路径 | `KonghaYao/peri` 的 `e2e/` |
| 导出日期 | 2026-11-09 |
| 导入模式 | 工作树快照，不导入 Peri git 历史 |
| 许可 | Apache-2.0（见 [LICENSE](LICENSE)，复制自 Peri 仓库） |

## 与 v2 的关系

仓库根目录是已迁移并继续维护的 Replay v2 套件（`fixtures/replay-v2/`、
`tests/replay-v2/`、`scripts/run-replay-v2.mjs`）。本目录是 PR #365 当时的完整
`e2e/` 快照，同时包含 v2 基线与 v3 新增场景（`tests/replay-v3/`：异步任务、
monitor、跨生命周期存储、TUI 长上下文等）。

- 两者同名文件不共享；本目录位于 `legacy/` 下，不覆盖根目录的 v2 文件。
- 根目录 v2 是权威版本；本目录冻结在 #365 head，不再接收更新或迁移。
- 本目录没有接入任何 CI workflow。

## 运行前提

- Node.js、npm、Python 3、Unix PTY。
- Peri 源码与已构建二进制；v3 场景驱动真实 ACP、Agent、工具与 TUI。
- `tui-tester` 复用仓库根目录的 vendored 副本（MIT），需先构建：

```bash
# 在 peri-e2e 仓库根
npm ci                            # postinstall 会构建 tui-tester

cd legacy/replay-v3
npm ci

# 指向本机 Peri checkout；PERI_BINARY 或 PERI_SOURCE_ROOT 二选一即可
PERI_SOURCE_ROOT=/path/to/peri npm run e2e:replay:check
PERI_BINARY=/path/to/peri/target/debug/peri npm run e2e:replay:quick
```

二进制解析顺序：`PERI_BINARY` → `PERI_E2E_BINARY` →
`PERI_SOURCE_ROOT/target/debug/peri` → `<repo>/target/debug/peri`。

完整门禁包含真实生产等待边界；`e2e:replay:quick` 只跳过显式 `[slow]` 场景。
录制模式 `e2e:replay:record` 仅限本地，`CI` 环境会拒绝。

## 相对源 PR 的子目录适配

源套件假设 `e2e/` 的父目录就是 Peri 仓库根，嵌套到本仓库后必须改为套件根相对：

| 文件 | 变更 |
| --- | --- |
| `helpers/llm-replay-tui.ts` | PTY 脚本改为套件根相对；二进制支持 `PERI_BINARY` / `PERI_SOURCE_ROOT` |
| `helpers/llm-replay-suite.ts` | fixture、results、隔离源码签名改为套件根相对；报告使用统一二进制解析 |
| `scripts/run-replay.mjs` | 二进制默认路径不再假设 `../target/debug/peri` |
| `package.json` / `package-lock.json` | `tui-tester` 指向 `file:../../tui-tester`（仓库根 vendored 包） |
| `README.md` | 本文件；源 README 保留为 `README.source.md`，仅作历史参考 |

源 README 中的 `../docs/...`、`e2e/tui-tester` submodule 等说明已不适用于本目录。

## 导出范围与差异

- PR #365 变更的 e2e 路径：**1223**（1010 新增 + 213 修改，无删除、无重命名）。
- 本目录导出：**1448** 个源 PR head 普通文件，其中 1223 为 PR 变更，
  225 为未变但套件运行所需的支撑文件（v2 的 response/seed、测试、helpers、config 等）。
- 额外新增：本 README、`LICENSE`；源 `README.md` 重命名为 `README.source.md`。
- 排除：`e2e/tui-tester` submodule gitlink（改用仓库根 vendored 副本）；
  无 `.env`、`results/`、`recordings/`、`node_modules/`、`.git`。
- fixture 中的 `/tmp/peri-wire-e2e-*` 是录制时临时 HOME/work 路径，属预期；
  未发现真实密钥或用户主目录绝对路径。
