#!/usr/bin/env node
/**
 * replay-v2 catalog 门禁：测试源码、封存 fixture 与实际执行报告必须一一对应。
 *
 * 静态模式统计 `runReplayScenario({ id: "XX" })`，要求场景数等于
 * EXPECTED_REPLAY_SCENARIOS，ID 不重复、fixture 不缺不多、没有声明 skip。
 * `config/replay-blocked.json` 显式登记产品阻塞 ID 与原因：这些 ID 计入 catalog，
 * 但不要求可执行测试、fixture 或 report；它们不进入默认回放，也不能计为通过。
 * `--results <dir>` 额外核对每个可执行 ID 都有 passed/replay 的 report.json，
 * 用于抓住 Vitest 以 0 退出但实际未执行（skip）的场景。
 */
import { access, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const here = path.dirname(fileURLToPath(import.meta.url));
const e2eRoot = path.resolve(here, '..');
const testsRoot = path.join(e2eRoot, 'tests/replay-v2');
const { values } = parseArgs({
  options: {
    expected: { type: 'string' },
    fixtures: { type: 'string' },
    results: { type: 'string' },
  },
});

// 66 = catalog 场景数（既有 30 + E2E-02 第一批 B/H/M 36）；其中 4 个产品阻塞项
// 暂留归档 cassette。D/J/L 接回后必须再显式改为 94，不要从实际 catalog 反向生成
// 期望值，否则迁移遗漏会被误报为通过。
const expected = Number(values.expected ?? process.env.EXPECTED_REPLAY_SCENARIOS ?? 66);
const fixturesRoot = path.resolve(values.fixtures ?? path.join(e2eRoot, 'fixtures/replay-v2'));
const errors = [];

// 产品阻塞项不属于通过；显式登记原因，缺 fixture、无 report 都不算迁移遗漏。
const blocked = JSON.parse(await readFile(path.join(e2eRoot, 'config/replay-blocked.json'), 'utf8'));
for (const [id, reason] of Object.entries(blocked)) {
  if (!/^[A-Z][0-9]{2}$/u.test(id)) errors.push(`阻塞项 ID 非法：${id}`);
  if (typeof reason !== 'string' || reason.trim().length === 0) errors.push(`阻塞项 ${id} 缺少原因`);
}

if (!Number.isInteger(expected) || expected <= 0) {
  errors.push(`EXPECTED_REPLAY_SCENARIOS 必须是正整数，实际为 ${JSON.stringify(expected)}`);
}

const exists = async (file) => {
  try { await access(file); return true; } catch { return false; }
};

// ---- 测试源码中的场景 ID 与显式 skip ----
const testFiles = (await readdir(testsRoot, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && entry.name.endsWith('.test.ts'))
  .map((entry) => entry.name)
  .sort();
if (testFiles.length === 0) errors.push('tests/replay-v2 未找到任何 *.test.ts');

const idFiles = new Map();
const skipMarkers = [];
const skipPattern = /\b(?:describe|it|test)\.(?:concurrent\.)?(?:skip|skipIf|todo)\b|\bskip\s*:\s*true\b/g;
for (const file of testFiles) {
  const text = await readFile(path.join(testsRoot, file), 'utf8');
  for (const match of text.matchAll(/\bid:\s*["']([A-Z][0-9]{2})["']/g)) {
    const id = match[1];
    if (!idFiles.has(id)) idFiles.set(id, []);
    idFiles.get(id).push(file);
  }
  for (const match of text.matchAll(skipPattern)) {
    const line = text.slice(0, match.index).split('\n').length;
    skipMarkers.push(`${file}:${line}: ${match[0]}`);
  }
}
for (const [id, files] of idFiles) {
  if (files.length > 1) errors.push(`场景 ID ${id} 重复：${[...new Set(files)].join(', ')}`);
}
if (skipMarkers.length > 0) {
  errors.push(`存在未声明的新增 skip/todo：${skipMarkers.join('; ')}`);
}
for (const id of idFiles.keys()) {
  if (blocked[id]) errors.push(`阻塞场景 ${id} 仍注册为可执行测试；恢复前不要计入通过`);
}
const scenarios = [...idFiles.keys(), ...Object.keys(blocked)].sort();
if (scenarios.length !== new Set(scenarios).size) errors.push('场景 ID 重复（可执行测试与阻塞项冲突）');
if (scenarios.length === 0) errors.push('未统计到任何业务场景 ID（零测试）');
if (scenarios.length !== expected) {
  errors.push(`场景数 ${scenarios.length} 与期望 ${expected} 不一致；迁移后必须更新 EXPECTED_REPLAY_SCENARIOS`);
}

// ---- 封存 fixture 目录 ----
const fixtures = new Set();
const fixtureEntries = (await readdir(fixturesRoot, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'world');
for (const entry of fixtureEntries) {
  const directory = path.join(fixturesRoot, entry.name);
  const sealed = await exists(path.join(directory, 'scenario.json'))
    && await exists(path.join(directory, 'cassette/manifest.json'));
  if (!sealed) {
    errors.push(`fixture 目录 ${entry.name} 缺少 scenario.json 或 cassette/manifest.json`);
    continue;
  }
  fixtures.add(entry.name);
}
for (const id of idFiles.keys()) {
  if (!fixtures.has(id)) errors.push(`场景 ${id} 缺少封存 fixture`);
}
for (const id of fixtures) {
  if (!idFiles.has(id)) {
    errors.push(blocked[id]
      ? `fixture ${id} 属于阻塞项；恢复前不应进入默认 fixture 集`
      : `fixture ${id} 没有对应的业务场景测试`);
  }
}

// ---- 实际执行报告（--results） ----
let results = null;
if (values.results) {
  const resultsRoot = path.resolve(e2eRoot, values.results);
  const reports = [];
  for (const id of [...idFiles.keys()].sort()) {
    if (blocked[id]) continue;
    const reportFile = path.join(resultsRoot, id, 'report.json');
    let report;
    try {
      report = JSON.parse(await readFile(reportFile, 'utf8'));
    } catch (error) {
      errors.push(`场景 ${id} 缺少可读的 report.json（未执行或被 skip）：${error.message}`);
      continue;
    }
    if (report.id !== id) errors.push(`场景 ${id} 的 report.json id 为 ${report.id}`);
    if (report.status !== 'passed') errors.push(`场景 ${id} 执行结果为 ${report.status}`);
    if (report.mode !== 'replay') errors.push(`场景 ${id} 执行模式为 ${report.mode}`);
    reports.push(id);
  }
  const resultEntries = (await readdir(resultsRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name);
  for (const id of resultEntries) {
    if (!idFiles.has(id) && !blocked[id]) errors.push(`结果目录 ${id} 没有对应的业务场景测试`);
  }
  results = { directory: resultsRoot, reports: reports.length };
}

const report = {
  passed: errors.length === 0,
  expected,
  scenarios,
  executed: [...idFiles.keys()].sort(),
  blocked: Object.fromEntries(Object.entries(blocked).sort(([left], [right]) => left.localeCompare(right))),
  testFiles,
  fixtures: [...fixtures].sort(),
  skipMarkers,
  ...(results ? { results } : {}),
  errors,
};
console.log(JSON.stringify(report, null, 2));
if (errors.length > 0) process.exitCode = 1;
