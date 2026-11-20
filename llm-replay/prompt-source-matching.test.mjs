import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCassette } from './cassette.mjs';
import { createCassetteBindingRegistry, loadWorld } from './world-store.mjs';
import { assertRequestMatches, ReplayError, sha256 } from './matcher.mjs';
import { splitPromptSourceTail } from './world-slots.mjs';

const e2eRoot = fileURLToPath(new URL('..', import.meta.url));
const cassetteDir = path.join(e2eRoot, 'fixtures/replay-v2/U04/cassette');
const worldDir = path.join(e2eRoot, 'fixtures/replay-v2/world');
const RECIPE = 'sys.block1.main.t171';
const SOURCE_LEAF = 'sys.block1.main.t171.prompt';
const OLD_TAIL_SHA256 = 'c58b8d2d5299f7a5913663c825576bcbccd7dcf32db1d6bd8a6fe194bf4e2234';
const UPDATED = 'This session runs inside the Peri terminal UI. SOURCE_UPDATED.';

/** 用录制快照或改写的正文搭一个最小 checkout，避免单测依赖本机 Peri 仓库。 */
async function sourceRoot(t, body) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'peri-prompt-source-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'peri-tui/prompts'), { recursive: true });
  await writeFile(path.join(root, 'peri-tui/prompts/tui.md'), body);
  return root;
}

async function baseline(t) {
  const world = await loadWorld(worldDir);
  const body = world.leafBytes(SOURCE_LEAF).toString('utf8');
  const root = await sourceRoot(t, body);
  const cassette = await loadCassette(cassetteDir, { sourceRoot: root, requireSources: true });
  const fresh = [...cassette.entries.values()].find((entry) => entry.identity.owner === 'fresh');
  const rootEntry = [...cassette.entries.values()].find((entry) => entry.identity.owner === 'root');
  assert.ok(fresh && rootEntry);
  return { world, body, root, cassette, fresh, rootEntry };
}

function call(entry, body) {
  return { method: entry.request.method, target: entry.request.target, headers: entry.request.headers, body };
}

function normalization(entry) {
  return { bindings: createCassetteBindingRegistry(entry.bindings), owner: 'world', rules: entry.requestRules };
}

function body(entry, which = 'expectedBody') {
  return JSON.parse(entry.request[which].toString('utf8'));
}

function encode(value) {
  return Buffer.from(JSON.stringify(value), 'utf8');
}

function expectRejected(entry, actual) {
  assert.throws(
    () => assertRequestMatches(entry.request, call(entry, actual), normalization(entry)),
    (error) => {
      assert.ok(error instanceof ReplayError || error.name === 'BindingError', String(error));
      assert.ok(['request_mismatch', 'binding_value_mismatch'].includes(error.code), error.code);
      assert.ok(error.details && (error.details.path || error.details.difference),
        '拒绝原因必须报告字段或首个差异');
      return true;
    },
  );
}

test('正例：源码正文变化后 fresh 请求按当前 checkout 匹配', async (t) => {
  const { body: recorded } = await baseline(t);
  const changed = await sourceRoot(t, recorded.replace('This session runs inside the Peri terminal UI.', UPDATED));
  const cassette = await loadCassette(cassetteDir, { sourceRoot: changed, requireSources: true });
  const fresh = [...cassette.entries.values()].find((entry) => entry.identity.owner === 'fresh');
  assert.equal(cassette.report.sourceDrift.length, 1);
  assert.equal(cassette.report.sourceDrift[0].leaf, SOURCE_LEAF);
  assert.equal(cassette.report.sourceDrift[0].field, '/system/1/text');
  assert.equal(cassette.report.sourceDrift[0].session, 'interactive-fresh');
  assert.notEqual(cassette.report.sourceDrift[0].recordedSha256, cassette.report.sourceDrift[0].currentSha256);
  assertRequestMatches(fresh.request, call(fresh, fresh.request.expectedBody), normalization(fresh));
});

test('负例 1：漏掉提示词正文段被拒绝', async (t) => {
  const { body: recorded, fresh } = await baseline(t);
  const value = body(fresh);
  assert.ok(value.system[1].text.includes(recorded));
  value.system[1].text = value.system[1].text.replace(recorded, '');
  expectRejected(fresh, encode(value));
});

test('负例 2：提示词正文重复注入被拒绝', async (t) => {
  const { body: recorded, fresh } = await baseline(t);
  const value = body(fresh);
  value.system[1].text = value.system[1].text.replace(recorded, `${recorded}${recorded}`);
  expectRejected(fresh, encode(value));
});

test('负例 3：提示词正文放进错误系统块被拒绝', async (t) => {
  const { body: recorded, fresh } = await baseline(t);
  const value = body(fresh);
  value.system[1].text = value.system[1].text.replace(recorded, '');
  value.system[0].text = `${value.system[0].text}\n${recorded}`;
  expectRejected(fresh, encode(value));
});

test('负例 4：源码变化后仍发送旧正文被拒绝', async (t) => {
  const { body: recorded } = await baseline(t);
  const changed = await sourceRoot(t, recorded.replace('This session runs inside the Peri terminal UI.', UPDATED));
  const cassette = await loadCassette(cassetteDir, { sourceRoot: changed, requireSources: true });
  const fresh = [...cassette.entries.values()].find((entry) => entry.identity.owner === 'fresh');
  expectRejected(fresh, fresh.request.recordedBody);
});

test('负例 5：fresh 使用旧 session ID 被拒绝', async (t) => {
  const { fresh, rootEntry } = await baseline(t);
  const freshSession = fresh.bindings.find((binding) => binding.kind === 'session' && binding.alias === 'fresh');
  const rootSession = rootEntry.bindings.find((binding) => binding.kind === 'session' && binding.alias === 'root');
  assert.ok(freshSession && rootSession);
  assert.notEqual(freshSession.recorded, rootSession.recorded);
  const value = body(fresh);
  value.system[1].text = value.system[1].text.split(freshSession.recorded).join(rootSession.recorded);
  expectRejected(fresh, encode(value));
});

test('负例 6：fresh 夹带旧会话消息被拒绝', async (t) => {
  const { fresh, rootEntry } = await baseline(t);
  const value = body(fresh);
  value.messages = [...body(rootEntry, 'recordedBody').messages, ...value.messages];
  expectRejected(fresh, encode(value));
});

test('负例 7：工具 schema 变化被拒绝', async (t) => {
  const { fresh } = await baseline(t);
  const value = body(fresh);
  assert.ok(Array.isArray(value.tools) && value.tools.length);
  value.tools[0].name = `${value.tools[0].name}_CHANGED`;
  expectRejected(fresh, encode(value));
});

test('负例 8：丢失缓存边界被拒绝', async (t) => {
  const { fresh } = await baseline(t);
  const value = body(fresh);
  assert.ok(value.system[0].cache_control);
  delete value.system[0].cache_control;
  expectRejected(fresh, encode(value));
});

test('负例 9：给恢复会话补注入提示词正文被拒绝', async (t) => {
  const { body: recorded, rootEntry } = await baseline(t);
  const value = body(rootEntry, 'recordedBody');
  assert.ok(!value.system[1].text.includes(recorded));
  value.system[1].text = value.system[1].text.replace(
    '<env>', `<agent_instructions>\n${recorded}\n</agent_instructions>\n\n<env>`,
  );
  assert.ok(value.system[1].text.includes('<agent_instructions>'));
  expectRejected(rootEntry, encode(value));
});

test('源文件缺失或未设置 checkout 时报告场景、调用与字段', async (t) => {
  const empty = await mkdtemp(path.join(os.tmpdir(), 'peri-empty-source-'));
  t.after(() => rm(empty, { recursive: true, force: true }));
  await assert.rejects(
    () => loadCassette(cassetteDir, { sourceRoot: empty, requireSources: true }),
    (error) => {
      assert.equal(error.code, 'prompt_source_missing');
      assert.equal(error.details.scenario, 'U04');
      assert.equal(error.details.field, '/system/1/text');
      assert.equal(error.details.path, 'peri-tui/prompts/tui.md');
      assert.ok(error.details.entry);
      return true;
    },
  );
  await assert.rejects(
    () => loadCassette(cassetteDir, { requireSources: true }),
    (error) => {
      assert.equal(error.code, 'prompt_source_root_missing');
      assert.equal(error.details.scenario, 'U04');
      assert.equal(error.details.field, '/system/1/text');
      return true;
    },
  );
  // strict verify 只校验封存字节，不要求 checkout。
  const recorded = await loadCassette(cassetteDir);
  assert.equal(recorded.report.sourceDrift.length, 0);
  const fresh = [...recorded.entries.values()].find((entry) => entry.identity.owner === 'fresh');
  assert.equal(sha256(fresh.request.recordedBody), sha256(fresh.request.expectedBody));
});

test('迁移等价：拆分前后 tail、raw 与 canonical 摘要一致', async () => {
  const world = await loadWorld(worldDir);
  const parts = world.recipeParts(RECIPE);
  assert.ok(parts, `缺少 ${RECIPE}`);
  const sourcePart = parts.find((part) => part && part.source);
  assert.deepEqual(
    { source: sourcePart?.source, field: sourcePart?.field, session: sourcePart?.session, leaf: sourcePart?.leaf },
    { source: 'tuiSessionInstructions', field: '/system/1/text', session: 'interactive-fresh', leaf: SOURCE_LEAF },
  );
  const tail = Buffer.concat([
    world.leafBytes('sys.block1.main.t171.head'),
    world.leafBytes(SOURCE_LEAF),
    world.leafBytes('sys.block1.main.t171.suffix'),
  ]);
  assert.equal(sha256(tail), OLD_TAIL_SHA256);
  const rendered = world.renderParts([{ recipe: RECIPE }]);
  assert.ok(rendered.subarray(rendered.length - tail.length).equals(tail));

  const recorded = await loadCassette(cassetteDir);
  const fresh = [...recorded.entries.values()].find((entry) => entry.identity.owner === 'fresh');
  const stub = JSON.parse(await readFile(path.join(cassetteDir, fresh.request.stub), 'utf8'));
  assert.equal(sha256(fresh.request.recordedBody), stub.rawSha256);
  assert.equal(sha256(fresh.request.canonicalBody), stub.canonicalSha256);
});

test('tail 拆分要求正文唯一且会话范围与注册表一致', () => {
  const value = '<body>';
  const text = `head\n${value}\nsuffix`;
  assert.deepEqual(splitPromptSourceTail(text, { sourceId: 'tuiSessionInstructions', body: value, field: '/system/1/text', session: 'interactive-fresh' }), {
    head: 'head\n', body: value, suffix: '\nsuffix',
  });
  assert.throws(
    () => splitPromptSourceTail(`${text}${value}`, { sourceId: 'tuiSessionInstructions', body: value, field: '/system/1/text', session: 'interactive-fresh' }),
    (error) => error.code === 'prompt_source_ambiguous',
  );
  assert.throws(
    () => splitPromptSourceTail('no body', { sourceId: 'tuiSessionInstructions', body: value, field: '/system/1/text', session: 'interactive-fresh' }),
    (error) => error.code === 'prompt_source_missing',
  );
  assert.throws(
    () => splitPromptSourceTail(text, { sourceId: 'tuiSessionInstructions', body: value, field: '/system/1/text', session: 'resumed' }),
    (error) => error.code === 'prompt_source_scope_mismatch',
  );
});
