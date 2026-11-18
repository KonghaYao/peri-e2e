import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorldBuilder, encodeRequestStub } from './world-store.mjs';
import { createSlotResolver } from './world-slots.mjs';
import { sha256 } from './matcher.mjs';

const BLOCK0 = 'BLOCK0: strict instructions';
const SKILLS = '# Skills\n\nSkill body.';
const PREFIX = 'MAIN PREFIX: available workspace tools.\n';
const TAIL = '\n\n<env>\nWorking directory: /tmp/work\n</env>';
const TOOLS = '[{"name":"Bash","input_schema":{"type":"object"}}]';

function fixture() {
  const builder = createWorldBuilder({ generation: 'slots' });
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

function body({ block1 = `${PREFIX}${SKILLS}${TAIL}`, tools = TOOLS, extra = [] } = {}) {
  return Buffer.from(JSON.stringify({
    model: 'fixture-model', max_tokens: 32000, stream: true,
    system: [{ type: 'text', text: BLOCK0 }, { type: 'text', text: block1 }, ...extra],
    messages: [{ role: 'user', content: 'same question' }],
    tools: JSON.parse(tools),
  }));
}

test('slots 把 block0/block1/tools 映射到稳定 leaf 与 recipe，并逐字节重建', () => {
  const builder = fixture();
  const { slots, stats } = createSlotResolver({ world: builder, builder });
  const raw = body();
  const stub = encodeRequestStub(raw, { world: builder, slots });
  assert.equal(stub.legacy, undefined);
  assert.ok(builder.renderParts(stub.parts).equals(raw));
  const refs = stub.parts.filter((part) => part && typeof part === 'object');
  assert.deepEqual(refs, [
    { leaf: 'sys.block0.main', as: 'json-string' },
    { recipe: 'sys.block1.main.t01', as: 'json-string' },
    { recipe: 'tools.anthropic.main', as: 'raw' },
  ]);
  assert.equal(stats.addedLeaves.length, 0);
  assert.equal(stats.addedRecipes.length, 0);
  assert.ok(stats.reusedRecipes.has('sys.block1.main.t01'));
  assert.ok(stats.reusedRecipes.has('tools.anthropic.main'));
});

test('compact summary 复用 sys.compact.summary 稳定 leaf', () => {
  const compact = 'CRITICAL: You are a conversation compression tool.';
  const builder = fixture();
  builder.addLeaf('sys.compact.summary', compact);
  const { slots, stats } = createSlotResolver({ world: builder, builder });
  const raw = Buffer.from(JSON.stringify({
    model: 'fixture-model', max_tokens: 32000,
    system: [{ type: 'text', text: compact }],
    messages: [{ role: 'user', content: 'compact this' }],
  }));
  const stub = encodeRequestStub(raw, { world: builder, slots });
  assert.ok(builder.renderParts(stub.parts).equals(raw));
  assert.ok(stub.parts.some((part) => part?.leaf === 'sys.compact.summary'));
  assert.equal(stats.addedLeaves.length, 0, 'compact prompt 不得写成内容寻址 leaf');
});

test('compact user prompt 复用 sys.compact.user 稳定 leaf', () => {
  const compactUser = 'COMPACT USER: keep the small contract core.';
  const builder = fixture();
  builder.addLeaf('sys.compact.user', compactUser);
  const { slots, stats } = createSlotResolver({ world: builder, builder });
  const raw = Buffer.from(JSON.stringify({
    model: 'fixture-model', max_tokens: 32000,
    system: [{ type: 'text', text: BLOCK0 }],
    messages: [{ role: 'user', content: [{ type: 'text', text: compactUser }] }],
  }));
  const stub = encodeRequestStub(raw, { world: builder, slots });
  assert.ok(builder.renderParts(stub.parts).equals(raw));
  assert.ok(stub.parts.some((part) => part?.leaf === 'sys.compact.user'));
  assert.equal(stats.addedLeaves.length, 0, 'compact user prompt 不得写成内容寻址 leaf');
});

test('新 tail 分配确定性 recipe；相同内容再次出现时复用', () => {
  const builder = fixture();
  const { slots, stats } = createSlotResolver({ world: builder, builder });
  const newTail = '\n\n<env>\nSession ID: new-session\n</env>';
  const first = encodeRequestStub(body({ block1: `${PREFIX}${SKILLS}${newTail}` }), { world: builder, slots });
  assert.ok(builder.hasLeaf('sys.block1.main.t02.tail'));
  assert.ok(builder.recipeParts('sys.block1.main.t02'));
  assert.ok(builder.renderParts(first.parts).equals(body({ block1: `${PREFIX}${SKILLS}${newTail}` })));
  const added = stats.addedLeaves.length;

  const second = encodeRequestStub(body({ block1: `${PREFIX}${SKILLS}${newTail}` }), { world: builder, slots });
  assert.equal(stats.addedLeaves.length, added);
  assert.equal(stats.addedRecipes.filter((id) => id === 'sys.block1.main.t02').length, 1);
  assert.ok(second.parts.some((part) => part?.recipe === 'sys.block1.main.t02'));
});

test('未知 prefix 使用内容寻址 prefix leaf，不与其他 class 合并', () => {
  const builder = fixture();
  const { slots } = createSlotResolver({ world: builder, builder });
  const prefix = 'UNKNOWN PREFIX for a different agent\n';
  const raw = body({ block1: `${prefix}${SKILLS}${TAIL}` });
  const stub = encodeRequestStub(raw, { world: builder, slots });
  assert.ok(builder.renderParts(stub.parts).equals(raw));
  const expected = `sys.block1.main.prefix.${sha256(Buffer.from(prefix, 'utf8')).slice(0, 8)}`;
  assert.ok(builder.hasLeaf(expected), expected);
  assert.ok(stub.parts.some((part) => part?.recipe?.startsWith('sys.block1.main.t')));
});

test('skills 出现多次时不猜测结构，退回内容寻址 leaf', () => {
  const builder = fixture();
  const { slots } = createSlotResolver({ world: builder, builder });
  const raw = body({ block1: `${PREFIX}${SKILLS}${SKILLS}${TAIL}` });
  const stub = encodeRequestStub(raw, { world: builder, slots });
  assert.ok(builder.renderParts(stub.parts).equals(raw));
  const systemPart = stub.parts.find((part) => part && typeof part === 'object' && part.as === 'json-string' && part.leaf?.startsWith('sys.sha256.'));
  assert.ok(systemPart, 'ambiguous block1 must use a content-addressed leaf');
});
