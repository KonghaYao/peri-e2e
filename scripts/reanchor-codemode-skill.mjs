#!/usr/bin/env node
/**
 * 一次性迁移：把 codemode builtin skill 纳入 replay world 的技能目录快照。
 *
 * Peri 在 BUILTIN_SKILLS 中新增 `codemode` 后，系统提示词会多出两段固定文本：
 * 1. skills catalog 行 `- **mcp__peri__codemode** [builtin]`；
 * 2. `mcp_read_resource` 资源清单中的 `skill://builtin/codemode/SKILL.md`。
 *
 * world 中 314 个 tail / t171.suffix / 2 个 Responses 内容寻址 system leaf 是录制
 * 快照，不属于源码映射，`world:sync` 不会更新它们。本脚本按录制字节做**唯一插入**，
 * 重建 world seal，并按新 world 重渲染每个请求 stub 与 cassette seal；响应字节原样复制。
 *
 * 这是受控迁移，不是日常同步入口。日常 prompt 同步仍走 `e2e:replay:world-sync`。
 */
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const e2eRoot = path.resolve(here, '..');
const fixtures = path.join(e2eRoot, 'fixtures/replay-v2');
const worldDir = path.join(fixtures, 'world');
const load = (relative) => import(pathToFileURL(path.join(e2eRoot, relative)).href);

const { loadCassette } = await load('llm-replay/cassette.mjs');
const { sha256 } = await load('llm-replay/matcher.mjs');
const {
  CASSETTE_FORMAT_VERSION, canonicalRecordedBody, collectWorldRefs, createWorldBuilder,
  expandTypedTemplateRules, loadWorld, requestCoreSha256, serializeRequestStub,
} = await load('llm-replay/world-store.mjs');
const { replaceWorldDirectory } = await load('scripts/world-sync-swap.mjs');

const CATALOG_OLD = '- **mcp__peri__cron** [builtin]\n';
const CATALOG_NEW = '- **mcp__peri__codemode** [builtin]\n' + CATALOG_OLD;
const URI_OLD = 'skill://builtin/ultracode/SKILL.md, skill://builtin/cron/SKILL.md';
const URI_NEW = 'skill://builtin/ultracode/SKILL.md, skill://builtin/codemode/SKILL.md, skill://builtin/cron/SKILL.md';
// raw/canonical HTTP body 里的换行是 JSON 字符串转义后的反斜杠 + n。
const RAW_CATALOG_OLD = '- **mcp__peri__cron** [builtin]\\n';
const RAW_CATALOG_NEW = '- **mcp__peri__codemode** [builtin]\\n' + RAW_CATALOG_OLD;
const INSERTED_BYTES = Buffer.byteLength(CATALOG_NEW) - Buffer.byteLength(CATALOG_OLD)
  + Buffer.byteLength(URI_NEW) - Buffer.byteLength(URI_OLD);
const RESOURCE_COUNT = /\((\d+) resources\)/g;

const assert = (condition, message) => { if (!condition) throw new Error(message); };
const sortedObject = (entries) => Object.fromEntries(entries.sort(([left], [right]) => left.localeCompare(right)));
const text = (bytes) => bytes.toString('utf8');
const countOf = (haystack, needle) => haystack.split(needle).length - 1;

function bumpResourceCount(content, label) {
  const matches = [...content.matchAll(RESOURCE_COUNT)];
  assert(matches.length === 1, `${label}: mcp_read_resource 资源计数应恰好出现一次，实际 ${matches.length} 次`);
  const oldText = matches[0][0];
  const newText = `(${Number(matches[0][1]) + 1} resources)`;
  return { oldText, newText, delta: newText.length - oldText.length };
}

function assertSingleInsertion(label, before, after, count) {
  assert(countOf(after, CATALOG_NEW) === 1, `${label}: 新 catalog 行应恰好出现一次，实际 ${countOf(after, CATALOG_NEW)} 次`);
  assert(countOf(after, URI_NEW) === 1, `${label}: 新 resource URI 应恰好出现一次，实际 ${countOf(after, URI_NEW)} 次`);
  let restored = after.split(CATALOG_NEW).join(CATALOG_OLD).split(URI_NEW).join(URI_OLD);
  restored = restored.split(count.newText).join(count.oldText);
  assert(restored === before, `${label}: 与录制字节的差异不止 codemode 三处替换`);
  const expected = INSERTED_BYTES + count.delta;
  assert(Buffer.byteLength(after) - Buffer.byteLength(before) === expected,
    `${label}: 字节差应为 ${expected}，实际 ${Buffer.byteLength(after) - Buffer.byteLength(before)}`);
}

function assertSingleRawInsertion(label, before, after, count) {
  assert(countOf(after, RAW_CATALOG_NEW) === 1, `${label}: 新 catalog 行应恰好出现一次，实际 ${countOf(after, RAW_CATALOG_NEW)} 次`);
  assert(countOf(after, URI_NEW) === 1, `${label}: 新 resource URI 应恰好出现一次，实际 ${countOf(after, URI_NEW)} 次`);
  let restored = after.split(RAW_CATALOG_NEW).join(RAW_CATALOG_OLD).split(URI_NEW).join(URI_OLD);
  restored = restored.split(count.newText).join(count.oldText);
  assert(restored === before, `${label}: 与录制字节的差异不止 codemode 三处替换`);
  const expected = INSERTED_BYTES + count.delta + 1;
  assert(after.length - before.length === expected,
    `${label}: 字节差应为 ${expected}，实际 ${after.length - before.length}`);
}

const manifestBytes = await readFile(path.join(worldDir, 'manifest.json'));
const manifest = JSON.parse(text(manifestBytes));
const previousSeal = JSON.parse(await readFile(path.join(worldDir, 'seal.json'), 'utf8'));
assert(manifest.formatVersion === 2 && manifest.kind === 'world', 'world manifest 不是 v2');
assert(previousSeal.manifestSha256 === sha256(manifestBytes), 'world manifest 与旧 seal 不一致');
assert(previousSeal.formatVersion === 2, 'world seal 不是 v2');

const leafBytes = new Map();
for (const [id, meta] of Object.entries(manifest.leaves)) {
  const file = path.resolve(worldDir, meta.file);
  assert(file.startsWith(`${worldDir}${path.sep}`), `${id}: leaf 路径越出 world 根目录`);
  const bytes = await readFile(file);
  assert(previousSeal.leaves[id] !== undefined, `${id}: 旧 seal 未覆盖该 leaf`);
  assert(sha256(bytes) === previousSeal.leaves[id], `${id}: leaf 与旧 seal 哈希不符`);
  leafBytes.set(id, bytes);
}

// 1) 只允许一次性插入 codemode 的两段文本；其余 leaf 原样保留。
const overrides = new Map();
const removedLeaves = new Set();
const addedLeaves = new Map();
const oldShaToNew = new Map();
const changedLeafIds = new Set();
const countByLeaf = new Map();

for (const [id, bytes] of leafBytes) {
  const content = text(bytes);
  if (!content.includes(CATALOG_OLD)) {
    assert(!content.includes('mcp__peri__codemode'), `${id}: 已包含 codemode，拒绝重复迁移`);
    continue;
  }
  assert(countOf(content, CATALOG_OLD) === 1, `${id}: 旧 catalog 行应恰好出现一次`);
  assert(countOf(content, URI_OLD) === 1, `${id}: 旧 resource URI 应恰好出现一次`);
  const count = bumpResourceCount(content, id);
  const next = content.replace(CATALOG_OLD, CATALOG_NEW).replace(URI_OLD, URI_NEW).replace(count.oldText, count.newText);
  assertSingleInsertion(id, content, next, count);
  const nextBytes = Buffer.from(next, 'utf8');
  changedLeafIds.add(id);
  countByLeaf.set(id, count);
  if (id.startsWith('sys.sha256.')) {
    const nextId = `sys.sha256.${sha256(nextBytes)}`;
    assert(nextId !== id, `${id}: 内容寻址 id 不应保持不变`);
    assert(!leafBytes.has(nextId), `world 已存在 ${nextId}`);
    oldShaToNew.set(id, nextId);
    removedLeaves.add(id);
    addedLeaves.set(nextId, nextBytes);
  } else {
    overrides.set(id, nextBytes);
  }
}

assert(oldShaToNew.size === 2, `应有 2 个 Responses 内容寻址 system leaf 需要迁移，实际 ${oldShaToNew.size}`);
assert(changedLeafIds.size === 317, `应迁移 317 个 leaf，实际 ${changedLeafIds.size}`);
assert([...oldShaToNew.keys()].every((id) => changedLeafIds.has(id)), '旧 sha leaf 必须纳入变更集合');

// 2) 构造旧/新 world；旧 world 必须能逐字节重渲染录制请求。
const build = (leafOverrides, removed, added, generation) => {
  const builder = createWorldBuilder(generation ? { generation } : {});
  for (const [id, bytes] of leafBytes) {
    if (removed.has(id)) continue;
    builder.addLeaf(id, leafOverrides.get(id) ?? bytes);
  }
  for (const [id, bytes] of added) builder.addLeaf(id, bytes);
  for (const [id, parts] of Object.entries(manifest.recipes)) builder.addRecipe(id, parts);
  return builder;
};
const previousWorld = build(new Map(), new Set(), new Map(), manifest.generation);
const newWorld = build(overrides, removedLeaves, addedLeaves);

const rewritePart = (part) => (part && typeof part === 'object' && oldShaToNew.has(part.leaf)
  ? { ...part, leaf: oldShaToNew.get(part.leaf) }
  : part);

// 3) 逐条 cassette 重渲染；响应与 manifest 原样复制。
const cassetteIds = [];
for (const entry of await readdir(fixtures, { withFileTypes: true })) {
  if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'world') continue;
  try {
    await readFile(path.join(fixtures, entry.name, 'cassette', 'manifest.json'));
    cassetteIds.push(entry.name);
  } catch { /* 非 cassette 目录 */ }
}
cassetteIds.sort();
assert(cassetteIds.length === 62, `cassette 数量应为 62，实际 ${cassetteIds.length}`);

const stagingBase = await mkdtemp(path.join(fixtures, '.reanchor-codemode-'));
const stagedWorldDir = path.join(stagingBase, 'world');
const stagedById = new Map();
const expectedCanonical = new Map();
let stubCount = 0;
let updatedStubs = 0;
let unchangedStubs = 0;
let responseCount = 0;

try {
  for (const id of cassetteIds) {
    const directory = path.join(fixtures, id, 'cassette');
    const cassetteManifestBytes = await readFile(path.join(directory, 'manifest.json'));
    const cassetteManifest = JSON.parse(text(cassetteManifestBytes));
    const seal = JSON.parse(await readFile(path.join(directory, 'seal.json'), 'utf8'));
    assert(cassetteManifest.formatVersion === CASSETTE_FORMAT_VERSION, `${id}: cassette 不是 v2`);
    assert(seal.formatVersion === CASSETTE_FORMAT_VERSION && seal.manifestSha256 === sha256(cassetteManifestBytes),
      `${id}: cassette seal 或 manifest 校验失败`);
    assert(seal.requestMeta && seal.files && typeof seal.requestMeta === 'object' && typeof seal.files === 'object',
      `${id}: seal 缺少元数据`);

    const stubFiles = cassetteManifest.entries.map((entry) => entry.request.stub);
    const metaFiles = Object.keys(seal.requestMeta);
    assert(new Set(stubFiles).size === stubFiles.length, `${id}: manifest 中 stub 路径重复`);
    assert(metaFiles.length === stubFiles.length && stubFiles.every((file) => Object.hasOwn(seal.requestMeta, file)),
      `${id}: seal.requestMeta 未精确覆盖 manifest 的全部 stub`);

    const output = path.join(stagingBase, 'cassettes', id, 'cassette');
    await mkdir(path.join(output, 'requests'), { recursive: true, mode: 0o700 });
    await mkdir(path.join(output, 'responses'), { recursive: true, mode: 0o700 });
    const sealedFiles = {};
    const requestMeta = {};

    for (const entry of cassetteManifest.entries) {
      const stubFile = entry.request.stub;
      const stubBytes = await readFile(path.join(directory, stubFile));
      assert(seal.files[stubFile] === sha256(stubBytes), `${id}/${stubFile}: stub 未纳入 seal 或哈希不符`);
      const stub = JSON.parse(text(stubBytes));
      assert(stub.v === 2 && Array.isArray(stub.parts), `${id}/${stubFile}: stub 不是 v2`);

      const beforeBytes = previousWorld.renderParts(stub.parts);
      assert(sha256(beforeBytes) === stub.rawSha256, `${id}/${stubFile}: 逆推旧 world 渲染与录制 rawSha256 不符`);
      const beforeExpanded = expandTypedTemplateRules(entry.requestRules ?? [], beforeBytes);
      const beforeCanonical = canonicalRecordedBody(beforeBytes, beforeExpanded.rules, beforeExpanded.bindings);
      assert(sha256(beforeCanonical) === stub.canonicalSha256, `${id}/${stubFile}: 逆推旧 canonicalSha256 不符`);

      const refs = collectWorldRefs(stub.parts, previousWorld);
      const nextParts = stub.parts.map(rewritePart);
      const affectedRefs = refs.filter((ref) => changedLeafIds.has(ref.id));
      assert(affectedRefs.length <= 1, `${id}/${stubFile}: 一个请求引用了多个变更 leaf`);
      const affected = affectedRefs.length === 1;
      const afterBytes = newWorld.renderParts(nextParts);
      const afterExpanded = expandTypedTemplateRules(entry.requestRules ?? [], afterBytes);
      const afterCanonical = canonicalRecordedBody(afterBytes, afterExpanded.rules, afterExpanded.bindings);

      if (affected) {
        const count = countByLeaf.get(affectedRefs[0].id);
        assert(count, `${id}/${stubFile}: 变更 leaf 缺少资源计数`);
        assertSingleRawInsertion(`${id}/${stubFile} raw`, text(beforeBytes), text(afterBytes), count);
        assertSingleRawInsertion(`${id}/${stubFile} canonical`, beforeCanonical, afterCanonical, count);
        updatedStubs += 1;
      } else {
        assert(nextParts.every((part, index) => part === stub.parts[index]), `${id}/${stubFile}: 未引用目标 leaf 却改写了 part`);
        assert(afterBytes.equals(beforeBytes), `${id}/${stubFile}: 未引用目标 leaf 却渲染出不同字节`);
        assert(afterCanonical === beforeCanonical, `${id}/${stubFile}: 未引用目标 leaf 却 canonical 不同`);
        unchangedStubs += 1;
      }

      const nextStub = {
        ...stub,
        parts: nextParts,
        rawBytes: afterBytes.length,
        rawSha256: sha256(afterBytes),
        canonicalSha256: sha256(afterCanonical),
      };
      const nextStubBytes = serializeRequestStub(nextStub);
      await writeFile(path.join(output, stubFile), nextStubBytes, { mode: 0o600 });
      sealedFiles[stubFile] = sha256(nextStubBytes);
      requestMeta[stubFile] = {
        requestCoreSha256: requestCoreSha256(nextStub),
        worldRefs: collectWorldRefs(nextStub.parts, newWorld),
      };
      expectedCanonical.set(`${id}/${stubFile}`, afterCanonical);

      const responseBytes = await readFile(path.join(directory, entry.response.file));
      assert(responseBytes.length === entry.response.size && sha256(responseBytes) === entry.response.sha256,
        `${id}/${entry.response.file}: 响应字节与 manifest 不符`);
      await writeFile(path.join(output, entry.response.file), responseBytes, { mode: 0o600 });
      responseCount += 1;
      stubCount += 1;
    }

    await writeFile(path.join(output, 'manifest.json'), cassetteManifestBytes, { mode: 0o600 });
    const nextSeal = {
      formatVersion: CASSETTE_FORMAT_VERSION,
      manifestSha256: sha256(cassetteManifestBytes),
      files: sortedObject(Object.entries(sealedFiles)),
      requestMeta: sortedObject(Object.entries(requestMeta)),
    };
    await writeFile(path.join(output, 'seal.json'), `${JSON.stringify(nextSeal)}\n`, { mode: 0o600 });
    stagedById.set(id, output);
  }

  // 4) 先封存并校验 staging，再原子替换；失败时 fixture 不会被部分改写。
  const sealedWorld = await newWorld.seal(stagedWorldDir);
  const stagedWorld = await loadWorld(stagedWorldDir);
  assert(stagedWorld.leaves.length === leafBytes.size,
    `world leaf 数量应保持不变，实际 ${stagedWorld.leaves.length}，期望 ${leafBytes.size}`);
  for (const [id, output] of stagedById) {
    const staged = await loadCassette(output, { worldDir: stagedWorldDir });
    assert(staged.report.legacy.length === 0, `${id}: staging 出现 legacy body`);
    assert(staged.report.worldDrift.length === 0, `${id}: staging 出现 world drift`);
    for (const entry of staged.entries.values()) {
      assert(entry.request.canonicalBody === expectedCanonical.get(`${id}/${entry.request.stub}`),
        `${id}/${entry.request.stub}: staging canonical body 与重算值不一致`);
    }
  }

  const swap = await replaceWorldDirectory(worldDir, stagedWorldDir, { validate: (dir) => loadWorld(dir) });
  if (!swap.removed) console.error(`world 已替换，但旧目录清理失败：${swap.previous}`);

  const backups = [];
  try {
    for (const [id, output] of stagedById) {
      const target = path.join(fixtures, id, 'cassette');
      const backup = path.join(stagingBase, 'backup', id, 'cassette');
      await mkdir(path.dirname(backup), { recursive: true });
      await rename(target, backup);
      await rename(output, target);
      backups.push({ target, backup });
    }
  } catch (error) {
    for (const { target, backup } of backups.reverse()) {
      await rm(target, { recursive: true, force: true });
      await rename(backup, target).catch(() => {});
    }
    throw error;
  }

  for (const id of cassetteIds) {
    const loaded = await loadCassette(path.join(fixtures, id, 'cassette'));
    assert(loaded.report.legacy.length === 0 && loaded.report.worldDrift.length === 0,
      `${id}: 最终 cassette 出现 legacy/world drift`);
  }

  console.log(JSON.stringify({
    command: 'reanchor-codemode-skill',
    oneTimeMigration: 'builtin skill catalog gains mcp__peri__codemode',
    world: {
      generation: sealedWorld.generation,
      leaves: stagedWorld.leaves.length,
      recipes: stagedWorld.recipes.length,
      changedLeaves: [...changedLeafIds].length,
      removedLeaves: [...removedLeaves],
      addedLeaves: [...addedLeaves.keys()],
    },
    cassettes: cassetteIds.length,
    stubs: stubCount,
    updatedStubs,
    unchangedStubs,
    responsesUnchanged: responseCount,
  }, null, 2));
} finally {
  if (!process.env.PERI_KEEP_REANCHOR) await rm(stagingBase, { recursive: true, force: true });
}
