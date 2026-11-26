#!/usr/bin/env node
/**
 * 用 CI 失败请求证据校验 replay world 的 `system[1]` 渲染是否已修正。
 *
 * 证据目录形如 `<evidence>/<scenario>/replay-request-*.json`：每个文件是代理收到的实际
 * Anthropic 请求 body。对每个请求：
 * 1. 取 `system[1].text`（block1：prefix + skills + tail）。
 * 2. catalog 段必须与两个冻结模板之一逐字节一致（A/B 系用 replay-worker 变体）。
 * 3. 用 world 渲染该场景 cassette 请求，取同一字段；把证据里由 typed-template 声明的
 *    env 值（path/platform/os_version/date/session）映射回录制值后，整段文本必须与渲染
 *    逐字节相等，并断言两者字节长度一致。
 * 4. `--require` 场景（默认 T02..T06 + 证据中出现的 A/B 系）必须有精确匹配；存在
 *    report.json 详细错误时，还断言证据文本的 sha256/长度与 CI 报错一致。
 *
 * 用法：node scripts/verify-explorer-evidence.mjs --evidence /path/to/ci-evidence
 */
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const here = path.dirname(fileURLToPath(import.meta.url));
const e2eRoot = path.resolve(here, '..');
const fixtures = path.join(e2eRoot, 'fixtures/replay-v2');
const templatesDir = path.join(e2eRoot, 'llm-replay/world-source-templates');
const load = (relative) => import(pathToFileURL(path.join(e2eRoot, relative)).href);

const { sha256 } = await load('llm-replay/matcher.mjs');
const { loadWorld } = await load('llm-replay/world-store.mjs');

const { values } = parseArgs({
  options: {
    evidence: { type: 'string' },
    fixtures: { type: 'string', default: fixtures },
    require: { type: 'string' },
  },
});
if (!values.evidence) throw new Error('缺少 --evidence <CI 失败请求证据目录>');
const evidenceRoot = path.resolve(values.evidence);
const fixturesRoot = path.resolve(values.fixtures);
const world = await loadWorld(path.join(fixturesRoot, 'world'));

const assert = (condition, message) => { if (!condition) throw new Error(message); };
const text = (bytes) => bytes.toString('utf8');
const byteLength = (value) => Buffer.byteLength(value, 'utf8');

const CATALOG_START = '## Available agent types\n\n';
const CATALOG_END = '\n\nEach agent entry shows';
const ENV_BLOCK = /\n<env>\n[\s\S]*?\n<\/env>/u;

function catalogOf(value) {
  const start = value.indexOf(CATALOG_START);
  const end = value.indexOf(CATALOG_END);
  if (start < 0 || end < 0 || end <= start) return null;
  return value.slice(start + CATALOG_START.length, end);
}

function envBlockOf(value) {
  const matches = value.match(new RegExp(ENV_BLOCK.source, 'gu')) ?? [];
  assert(matches.length === 1, `system[1] 必须恰好包含一个 <env> 块，实际 ${matches.length} 个`);
  return matches[0];
}

function envValuesOf(value) {
  const block = envBlockOf(value);
  const line = (label) => {
    const match = new RegExp(`^${label}: (.*)$`, 'mu').exec(block);
    assert(match, `system[1] 的 <env> 块缺少 ${label}`);
    return match[1];
  };
  return {
    path: line('Working directory'),
    platform: line('Platform'),
    os_version: line('OS Version'),
    date: line("Today's date"),
    session: line('Session ID'),
  };
}

function systemRuleOf(rules) {
  return (rules ?? []).find((rule) => rule && rule.path === '/system/1/text' && rule.mode === 'typed-template');
}

/** 只把证据里的 live env 值换回录制值；其余字节必须原样。 */
function normalizeEvidence(rule, evidenceText, env) {
  let normalized = evidenceText;
  for (const reference of rule.pattern) {
    const key = `${reference.kind}:${reference.alias}`;
    const live = env[reference.kind];
    const recorded = rule.recorded?.[key];
    assert(typeof live === 'string' && live, `证据缺少 ${reference.kind} 值`);
    assert(typeof recorded === 'string' && recorded, `cassette 缺少 ${key} 录制值`);
    normalized = normalized.split(live).join(recorded);
  }
  return normalized;
}

const mainTemplate = await readFile(path.join(templatesDir, 'block1.main.catalog.txt'), 'utf8');
const workerTemplate = await readFile(path.join(templatesDir, 'block1.replay-worker.catalog.txt'), 'utf8');
for (const [id, file, template] of [
  ['sys.block1.main.prefix', 'block1.main.catalog.txt', mainTemplate],
  ['sys.block1.replay-worker.prefix', 'block1.replay-worker.catalog.txt', workerTemplate],
]) {
  const current = catalogOf(text(world.leafBytes(id)));
  assert(current === template, `${id}: 渲染 catalog 与冻结模板 ${file} 不一致`);
}
const templates = [
  { variant: 'main', catalog: mainTemplate },
  { variant: 'replay-worker', catalog: workerTemplate },
];

const scenarioIds = (await readdir(evidenceRoot, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
  .map((entry) => entry.name)
  .sort();
assert(scenarioIds.length > 0, `${evidenceRoot}: 未找到场景证据目录`);

const required = values.require
  ? values.require.split(',').map((value) => value.trim()).filter(Boolean)
  : ['T02', 'T03', 'T04', 'T05', 'T06', ...scenarioIds.filter((id) => /^[AB]\d+$/u.test(id))];
const requiredSet = new Set(required);

async function loadRenders(scenario) {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(path.join(fixturesRoot, scenario, 'cassette', 'manifest.json'), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const renders = [];
  for (const entry of manifest.entries) {
    const stub = JSON.parse(await readFile(path.join(fixturesRoot, scenario, 'cassette', entry.request.stub), 'utf8'));
    let body;
    try { body = JSON.parse(text(world.renderParts(stub.parts))); } catch { continue; }
    const value = body?.system?.[1]?.text;
    if (typeof value !== 'string') continue;
    renders.push({ stub: entry.request.stub, value, rules: entry.requestRules ?? [] });
  }
  return renders;
}

const rows = [];
const failures = [];
let catalogChecks = 0;
let exactChecks = 0;
let detailChecks = 0;

for (const scenario of scenarioIds) {
  const directory = path.join(evidenceRoot, scenario);
  const files = (await readdir(directory)).filter((file) => file.startsWith('replay-request-') && file.endsWith('.json')).sort();
  if (!files.length) continue;
  const renders = await loadRenders(scenario);

  for (const file of files) {
    const body = JSON.parse(await readFile(path.join(directory, file), 'utf8'));
    const evidenceText = body?.system?.[1]?.text;
    if (typeof evidenceText !== 'string') continue;
    const catalog = catalogOf(evidenceText);
    assert(catalog, `${scenario}/${file}: system[1] 缺少 agent catalog 段`);
    const variants = templates.filter((template) => template.catalog === catalog);
    assert(variants.length === 1, `${scenario}/${file}: catalog 与冻结模板不唯一匹配（${variants.map((item) => item.variant).join(', ') || '无'}）`);
    catalogChecks += 1;

    const env = envValuesOf(evidenceText);
    let match = null;
    for (const render of renders) {
      const rule = systemRuleOf(render.rules);
      // 证据只覆盖 root 会话（<env> 只有 Session ID）；child 条目的 thread 绑定无法从证据还原。
      if (!rule || rule.pattern.some((reference) => reference.kind === 'thread')) continue;
      if (normalizeEvidence(rule, evidenceText, env) === render.value) { match = render; break; }
    }
    if (match) {
      exactChecks += 1;
      const swapped = match.value.replace(envBlockOf(match.value), envBlockOf(evidenceText));
      assert(swapped === evidenceText, `${scenario}/${file}: 替换 <env> 后仍与证据不同`);
      assert(sha256(Buffer.from(swapped, 'utf8')) === sha256(Buffer.from(evidenceText, 'utf8')),
        `${scenario}/${file}: 替换 <env> 后摘要不同`);
    } else if (requiredSet.has(scenario)) {
      failures.push({ scenario, file, variants: variants.map((item) => item.variant), evidenceBytes: byteLength(evidenceText) });
    }

    rows.push({
      scenario,
      file,
      variant: variants[0].variant,
      evidenceBytes: byteLength(evidenceText),
      evidenceSha256: sha256(Buffer.from(evidenceText, 'utf8')),
      matchedStub: match?.stub ?? null,
      renderedBytes: match ? byteLength(match.value) : null,
      envDeltaBytes: match ? byteLength(match.value) - byteLength(evidenceText) : null,
      catalogBytes: byteLength(catalog),
      exact: Boolean(match),
    });
  }
}

assert(failures.length === 0, `必需场景未找到精确匹配：${JSON.stringify(failures)}`);

// 证据目录里的 report.json 若保留完整 details，交叉校验 sha256/长度/字段。
for (const scenario of requiredSet) {
  let report;
  try { report = JSON.parse(await readFile(path.join(evidenceRoot, scenario, 'report.json'), 'utf8')); }
  catch { continue; }
  const message = report?.error?.message;
  if (typeof message !== 'string') continue;
  const start = message.indexOf('[{');
  const end = message.lastIndexOf(']');
  if (start < 0 || end < start) continue;
  let detail;
  try { detail = JSON.parse(message.slice(start, end + 1))[0]?.details; } catch { continue; }
  if (!detail || detail.path !== '/system/1/text' || typeof detail.actualSha256 !== 'string') continue;
  const scenarioRows = rows.filter((row) => row.scenario === scenario);
  assert(scenarioRows.length > 0, `${scenario}: 没有可校验的 system[1] 证据`);
  for (const row of scenarioRows) {
    assert(row.evidenceBytes === detail.actualLength, `${scenario}/${row.file}: 证据长度 ${row.evidenceBytes} 与 CI ${detail.actualLength} 不符`);
    assert(row.evidenceSha256 === detail.actualSha256, `${scenario}/${row.file}: 证据 sha256 与 CI ${detail.actualSha256} 不符`);
    detailChecks += 1;
  }
}

for (const scenario of ['T02', 'T03', 'T04', 'T05', 'T06']) {
  const scenarioRows = rows.filter((row) => row.scenario === scenario);
  assert(scenarioRows.length > 0, `${scenario}: 缺少证据请求`);
  for (const row of scenarioRows) {
    assert(row.exact, `${scenario}/${row.file}: 未与 world 渲染精确匹配`);
    assert(row.evidenceBytes === 29270, `${scenario}/${row.file}: system[1] 应为 29270 字节，实际 ${row.evidenceBytes}`);
  }
}

console.log(JSON.stringify({
  command: 'verify-explorer-evidence',
  evidence: evidenceRoot,
  world: { generation: world.manifest.generation, leaves: world.leaves.length },
  scenarios: scenarioIds.length,
  requests: rows.length,
  catalogChecks,
  exactChecks,
  detailChecks,
  required: [...requiredSet].sort(),
  variants: Object.fromEntries(templates.map((template) => [template.variant, rows.filter((row) => row.variant === template.variant).length])),
  nonExact: rows.filter((row) => !row.exact),
  rows,
}, null, 2));
