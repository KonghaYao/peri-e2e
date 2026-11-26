#!/usr/bin/env node
/**
 * 一次性迁移：把 Peri #596 的 explorer/web-researcher 委派路由同步到 cassette 录制侧。
 *
 * `world:sync` 已把 `sys.block1.main.prefix` / `sys.block1.replay-worker.prefix` 重渲染为
 * 新的 Exploration 段落，但 62 个 cassette 的 stub rawBytes/rawSha256/canonicalSha256 与
 * cassette seal 的 requestMeta.worldRefs 仍指向旧 world。S06 Responses 场景把整块 system
 * 文本存成内容寻址 leaf，不在源码映射内，必须按同一行变化重算 id。
 *
 * 本脚本从新 prefix 逆向还原旧前缀（唯一一次行替换），逐条重渲染 stub 并重封 cassette；
 * 响应字节原样复制。硬断言：差异只允许是 Exploration 这一行的替换、其余 world leaf 与
 * 全部 response 文件逐字节不变。
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
const { compareRecordedWorldRefs, readRecordedWorldRefs } = await load('scripts/replay-world-recorded.mjs');
const { replaceWorldDirectory } = await load('scripts/world-sync-swap.mjs');

const MAIN_PREFIX = 'sys.block1.main.prefix';
const REPLAY_WORKER_PREFIX = 'sys.block1.replay-worker.prefix';
const PREFIX_LEAVES = [MAIN_PREFIX, REPLAY_WORKER_PREFIX];
const OLD_LINE = '- **Exploration:** ordinary locating belongs to the implementation owner. Delegate an independent investigation only when it is worth delivering on its own, for example an unfamiliar subsystem whose findings will steer several downstream tasks. Do not treat `explorer` as a mandatory precursor.';
const NEW_LINE = '- **Exploration:** when the user needs a read-only finding, choose the owner before opening sources. Answer directly if the current context already establishes it, or if you know the exact source and a single lookup will answer it without following a reference. Otherwise launch one available `explorer` with the whole question. Following a value through code, locating the authoritative document, and comparing implementation with a published contract are investigations even if the final answer is a single value. A missing source tool limits the evidence the explorer can return; give it the accessible part and ask it to identify the gap. If a direct lookup opens a new investigation, delegate before the next search. Command execution, edits and artifact delivery stay with their respective owners.';
const LINE_DELTA = Buffer.byteLength(NEW_LINE) - Buffer.byteLength(OLD_LINE);

const assert = (condition, message) => { if (!condition) throw new Error(message); };
const sortedObject = (entries) => Object.fromEntries(entries.sort(([left], [right]) => left.localeCompare(right)));
const text = (bytes) => bytes.toString('utf8');
const countOf = (haystack, needle) => haystack.split(needle).length - 1;

/** 整块 leaf：只能有一行从旧文案换成新文案，其余行逐字节相同。 */
function assertSingleLineReplacement(label, before, after) {
  const beforeLines = before.split('\n');
  const afterLines = after.split('\n');
  assert(beforeLines.length === afterLines.length, `${label}: 行数变化（${beforeLines.length} -> ${afterLines.length}）`);
  const changed = beforeLines.map((line, index) => (line === afterLines[index] ? -1 : index)).filter((index) => index >= 0);
  assert(changed.length === 1, `${label}: 变化行应恰好一行，实际 ${changed.length}`);
  assert(beforeLines[changed[0]] === OLD_LINE, `${label}: 旧行与 #596 前文案不符`);
  assert(afterLines[changed[0]] === NEW_LINE, `${label}: 新行与 #596 后文案不符`);
  assert(Buffer.byteLength(after) - Buffer.byteLength(before) === LINE_DELTA,
    `${label}: 字节差应为 ${LINE_DELTA}，实际 ${Buffer.byteLength(after) - Buffer.byteLength(before)}`);
}

/** 请求 raw/canonical body：JSON 转义不改变该行，差异必须只是这一处替换。 */
function assertSingleRequestReplacement(label, before, after) {
  assert(countOf(before, OLD_LINE) === 1, `${label}: 旧文案应恰好出现一次，实际 ${countOf(before, OLD_LINE)} 次`);
  assert(countOf(after, NEW_LINE) === 1, `${label}: 新文案应恰好出现一次，实际 ${countOf(after, NEW_LINE)} 次`);
  assert(after === before.split(OLD_LINE).join(NEW_LINE), `${label}: 变化不止 Exploration 段落`);
  assert(Buffer.byteLength(after) - Buffer.byteLength(before) === LINE_DELTA,
    `${label}: 字节差应为 ${LINE_DELTA}，实际 ${Buffer.byteLength(after) - Buffer.byteLength(before)}`);
}

assert(LINE_DELTA === 509, `Exploration 段落替换的字节差应为 509，实际 ${LINE_DELTA}`);

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

// 1) 两个 prefix 必须已由 world:sync 写入 #596 文案；逆向还原旧值用于重渲染录制请求。
const oldPrefixBytes = new Map();
for (const id of PREFIX_LEAVES) {
  const current = text(leafBytes.get(id));
  assert(countOf(current, NEW_LINE) === 1, `${id}: 新 Exploration 段落应恰好出现一次`);
  assert(countOf(current, OLD_LINE) === 0, `${id}: 不应残留旧 Exploration 段落`);
  const previous = current.split(NEW_LINE).join(OLD_LINE);
  assertSingleLineReplacement(`${id} (reverse)`, previous, current);
  oldPrefixBytes.set(id, Buffer.from(previous, 'utf8'));
}

// 2) 找出被 cassette 引用且内嵌旧 system 文本的内容寻址 leaf（S06 Responses）。
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

const referenced = new Set();
for (const id of cassetteIds) {
  const seal = JSON.parse(await readFile(path.join(fixtures, id, 'cassette', 'seal.json'), 'utf8'));
  for (const meta of Object.values(seal.requestMeta)) {
    for (const ref of meta.worldRefs) referenced.add(ref.id);
  }
}
const oldSystemLeaves = [...referenced].filter((id) => id.startsWith('sys.sha256.')
  && text(leafBytes.get(id)).includes(OLD_LINE));
assert(oldSystemLeaves.length === 1, `应恰好有一个被引用的旧 system 快照，实际 ${oldSystemLeaves.join(', ')}`);
const OLD_SYSTEM_LEAF = oldSystemLeaves[0];
const oldSystemContent = text(leafBytes.get(OLD_SYSTEM_LEAF));
assert(countOf(oldSystemContent, OLD_LINE) === 1, `${OLD_SYSTEM_LEAF}: 旧文案应恰好出现一次`);
const newSystemContent = oldSystemContent.split(OLD_LINE).join(NEW_LINE);
assertSingleLineReplacement('S06 system leaf', oldSystemContent, newSystemContent);

// 结构证明：内容寻址 leaf 就是 block0 + 分隔符 + 旧 main prefix + skills + 其余录制尾部。
const block0 = text(leafBytes.get('sys.block0.main'));
const skills = text(leafBytes.get('sys.skills'));
assert(oldSystemContent.startsWith(`${block0}\n\n\n${text(oldPrefixBytes.get(MAIN_PREFIX))}${skills}`),
  '旧 S06 system 文本必须逐字节内嵌旧 main prefix');
assert(newSystemContent.startsWith(`${block0}\n\n\n${text(leafBytes.get(MAIN_PREFIX))}${skills}`),
  '新 S06 system 文本必须逐字节内嵌新 main prefix');
const NEW_SYSTEM_LEAF = `sys.sha256.${sha256(Buffer.from(newSystemContent, 'utf8'))}`;
assert(NEW_SYSTEM_LEAF !== OLD_SYSTEM_LEAF, '新 system leaf id 不能与旧 id 相同');
assert(!leafBytes.has(NEW_SYSTEM_LEAF), `world 已存在 ${NEW_SYSTEM_LEAF}`);

// 未被任何 cassette 引用的旧 system 快照不参与迁移，必须原样保留。
const unreferencedOldLeaves = [...leafBytes.keys()].filter((id) => !referenced.has(id)
  && text(leafBytes.get(id)).includes(OLD_LINE));
for (const id of unreferencedOldLeaves) {
  assert(id !== OLD_SYSTEM_LEAF, `${id}: 已引用快照不能同时被当作未引用`);
}

// 3) 构造旧/新 world：旧 world 必须是录制时的逐字节快照，否则 rawSha256 断言无法通过。
const build = (overrides, removed, added, generation) => {
  const builder = createWorldBuilder(generation ? { generation } : {});
  for (const [id, bytes] of leafBytes) {
    if (removed.has(id)) continue;
    builder.addLeaf(id, overrides.get(id) ?? bytes);
  }
  for (const [id, bytes] of overrides) {
    if (!leafBytes.has(id)) builder.addLeaf(id, bytes);
  }
  for (const [id, bytes] of added) builder.addLeaf(id, bytes);
  for (const [id, parts] of Object.entries(manifest.recipes)) builder.addRecipe(id, parts);
  return builder;
};
const previousWorld = build(oldPrefixBytes, new Set(), new Map(), manifest.generation);
const newWorld = build(new Map(), new Set([OLD_SYSTEM_LEAF]), new Map([[NEW_SYSTEM_LEAF, Buffer.from(newSystemContent, 'utf8')]]));

const changedLeafIds = new Set([...PREFIX_LEAVES, OLD_SYSTEM_LEAF, NEW_SYSTEM_LEAF]);
const rewritePart = (part) => (part && typeof part === 'object' && part.leaf === OLD_SYSTEM_LEAF
  ? { ...part, leaf: NEW_SYSTEM_LEAF }
  : part);

// 4) 逐条 cassette 重渲染；响应与 manifest 原样复制，只允许 Exploration 一行差异。
const stagingBase = await mkdtemp(path.join(fixtures, '.reanchor-explorer-'));
const stagedWorldDir = path.join(stagingBase, 'world');
const stagedById = new Map();
const expectedCanonical = new Map();
const affectedByCassette = {};
const requests = [];
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
      const affected = refs.some((ref) => changedLeafIds.has(ref.id));
      const afterBytes = newWorld.renderParts(nextParts);
      const afterExpanded = expandTypedTemplateRules(entry.requestRules ?? [], afterBytes);
      const afterCanonical = canonicalRecordedBody(afterBytes, afterExpanded.rules, afterExpanded.bindings);

      if (affected) {
        assertSingleRequestReplacement(`${id}/${stubFile} raw`, text(beforeBytes), text(afterBytes));
        assertSingleRequestReplacement(`${id}/${stubFile} canonical`, beforeCanonical, afterCanonical);
        updatedStubs += 1;
        affectedByCassette[id] = (affectedByCassette[id] ?? 0) + 1;
        requests.push({
          cassette: id,
          stub: stubFile,
          rawBytesBefore: beforeBytes.length,
          rawBytesAfter: afterBytes.length,
          rawDelta: afterBytes.length - beforeBytes.length,
          canonicalDelta: Buffer.byteLength(afterCanonical) - Buffer.byteLength(beforeCanonical),
          via: refs.filter((ref) => changedLeafIds.has(ref.id)).map((ref) => ref.id),
        });
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
      if (!affected) assert(nextStubBytes.equals(stubBytes), `${id}/${stubFile}: 未变化 stub 重新序列化产生差异`);
      await writeFile(path.join(output, stubFile), nextStubBytes, { mode: 0o600 });
      sealedFiles[stubFile] = sha256(nextStubBytes);
      requestMeta[stubFile] = {
        requestCoreSha256: requestCoreSha256(nextStub),
        worldRefs: collectWorldRefs(nextStub.parts, newWorld),
      };
      expectedCanonical.set(`${id}/${stubFile}`, afterCanonical);

      assert(entry.response.file.startsWith('responses/'), `${id}/${entry.response.file}: 响应路径必须位于 responses/`);
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
  assert(stubCount === 305, `stub 数量应为 305，实际 ${stubCount}`);
  assert(responseCount === 305, `响应数量应为 305，实际 ${responseCount}`);
  assert(updatedStubs === 260, `受影响 stub 应为 260，实际 ${updatedStubs}`);
  assert(unchangedStubs === 45, `未变化 stub 应为 45，实际 ${unchangedStubs}`);
  assert(Object.keys(affectedByCassette).length === 62, `每个 cassette 都应至少有一个受影响 stub，实际 ${Object.keys(affectedByCassette).length}`);

  // 5) 封存 staging world，并证明除已知 leaf 外全部原样保留。
  const sealedWorld = await newWorld.seal(stagedWorldDir);
  const stagedManifestBytes = await readFile(path.join(stagedWorldDir, 'manifest.json'));
  const stagedManifest = JSON.parse(text(stagedManifestBytes));
  const stagedWorld = await loadWorld(stagedWorldDir);
  const expectedLeafIds = new Set(leafBytes.keys());
  expectedLeafIds.delete(OLD_SYSTEM_LEAF);
  expectedLeafIds.add(NEW_SYSTEM_LEAF);
  assert(stagedWorld.leaves.length === expectedLeafIds.size, `staging world leaf 数量应为 ${expectedLeafIds.size}，实际 ${stagedWorld.leaves.length}`);
  assert([...expectedLeafIds].every((id) => stagedManifest.leaves[id]), 'staging world 缺少预期 leaf');
  assert(stagedWorld.seal.manifestSha256 === sha256(stagedManifestBytes), 'staging world seal 与 manifest 不符');
  assert(sealedWorld.generation !== manifest.generation, '内容寻址 leaf 替换必须产生新的 world generation');
  assert(JSON.stringify(stagedManifest.recipes) === JSON.stringify(manifest.recipes), 'world recipe 结构必须保持不变');
  for (const [id, bytes] of leafBytes) {
    if (changedLeafIds.has(id)) continue;
    assert(stagedWorld.leafBytes(id).equals(bytes), `${id}: 非目标 world leaf 被意外改写`);
  }
  for (const id of PREFIX_LEAVES) {
    assert(stagedWorld.leafBytes(id).equals(leafBytes.get(id)), `${id}: prefix leaf 必须与 world:sync 结果逐字节一致`);
  }
  assert(stagedWorld.leafBytes(NEW_SYSTEM_LEAF).equals(Buffer.from(newSystemContent, 'utf8')),
    `${NEW_SYSTEM_LEAF}: 新 system leaf 与重算内容不符`);
  assert(!stagedWorld.hasLeaf(OLD_SYSTEM_LEAF), `${OLD_SYSTEM_LEAF}: 旧 system leaf 必须被替换`);

  // 6) 先校验 staging cassette，再原子替换；失败时 fixture 不会被部分改写。
  for (const [id, output] of stagedById) {
    const staged = await loadCassette(output, { worldDir: stagedWorldDir });
    assert(staged.report.legacy.length === 0, `${id}: staging 出现 legacy body`);
    assert(staged.report.worldDrift.length === 0, `${id}: staging 出现 world drift`);
    assert(staged.entries.size === staged.manifest.entries.length, `${id}: staging entry 数量变化`);
    for (const entry of staged.entries.values()) {
      assert(entry.request.canonicalBody === expectedCanonical.get(`${id}/${entry.request.stub}`),
        `${id}/${entry.request.stub}: staging canonical body 与重算值不一致`);
    }
    const stagedResponses = (await readdir(path.join(output, 'responses'))).sort();
    const expectedResponses = staged.manifest.entries.map((entry) => path.posix.basename(entry.response.file)).sort();
    assert(JSON.stringify(stagedResponses) === JSON.stringify(expectedResponses), `${id}: staging 响应文件集合变化`);
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

  // 7) 落盘后复核：无 legacy/world drift、录制引用与 world 完全一致、响应逐字节未变。
  let responseBytesChecked = 0;
  for (const id of cassetteIds) {
    const loaded = await loadCassette(path.join(fixtures, id, 'cassette'));
    assert(loaded.report.legacy.length === 0 && loaded.report.worldDrift.length === 0,
      `${id}: 最终 cassette 出现 legacy/world drift`);
    for (const entry of loaded.manifest.entries) {
      const responseBytes = await readFile(path.join(fixtures, id, 'cassette', entry.response.file));
      assert(responseBytes.length === entry.response.size && sha256(responseBytes) === entry.response.sha256,
        `${id}/${entry.response.file}: 最终响应字节与 manifest 不符`);
      responseBytesChecked += 1;
    }
  }
  const finalWorld = await loadWorld(worldDir);
  const recorded = compareRecordedWorldRefs(finalWorld, await readRecordedWorldRefs(fixtures));
  assert(recorded.mappedDrift.length === 0, `最终 mappedDrift 应为空，实际 ${recorded.mappedDrift.join(', ')}`);
  assert(recorded.unmappedDrift.length === 0, `最终 unmappedDrift 应为空，实际 ${recorded.unmappedDrift.join(', ')}`);
  assert(recorded.missingLeaves.length === 0, `最终缺失 leaf：${recorded.missingLeaves.join(', ')}`);

  console.log(JSON.stringify({
    command: 'reanchor-explorer-world',
    oneTimeMigration: 'Peri #596 explorer/web-researcher delegation routing',
    world: {
      generation: sealedWorld.generation,
      previousGeneration: manifest.generation,
      leaves: stagedWorld.leaves.length,
      recipes: stagedWorld.recipes.length,
      changedLeaves: [...PREFIX_LEAVES],
      removedLeaf: OLD_SYSTEM_LEAF,
      addedLeaf: NEW_SYSTEM_LEAF,
      untouchedOldLineLeaves: unreferencedOldLeaves,
      lineDelta: LINE_DELTA,
    },
    cassettes: cassetteIds.length,
    stubs: stubCount,
    updatedStubs,
    unchangedStubs,
    responsesUnchanged: responseCount,
    responseBytesChecked,
    recorded,
    affectedByCassette,
    requests,
  }, null, 2));
} finally {
  if (!process.env.PERI_KEEP_REANCHOR) await rm(stagingBase, { recursive: true, force: true });
}
