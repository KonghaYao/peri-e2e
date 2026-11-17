import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
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
    return { code: 0, report: JSON.parse(stdout), stderr: '' };
  } catch (error) {
    const stdout = error.stdout ?? '';
    return {
      code: typeof error.code === 'number' ? error.code : 1,
      report: stdout.trim() ? JSON.parse(stdout) : null,
      stderr: error.stderr ?? '',
    };
  }
}

/** 记录 world 目录内每个文件的哈希，用来断言同步只落盘预期文件。 */
async function worldHashes(root) {
  const hashes = new Map();
  const walk = async (directory, relative = '') => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const next = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(path.join(directory, entry.name), next);
      else hashes.set(next, sha256(await readFile(path.join(directory, entry.name))));
    }
  };
  await walk(root);
  return hashes;
}

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

const MOD_RS = `const BASE_SECTIONS: [(&str, &str, PromptSectionZone, u16); 8] = [
${SECTIONS.map(([id, file, zone, order]) => `    (
        "${id}",
        include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../peri-acp/prompts/sections/${file}"
        )),
        PromptSectionZone::${zone},
        ${order},
    ),`).join('\n')}
];`;

/** 由 world 现有 leaf 反推一个合成 Peri 源树，用于制造“源已变化”的场景。 */
async function syntheticPeriSource(t, worldDir, { block0 } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'peri-world-check-source-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'peri-acp/prompts/sections'), { recursive: true });
  await mkdir(path.join(root, 'peri-middlewares/src/subagent/tool/descriptions'), { recursive: true });
  await mkdir(path.join(root, 'peri-agent/src/agent/compact_v2/descriptions'), { recursive: true });
  await mkdir(path.join(root, 'peri-middlewares/src/default_system_prompt'), { recursive: true });
  await mkdir(path.join(root, 'peri-middlewares/src/subagent/tool/define'), { recursive: true });
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
  await writeFile(path.join(root, 'peri-middlewares/src/subagent/tool/define/sub_agent_tool.rs'), SEND_ONLY);
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
  assert.deepEqual(report.recorded.mappedDrift, ['tools.Agent.anthropic']);
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
  assert.deepEqual(before.report.recorded.mappedDrift, ['sys.block0.main', 'tools.Agent.anthropic']);
  assert.deepEqual(before.report.recorded.unanchoredDrift, ['sys.block0.main']);
  assert.equal(before.report.recorded.requiresRerecord, true);

  const synced = await run(['--world', world, '--peri-root', source]);
  assert.equal(synced.code, 0);
  assert.deepEqual(synced.report.updated, ['sys.block0.main']);

  const after = await run(['--check', '--world', world, '--peri-root', source]);
  assert.equal(after.code, 0);
  assert.equal(after.report.stale, false);
  assert.deepEqual(after.report.recorded.mappedDrift, ['sys.block0.main', 'tools.Agent.anthropic']);
  assert.deepEqual(after.report.recorded.sourceAnchoredDrift, ['sys.block0.main', 'tools.Agent.anthropic']);
  assert.deepEqual(after.report.recorded.unanchoredDrift, []);
  assert.equal(after.report.recorded.requiresRerecord, false);
});

test('block0 源等价变化经 world:sync 只改 leaf 与 seal 两个文件', async (t) => {
  const { world } = await fixture(t);
  const original = await readFile(path.join(world, 'system/block0.main.txt'));
  const source = await syntheticPeriSource(t, world, { block0: `${original.toString('utf8')}\nSYNCED CHANGE` });
  const before = await worldHashes(world);

  const synced = await run(['--world', world, '--peri-root', source]);
  assert.equal(synced.code, 0);
  assert.deepEqual(synced.report.updated, ['sys.block0.main']);
  assert.equal(synced.report.written, 1);

  const after = await worldHashes(world);
  const changedFiles = [...new Set([...before.keys(), ...after.keys()])]
    .filter((file) => before.get(file) !== after.get(file)).sort();
  assert.deepEqual(changedFiles, ['seal.json', 'system/block0.main.txt']);

  const check = await run(['--check', '--world', world, '--peri-root', source]);
  assert.equal(check.code, 0);
  assert.equal(check.report.stale, false);
  assert.ok(check.report.recorded.sourceAnchoredDrift.includes('sys.block0.main'));
  assert.deepEqual(check.report.recorded.unanchoredDrift, []);
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
  assert.deepEqual(after.report.recorded.mappedDrift, ['sys.skills', 'tools.Agent.anthropic']);
  assert.deepEqual(after.report.recorded.sourceAnchoredDrift, ['sys.skills', 'tools.Agent.anthropic']);
  assert.deepEqual(after.report.recorded.unmappedDrift, []);
  assert.equal(after.report.recorded.requiresRerecord, false);
});

test('篡改 tools.Agent.* 非管理字段并重封 world 时 world:check 失败', async (t) => {
  const { world } = await fixture(t);
  const periRoot = await syntheticPeriSource(t, world);
  const id = 'tools.Agent.anthropic';
  const original = JSON.parse(await readFile(path.join(world, 'tools/Agent.anthropic.json'), 'utf8'));
  await rewriteLeaf(world, id, JSON.stringify({ ...original, name: 'AgentTampered' }));

  const { code, report, stderr } = await run(['--check', '--world', world, '--peri-root', periRoot]);
  assert.equal(code, 1);
  assert.equal(report, null);
  assert.match(stderr, new RegExp(`${id}: name/schema 等非管理字段与全量模板不一致`, 'u'));
});

test('Agent description 正常源同步后 world:check 通过且不要求重录', async (t) => {
  const { world } = await fixture(t);
  const ids = ['tools.Agent.anthropic', 'tools.Agent.responses'];
  const original = JSON.parse(await readFile(path.join(world, 'tools/Agent.anthropic.json'), 'utf8'));
  const periRoot = await syntheticPeriSource(t, world);
  await writeFile(
    path.join(periRoot, 'peri-middlewares/src/subagent/tool/descriptions/agent.md'),
    `${original.description}\nUPDATED FROM SOURCE`,
  );

  const before = await run(['--check', '--world', world, '--peri-root', periRoot]);
  assert.equal(before.code, 1);
  assert.deepEqual(before.report.updated, ids);

  const synced = await run(['--world', world, '--peri-root', periRoot]);
  assert.equal(synced.code, 0);
  assert.deepEqual(synced.report.updated, ids);

  const after = await run(['--check', '--world', world, '--peri-root', periRoot]);
  assert.equal(after.code, 0);
  assert.equal(after.report.stale, false);
  // 当前 cassette 只录制了 Anthropic 请求，因此只有 anthropic leaf 出现在录制引用中。
  assert.deepEqual(after.report.recorded.mappedDrift, ['tools.Agent.anthropic']);
  assert.deepEqual(after.report.recorded.sourceAnchoredDrift, ['tools.Agent.anthropic']);
  assert.equal(after.report.recorded.requiresRerecord, false);
});
