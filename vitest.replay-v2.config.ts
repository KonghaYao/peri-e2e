import { defineConfig } from "vitest/config";
import path from "node:path";

const E2E_ROOT = __dirname;
const PERI_SOURCE_ROOT = process.env.PERI_SOURCE_ROOT
  ? path.resolve(process.env.PERI_SOURCE_ROOT)
  : undefined;

// A default run only opens sealed fixtures. Recording is an explicit local mode in the harness.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/replay-v2/**/*.test.ts"],
    testTimeout: 180_000,
    hookTimeout: 120_000,
    teardownTimeout: 10_000,
    fileParallelism: process.env.PERI_E2E_REPLAY_MODE !== "record",
    maxWorkers: process.env.PERI_E2E_REPLAY_MODE === "record" ? 1 : 3,
    maxConcurrency: 1,
    env: {
      E2E_ROOT,
      ...(PERI_SOURCE_ROOT ? { PERI_SOURCE_ROOT } : {}),
    },
  },
});
