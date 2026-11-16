#!/usr/bin/env node
/**
 * 一次性迁移脚本：把新增 builtin skill 的 catalog 行 re-anchor 到 replay world v2。
 * 禁止日常使用：日常 prompt 同步走 `e2e:replay:world-sync`；其他未映射 leaf 变化必须重录。
 *
 * 背景：`sys.block1.*.tail` 内含冻结的 builtin skill catalog。新增 builtin skill 后
 * 每个 tail 只多一行 catalog 摘要、一条 Recovery 资源 URI，以及同一行末尾的
 * `(N resources)` 计数加一；请求正文按旧 world 渲染会与 cassette 的 system/1 绑定冲突。
 * 本脚本只允许这些插入：重建 world、按新 world 重渲染全部请求 stub，响应字节原样保留。
 */
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const e2eRoot = path.resolve(here, '..');
const fixtures = path.join(e2eRoot, 'fixtures/replay-v2');
const worldDir = path.join(fixtures, 'world');
const load = (relative) => import(pathToFileURL(path.join(e2eRoot, relative)));

const { loadCassette } = await load('llm-replay/cassette.mjs');
const { sha256 } = await load('llm-replay/matcher.mjs');
const {
  CASSETTE_FORMAT_VERSION, canonicalRecordedBody, collectWorldRefs, createWorldBuilder,
  expandTypedTemplateRules, loadWorld, requestCoreSha256, serializeRequestStub,
} = await load('llm-replay/world-store.mjs');
const { replaceWorldDirectory } = await load('scripts/world-sync-swap.mjs');

const CATALOG_ANCHOR = '- **mcp__workspace__goal** [builtin]';
const CATALOG_ADDED = '- **mcp__workspace__interview** [builtin]';
const RECOVERY_ANCHOR = 'skill://builtin/monitor/SKILL.md, ';
const RECOVERY_ADDED = 'skill://builtin/interview/SKILL.md, ';
const TAIL_LEAF_RE = /^sys\.block1\..+\.tail$/u;

const assert = (condition, message) => { if (!condition) throw new Error(message); };
const sortedObject = (entries) => Object.fromEntries(entries.sort(([left], [right]) => left.localeCompare(right)));
const text = (bytes) => bytes.toString('utf8');

/** 同一份 skill catalog 在 block1 出现两次：摘要列表（按名称排序）与 Recovery resources（按注册顺序）。
 *  请求正文里同一份 Recovery 列表还可能在工具结果中出现，因此必须逐处插入并各自加一。 */
function migrateText(before, newline, { requireCatalog = true } = {}) {
  if (requireCatalog) assert(before.includes(CATALOG_ANCHOR), 'catalog 摘要插入点缺失');
  let value = before.replaceAll(CATALOG_ANCHOR, `${CATALOG_ANCHOR}${newline}${CATALOG_ADDED}`);
  let cursor = 0;
  let inserted = 0;
  while (true) {
    const at = value.indexOf(RECOVERY_ANCHOR, cursor);
    if (at === -1) break;
    const afterAnchor = at + RECOVERY_ANCHOR.length;
    value = `${value.slice(0, afterAnchor)}${RECOVERY_ADDED}${value.slice(afterAnchor)}`;
    const pattern = /\((\d+) resources\)/gu;
    pattern.lastIndex = afterAnchor + RECOVERY_ADDED.length;
    const match = pattern.exec(value);
    assert(match, 'Recovery 资源插入后找不到 workspace 资源计数');
    const replacement = `(${Number(match[1]) + 1} resources)`;
    value = value.slice(0, match.index) + replacement + value.slice(match.index + match[0].length);
    cursor = match.index + replacement.length;
    inserted += 1;
  }
  assert(inserted >= 1, 'Recovery resources 插入点缺失');
  return value;
}

/** stub 的字符串片段是原始 JSON 文本：换行已转义，其他字段保持原样。 */
function migrateLiteralParts(parts) {
  return parts.map((part) => {
    if (typeof part !== 'string') return part;
    if (!part.includes(CATALOG_ANCHOR) && !part.includes(RECOVERY_ANCHOR)) return part;
    return migrateText(part, '\\n', { requireCatalog: false });
  });
}

function assertCatalogInsertion(label, before, after, newline) {
  let expected;
  try {
    expected = migrateText(before, newline);
  } catch (error) {
    throw new Error(`${label}: ${error.message}`);
  }
  assert(after === expected,
    `${label}: 差异不是新增 interview 的摘要行、Recovery 资源与计数（before=${before.length}, after=${after.length}）`);
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
  leafBytes.set(id, bytes);
}

const targetLeaves = [...leafBytes.keys()].filter((id) => TAIL_LEAF_RE.test(id));
assert(targetLeaves.length > 0, 'world 中没有 block1 tail leaf');
for (const id of targetLeaves) {
  const value = text(leafBytes.get(id));
  assert(value.includes(CATALOG_ANCHOR), `${id}: 缺少 goal catalog 行，无法定位插入点`);
  assert(!value.includes(CATALOG_ADDED), `${id}: 已包含 interview catalog 行`);
  assert(!value.includes(RECOVERY_ADDED), `${id}: 已包含 interview Recovery 资源`);
  assert(value.split(CATALOG_ANCHOR).length - 1 === 1, `${id}: catalog 摘要插入点必须恰好出现一次`);
  assert(value.split(RECOVERY_ANCHOR).length - 1 === 1, `${id}: Recovery resources 插入点必须恰好出现一次`);
  migrateText(value, '\n');
}

const baselineLeaves = new Map();
const nextLeaves = new Map();
for (const id of targetLeaves) {
  const before = text(leafBytes.get(id));
  const after = migrateText(before, '\n');
  assertCatalogInsertion(id, before, after, '\n');
  baselineLeaves.set(id, leafBytes.get(id));
  nextLeaves.set(id, Buffer.from(after, 'utf8'));
}
// 未命中的 tail 必须与旧内容完全一致。
for (const [id, bytes] of leafBytes) {
  if (!nextLeaves.has(id)) nextLeaves.set(id, bytes);
}

function buildWorld(overrides) {
  const builder = createWorldBuilder({ generation: manifest.generation });
  for (const [id] of Object.entries(manifest.leaves)) builder.addLeaf(id, overrides.get(id) ?? leafBytes.get(id));
  for (const [id, parts] of Object.entries(manifest.recipes)) builder.addRecipe(id, parts);
  return builder;
}
const newWorld = buildWorld(nextLeaves);
const previousWorld = buildWorld(baselineLeaves);

const cassetteIds = [];
for (const entry of await readdir(fixtures, { withFileTypes: true })) {
  if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'world') continue;
  try {
    await readFile(path.join(fixtures, entry.name, 'cassette', 'manifest.json'));
    cassetteIds.push(entry.name);
  } catch { /* 非 cassette 目录 */ }
}
cassetteIds.sort();
assert(cassetteIds.length > 0, '没有找到 cassette');

const stagingBase = await mkdtemp(path.join(fixtures, '.reanchor-skills-'));
const stagedWorldDir = path.join(stagingBase, 'world');
const stagedById = new Map();
const expectedCanonical = new Map();
let stubCount = 0;
let updatedStubs = 0;
let unchangedStubs = 0;
let responseCount = 0;
let sealCount = 0;

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
      const migratedParts = migrateLiteralParts(stub.parts);
      const literalChanged = migratedParts.some((part, index) => part !== stub.parts[index]);
      const afterBytes = newWorld.renderParts(migratedParts);
      const affected = literalChanged
        || collectWorldRefs(stub.parts, previousWorld).some((ref) => targetLeaves.includes(ref.id));

      const beforeText = text(beforeBytes);
      const beforeExpanded = expandTypedTemplateRules(entry.requestRules ?? [], beforeBytes);
      const beforeCanonical = canonicalRecordedBody(beforeBytes, beforeExpanded.rules, beforeExpanded.bindings);
      assert(sha256(beforeCanonical) === stub.canonicalSha256, `${id}/${stubFile}: 逆推旧 canonicalSha256 不符`);

      const afterExpanded = expandTypedTemplateRules(entry.requestRules ?? [], afterBytes);
      const afterCanonical = canonicalRecordedBody(afterBytes, afterExpanded.rules, afterExpanded.bindings);

      if (affected) {
        assertCatalogInsertion(`${id}/${stubFile} raw`, beforeText, text(afterBytes), '\\n');
        assertCatalogInsertion(`${id}/${stubFile} canonical`, beforeCanonical, afterCanonical, '\\n');
        updatedStubs += 1;
      } else {
        assert(afterBytes.equals(beforeBytes), `${id}/${stubFile}: 未引用目标 leaf 却渲染出不同字节`);
        assert(afterCanonical === beforeCanonical, `${id}/${stubFile}: 未引用目标 leaf 却 canonical 不同`);
        unchangedStubs += 1;
      }

      const nextStub = {
        ...stub,
        parts: migratedParts,
        rawBytes: afterBytes.length,
        rawSha256: sha256(afterBytes),
        canonicalSha256: sha256(afterCanonical),
      };
      const nextStubBytes = serializeRequestStub(nextStub);
      if (!affected) assert(nextStubBytes.equals(stubBytes), `${id}/${stubFile}: 未变化 stub 重新序列化产生差异`);
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
    sealCount += 1;
  }

  const sealedWorld = await newWorld.seal(stagedWorldDir);
  const stagedManifestBytes = await readFile(path.join(stagedWorldDir, 'manifest.json'));
  assert(stagedManifestBytes.equals(manifestBytes), '重封 world 改变了 manifest；generation/结构必须保持不变');
  const stagedWorld = await loadWorld(stagedWorldDir);

  for (const [id, output] of stagedById) {
    const staged = await loadCassette(output, { worldDir: stagedWorldDir });
    assert(staged.report.legacy.length === 0 && staged.report.worldDrift.length === 0,
      `${id}: staging 出现 legacy/world drift`);
    const manifestEntries = staged.manifest.entries.length;
    assert(staged.entries.size === manifestEntries, `${id}: staging entry 数量变化`);
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
    command: 'reanchor-skills-catalog',
    oneTimeMigration: 'builtin interview skill -> world v2 block1 tails',
    world: {
      generation: sealedWorld.generation,
      manifestUnchanged: true,
      leaves: stagedWorld.leaves.length,
      recipes: stagedWorld.recipes.length,
      changedLeaves: targetLeaves,
      addedCatalogLine: CATALOG_ADDED,
      addedRecoveryResource: RECOVERY_ADDED,
    },
    cassettes: cassetteIds.length,
    seals: sealCount,
    stubs: stubCount,
    updatedStubs,
    unchangedStubs,
    responsesUnchanged: responseCount,
  }, null, 2));
} finally {
  if (!process.env.PERI_KEEP_REANCHOR) await rm(stagingBase, { recursive: true, force: true });
}
