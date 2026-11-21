#!/usr/bin/env node
/**
 * 一次性迁移：把 Peri #517 的 explorer catalog access 从 `[readonly]` 重锚到 `[writes]`。
 *
 * 两个 block1 prefix 已由 world:sync 写入新模板；Responses 场景（S06）把整块 system 文本
 * 存成内容寻址 leaf，不在源码映射内，必须在这里按新内容重算 id。迁移按 stub 重渲染：
 * 更新 rawBytes/rawSha256/canonicalSha256 与 cassette seal 的 requestMeta，响应字节原样复制。
 * 旧 world 由新 prefix 逆向还原（换回 `[readonly]`），用于断言只差这一处 access 标签。
 */
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const e2eRoot = path.resolve(here, '..');
const fixtures = path.join(e2eRoot, 'fixtures/replay-v2');
const worldDir = path.join(fixtures, 'world');
const templatesDir = path.join(e2eRoot, 'llm-replay/world-source-templates');
const load = (relative) => import(pathToFileURL(path.join(e2eRoot, relative)));

const { loadCassette } = await load('llm-replay/cassette.mjs');
const { sha256 } = await load('llm-replay/matcher.mjs');
const {
  CASSETTE_FORMAT_VERSION, canonicalRecordedBody, collectWorldRefs, createWorldBuilder,
  expandTypedTemplateRules, loadWorld, requestCoreSha256, serializeRequestStub,
} = await load('llm-replay/world-store.mjs');
const { replaceWorldDirectory } = await load('scripts/world-sync-swap.mjs');

const MAIN_PREFIX = 'sys.block1.main.prefix';
const REPLAY_WORKER_PREFIX = 'sys.block1.replay-worker.prefix';
const CATALOG_TEMPLATES = Object.freeze({
  [MAIN_PREFIX]: 'block1.main.catalog.txt',
  [REPLAY_WORKER_PREFIX]: 'block1.replay-worker.catalog.txt',
});

const assert = (condition, message) => { if (!condition) throw new Error(message); };
const sortedObject = (entries) => Object.fromEntries(entries.sort(([left], [right]) => left.localeCompare(right)));
const text = (bytes) => bytes.toString('utf8');
const countOf = (haystack, needle) => haystack.split(needle).length - 1;

const assertSingleTagChange = (label, before, after) => {
  const oldLine = `${EXPLORER_PREFIX}[readonly]${EXPLORER_SUFFIX}`;
  const newLine = `${EXPLORER_PREFIX}[writes]${EXPLORER_SUFFIX}`;
  assert(countOf(before, oldLine) === 1, `${label}: 旧文本应恰好包含一次 explorer readonly 行`);
  assert(countOf(before, newLine) === 0, `${label}: 旧文本不应包含 explorer writes 行`);
  assert(after === before.replace(oldLine, newLine), `${label}: 变化不止 explorer access 标签`);
  assert(before.length - after.length === 2, `${label}: 标签变化应恰好少 2 字节`);
};

const EXPLORER_PREFIX = '- explorer [haiku] ';
const EXPLORER_SUFFIX = ' | description (untrusted metadata): Read-only codebase investigation: trace unfamiliar behavior, call paths, and change impact. Return evidence with file locations for decisions and implementation. No shell or edits.';

const manifestBytes = await readFile(path.join(worldDir, 'manifest.json'));
const manifest = JSON.parse(text(manifestBytes));
assert(manifest.formatVersion === 2 && manifest.kind === 'world', 'world manifest 不是 v2');
const previousSeal = JSON.parse(await readFile(path.join(worldDir, 'seal.json'), 'utf8'));
assert(previousSeal.manifestSha256 === sha256(manifestBytes), 'world manifest 与旧 seal 不一致');

const leafBytes = new Map();
for (const [id, meta] of Object.entries(manifest.leaves)) {
  const file = path.resolve(worldDir, meta.file);
  assert(file.startsWith(`${worldDir}${path.sep}`), `${id}: leaf 路径越出 world 根目录`);
  leafBytes.set(id, await readFile(file));
  assert(previousSeal.leaves[id] !== undefined, `${id}: 旧 seal 未覆盖该 leaf`);
}

// 1) 两个映射 prefix 必须已由 world:sync 写入新模板；逆向还原旧值后验证差异只有 access 标签。
const oldPrefixBytes = new Map();
const newPrefixBytes = new Map();
for (const [id, templateName] of Object.entries(CATALOG_TEMPLATES)) {
  const template = await readFile(path.join(templatesDir, templateName), 'utf8');
  const current = text(leafBytes.get(id));
  assert(countOf(current, template) === 1, `${id}: 当前 prefix 必须恰好包含一次 ${templateName}`);
  assert(countOf(current, `${EXPLORER_PREFIX}[writes]${EXPLORER_SUFFIX}`) === 1,
    `${id}: 当前 prefix 的 explorer 必须已是 writes`);
  const old = current.replace(`${EXPLORER_PREFIX}[writes]${EXPLORER_SUFFIX}`, `${EXPLORER_PREFIX}[readonly]${EXPLORER_SUFFIX}`);
  assertSingleTagChange(`${id} (reverse)`, old, current);
  oldPrefixBytes.set(id, Buffer.from(old, 'utf8'));
  newPrefixBytes.set(id, Buffer.from(current, 'utf8'));
}

// 2) 找出被 cassette 引用、且仍带 readonly catalog 的内容寻址 system leaf（S06 Responses）。
const cassetteIds = [];
for (const entry of await readdir(fixtures, { withFileTypes: true })) {
  if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'world') continue;
  try {
    await readFile(path.join(fixtures, entry.name, 'cassette', 'manifest.json'));
    cassetteIds.push(entry.name);
  } catch { /* 非 cassette 目录 */ }
}
cassetteIds.sort();

const referenced = new Set();
for (const id of cassetteIds) {
  const seal = JSON.parse(await readFile(path.join(fixtures, id, 'cassette', 'seal.json'), 'utf8'));
  for (const meta of Object.values(seal.requestMeta)) {
    for (const ref of meta.worldRefs) referenced.add(ref.id);
  }
}
const oldSystemLeaves = [...referenced].filter((id) => id.startsWith('sys.sha256.')
  && text(leafBytes.get(id)).includes(`${EXPLORER_PREFIX}[readonly]${EXPLORER_SUFFIX}`));
assert(oldSystemLeaves.length === 1, `应恰好有一个被引用的 readonly system 快照，实际 ${oldSystemLeaves.join(', ')}`);
const OLD_SYSTEM_LEAF = oldSystemLeaves[0];
const oldSystemContent = text(leafBytes.get(OLD_SYSTEM_LEAF));
const newSystemContent = oldSystemContent.replace(
  `${EXPLORER_PREFIX}[readonly]${EXPLORER_SUFFIX}`,
  `${EXPLORER_PREFIX}[writes]${EXPLORER_SUFFIX}`,
);
assertSingleTagChange('S06 system leaf', oldSystemContent, newSystemContent);

// 结构证明：内容寻址 leaf 就是 block0 + 分隔符 + prefix + skills + tail，旧 prefix 逐字节来自逆向还原。
const block0 = text(leafBytes.get('sys.block0.main'));
const skills = text(leafBytes.get('sys.skills'));
for (const [label, content, prefix] of [
  ['旧 S06 system', oldSystemContent, text(oldPrefixBytes.get(MAIN_PREFIX))],
  ['新 S06 system', newSystemContent, text(newPrefixBytes.get(MAIN_PREFIX))],
]) {
  const head = `${block0}\n\n\n${prefix}${skills}`;
  assert(content.startsWith(head), `${label}: block0/prefix/skills 前缀不匹配`);
  assert(countOf(content, prefix) === 1, `${label}: 内嵌 main prefix 必须恰好一次`);
}
const NEW_SYSTEM_LEAF = `sys.sha256.${sha256(Buffer.from(newSystemContent, 'utf8'))}`;
assert(NEW_SYSTEM_LEAF !== OLD_SYSTEM_LEAF, '新 system leaf id 不能与旧 id 相同');
assert(!leafBytes.has(NEW_SYSTEM_LEAF), `world 已存在 ${NEW_SYSTEM_LEAF}`);

// 3) 构造旧/新 world：旧 world 必须是录制时的逐字节快照，否则下面的 rawSha256 断言无法通过。
const build = (overrides, removed, generation) => {
  const builder = createWorldBuilder(generation ? { generation } : {});
  for (const [id, bytes] of leafBytes) {
    if (removed?.has(id)) continue;
    builder.addLeaf(id, overrides.get(id) ?? bytes);
  }
  for (const [id, bytes] of overrides) {
    if (!leafBytes.has(id)) builder.addLeaf(id, bytes);
  }
  for (const [id, parts] of Object.entries(manifest.recipes)) builder.addRecipe(id, parts);
  return builder;
};
const previousWorld = build(new Map([...oldPrefixBytes, [OLD_SYSTEM_LEAF, Buffer.from(oldSystemContent, 'utf8')]]), new Set(), manifest.generation);
const newWorld = build(new Map([...newPrefixBytes, [NEW_SYSTEM_LEAF, Buffer.from(newSystemContent, 'utf8')]]), new Set([OLD_SYSTEM_LEAF]));

const changedLeafIds = [MAIN_PREFIX, REPLAY_WORKER_PREFIX, OLD_SYSTEM_LEAF, NEW_SYSTEM_LEAF];
const rewritePart = (part) => (part && typeof part === 'object' && part.leaf === OLD_SYSTEM_LEAF
  ? { ...part, leaf: NEW_SYSTEM_LEAF }
  : part);

// 4) 逐条 cassette 重渲染；响应与 manifest 原样复制，只允许 explorer 标签一处差异。
const stagingBase = await mkdtemp(path.join(fixtures, '.reanchor-access-'));
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
      const affected = refs.some((ref) => changedLeafIds.includes(ref.id));
      const afterBytes = newWorld.renderParts(nextParts);
      const afterExpanded = expandTypedTemplateRules(entry.requestRules ?? [], afterBytes);
      const afterCanonical = canonicalRecordedBody(afterBytes, afterExpanded.rules, afterExpanded.bindings);

      if (affected) {
        assertSingleTagChange(`${id}/${stubFile} raw`, text(beforeBytes), text(afterBytes));
        assertSingleTagChange(`${id}/${stubFile} canonical`, beforeCanonical, afterCanonical);
        updatedStubs += 1;
      } else {
        assert(!nextParts.some((part) => part?.leaf === NEW_SYSTEM_LEAF), `${id}/${stubFile}: 未引用旧 system leaf 却改写了 id`);
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

  // 5) 先封存并校验 staging，再原子替换；失败时 fixture 不会被部分改写。
  const sealedWorld = await newWorld.seal(stagedWorldDir);
  const stagedWorld = await loadWorld(stagedWorldDir);
  assert(stagedWorld.leaves.length === leafBytes.size, 'world leaf 数量应保持不变（旧 system leaf 由新 id 替代）');
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
    assert(loaded.report.legacy.length === 0 && loaded.report.worldDrift.length === 0, `${id}: 最终 cassette 出现 legacy/world drift`);
  }

  console.log(JSON.stringify({
    command: 'reanchor-catalog-access',
    oneTimeMigration: 'Peri #517 explorer catalog readonly -> writes',
    world: {
      generation: sealedWorld.generation,
      leaves: stagedWorld.leaves.length,
      recipes: stagedWorld.recipes.length,
      changedLeaves: changedLeafIds,
      removedLeaf: OLD_SYSTEM_LEAF,
      addedLeaf: NEW_SYSTEM_LEAF,
      explorerLine: `${EXPLORER_PREFIX}[writes]${EXPLORER_SUFFIX}`,
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
