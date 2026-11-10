import { defineConfig } from "vitest/config";
import path from "node:path";

const E2E_ROOT = __dirname;
const PERI_SOURCE_ROOT = process.env.PERI_SOURCE_ROOT
  ? path.resolve(process.env.PERI_SOURCE_ROOT)
  : undefined;

// 回放用例使用隔离 PTY 和本地模型 fixture，不加载在线 LLM judge 或 tmux 全局 setup。
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/replay/**/*.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    teardownTimeout: 10_000,
    fileParallelism: false,
    maxConcurrency: 1,
    env: {
      E2E_ROOT,
      ...(PERI_SOURCE_ROOT ? { PERI_SOURCE_ROOT } : {}),
    },
  },
});
