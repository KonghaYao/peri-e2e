import { defineConfig } from "vitest/config";
import fs from "node:fs";
import path from "node:path";

const E2E_ROOT = __dirname;
const inferredPeriRoot = path.resolve(E2E_ROOT, "..");
const PERI_SOURCE_ROOT = process.env.PERI_SOURCE_ROOT
  ? path.resolve(process.env.PERI_SOURCE_ROOT)
  : fs.existsSync(path.join(inferredPeriRoot, "Cargo.toml")) &&
      fs.existsSync(path.join(inferredPeriRoot, "dev.sh"))
    ? inferredPeriRoot
    : undefined;

// legacy 套件依赖 Peri 源码（dev.sh/tmux/在线 judge）；没有源码根时显式跳过。
const LEGACY_TEST_GLOBS = ["smoke", "scenarios", "tool-cards", "panels", "subagent", "workflow"]
  .map((dir) => `tests/${dir}/**`);
if (!PERI_SOURCE_ROOT) {
  console.warn(
    "[e2e] PERI_SOURCE_ROOT 未设置：legacy 套件（tmux/dev.sh/在线 judge）已跳过；replay 套件只需 PERI_BINARY。",
  );
}

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    testTimeout: 600_000,
    hookTimeout: 120_000,
    // Vitest 4: 顺序执行避免 tmux session 冲突
    fileParallelism: false,
    maxConcurrency: 1,
    bail: 0,
    exclude: [
      "node_modules/**",
      "tui-tester/**",
      "dist/**",
      ...(PERI_SOURCE_ROOT ? [] : LEGACY_TEST_GLOBS),
    ],
    setupFiles: ["./tests/setup.ts"],
    teardownTimeout: 10_000,
    env: {
      E2E_ROOT,
      ...(PERI_SOURCE_ROOT ? { PERI_SOURCE_ROOT, PROJECT_ROOT: PERI_SOURCE_ROOT } : {}),
    },
    // 全局 teardown: 测试完成后自动生成 HTML 报告
    globalTeardown: ["./scripts/generate-report.ts"],
  },
});
