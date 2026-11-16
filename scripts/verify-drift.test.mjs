import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadWorld } from '../llm-replay/world-store.mjs';
import { sha256 } from '../llm-replay/matcher.mjs';
import { assertBlock0SectionOrder } from './replay-world-sources.mjs';

const execute = promisify(execFile);
const e2eRoot = fileURLToPath(new URL('..', import.meta.url));
const script = path.join(e2eRoot, 'scripts/verify-replay-fixtures.mjs');
const syncScript = path.join(e2eRoot, 'scripts/refresh-cassettes.mjs');
const fixtures = path.join(e2eRoot, 'fixtures/replay-v2');

const SEND_ONLY = `"send_only": {
    "type": "boolean",
    "default": false,
    "description": "When true, only queue a non-empty prompt to the live background sub-agent identified by resume_thread_id. If it has no live receiver, fail without loading or resuming a persisted thread."
  },`;

const SECTIONS = [
  ['01_intro', '01_intro.md', 'Cached', 1],
  ['02_system', '02_system.md', 'Cached', 2],
  ['03_doing_tasks', '03_doing_tasks.md', 'Cached', 3],
  ['04_actions', '04_actions.md', 'Cached', 4],
  ['05_using_tools', '05_using_tools.md', 'Cached', 5],
  ['06_tone_style', '06_tone_style.md', 'Cached', 6],
  ['07_runtime', '07_runtime.md', 'Uncached', 1],
  ['env', 'env.md', 'Environment', 0],
];

/** 生成与 Peri 源码同形的 BASE_SECTIONS；路径使用完整 section 相对路径。 */
function modRs(sections) {
  const entries = sections.map(([id, file, zone, order]) => `    (
        "${id}",
        include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../peri-acp/prompts/sections/${file}"
        )),
        PromptSectionZone::${zone},
        ${order},
    ),`).join('\n');
  return `const BASE_SECTIONS: [(&str, &str, PromptSectionZone, u16); ${sections.length}] = [\n${entries}\n];`;
}

const MOD_RS = modRs(SECTIONS);

async function temporary(t, prefix = 'peri-verify-drift-') {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

/** 复制 world 与 S01 cassette，得到可独立篡改的 fixture root。 */
async function fixture(t) {
  const directory = await temporary(t);
  const world = path.join(directory, 'world');
  await cp(path.join(fixtures, 'world'), world, { recursive: true });
  await mkdir(path.join(directory, 'S01'), { recursive: true });
  await cp(path.join(fixtures, 'S01/cassette'), path.join(directory, 'S01/cassette'), { recursive: true });
  return { directory, world };
}

async function syntheticPeriRoot(t, worldDir, { block0 } = {}) {
  const root = await temporary(t, 'peri-verify-source-');
  await mkdir(path.join(root, 'peri-acp/prompts/sections'), { recursive: true });
  await mkdir(path.join(root, 'peri-middlewares/src/subagent/tool/descriptions'), { recursive: true });
  await mkdir(path.join(root, 'peri-agent/src/agent/compact_v2/descriptions'), { recursive: true });
  await mkdir(path.join(root, 'peri-middlewares/src/default_system_prompt'), { recursive: true });
  const world = await loadWorld(worldDir);
  const block = block0 ?? world.leafBytes('sys.block0.main').toString('utf8');
  await writeFile(path.join(root, 'Cargo.toml'), '');
  const sections = ['01_intro', '02_system', '03_doing_tasks', '04_actions', '05_using_tools', '06_tone_style'];
  for (const [index, id] of sections.entries()) {
    await writeFile(path.join(root, `peri-acp/prompts/sections/${id}.md`), index === 0 ? block : '');
  }
  await writeFile(path.join(root, 'peri-acp/prompts/sections/13_skills.md'), world.leafBytes('sys.skills'));
  await writeFile(path.join(root, 'peri-agent/src/agent/compact_v2/descriptions/summary_system_prompt.md'), world.leafBytes('sys.compact.summary'));
  const agentId = world.leaves.find((id) => id.startsWith('tools.Agent.'));
  const agent = JSON.parse(world.leafBytes(agentId).toString('utf8'));
  await writeFile(path.join(root, 'peri-middlewares/src/subagent/tool/descriptions/agent.md'), agent.description);
  await writeFile(path.join(root, 'peri-middlewares/src/subagent/tool/define.rs'), SEND_ONLY);
  await writeFile(path.join(root, 'peri-middlewares/src/default_system_prompt/mod.rs'), MOD_RS);
  return root;
}

async function rewriteLeaf(worldDir, id, content) {
  const manifest = JSON.parse(await readFile(path.join(worldDir, 'manifest.json'), 'utf8'));
  await writeFile(path.join(worldDir, manifest.leaves[id].file), content);
  const seal = JSON.parse(await readFile(path.join(worldDir, 'seal.json'), 'utf8'));
  seal.leaves[id] = sha256(Buffer.from(content));
  await writeFile(path.join(worldDir, 'seal.json'), `${JSON.stringify(seal)}\n`);
}

async function run(directory, ...args) {
  try {
    const { stdout } = await execute(process.execPath, [script, '--fixtures', directory, ...args], { cwd: e2eRoot });
    return { code: 0, report: JSON.parse(stdout) };
  } catch (error) {
    return { code: typeof error.code === 'number' ? error.code : 1, report: JSON.parse(error.stdout) };
  }
}

async function runSync(world, periRoot) {
  try {
    const { stdout } = await execute(process.execPath, [syncScript, '--world', world, '--peri-root', periRoot], { cwd: e2eRoot });
    return { code: 0, report: JSON.parse(stdout) };
  } catch (error) {
    return { code: typeof error.code === 'number' ? error.code : 1, report: error.stdout ? JSON.parse(error.stdout) : null };
  }
}

test('source-anchored 放行与源等值的 mapped drift，strict 仍失败', async (t) => {
  const { directory, world } = await fixture(t);
  const changed = 'CHANGED BLOCK0';
  await rewriteLeaf(world, 'sys.block0.main', changed);
  const periRoot = await syntheticPeriRoot(t, world, { block0: changed });

  const strict = await run(directory);
  assert.equal(strict.code, 1);
  assert.equal(strict.report.passed, false);
  assert.ok(strict.report.errors.length > 0);
  assert.ok(strict.report.errors.every((item) => item.code === 'world_drift_strict'));

  const anchored = await run(directory, '--drift-policy=source-anchored', `--peri-root=${periRoot}`);
  assert.equal(anchored.code, 0);
  assert.equal(anchored.report.passed, true);
  assert.equal(anchored.report.approvedDrift.length, anchored.report.driftLeaves);
  assert.ok(anchored.report.approvedDrift.length > 0);
  assert.ok(anchored.report.approvedDrift.every((item) => item.leaf === 'sys.block0.main'));
  for (const item of anchored.report.approvedDrift) assert.equal(item.sourceSha, item.currentSha);
});

test('source-anchored 拒绝 world 与源不等值，未映射 leaf 两种策略都失败', async (t) => {
  const { directory, world } = await fixture(t);
  const original = await readFile(path.join(world, 'system/block0.main.txt'));
  const periRoot = await syntheticPeriRoot(t, world);
  await rewriteLeaf(world, 'sys.block0.main', Buffer.concat([original, Buffer.from('\nTAMPERED\n')]));

  const mismatch = await run(directory, '--drift-policy=source-anchored', `--peri-root=${periRoot}`);
  assert.equal(mismatch.code, 1);
  assert.ok(mismatch.report.errors.length > 0);
  assert.ok(mismatch.report.errors.every((item) => item.code === 'world_drift_source_mismatch'));

  await rewriteLeaf(world, 'sys.block1.main.prefix', 'PREFIX TAMPERED');
  for (const args of [[], ['--drift-policy=source-anchored', `--peri-root=${periRoot}`]]) {
    const result = await run(directory, ...args);
    assert.equal(result.code, 1);
    assert.equal(result.report.passed, false);
    assert.ok(result.report.errors.some((item) => item.code === 'world_drift_unmapped_leaf' && item.leaf === 'sys.block1.main.prefix'));
  }
});

test('篡改 tools.Agent.* 非管理字段时 source-anchored 失败，正常 Agent 源同步仍通过', async (t) => {
  const { directory, world } = await fixture(t);
  const id = 'tools.Agent.anthropic';
  const leafFile = path.join(world, 'tools/Agent.anthropic.json');
  const original = JSON.parse(await readFile(leafFile, 'utf8'));
  const periRoot = await syntheticPeriRoot(t, world);

  const nameTampered = { ...structuredClone(original), name: 'AgentTampered' };
  await rewriteLeaf(world, id, JSON.stringify(nameTampered));
  const nameResult = await run(directory, '--drift-policy=source-anchored', `--peri-root=${periRoot}`);
  assert.equal(nameResult.code, 1);
  assert.equal(nameResult.report.passed, false);
  assert.ok(nameResult.report.errors.some((item) => item.code === 'world_source_unanchored' && item.message.includes(id)));

  const schemaTampered = structuredClone(original);
  schemaTampered.input_schema.properties.fork.type = 'number';
  await rewriteLeaf(world, id, JSON.stringify(schemaTampered));
  const schemaResult = await run(directory, '--drift-policy=source-anchored', `--peri-root=${periRoot}`);
  assert.equal(schemaResult.code, 1);
  assert.ok(schemaResult.report.errors.some((item) => item.code === 'world_source_unanchored' && item.message.includes(id)));

  // 恢复录制字节后，合法源变化（Agent description）仍可经 world:sync + source-anchored 放行。
  await rewriteLeaf(world, id, JSON.stringify(original));
  await writeFile(path.join(periRoot, 'peri-middlewares/src/subagent/tool/descriptions/agent.md'), `${original.description}\nUPDATED FROM SOURCE`);
  const ids = ['tools.Agent.anthropic', 'tools.Agent.responses'];
  const synced = await runSync(world, periRoot);
  assert.equal(synced.code, 0);
  assert.deepEqual(synced.report.updated, ids);

  const anchored = await run(directory, '--drift-policy=source-anchored', `--peri-root=${periRoot}`);
  assert.equal(anchored.code, 0);
  assert.equal(anchored.report.passed, true);
  assert.ok(anchored.report.approvedDrift.length > 0);
  // S01 只录制了 Anthropic 请求；responses leaf 虽同步但不在本 cassette 的录制引用中。
  assert.deepEqual([...new Set(anchored.report.approvedDrift.map((item) => item.leaf))], ['tools.Agent.anthropic']);
});

test('BASE_SECTIONS 完整集合、zone 或 include_str 路径变化时拒绝组合 block0', async (t) => {
  const root = await temporary(t, 'peri-section-order-');
  const modFile = path.join(root, 'peri-middlewares/src/default_system_prompt/mod.rs');
  await mkdir(path.dirname(modFile), { recursive: true });
  await writeFile(modFile, MOD_RS);
  await assert.doesNotReject(assertBlock0SectionOrder(root));

  const attacks = new Map([
    ['07_runtime zone 改为 Cached', SECTIONS.map(([id, file, zone, order]) => (id === '07_runtime' ? [id, file, 'Cached', order] : [id, file, zone, order]))],
    ['06 后新增 Cached 段', [...SECTIONS.slice(0, 6), ['06b_extra', '06b_extra.md', 'Cached', 7], ...SECTIONS.slice(6)]],
    ['04/05 include_str 路径交换', SECTIONS.map(([id, file, zone, order]) => [
      id,
      id === '04_actions' ? '05_using_tools.md' : id === '05_using_tools' ? '04_actions.md' : file,
      zone, order,
    ])],
  ]);
  for (const [name, sections] of attacks) {
    await writeFile(modFile, modRs(sections));
    await assert.rejects(assertBlock0SectionOrder(root), /BASE_SECTIONS/u, name);
  }
});
