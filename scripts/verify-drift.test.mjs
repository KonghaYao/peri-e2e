import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectPromptSourceParts, loadWorld } from '../llm-replay/world-store.mjs';
import { sha256 } from '../llm-replay/matcher.mjs';
import { assertBlock0SectionOrder, COMPACT_USER_PLACEHOLDER, COMPACT_USER_TARGET_TOKENS, PROMPT_SOURCES, loadSourceLeaves } from './replay-world-sources.mjs';

const execute = promisify(execFile);
const e2eRoot = fileURLToPath(new URL('..', import.meta.url));
const script = path.join(e2eRoot, 'scripts/verify-replay-fixtures.mjs');
const syncScript = path.join(e2eRoot, 'scripts/refresh-cassettes.mjs');
const fixtures = path.join(e2eRoot, 'fixtures/replay-v2');

/** 与 world:sync 映射一致：source-anchored 只可能放行这些 leaf。 */
const SYNCED_LEAVES = new Set([
  'sys.block0.main', 'sys.block1.main.prefix', 'sys.block1.replay-worker.prefix',
  'sys.block1.subagent.prefix', 'sys.skills', 'sys.compact.summary', 'sys.compact.user',
  'tools.Bash.anthropic', 'tools.Bash.responses',
]);
const isSyncedLeaf = (id) => SYNCED_LEAVES.has(id) || id.startsWith('tools.Agent.');

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

const SECTION_CONSTANTS = Object.freeze({
  '01_intro': 'INTRO',
  '02_system': 'SYSTEM',
  '03_doing_tasks': 'TASKS',
  '04_actions': 'ACTIONS',
  '05_using_tools': 'TOOLS',
  '06_tone_style': 'STYLE',
  '07_runtime': 'RUNTIME',
  env: 'ENV',
});

function sectionConstant(id) {
  return SECTION_CONSTANTS[id] ?? `EXTRA_${id.replace(/[^a-z0-9]+/giu, '_').toUpperCase()}`;
}

/** 生成 #443 后的 SectionSpec 声明形状（常量引用 + 相对 include_str）。 */
function modRsWithSpecs(sections) {
  const entries = sections.map(([id, file]) => `    (
        sections::${sectionConstant(id)},
        include_str!("../../prompts/sections/${file}"),
    ),`).join('\n');
  return `const BASE_SECTIONS: &[(SectionSpec, &str)] = &[\n${entries}\n];`;
}

function ownersRs(sections) {
  const entries = sections.map(([id, , zone, order]) => `        ${sectionConstant(id)}("${id}", ${zone}, ${order}),`).join('\n');
  return `declare_owners! {\n    DefaultSystemPrompt("DefaultSystemPromptMiddleware", true, true) [] {\n${entries}\n    },\n}`;
}

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

/** U06 包含 compact system/user prompt；用于验证 user leaf 的同步与篡改门禁。 */
async function u06Fixture(t) {
  const directory = await temporary(t);
  const world = path.join(directory, 'world');
  await cp(path.join(fixtures, 'world'), world, { recursive: true });
  await mkdir(path.join(directory, 'U06'), { recursive: true });
  await cp(path.join(fixtures, 'U06/cassette'), path.join(directory, 'U06/cassette'), { recursive: true });
  return { directory, world };
}

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

/** 从 main prefix 反推四个源段；分隔符与 render 的 join 一致（仅测试合成源树）。 */
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

async function syntheticPeriRoot(t, worldDir, { block0, legacySchema = false } = {}) {
  const root = await temporary(t, 'peri-verify-source-');
  await mkdir(path.join(root, 'peri-acp/prompts/sections'), { recursive: true });
  await mkdir(path.join(root, 'peri-middlewares/src/subagent/tool/descriptions'), { recursive: true });
  await mkdir(path.join(root, 'peri-agent/src/agent/compact_v2/descriptions'), { recursive: true });
  await mkdir(path.join(root, 'peri-middlewares/src/default_system_prompt'), { recursive: true });
  await mkdir(path.join(root, 'peri-middlewares/src/subagent/tool/define'), { recursive: true });
  await mkdir(path.join(root, 'mcp-packages/workspace/src/descriptions'), { recursive: true });
  const world = await loadWorld(worldDir);
  const block = block0 ?? world.leafBytes('sys.block0.main').toString('utf8');
  await writeFile(path.join(root, 'Cargo.toml'), '');
  const sections = ['01_intro', '02_system', '03_doing_tasks', '04_actions', '05_using_tools', '06_tone_style'];
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
  await writeFile(
    path.join(root, 'mcp-packages/workspace/src/descriptions/bash.md'),
    bash.description.replace(/^\[MCP:peri\] /u, ''),
  );
  const definition = legacySchema
    ? 'peri-middlewares/src/subagent/tool/define.rs'
    : 'peri-middlewares/src/subagent/tool/define/sub_agent_tool.rs';
  await writeFile(path.join(root, definition), SEND_ONLY);
  await writeFile(path.join(root, 'peri-middlewares/src/default_system_prompt/mod.rs'), MOD_RS);
  // 提示词正文不属于 world:sync 管理集合；合成源必须复制录制快照才能比对摘要。
  for (const recipeId of world.recipeIds()) {
    for (const part of collectPromptSourceParts(world, [{ recipe: recipeId }])) {
      const relative = PROMPT_SOURCES[part.source].path;
      await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
      await writeFile(path.join(root, relative), world.leafBytes(part.leaf));
    }
  }
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
  assert.ok(anchored.report.approvedDrift.some((item) => item.leaf === 'sys.block0.main'));
  // 基线中也可能存在 pin 更新后的 Agent 源等值 drift；只允许 SYNCED/Agent leaf。
  assert.ok(anchored.report.approvedDrift.every((item) => isSyncedLeaf(item.leaf)));
  for (const item of anchored.report.approvedDrift) assert.equal(item.sourceSha, item.currentSha);
});

test('compact user prompt 源变化只改 sys.compact.user 与 seal，source-anchored 放行', async (t) => {
  const { directory, world } = await u06Fixture(t);
  const periRoot = await syntheticPeriRoot(t, world);
  const sourceFile = path.join(periRoot, 'peri-agent/src/agent/compact_v2/descriptions/summary_user_prompt.md');
  const source = await readFile(sourceFile, 'utf8');
  await writeFile(sourceFile, source.replace('Keep a small contract/recovery core', 'Keep a compact contract/recovery core'));
  const before = await worldHashes(world);

  const synced = await runSync(world, periRoot);
  assert.equal(synced.code, 0);
  assert.deepEqual(synced.report.updated, ['sys.compact.user']);
  assert.equal(synced.report.written, 1);

  const after = await worldHashes(world);
  assert.deepEqual(await changedWorldFiles(before, after), ['seal.json', 'system/compact.user.txt']);
  const leaf = await readFile(path.join(world, 'system/compact.user.txt'), 'utf8');
  assert.ok(leaf.includes('Keep a compact contract/recovery core'));
  assert.ok(leaf.includes('Target at most 8000 output tokens'));
  assert.ok(!leaf.includes('{summary_target_tokens}'));

  const anchored = await run(directory, '--drift-policy=source-anchored', `--peri-root=${periRoot}`);
  assert.equal(anchored.code, 0);
  assert.equal(anchored.report.passed, true);
  assert.ok(anchored.report.approvedDrift.some((item) => item.leaf === 'sys.compact.user' && item.sourceSha === item.currentSha));
  assert.ok(anchored.report.approvedDrift.every((item) => isSyncedLeaf(item.leaf)));
});

test('compact system prompt 源变化仍只改 sys.compact.summary 与 seal', async (t) => {
  const { directory, world } = await u06Fixture(t);
  const periRoot = await syntheticPeriRoot(t, world);
  const sourceFile = path.join(periRoot, 'peri-agent/src/agent/compact_v2/descriptions/summary_system_prompt.md');
  await writeFile(sourceFile, `${await readFile(sourceFile, 'utf8')}\nSYSTEM CHANGE`);
  const before = await worldHashes(world);

  const synced = await runSync(world, periRoot);
  assert.equal(synced.code, 0);
  assert.deepEqual(synced.report.updated, ['sys.compact.summary']);

  const after = await worldHashes(world);
  assert.deepEqual(await changedWorldFiles(before, after), ['seal.json', 'system/compact.summary.txt']);

  const anchored = await run(directory, '--drift-policy=source-anchored', `--peri-root=${periRoot}`);
  assert.equal(anchored.code, 0);
  assert.equal(anchored.report.passed, true);
  assert.ok(anchored.report.approvedDrift.some((item) => item.leaf === 'sys.compact.summary'));
});

test('篡改 sys.compact.user leaf 后 source-anchored 拒绝', async (t) => {
  const { directory, world } = await u06Fixture(t);
  const periRoot = await syntheticPeriRoot(t, world);
  const original = await readFile(path.join(world, 'system/compact.user.txt'), 'utf8');
  await rewriteLeaf(world, 'sys.compact.user', `${original}\nTAMPERED`);

  const result = await run(directory, '--drift-policy=source-anchored', `--peri-root=${periRoot}`);
  assert.equal(result.code, 1);
  assert.equal(result.report.passed, false);
  assert.ok(result.report.errors.some((item) => item.code === 'world_drift_source_mismatch' && item.leaf === 'sys.compact.user'));
});

test('篡改 U06 compact stub 并重封文件哈希仍被 requestCoreSha256 拒绝', async (t) => {
  const { directory } = await u06Fixture(t);
  const cassette = path.join(directory, 'U06/cassette');
  const manifest = JSON.parse(await readFile(path.join(cassette, 'manifest.json'), 'utf8'));
  const compact = manifest.entries.find((entry) => entry.identity?.purpose === 'compact');
  assert.ok(compact, 'U06 必须包含 compact 请求');
  const stubRelative = compact.request.stub;
  const stubFile = path.join(cassette, stubRelative);
  const stub = JSON.parse(await readFile(stubFile, 'utf8'));
  stub.parts[0] = stub.parts[0].replace('COMPACT_SEED_INPUT_731', 'COMPACT_SEED_INPUT_TAMPERED');
  const tampered = Buffer.from(`${JSON.stringify(stub, null, 2)}\n`);
  await writeFile(stubFile, tampered);

  const sealFile = path.join(cassette, 'seal.json');
  const seal = JSON.parse(await readFile(sealFile, 'utf8'));
  seal.files[stubRelative] = sha256(tampered);
  await writeFile(sealFile, `${JSON.stringify(seal)}\n`);

  const result = await run(directory);
  assert.equal(result.code, 1);
  assert.equal(result.report.passed, false);
  assert.ok(result.report.errors.some((item) => item.code === 'corrupt_cassette' && item.message.includes('core 校验失败')));
});

test('旧布局只有 define.rs 时仍能解析 Agent schema', async (t) => {
  const { directory, world } = await fixture(t);
  const changed = 'CHANGED BLOCK0 LEGACY SCHEMA';
  await rewriteLeaf(world, 'sys.block0.main', changed);
  const periRoot = await syntheticPeriRoot(t, world, { block0: changed, legacySchema: true });

  const anchored = await run(directory, '--drift-policy=source-anchored', `--peri-root=${periRoot}`);
  assert.equal(anchored.code, 0);
  assert.equal(anchored.report.passed, true);
  assert.ok(anchored.report.approvedDrift.some((item) => item.leaf === 'sys.block0.main'));
  assert.ok(anchored.report.approvedDrift.every((item) => isSyncedLeaf(item.leaf)));
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

  // 从实际 S01 请求推导被引用的 block1 tail，避免录制 tail 编号变化后测试失真。
  const loaded = await loadWorld(world);
  const requests = path.join(directory, 'S01/cassette/requests');
  let tail = null;
  for (const file of await readdir(requests)) {
    const stub = JSON.parse(await readFile(path.join(requests, file), 'utf8'));
    for (const part of stub.parts) {
      if (!part?.recipe?.startsWith('sys.block1.main.')) continue;
      const leaf = loaded.recipeParts(part.recipe)?.find((item) => item.leaf?.startsWith('sys.block1.main.t') && item.leaf.endsWith('.tail'));
      if (leaf) { tail = leaf.leaf; break; }
    }
    if (tail) break;
  }
  assert.ok(tail, 'S01 cassette 必须引用一个 block1 tail');
  await rewriteLeaf(world, tail, 'TAIL TAMPERED');
  for (const args of [[], ['--drift-policy=source-anchored', `--peri-root=${periRoot}`]]) {
    const result = await run(directory, ...args);
    assert.equal(result.code, 1);
    assert.equal(result.report.passed, false);
    assert.ok(result.report.errors.some((item) => item.code === 'world_drift_unmapped_leaf' && item.leaf === tail));
  }
});

test('篡改 tools.Agent.* 非管理字段时源码锚定拒绝，正常 Agent 源同步仍通过', async (t) => {
  const { world } = await fixture(t);
  const id = 'tools.Agent.anthropic';
  const leafFile = path.join(world, 'tools/Agent.anthropic.json');
  const original = JSON.parse(await readFile(leafFile, 'utf8'));
  const periRoot = await syntheticPeriRoot(t, world);
  const assertUnanchored = async () => {
    const loaded = await loadWorld(world);
    await assert.rejects(() => loadSourceLeaves(loaded, periRoot), /Agent/);
  };

  const nameTampered = { ...structuredClone(original), name: 'AgentTampered' };
  await rewriteLeaf(world, id, JSON.stringify(nameTampered));
  await assertUnanchored();

  await rewriteLeaf(world, id, JSON.stringify(original));
  const schemaTampered = structuredClone(original);
  schemaTampered.input_schema.properties.fork.type = 'number';
  await rewriteLeaf(world, id, JSON.stringify(schemaTampered));
  await assertUnanchored();

  // 恢复录制字节后，合法源变化（Agent description）仍可经 world:sync 放行。
  await rewriteLeaf(world, id, JSON.stringify(original));
  await writeFile(path.join(periRoot, 'peri-middlewares/src/subagent/tool/descriptions/agent.md'), `${original.description}\nUPDATED FROM SOURCE`);
  const ids = ['tools.Agent.anthropic', 'tools.Agent.responses'];
  const synced = await runSync(world, periRoot);
  assert.equal(synced.code, 0);
  assert.deepEqual(synced.report.updated, ids);

  // world:sync 后 world leaf 已与源等值；再次加载不会因非管理字段被拒。
  const syncedWorld = await loadWorld(world);
  const expected = await loadSourceLeaves(syncedWorld, periRoot);
  for (const leaf of ids) {
    assert.ok(syncedWorld.leafBytes(leaf).equals(expected.get(leaf)), leaf);
  }
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

test('#443 SectionSpec 形状的 BASE_SECTIONS 仍严格校验声明、zone 与 include_str', async (t) => {
  const root = await temporary(t, 'peri-section-spec-');
  const modFile = path.join(root, 'peri-middlewares/src/default_system_prompt/mod.rs');
  const ownersFile = path.join(root, 'peri-acp-types/src/meta_harness/owners.rs');
  await mkdir(path.dirname(modFile), { recursive: true });
  await mkdir(path.dirname(ownersFile), { recursive: true });
  const write = async (sections, declared = sections) => {
    await writeFile(modFile, modRsWithSpecs(sections));
    await writeFile(ownersFile, ownersRs(declared));
  };

  await write(SECTIONS);
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
    await write(sections);
    await assert.rejects(assertBlock0SectionOrder(root), /BASE_SECTIONS/u, name);
  }

  await write(SECTIONS);
  await writeFile(modFile, modRsWithSpecs(SECTIONS).replace('sections::ENV', 'sections::MISSING'));
  await assert.rejects(assertBlock0SectionOrder(root), /未声明的 SectionSpec/u);

  await write(SECTIONS, [...SECTIONS, ['01_intro', '01_intro.md', 'Cached', 1]]);
  await assert.rejects(assertBlock0SectionOrder(root), /重复声明/u);
});
