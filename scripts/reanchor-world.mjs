#!/usr/bin/env node
/**
 * 一次性迁移脚本：仅用于把 #374 新增的 `mcp__workflow__Workflow` 敏感项 re-anchor 到 replay world v2。
 * 禁止日常使用：日常 prompt 同步走 `e2e:replay:world-sync`；未映射 leaf 变化必须重录，不能用本脚本绕过 verify。
 *
 * 前置状态：world/system/block1.main.prefix.txt 已插入且仅插入一条新增敏感项。
 * 脚本从 manifest + leaf 文件重建并重封 world，然后按新 world 重新渲染每个请求 stub：
 * 更新 rawBytes/rawSha256/canonicalSha256 与 cassette seal 的 requestMeta，响应字节原样复制。
 * 旧 world 在内存中按精确逆操作还原，用于断言仅多出这一行 prompt（含 canonical body）。
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

const TARGET_LEAF = 'sys.block1.main.prefix';
const ADDED_LINE = '- `mcp__workflow__Workflow` — workflow delegation (launches a multi-agent workflow that bypasses HITL, equivalent to delegated execution rights)';
const ADDED_TEXT = `${ADDED_LINE}\\n`; // 原始 HTTP body 是 JSON 文本，换行被转义为反斜杠 + n。

const assert = (condition, message) => { if (!condition) throw new Error(message); };
const sortedObject = (entries) => Object.fromEntries(entries.sort(([left], [right]) => left.localeCompare(right)));
const text = (bytes) => bytes.toString('utf8');

function assertSingleInsertion(label, before, after) {
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < before.length - prefix && suffix < after.length - prefix
    && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix += 1;
  const inserted = after.slice(prefix, after.length - suffix);
  if (inserted !== ADDED_TEXT || after.length - before.length !== ADDED_TEXT.length) {
    throw new Error(`${label}: 与基线的差异不是唯一新增 prompt 行（inserted=${JSON.stringify(inserted.slice(0, 120))}）`);
  }
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
const changedLeaves = [...leafBytes].filter(([id, bytes]) => sha256(bytes) !== previousSeal.leaves[id]).map(([id]) => id);
assert(changedLeaves.length === 1 && changedLeaves[0] === TARGET_LEAF,
  `只允许 ${TARGET_LEAF} 变化，实际: ${changedLeaves.join(', ')}`);

const targetText = text(leafBytes.get(TARGET_LEAF));
const occurrences = targetText.split(ADDED_LINE).length - 1;
assert(occurrences === 1, `${TARGET_LEAF}: 新增行应恰好出现一次，实际 ${occurrences} 次`);
const baselineTargetText = targetText.replace(`${ADDED_LINE}\n`, '');
assert(baselineTargetText.length === targetText.length - ADDED_LINE.length - 1 && !baselineTargetText.includes(ADDED_LINE),
  `${TARGET_LEAF}: 无法唯一还原基线 leaf`);

function buildWorld(overrides) {
  const builder = createWorldBuilder({ generation: manifest.generation });
  for (const [id] of Object.entries(manifest.leaves)) builder.addLeaf(id, overrides.get(id) ?? leafBytes.get(id));
  for (const [id, parts] of Object.entries(manifest.recipes)) builder.addRecipe(id, parts);
  return builder;
}
const newWorld = buildWorld(new Map());
const previousWorld = buildWorld(new Map([[TARGET_LEAF, Buffer.from(baselineTargetText, 'utf8')]]));

const cassetteIds = [];
for (const entry of await readdir(fixtures, { withFileTypes: true })) {
  if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'world') continue;
  try {
    await readFile(path.join(fixtures, entry.name, 'cassette', 'manifest.json'));
    cassetteIds.push(entry.name);
  } catch { /* 非 cassette 目录 */ }
}
cassetteIds.sort();
assert(cassetteIds.length === 30, `cassette 数量应为 30，实际 ${cassetteIds.length}`);

const stagingBase = await mkdtemp(path.join(fixtures, '.reanchor-'));
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
    assert(seal.formatVersion === CASSETTE_FORMAT_VERSION && seal.manifestSha256 === sha256(cassetteManifestBytes), `${id}: cassette seal 或 manifest 校验失败`);
    assert(seal.requestMeta && seal.files && typeof seal.requestMeta === 'object' && typeof seal.files === 'object', `${id}: seal 缺少元数据`);

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
      const afterBytes = newWorld.renderParts(stub.parts);
      const affected = collectWorldRefs(stub.parts, previousWorld).some((ref) => ref.id === TARGET_LEAF);

      const beforeText = text(beforeBytes);
      const beforeExpanded = expandTypedTemplateRules(entry.requestRules ?? [], beforeBytes);
      const beforeCanonical = canonicalRecordedBody(beforeBytes, beforeExpanded.rules, beforeExpanded.bindings);
      assert(sha256(beforeCanonical) === stub.canonicalSha256, `${id}/${stubFile}: 逆推旧 canonicalSha256 不符`);

      const afterExpanded = expandTypedTemplateRules(entry.requestRules ?? [], afterBytes);
      const afterCanonical = canonicalRecordedBody(afterBytes, afterExpanded.rules, afterExpanded.bindings);

      if (affected) {
        assertSingleInsertion(`${id}/${stubFile} raw`, beforeText, text(afterBytes));
        assertSingleInsertion(`${id}/${stubFile} canonical`, beforeCanonical, afterCanonical);
        updatedStubs += 1;
      } else {
        assert(afterBytes.equals(beforeBytes), `${id}/${stubFile}: 未引用目标 leaf 却渲染出不同字节`);
        assert(afterCanonical === beforeCanonical, `${id}/${stubFile}: 未引用目标 leaf 却 canonical 不同`);
        unchangedStubs += 1;
      }

      const nextStub = {
        ...stub,
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
  assert(stubCount === 99, `stub 数量应为 99，实际 ${stubCount}`);
  assert(responseCount === 99, `响应数量应为 99，实际 ${responseCount}`);

  const sealedWorld = await newWorld.seal(stagedWorldDir);
  const stagedManifestBytes = await readFile(path.join(stagedWorldDir, 'manifest.json'));
  assert(stagedManifestBytes.equals(manifestBytes), '重封 world 改变了 manifest；generation/结构必须保持不变');
  const stagedWorld = await loadWorld(stagedWorldDir);

  for (const [id, output] of stagedById) {
    const staged = await loadCassette(output, { worldDir: stagedWorldDir });
    assert(staged.report.legacy.length === 0 && staged.report.worldDrift.length === 0, `${id}: staging 出现 legacy/world drift`);
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
    assert(loaded.report.legacy.length === 0 && loaded.report.worldDrift.length === 0, `${id}: 最终 cassette 出现 legacy/world drift`);
  }

  console.log(JSON.stringify({
    command: 'reanchor-world',
    oneTimeMigration: '#374 bridge -> world v2 shared leaf',
    world: {
      generation: sealedWorld.generation,
      manifestUnchanged: true,
      leaves: stagedWorld.leaves.length,
      recipes: stagedWorld.recipes.length,
      changedLeaves,
      leafSha256: stagedWorld.seal.leaves[TARGET_LEAF],
      addedLine: ADDED_LINE,
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
