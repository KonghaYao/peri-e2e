import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256 } from './matcher.mjs';
import { loadWorld } from './world-store.mjs';

const execute = promisify(execFile);
const e2eRoot = fileURLToPath(new URL('..', import.meta.url));
const script = path.join(e2eRoot, 'scripts/refresh-cassettes.mjs');
const fixtures = path.join(e2eRoot, 'fixtures/replay-v2');
const recordedSeal = path.join(fixtures, 'S01/cassette/seal.json');

/** 复制真实 world 与一条 cassette seal，得到可自由重封的隔离 fixture。 */
async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'peri-world-check-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const world = path.join(directory, 'world');
  await cp(path.join(fixtures, 'world'), world, { recursive: true });
  const cassette = path.join(directory, 'S01/cassette');
  await mkdir(cassette, { recursive: true });
  await cp(recordedSeal, path.join(cassette, 'seal.json'));
  return { directory, world, sealFile: path.join(cassette, 'seal.json') };
}

/** 模拟“改 leaf 后手工重封 world seal”：loadWorld 仍通过，录制引用未变。 */
async function rewriteLeaf(world, id, content) {
  const manifest = JSON.parse(await readFile(path.join(world, 'manifest.json'), 'utf8'));
  await writeFile(path.join(world, manifest.leaves[id].file), content);
  const sealFile = path.join(world, 'seal.json');
  const seal = JSON.parse(await readFile(sealFile, 'utf8'));
  seal.leaves[id] = sha256(Buffer.from(content));
  await writeFile(sealFile, `${JSON.stringify(seal)}\n`);
}

async function run(args) {
  try {
    const { stdout } = await execute(process.execPath, [script, ...args], { cwd: e2eRoot });
    return { code: 0, report: JSON.parse(stdout) };
  } catch (error) {
    const stdout = error.stdout ?? '';
    return { code: typeof error.code === 'number' ? error.code : 1, report: stdout ? JSON.parse(stdout) : null };
  }
}

const SEND_ONLY = `"send_only": {
    "type": "boolean",
    "default": false,
    "description": "When true, only queue a non-empty prompt to the live background sub-agent identified by resume_thread_id. If it has no live receiver, fail without loading or resuming a persisted thread."
  },`;

const MOD_RS = `const BASE_SECTIONS: [(&str, &str, PromptSectionZone, u16); 6] = [
    ("01_intro", include_str!("a"), PromptSectionZone::Cached, 1,),
    ("02_system", include_str!("b"), PromptSectionZone::Cached, 2,),
    ("03_doing_tasks", include_str!("c"), PromptSectionZone::Cached, 3,),
    ("04_actions", include_str!("d"), PromptSectionZone::Cached, 4,),
    ("05_using_tools", include_str!("e"), PromptSectionZone::Cached, 5,),
    ("06_tone_style", include_str!("f"), PromptSectionZone::Cached, 6,),
];`;

/** 由 world 现有 leaf 反推一个合成 Peri 源树，用于制造“源已变化”的场景。 */
async function syntheticPeriSource(t, worldDir, { block0 } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'peri-world-check-source-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'peri-acp/prompts/sections'), { recursive: true });
  await mkdir(path.join(root, 'peri-middlewares/src/subagent/tool/descriptions'), { recursive: true });
  await mkdir(path.join(root, 'peri-agent/src/agent/compact_v2/descriptions'), { recursive: true });
  await mkdir(path.join(root, 'peri-middlewares/src/default_system_prompt'), { recursive: true });
  const world = await loadWorld(worldDir);
  const sections = ['01_intro', '02_system', '03_doing_tasks', '04_actions', '05_using_tools', '06_tone_style'];
  const block = block0 ?? world.leafBytes('sys.block0.main').toString('utf8');
  await writeFile(path.join(root, 'Cargo.toml'), '');
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

test('手工改写未映射 leaf 并重封 world seal 时 world:check 非零且 stale', async (t) => {
  const { world } = await fixture(t);
  const original = await readFile(path.join(world, 'system/block1.main.prefix.txt'));
  await rewriteLeaf(world, 'sys.block1.main.prefix', Buffer.concat([original, Buffer.from('\nTAMPERED\n')]));

  const { code, report } = await run(['--check', '--world', world]);
  assert.equal(code, 1);
  assert.equal(report.stale, true);
  assert.deepEqual(report.staleReasons, ['cassette_unmapped_drift']);
  assert.deepEqual(report.recorded.unmappedDrift, ['sys.block1.main.prefix']);
  assert.deepEqual(report.recorded.mappedDrift, []);
  assert.deepEqual(report.updated, []);
});

test('block0 与源不等值时 world:check 判 stale，同步后只报告源等值 drift', async (t) => {
  const { world } = await fixture(t);
  const original = await readFile(path.join(world, 'system/block0.main.txt'));
  const source = await syntheticPeriSource(t, world, { block0: `${original.toString('utf8')}\nCHANGED` });

  await rewriteLeaf(world, 'sys.block0.main', Buffer.concat([original, Buffer.from('\nTAMPERED\n')]));

  const before = await run(['--check', '--world', world, '--peri-root', source]);
  assert.equal(before.code, 1);
  assert.deepEqual(before.report.updated, ['sys.block0.main']);
  assert.deepEqual(before.report.staleReasons, ['source_not_synced']);
  assert.deepEqual(before.report.recorded.mappedDrift, ['sys.block0.main']);
  assert.deepEqual(before.report.recorded.unanchoredDrift, ['sys.block0.main']);
  assert.equal(before.report.recorded.requiresRerecord, true);

  const synced = await run(['--world', world, '--peri-root', source]);
  assert.equal(synced.code, 0);
  assert.deepEqual(synced.report.updated, ['sys.block0.main']);

  const after = await run(['--check', '--world', world, '--peri-root', source]);
  assert.equal(after.code, 0);
  assert.equal(after.report.stale, false);
  assert.deepEqual(after.report.recorded.mappedDrift, ['sys.block0.main']);
  assert.deepEqual(after.report.recorded.sourceAnchoredDrift, ['sys.block0.main']);
  assert.deepEqual(after.report.recorded.unanchoredDrift, []);
  assert.equal(after.report.recorded.requiresRerecord, false);
});

test('干净基线 world:check 为 0 且录制引用全部一致', async (t) => {
  const { world } = await fixture(t);
  const { code, report } = await run(['--check', '--world', world]);
  assert.equal(code, 0);
  assert.equal(report.stale, false);
  assert.deepEqual(report.staleReasons, []);
  assert.equal(report.recorded.cassettes, 1);
  assert.ok(report.recorded.references > 0);
  assert.deepEqual(report.recorded.unmappedDrift, []);
  assert.deepEqual(report.recorded.missingLeaves, []);
});

test('mapped sys.skills 经 world:sync 后只报告待重录，不判为未映射损坏', async (t) => {
  const { world, sealFile } = await fixture(t);
  // 模拟 cassette 录制的是旧 skills：只有映射 leaf 的录制哈希落后于当前 world。
  const seal = JSON.parse(await readFile(sealFile, 'utf8'));
  const staleSkills = sha256(Buffer.from('recorded-old-skills'));
  let replaced = 0;
  for (const meta of Object.values(seal.requestMeta)) {
    for (const ref of meta.worldRefs) {
      if (ref.id !== 'sys.skills') continue;
      ref.sha256 = staleSkills;
      replaced += 1;
    }
  }
  assert.ok(replaced > 0, 'S01 seal 必须引用 sys.skills');
  await writeFile(sealFile, `${JSON.stringify(seal)}\n`);

  // 源已变化但 world 尚未同步：由源映射报 stale。
  await rewriteLeaf(world, 'sys.skills', 'OLD WORLD SKILLS');
  const before = await run(['--check', '--world', world]);
  assert.equal(before.code, 1);
  assert.ok(before.report.updated.includes('sys.skills'));

  const synced = await run(['--world', world]);
  assert.equal(synced.code, 0);
  assert.deepEqual(synced.report.updated, ['sys.skills']);
  assert.equal(synced.report.written, 1);

  const after = await run(['--check', '--world', world]);
  assert.equal(after.code, 0);
  assert.equal(after.report.stale, false);
  assert.deepEqual(after.report.staleReasons, []);
  assert.deepEqual(after.report.recorded.mappedDrift, ['sys.skills']);
  assert.deepEqual(after.report.recorded.sourceAnchoredDrift, ['sys.skills']);
  assert.deepEqual(after.report.recorded.unmappedDrift, []);
  assert.equal(after.report.recorded.requiresRerecord, false);
});
