import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { canonicalRecordedBody, createWorldBuilder, loadWorld, requestCoreSha256 } from './world-store.mjs';
import { loadCassette } from './cassette.mjs';
import { identityKey, sha256 } from './matcher.mjs';
import { migrateReplayLiterals } from '../scripts/migrate-replay-literals.mjs';

const BLOCK0 = 'BLOCK0: strict instructions';
const SKILLS = '# Skills\n\nSkill body.';
const PREFIX = 'MAIN PREFIX.\n';
const TAIL = '\n\n<env>\nWorking directory: /tmp/work\n</env>';
const NEW_TAIL = '\n\n<env>\nWorking directory: /tmp/other-work\n</env>';
const TOOLS = '[{"name":"Bash","input_schema":{"type":"object"}}]';
const identity = { owner: 'root', execution: 'turn-1', call: 'reason:1', attempt: 1, purpose: 'reason' };
const response = Buffer.from('data: migrated-answer\n\n');

function body() {
  return Buffer.from(JSON.stringify({
    model: 'fixture-model', max_tokens: 32000, stream: true,
    system: [{ type: 'text', text: BLOCK0 }, { type: 'text', text: `${PREFIX}${SKILLS}${NEW_TAIL}` }],
    messages: [{ role: 'user', content: 'same question' }],
    tools: JSON.parse(TOOLS),
  }));
}

/** 构造一个 v2 literal cassette：stub 只有字面量 parts，seal 记录空 worldRefs。 */
async function fixture(t, { bodyBytes } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'peri-migrate-refs-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const worldDir = path.join(root, 'world');
  const builder = createWorldBuilder({ generation: 'migration' });
  builder.addLeaf('sys.block0.main', BLOCK0);
  builder.addLeaf('sys.skills', SKILLS);
  builder.addLeaf('sys.block1.main.prefix', PREFIX);
  builder.addLeaf('sys.block1.main.t01.tail', TAIL);
  builder.addRecipe('sys.block1.main.t01', [
    { leaf: 'sys.block1.main.prefix' }, { leaf: 'sys.skills' }, { leaf: 'sys.block1.main.t01.tail' },
  ]);
  builder.addRecipe('tools.anthropic.main', [TOOLS]);
  await builder.seal(worldDir);

  const cassette = path.join(root, 'X01', 'cassette');
  await mkdir(path.join(cassette, 'requests'), { recursive: true });
  await mkdir(path.join(cassette, 'responses'), { recursive: true });
  const key = identityKey(identity);
  const id = sha256(key);
  const raw = bodyBytes ?? body();
  const stubFile = `requests/${id}.stub.json`;
  const responseFile = `responses/${id}.bin`;
  const stub = {
    v: 2, rawBytes: raw.length, rawSha256: sha256(raw), parts: [raw.toString('utf8')],
    canonicalSha256: sha256(canonicalRecordedBody(raw, [], [])),
  };
  const stubBytes = Buffer.from(`${JSON.stringify(stub, null, 2)}\n`);
  await writeFile(path.join(cassette, stubFile), stubBytes);
  await writeFile(path.join(cassette, responseFile), response);
  const manifest = {
    formatVersion: 2, kind: 'raw-http', provenance: { source: 'test', realLlm: false, scenario: 'X01' },
    entries: [{
      identity, requestRules: [],
      request: { method: 'POST', target: 'http://fixture.test/v1/messages', headers: { 'content-type': 'application/json' }, stub: stubFile },
      response: {
        file: responseFile, status: 200, headers: { 'content-type': 'text/event-stream' }, chunks: [{ offset: 0, length: response.length, atMs: 0, sha256: sha256(response) }],
        size: response.length, submittedBytes: response.length, sha256: sha256(response), terminal: { kind: 'complete', atMs: 1 },
      },
    }],
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(path.join(cassette, 'manifest.json'), manifestBytes);
  await writeFile(path.join(cassette, 'seal.json'), `${JSON.stringify({
    formatVersion: 2, manifestSha256: sha256(manifestBytes),
    files: { [stubFile]: sha256(stubBytes) },
    requestMeta: { [stubFile]: { requestCoreSha256: requestCoreSha256(stub), worldRefs: [] } },
  })}\n`);
  return { root, worldDir, cassette };
}

async function hashes(directory) {
  const out = new Map();
  const visit = async (current) => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(file);
      else out.set(path.relative(directory, file), sha256(await readFile(file)));
    }
  };
  await visit(directory);
  return out;
}

test('迁移后 raw/canonical/response 等价，stub 变为 world ref', async (t) => {
  const { root, worldDir, cassette } = await fixture(t);
  const dry = await migrateReplayLiterals({ fixtures: root, dryRun: true });
  assert.equal(dry.migratedStubs, 1);
  assert.deepEqual(dry.rawMismatches, []);
  assert.deepEqual(dry.canonicalMismatches, []);
  assert.deepEqual(dry.rebuildMismatches, []);
  assert.deepEqual(dry.responseChanges, []);
  assert.equal(dry.responseFiles, 1);
  assert.ok(dry.newLeaves.includes('sys.block1.main.t02.tail'));
  assert.ok(dry.newRecipes.includes('sys.block1.main.t02'));

  const beforeResponses = await readFile(path.join(cassette, 'responses', `${sha256(identityKey(identity))}.bin`));
  const report = await migrateReplayLiterals({ fixtures: root });
  assert.equal(report.migratedStubs, 1);
  const loaded = await loadCassette(cassette, { worldDir });
  assert.equal(loaded.report.legacy.length, 0);
  assert.equal(loaded.report.worldDrift.length, 0);
  const stubFile = loaded.manifest.entries[0].request.stub;
  const stub = JSON.parse(await readFile(path.join(cassette, stubFile), 'utf8'));
  assert.ok(stub.parts.some((part) => part && typeof part === 'object' && part.leaf === 'sys.block0.main'));
  assert.ok(stub.parts.some((part) => part && typeof part === 'object' && part.recipe === 'sys.block1.main.t02'));
  assert.ok(stub.parts.some((part) => part && typeof part === 'object' && part.recipe === 'tools.anthropic.main'));
  assert.ok(beforeResponses.equals(await readFile(path.join(cassette, loaded.manifest.entries[0].response.file))));
});

test('prompt-only 变更只改 block0 leaf 与 world seal，stub 保持 ref', async (t) => {
  const { root, worldDir, cassette } = await fixture(t);
  await migrateReplayLiterals({ fixtures: root });
  const before = await hashes(root);
  const worldBefore = await hashes(worldDir);
  const stubsBefore = (await readdir(path.join(cassette, 'requests'))).map((file) => before.get(path.relative(root, path.join(cassette, 'requests', file))));

  const manifest = JSON.parse(await readFile(path.join(worldDir, 'manifest.json'), 'utf8'));
  const nextBlock0 = `${BLOCK0}\nCHANGED`;
  await writeFile(path.join(worldDir, manifest.leaves['sys.block0.main'].file), nextBlock0);
  const seal = JSON.parse(await readFile(path.join(worldDir, 'seal.json'), 'utf8'));
  seal.leaves['sys.block0.main'] = sha256(Buffer.from(nextBlock0));
  await writeFile(path.join(worldDir, 'seal.json'), `${JSON.stringify(seal)}\n`);

  const after = await hashes(root);
  const changed = [...new Set([...before.keys(), ...after.keys()])].filter((file) => before.get(file) !== after.get(file));
  const worldChanged = [...new Set([...worldBefore.keys()])].filter((file) => worldBefore.get(file) !== after.get(path.join('world', file)));
  assert.deepEqual(changed.sort(), ['world/seal.json', 'world/system/block0.main.txt']);
  assert.deepEqual(worldChanged.sort(), ['seal.json', 'system/block0.main.txt']);
  const stubsAfter = (await readdir(path.join(cassette, 'requests'))).map((file) => after.get(path.relative(root, path.join(cassette, 'requests', file))));
  assert.deepEqual(stubsAfter, stubsBefore);

  const drifted = await loadCassette(cassette, { worldDir });
  assert.deepEqual(drifted.report.worldDrift.map((item) => item.leaves), [['sys.block0.main']]);
  assert.equal((await loadWorld(worldDir)).leafBytes('sys.block0.main').toString('utf8'), nextBlock0);
});

test('迁移成功后不残留 staging 或备份目录', async (t) => {
  const { root } = await fixture(t);
  await migrateReplayLiterals({ fixtures: root });
  assert.deepEqual((await readdir(root)).filter((name) => name.startsWith('.migrate-refs-')), []);
});

test('迁移拒绝不含 world ref 的 literal stub，且不改写 fixture', async (t) => {
  const rawOnlyMessages = Buffer.from(JSON.stringify({
    model: 'fixture-model', max_tokens: 32000, stream: true,
    messages: [{ role: 'user', content: 'no world material' }],
  }));
  const { root } = await fixture(t, { bodyBytes: rawOnlyMessages });
  const before = await hashes(root);
  await assert.rejects(migrateReplayLiterals({ fixtures: root }), /不含任何 world ref/u);
  assert.deepEqual(await hashes(root), before);
});

test('迁移拒绝非预期形状的新增 leaf', async (t) => {
  const parsed = JSON.parse(body().toString('utf8'));
  parsed.system.push({ type: 'text', text: 'UNMATCHED SYSTEM BLOCK' });
  const { root, worldDir } = await fixture(t, { bodyBytes: Buffer.from(JSON.stringify(parsed)) });
  const before = await hashes(worldDir);
  await assert.rejects(migrateReplayLiterals({ fixtures: root }), /非预期形状/u);
  assert.deepEqual(await hashes(worldDir), before);
});

test('swap 与回滚双失败时保留旧 world 并在错误中给出准确路径', async (t) => {
  const { root, worldDir } = await fixture(t);
  const worldBefore = await hashes(worldDir);
  const failingRename = async (from, to) => {
    const source = String(from);
    const backup = source.includes('.migrate-refs-backup-');
    if (!backup && String(to) === worldDir && /\.migrate-refs-[^/]+\/world$/u.test(source)) {
      throw new Error('injected swap failure');
    }
    if (backup && source.endsWith('/world') && String(to) === worldDir) {
      throw new Error('injected rollback failure');
    }
    return rename(from, to);
  };

  let failure;
  await assert.rejects(migrateReplayLiterals({ fixtures: root, ops: { rename: failingRename } }), (error) => {
    failure = error;
    return true;
  });
  assert.ok(failure instanceof AggregateError);
  assert.match(failure.message, /已保留/u);
  const keptWorld = /旧 world: (.+?)（对应备份已保留/u.exec(failure.message)?.[1];
  assert.ok(keptWorld, failure.message);
  assert.match(keptWorld, /\.migrate-refs-backup-[^/]+\/world$/u);
  assert.deepEqual(await hashes(keptWorld), worldBefore);

  const leftovers = (await readdir(root)).filter((name) => name.startsWith('.migrate-refs-'));
  assert.deepEqual(leftovers.map((name) => name.startsWith('.migrate-refs-backup-')), [true]);
});

test('world 回滚成功但 cassette 回滚失败时，错误只报告实际保留的备份路径', async (t) => {
  const { root, worldDir, cassette } = await fixture(t);
  const worldBefore = await hashes(worldDir);
  const cassetteBefore = await hashes(cassette);
  const target = path.join(root, 'X01/cassette');
  const failingRename = async (from, to) => {
    const source = String(from);
    const backup = source.includes('.migrate-refs-backup-');
    if (!backup && String(to) === target && /\.migrate-refs-[^/]+\/cassettes\/X01\/cassette$/u.test(source)) {
      throw new Error('injected cassette swap failure');
    }
    if (backup && String(to) === target && source.endsWith('/X01/cassette')) {
      throw new Error('injected cassette rollback failure');
    }
    return rename(from, to);
  };

  let failure;
  await assert.rejects(migrateReplayLiterals({ fixtures: root, ops: { rename: failingRename } }), (error) => {
    failure = error;
    return true;
  });
  assert.ok(failure instanceof AggregateError);
  assert.deepEqual(await hashes(worldDir), worldBefore);
  assert.ok(failure.message.includes(`旧 world 已回滚到 ${worldDir}；`), failure.message);
  const keptCassette = /cassette 备份: (.+?)（/u.exec(failure.message)?.[1];
  assert.ok(keptCassette, failure.message);
  assert.deepEqual(await hashes(keptCassette), cassetteBefore);
});
