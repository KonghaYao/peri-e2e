#!/usr/bin/env node
/**
 * 一次性迁移：把 U04 fresh 的 block1 tail 拆成「固定前段 / 客户端提示词正文 / 固定后段」。
 *
 * 正文 leaf 只保存录制快照，recipe 通过 source 锚定 peri-tui/prompts/tui.md；
 * 回放期望侧从当前 checkout 读取同一路径。迁移必须先证明 raw、canonical 与响应
 * 三类字节前后一致，再原子替换 world 并重写引用该 tail 的 cassette worldRefs。
 */
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const here = path.dirname(fileURLToPath(import.meta.url));
const e2eRoot = path.resolve(here, '..');
const load = (relative) => import(pathToFileURL(path.join(e2eRoot, relative)));
const { sha256 } = await load('llm-replay/matcher.mjs');
const {
  canonicalRecordedBody, collectWorldRefs, createWorldBuilder, decodeRequestStub,
  expandTypedTemplateRules, loadWorld, requestCoreSha256,
} = await load('llm-replay/world-store.mjs');
const { promptSourcePart, splitPromptSourceTail } = await load('llm-replay/world-slots.mjs');
const { loadPromptSource } = await load('llm-replay/prompt-sources.mjs');
const { loadCassette } = await load('llm-replay/cassette.mjs');
const { replaceWorldDirectory } = await load('scripts/world-sync-swap.mjs');
const { assertPeriRoot, resolvePeriRoot } = await load('scripts/peri-root.mjs');

const fail = (message) => { throw new Error(message); };
const text = (bytes) => bytes.toString('utf8');
const shaOfFile = async (file) => sha256(await readFile(file));

const { values } = parseArgs({
  options: {
    fixtures: { type: 'string' },
    recipe: { type: 'string', default: 'sys.block1.main.t171' },
    source: { type: 'string', default: 'tuiSessionInstructions' },
    field: { type: 'string', default: '/system/1/text' },
    session: { type: 'string', default: 'interactive-fresh' },
    'peri-root': { type: 'string' },
    apply: { type: 'boolean', default: false },
  },
});
const fixturesRoot = path.resolve(values.fixtures ?? path.join(e2eRoot, 'fixtures/replay-v2'));
const worldDir = path.join(fixturesRoot, 'world');
const periRoot = await assertPeriRoot(resolvePeriRoot(values['peri-root']));
const recipeId = values.recipe;
const sourceId = values.source;

const oldWorld = await loadWorld(worldDir);
const oldParts = oldWorld.recipeParts(recipeId);
if (!oldParts) fail(`world 缺少 recipe ${recipeId}`);
if (oldParts.some((part) => part && part.source)) {
  console.log(JSON.stringify({ recipe: recipeId, alreadyMigrated: true }, null, 2));
  process.exit(0);
}
const tailRef = oldParts.at(-1);
if (!tailRef || typeof tailRef.leaf !== 'string') fail(`${recipeId} 的最后一个 part 不是 tail leaf`);
const oldTailLeaf = tailRef.leaf;
const oldTailBytes = oldWorld.leafBytes(oldTailLeaf);
if (!oldTailBytes) fail(`world 缺少 tail leaf ${oldTailLeaf}`);
const oldRendered = oldWorld.renderParts([{ recipe: recipeId }]);

const source = await loadPromptSource(sourceId, periRoot, { scenario: path.basename(fixturesRoot), recipe: recipeId });
const split = splitPromptSourceTail(text(oldTailBytes), {
  sourceId, body: source.bytes, field: values.field, session: values.session,
});
if (!split.head.endsWith('<agent_instructions>\n')) fail('固定前段必须以 <agent_instructions> 结束');
if (!split.suffix.startsWith('\n</agent_instructions>')) fail('固定后段必须以 </agent_instructions> 开始');
if (!Buffer.from(split.body, 'utf8').equals(source.bytes)) {
  fail(`录制 tail 中的正文与 ${source.path} 的当前字节不一致；迁移必须使用录制版本源码`);
}

const base = recipeId;
const headId = `${base}.head`;
const promptId = `${base}.prompt`;
const suffixId = `${base}.suffix`;
const builder = createWorldBuilder();
for (const id of oldWorld.leafIds()) {
  if (id !== oldTailLeaf) builder.addLeaf(id, oldWorld.leafBytes(id));
}
for (const id of oldWorld.recipeIds()) {
  if (id !== recipeId) builder.addRecipe(id, oldWorld.recipeParts(id));
}
builder.addLeaf(headId, Buffer.from(split.head, 'utf8'));
builder.addLeaf(promptId, source.bytes);
builder.addLeaf(suffixId, Buffer.from(split.suffix, 'utf8'));
builder.addRecipe(recipeId, [
  ...oldParts.slice(0, -1),
  { leaf: headId },
  promptSourcePart(promptId, { sourceId, field: values.field, session: values.session }),
  { leaf: suffixId },
]);
const rebuilt = builder.renderParts([{ recipe: recipeId }]);
if (!rebuilt.equals(oldRendered)) fail('拆分后 recipe 重建字节与迁移前不一致');

/** 读取所有引用旧 tail 的 cassette，并在新 world 上重算 raw/canonical/worldRefs。 */
async function inspectCassettes(world) {
  const cassettes = [];
  const directories = (await readdir(fixturesRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'world')
    .map((entry) => entry.name).sort();
  for (const id of directories) {
    const directory = path.join(fixturesRoot, id, 'cassette');
    let manifestBytes;
    try { manifestBytes = await readFile(path.join(directory, 'manifest.json')); }
    catch { continue; }
    const manifest = JSON.parse(text(manifestBytes));
    const sealBytes = await readFile(path.join(directory, 'seal.json'));
    const seal = JSON.parse(text(sealBytes));
    if (seal.manifestSha256 !== sha256(manifestBytes)) fail(`${id}: cassette manifest 校验失败`);
    const updatedMeta = {};
    const entries = [];
    for (const entry of manifest.entries) {
      const stubFile = entry.request.stub;
      const stubBytes = await readFile(path.join(directory, stubFile));
      if (seal.files?.[stubFile] !== sha256(stubBytes)) fail(`${id}/${stubFile}: stub 未纳入 seal`);
      const stub = JSON.parse(text(stubBytes));
      const meta = seal.requestMeta?.[stubFile];
      if (!meta || requestCoreSha256(stub) !== meta.requestCoreSha256) fail(`${id}/${stubFile}: request core 校验失败`);
      const oldRefs = collectWorldRefs(stub.parts, oldWorld);
      if (!oldRefs.some((ref) => ref.id === oldTailLeaf)) continue;
      const decoded = await decodeRequestStub(stub, { world, worldRefs: meta.worldRefs });
      if (decoded.legacy || decoded.drifted) fail(`${id}/${stubFile}: 迁移后无法按录制字节重建`);
      if (sha256(decoded.bytes) !== stub.rawSha256) fail(`${id}/${stubFile}: raw 摘要变化`);
      const expanded = expandTypedTemplateRules(entry.requestRules ?? [], decoded.bytes);
      const canonical = canonicalRecordedBody(decoded.bytes, expanded.rules, expanded.bindings);
      if (sha256(canonical) !== stub.canonicalSha256) fail(`${id}/${stubFile}: canonical 摘要变化`);
      const responseFile = entry.response.file;
      const responseBytes = await readFile(path.join(directory, responseFile));
      if (sha256(responseBytes) !== entry.response.sha256) {
        fail(`${id}/${stubFile}: response 摘要变化`);
      }
      const newRefs = collectWorldRefs(stub.parts, world);
      updatedMeta[stubFile] = { ...meta, worldRefs: newRefs };
      entries.push({
        cassette: id, stub: stubFile, identity: entry.identity,
        rawSha256: stub.rawSha256, canonicalSha256: stub.canonicalSha256, responseSha256: entry.response.sha256,
        worldRefsBefore: oldRefs.map((ref) => ref.id),
        worldRefsAfter: newRefs.map((ref) => ref.id),
      });
    }
    if (entries.length) cassettes.push({ id, directory, seal, entries, updatedMeta });
  }
  return cassettes;
}

const work = await mkdtemp(path.join(os.tmpdir(), 'peri-prompt-source-migration-'));
try {
  const stagedWorld = path.join(work, 'world-new');
  await builder.seal(stagedWorld);
  const sealedWorld = await loadWorld(stagedWorld);
  if (!sealedWorld.renderParts([{ recipe: recipeId }]).equals(oldRendered)) fail('seal 后 recipe 重建不一致');
  const cassettes = await inspectCassettes(sealedWorld);
  if (!cassettes.length) fail('没有 cassette 引用待迁移的 tail，拒绝生成无人引用的拆分');

  // 在完整副本上验证迁移后的 seal 与全部 cassette，再决定是否落盘。
  const stagedFixtures = path.join(work, 'fixtures');
  await cp(fixturesRoot, stagedFixtures, { recursive: true });
  await rm(path.join(stagedFixtures, 'world'), { recursive: true, force: true });
  await cp(stagedWorld, path.join(stagedFixtures, 'world'), { recursive: true });
  for (const cassette of cassettes) {
    const sealFile = path.join(stagedFixtures, cassette.id, 'cassette', 'seal.json');
    const seal = JSON.parse(await readFile(sealFile, 'utf8'));
    seal.requestMeta = { ...seal.requestMeta, ...cassette.updatedMeta };
    await writeFile(sealFile, `${JSON.stringify(seal)}\n`);
  }
  for (const id of (await readdir(stagedFixtures, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'world')
    .map((entry) => entry.name).sort()) {
    const directory = path.join(stagedFixtures, id, 'cassette');
    try { await readFile(path.join(directory, 'manifest.json')); } catch { continue; }
    const cassette = await loadCassette(directory, { worldDir: path.join(stagedFixtures, 'world') });
    if (cassette.report.legacy.length || cassette.report.worldDrift.length) {
      fail(`${id}: 迁移后 cassette 出现 legacy 或 world drift`);
    }
  }

  const report = {
    recipe: recipeId,
    source: { id: sourceId, path: source.path, scope: source.scope, field: values.field, session: values.session },
    leaves: { before: oldTailLeaf, head: headId, prompt: promptId, suffix: suffixId },
    bytes: {
      oldTailSha256: sha256(oldTailBytes),
      rebuiltTailSha256: sha256(Buffer.from(split.head + split.body + split.suffix, 'utf8')),
      headBytes: Buffer.byteLength(split.head),
      promptBytes: source.bytes.length,
      suffixBytes: Buffer.byteLength(split.suffix, 'utf8'),
      rawSha256: null,
      canonicalSha256: null,
      responseSha256: null,
    },
    cassettes: cassettes.flatMap((cassette) => cassette.entries),
    applied: false,
  };
  const first = report.cassettes[0];
  if (first) Object.assign(report.bytes, {
    rawSha256: first.rawSha256, canonicalSha256: first.canonicalSha256, responseSha256: first.responseSha256,
  });

  if (values.apply) {
    await replaceWorldDirectory(worldDir, stagedWorld, { validate: (directory) => loadWorld(directory) });
    for (const cassette of cassettes) {
      const sealFile = path.join(fixturesRoot, cassette.id, 'cassette', 'seal.json');
      const seal = JSON.parse(await readFile(sealFile, 'utf8'));
      seal.requestMeta = { ...seal.requestMeta, ...cassette.updatedMeta };
      await writeFile(sealFile, `${JSON.stringify(seal)}\n`);
    }
    report.applied = true;
  }
  console.log(JSON.stringify(report, null, 2));
} finally {
  await rm(work, { recursive: true, force: true });
}
