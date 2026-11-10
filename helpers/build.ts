import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { requirePeriSourceRoot } from "./peri.js";

export async function buildPeriForE2e(): Promise<void> {
  const periRoot = requirePeriSourceRoot();
  await promisify(execFile)("bash", [
    path.join(periRoot, "scripts/cargo-rmcp-patched.sh"),
    "build", "--locked", "-p", "peri-tui", "--bin", "peri",
  ], {
    cwd: periRoot,
    timeout: 600_000,
    maxBuffer: 8 * 1024 * 1024,
  });
}
