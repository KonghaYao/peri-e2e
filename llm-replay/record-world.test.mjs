import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startReplayProxy, contextHeaders } from './proxy.mjs';
import { loadCassette } from './cassette.mjs';
import { createWorldBuilder, loadWorld } from './world-store.mjs';
import { createSlotResolver } from './world-slots.mjs';

const logical = 'http://fixture.invalid';
const endpoint = `${logical}/v1/messages`;
const identity = { owner: 'root', execution: 'turn-1', call: 'reason:1', attempt: 1, purpose: 'reason' };
const BLOCK0 = 'BLOCK0: strict instructions';
const SKILLS = '# Skills\n\nSkill body.';
const PREFIX = 'MAIN PREFIX.\n';
const TAIL = '\n\n<env>\nWorking directory: /tmp/work\n</env>';
const TOOLS = '[{"name":"Bash","input_schema":{"type":"object"}}]';
const body = {
  model: 'fixture-model', max_tokens: 32000, stream: true,
  system: [{ type: 'text', text: BLOCK0 }, { type: 'text', text: `${PREFIX}${SKILLS}${TAIL}` }],
  messages: [{ role: 'user', content: 'same question' }],
  tools: JSON.parse(TOOLS),
};

function worldFixture() {
  const builder = createWorldBuilder({ generation: 'record-world' });
  builder.addLeaf('sys.block0.main', BLOCK0);
  builder.addLeaf('sys.skills', SKILLS);
  builder.addLeaf('sys.block1.main.prefix', PREFIX);
  builder.addLeaf('sys.block1.main.t01.tail', TAIL);
  builder.addRecipe('sys.block1.main.t01', [
    { leaf: 'sys.block1.main.prefix' }, { leaf: 'sys.skills' }, { leaf: 'sys.block1.main.t01.tail' },
  ]);
  builder.addRecipe('tools.anthropic.main', [TOOLS]);
  return builder;
}

async function listen(t, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const close = async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  };
  t.after(close);
  return { url: `http://127.0.0.1:${server.address().port}`, close };
}

function sse(text) {
  return `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n`;
}

function post(proxy, run, value = body) {
  return fetch(`${proxy.url}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...contextHeaders({ run, ...identity }, endpoint) },
    body: JSON.stringify(value),
  });
}

test('record 传入 world+slots 时写出 ref stub；同一 cassette 可离线 replay', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'peri-record-world-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cassetteDir = path.join(directory, 'case', 'cassette');
  const worldDir = path.join(directory, 'world');
  const builder = worldFixture();
  const { slots } = createSlotResolver({ world: builder, builder });
  const upstream = await listen(t, async (request, response) => {
    for await (const _ of request) { /* 消费请求 */ }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(sse('recorded-world-answer'));
  });
  const recorder = await startReplayProxy({
    mode: 'record', cassetteDir, world: builder, slots,
    upstreams: [{ logicalOrigin: logical, transportOrigin: upstream.url }],
  });
  t.after(() => recorder.close());
  recorder.createRun('record');
  const recorded = await post(recorder, 'record');
  assert.match(await recorded.text(), /recorded-world-answer/u);
  await recorder.waitFor('record', (state) => state.calls.length === 1 && state.active === 0);
  recorder.completeRun('record');
  await recorder.seal();
  await recorder.close();
  await upstream.close();
  await builder.seal(worldDir);

  const stubFiles = (await readdir(path.join(cassetteDir, 'requests'))).filter((file) => file.endsWith('.stub.json'));
  assert.equal(stubFiles.length, 1);
  const stub = JSON.parse(await readFile(path.join(cassetteDir, 'requests', stubFiles[0]), 'utf8'));
  assert.ok(stub.parts.some((part) => part && typeof part === 'object' && part.leaf === 'sys.block0.main'));
  assert.ok(stub.parts.some((part) => part && typeof part === 'object' && part.recipe?.startsWith('sys.block1.main.t')));
  assert.ok(stub.parts.some((part) => part && typeof part === 'object' && part.recipe === 'tools.anthropic.main'));
  assert.equal(stub.parts.every((part) => typeof part === 'string'), false);

  const world = await loadWorld(worldDir);
  const cassette = await loadCassette(cassetteDir, { worldDir });
  assert.equal(cassette.report.legacy.length, 0);
  assert.equal(cassette.report.worldDrift.length, 0);
  const [entry] = cassette.entries.values();
  assert.ok(JSON.parse(entry.request.canonicalBody).system[1].text.includes('Skill body.'));

  const replay = await startReplayProxy({ mode: 'replay', cassetteDir, worldDir });
  t.after(() => replay.close());
  replay.createRun('replay');
  const replayed = await post(replay, 'replay');
  assert.equal(replayed.status, 200);
  assert.match(await replayed.text(), /recorded-world-answer/u);
  await replay.waitFor('replay', (state) => state.calls.length === 1 && state.active === 0);
  assert.equal((await replay.completeRun('replay')).upstreamCalls, 0);
});
