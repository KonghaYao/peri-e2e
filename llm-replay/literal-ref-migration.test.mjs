import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
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
async function fixture(t) {
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
  const raw = body();
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
