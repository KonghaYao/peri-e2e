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
import { COMPACT_USER_PLACEHOLDER, COMPACT_USER_TARGET_TOKENS, BASH_DESCRIPTION_PREFIX } from '../scripts/replay-world-sources.mjs';

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

async function changedWorldFiles(before, after) {
  return [...new Set([...before.keys(), ...after.keys()])]
    .filter((file) => before.get(file) !== after.get(file)).sort();
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

/**
 * 从 main prefix 反推四个源段；分隔符与 render 的 join 一致。
 * 只用于测试合成源树，不参与生产同步。
 */
function splitBlock1Prefix(prefix) {
  const hitlAt = prefix.indexOf('\n\n# Human-in-the-Loop (HITL) Approval Mode');
  const subagentAt = prefix.indexOf('\n\n# SubAgent Delegation');
  const askUserAt = prefix.indexOf('\n\n# Asking the User (AskUserQuestion)');
  if (hitlAt < 0 || subagentAt < 0 || askUserAt < 0 || !(hitlAt < subagentAt && subagentAt < askUserAt)) {
    throw new Error('无法从 main prefix 定位 block1 源段');
  }
  const runtime = prefix.slice(0, hitlAt);
  const hitl = prefix.slice(hitlAt + 2, subagentAt);
  const renderedSubagent = prefix.slice(subagentAt + 2, askUserAt);
  const askUser = prefix.slice(askUserAt + 2, -2);
  const marker = '## Available agent types\n\n';
  const end = '\n\nEach agent entry shows';
  const catalogAt = renderedSubagent.indexOf(marker);
  const catalogEnd = renderedSubagent.indexOf(end);
  if (catalogAt < 0 || catalogEnd < 0 || renderedSubagent.indexOf(marker, catalogAt + 1) >= 0) {
    throw new Error('无法从 main prefix 定位 agent catalog');
  }
  const subagent = `${renderedSubagent.slice(0, catalogAt + marker.length)}{{available_agents}}${renderedSubagent.slice(catalogEnd)}`;
  return {
    '07_runtime': runtime, '10_hitl': hitl, '11_subagent': subagent, '12_ask_user': askUser,
  };
}

/** 由 world 现有 leaf 反推一个合成 Peri 源树，用于制造“源已变化”的场景。 */
async function syntheticPeriSource(t, worldDir, { block0 } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'peri-world-check-source-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'peri-acp/prompts/sections'), { recursive: true });
  await mkdir(path.join(root, 'peri-middlewares/src/subagent/tool/descriptions'), { recursive: true });
  await mkdir(path.join(root, 'peri-agent/src/agent/compact_v2/descriptions'), { recursive: true });
  await mkdir(path.join(root, 'peri-middlewares/src/default_system_prompt'), { recursive: true });
  await mkdir(path.join(root, 'peri-middlewares/src/subagent/tool/define'), { recursive: true });
  await mkdir(path.join(root, 'mcp-packages/workspace/src/descriptions'), { recursive: true });
  const world = await loadWorld(worldDir);
  const sections = ['01_intro', '02_system', '03_doing_tasks', '04_actions', '05_using_tools', '06_tone_style'];
  const block = block0 ?? world.leafBytes('sys.block0.main').toString('utf8');
  await writeFile(path.join(root, 'Cargo.toml'), '');
  for (const [index, id] of sections.entries()) {
    await writeFile(path.join(root, `peri-acp/prompts/sections/${id}.md`), index === 0 ? block : '');
  }
  const block1 = splitBlock1Prefix(world.leafBytes('sys.block1.main.prefix').toString('utf8'));
  for (const [id, text] of Object.entries(block1)) {
    await writeFile(path.join(root, `peri-acp/prompts/sections/${id}.md`), text);
  }
  await writeFile(path.join(root, 'peri-acp/prompts/sections/13_skills.md'), world.leafBytes('sys.skills'));
  await writeFile(path.join(root, 'peri-agent/src/agent/compact_v2/descriptions/summary_system_prompt.md'), world.leafBytes('sys.compact.summary'));
  const compactUser = world.leafBytes('sys.compact.user').toString('utf8')
    .replaceAll(String(COMPACT_USER_TARGET_TOKENS), COMPACT_USER_PLACEHOLDER);
  await writeFile(path.join(root, 'peri-agent/src/agent/compact_v2/descriptions/summary_user_prompt.md'), compactUser);
  const agentId = world.leaves.find((id) => id.startsWith('tools.Agent.'));
  const agent = JSON.parse(world.leafBytes(agentId).toString('utf8'));
  await writeFile(path.join(root, 'peri-middlewares/src/subagent/tool/descriptions/agent.md'), agent.description);
  const bash = JSON.parse(world.leafBytes('tools.Bash.anthropic').toString('utf8'));
  assert.ok(bash.description.startsWith(BASH_DESCRIPTION_PREFIX));
  await writeFile(
    path.join(root, 'mcp-packages/workspace/src/descriptions/bash.md'),
    bash.description.slice(BASH_DESCRIPTION_PREFIX.length),
  );
  await writeFile(path.join(root, 'peri-middlewares/src/subagent/tool/define/sub_agent_tool.rs'), SEND_ONLY);
  await writeFile(path.join(root, 'peri-middlewares/src/default_system_prompt/mod.rs'), MOD_RS);
  return root;
}

test('手工改写未映射 leaf 并重封 world seal 时 world:check 非零且 stale', async (t) => {
  const { world } = await fixture(t);
  const id = 'sys.block1.main.t06.tail';
  const original = await readFile(path.join(world, 'system/block1.main.t06.tail.txt'));
  await rewriteLeaf(world, id, Buffer.concat([original, Buffer.from('\nTAMPERED\n')]));

  const { code, report } = await run(['--check', '--world', world]);
  assert.equal(code, 1);
  assert.equal(report.stale, true);
  assert.deepEqual(report.staleReasons, ['cassette_unmapped_drift']);
  assert.deepEqual(report.recorded.unmappedDrift, [id]);
  assert.deepEqual(report.recorded.mappedDrift, [
    'sys.block0.main', 'sys.block1.main.prefix', 'sys.skills', 'tools.Agent.anthropic', 'tools.Bash.anthropic',
  ]);
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
  assert.deepEqual(before.report.recorded.mappedDrift, [
    'sys.block0.main', 'sys.block1.main.prefix', 'sys.skills', 'tools.Agent.anthropic', 'tools.Bash.anthropic',
  ]);
  assert.deepEqual(before.report.recorded.unanchoredDrift, ['sys.block0.main']);
  assert.equal(before.report.recorded.requiresRerecord, true);

  const synced = await run(['--world', world, '--peri-root', source]);
  assert.equal(synced.code, 0);
  assert.deepEqual(synced.report.updated, ['sys.block0.main']);

  const after = await run(['--check', '--world', world, '--peri-root', source]);
  assert.equal(after.code, 0);
  assert.equal(after.report.stale, false);
  assert.deepEqual(after.report.recorded.mappedDrift, [
    'sys.block0.main', 'sys.block1.main.prefix', 'sys.skills', 'tools.Agent.anthropic', 'tools.Bash.anthropic',
  ]);
  assert.deepEqual(after.report.recorded.sourceAnchoredDrift, [
    'sys.block0.main', 'sys.block1.main.prefix', 'sys.skills', 'tools.Agent.anthropic', 'tools.Bash.anthropic',
  ]);
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

test('block1 prefix 源变化同步三个分类 leaf 与 seal，catalog 保持录制快照', async (t) => {
  const { world } = await fixture(t);
  const source = await syntheticPeriSource(t, world);
  const runtimeFile = path.join(source, 'peri-acp/prompts/sections/07_runtime.md');
  await writeFile(runtimeFile, `${await readFile(runtimeFile, 'utf8')}\nRUNTIME CHANGE`);
  const beforeHashes = await worldHashes(world);
  const beforeMain = await readFile(path.join(world, 'system/block1.main.prefix.txt'), 'utf8');

  const before = await run(['--check', '--world', world, '--peri-root', source]);
  assert.equal(before.code, 1);
  assert.deepEqual(before.report.updated, [
    'sys.block1.main.prefix', 'sys.block1.replay-worker.prefix', 'sys.block1.subagent.prefix',
  ]);
  assert.deepEqual(before.report.staleReasons, ['source_not_synced']);
  assert.deepEqual(before.report.recorded.unanchoredDrift, ['sys.block1.main.prefix']);
  assert.equal(before.report.recorded.requiresRerecord, true);

  const synced = await run(['--world', world, '--peri-root', source]);
  assert.equal(synced.code, 0);
  assert.deepEqual(synced.report.updated, [
    'sys.block1.main.prefix', 'sys.block1.replay-worker.prefix', 'sys.block1.subagent.prefix',
  ]);
  assert.equal(synced.report.written, 3);

  const changedFiles = (await changedWorldFiles(beforeHashes, await worldHashes(world)));
  assert.deepEqual(changedFiles, [
    'seal.json',
    'system/block1.main.prefix.txt',
    'system/block1.replay-worker.prefix.txt',
    'system/block1.subagent.prefix.txt',
  ]);
  const afterMain = await readFile(path.join(world, 'system/block1.main.prefix.txt'), 'utf8');
  const runtime = afterMain.slice(0, afterMain.indexOf('\n\n# Human-in-the-Loop'));
  assert.ok(runtime.endsWith('\nRUNTIME CHANGE'));
  // 动态 catalog 仍与录制快照逐字节一致，未因源同步被改写。
  const catalog = afterMain.slice(
    afterMain.indexOf('## Available agent types\n\n') + '## Available agent types\n\n'.length,
    afterMain.indexOf('\n\nEach agent entry shows'),
  );
  const beforeCatalog = beforeMain.slice(
    beforeMain.indexOf('## Available agent types\n\n') + '## Available agent types\n\n'.length,
    beforeMain.indexOf('\n\nEach agent entry shows'),
  );
  assert.equal(catalog, beforeCatalog);

  const check = await run(['--check', '--world', world, '--peri-root', source]);
  assert.equal(check.code, 0);
  assert.equal(check.report.stale, false);
  assert.deepEqual(check.report.recorded.sourceAnchoredDrift, [
    'sys.block0.main', 'sys.block1.main.prefix', 'sys.skills', 'tools.Agent.anthropic', 'tools.Bash.anthropic',
  ]);
  assert.deepEqual(check.report.recorded.unanchoredDrift, []);
  assert.equal(check.report.recorded.requiresRerecord, false);
});

test('篡改固定 catalog 时 world:check 判 stale，world:sync 恢复模板快照', async (t) => {
  const { world } = await fixture(t);
  const source = await syntheticPeriSource(t, world);
  const prefixFile = path.join(world, 'system/block1.main.prefix.txt');
  const original = await readFile(prefixFile, 'utf8');
  await rewriteLeaf(
    world,
    'sys.block1.main.prefix',
    original.replace('Default owner for implementation', 'Tampered owner for implementation'),
  );

  const before = await run(['--check', '--world', world, '--peri-root', source]);
  assert.equal(before.code, 1);
  assert.deepEqual(before.report.updated, ['sys.block1.main.prefix']);
  assert.deepEqual(before.report.staleReasons, ['source_not_synced']);
  assert.deepEqual(before.report.recorded.unanchoredDrift, ['sys.block1.main.prefix']);
  assert.equal(before.report.recorded.requiresRerecord, true);

  const synced = await run(['--world', world, '--peri-root', source]);
  assert.equal(synced.code, 0);
  assert.deepEqual(synced.report.updated, ['sys.block1.main.prefix']);
  assert.equal(await readFile(prefixFile, 'utf8'), original);
});

test('block1 源段标题或占位符不符时拒绝同步', async (t) => {
  const { world } = await fixture(t);
  const source = await syntheticPeriSource(t, world);
  const subagentFile = path.join(source, 'peri-acp/prompts/sections/11_subagent.md');
  await writeFile(subagentFile, (await readFile(subagentFile, 'utf8')).replace('{{available_agents}}', 'NO CATALOG'));

  const { code, report, stderr } = await run(['--check', '--world', world, '--peri-root', source]);
  assert.equal(code, 1);
  assert.equal(report, null);
  assert.match(stderr, /11_subagent\.md 必须恰好包含一个 \{\{available_agents\}\}/u);
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
  assert.deepEqual(after.report.recorded.mappedDrift, [
    'sys.block0.main', 'sys.block1.main.prefix', 'sys.skills', 'tools.Agent.anthropic', 'tools.Bash.anthropic',
  ]);
  assert.deepEqual(after.report.recorded.sourceAnchoredDrift, [
    'sys.block0.main', 'sys.block1.main.prefix', 'sys.skills', 'tools.Agent.anthropic', 'tools.Bash.anthropic',
  ]);
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
  assert.deepEqual(after.report.recorded.mappedDrift, [
    'sys.block0.main', 'sys.block1.main.prefix', 'sys.skills', 'tools.Agent.anthropic', 'tools.Bash.anthropic',
  ]);
  assert.deepEqual(after.report.recorded.sourceAnchoredDrift, [
    'sys.block0.main', 'sys.block1.main.prefix', 'sys.skills', 'tools.Agent.anthropic', 'tools.Bash.anthropic',
  ]);
  assert.equal(after.report.recorded.requiresRerecord, false);
});

test('篡改 tools.Bash.* 非管理字段时 world:check 失败，description 源同步后通过', async (t) => {
  const { world } = await fixture(t);
  const periRoot = await syntheticPeriSource(t, world);
  const id = 'tools.Bash.anthropic';
  const leafFile = path.join(world, 'tools/Bash.anthropic.json');
  const original = JSON.parse(await readFile(leafFile, 'utf8'));

  await rewriteLeaf(world, id, JSON.stringify({ ...original, name: 'BashTampered' }));
  const tampered = await run(['--check', '--world', world, '--peri-root', periRoot]);
  assert.equal(tampered.code, 1);
  assert.equal(tampered.report, null);
  assert.match(tampered.stderr, new RegExp(`${id}: name/schema 等非管理字段与录制模板不一致`, 'u'));

  await rewriteLeaf(world, id, JSON.stringify(original));
  const bashSource = path.join(periRoot, 'mcp-packages/workspace/src/descriptions/bash.md');
  await writeFile(bashSource, `${await readFile(bashSource, 'utf8')}\nSOURCE UPDATE`);
  const ids = ['tools.Bash.anthropic', 'tools.Bash.responses'];

  const before = await run(['--check', '--world', world, '--peri-root', periRoot]);
  assert.equal(before.code, 1);
  assert.deepEqual(before.report.updated, ids);

  const synced = await run(['--world', world, '--peri-root', periRoot]);
  assert.equal(synced.code, 0);
  assert.deepEqual(synced.report.updated, ids);

  const leaf = JSON.parse(await readFile(leafFile, 'utf8'));
  assert.equal(leaf.description, `${BASH_DESCRIPTION_PREFIX}${await readFile(bashSource, 'utf8')}`);

  const after = await run(['--check', '--world', world, '--peri-root', periRoot]);
  assert.equal(after.code, 0);
  assert.equal(after.report.stale, false);
  assert.ok(after.report.recorded.sourceAnchoredDrift.includes('tools.Bash.anthropic'));
  assert.equal(after.report.recorded.requiresRerecord, false);
});
