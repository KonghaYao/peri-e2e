#!/usr/bin/env node
/**
 * 一次性迁移：把 v2 cassette 中完全字面量的 request stub 改写为 world ref。
 *
 * 只重写 parts；raw/canonical/response 三类字节必须保持等价。迁移只在 staging 中生成，
 * 全部 loadCassette 通过后才原子替换 world 与 cassette；失败回滚。
 */
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const here = path.dirname(fileURLToPath(import.meta.url));
const e2eRoot = path.resolve(here, '..');
const load = (relative) => import(pathToFileURL(path.join(e2eRoot, relative)));
const { sha256 } = await load('llm-replay/matcher.mjs');
const {
  CASSETTE_FORMAT_VERSION, canonicalRecordedBody, collectWorldRefs, createWorldBuilderFromWorld,
  encodeRequestStub, expandTypedTemplateRules, loadWorld, requestCoreSha256, serializeRequestStub,
} = await load('llm-replay/world-store.mjs');
const { createSlotResolver } = await load('llm-replay/world-slots.mjs');
const { loadCassette } = await load('llm-replay/cassette.mjs');

const fail = (message) => { throw new Error(message); };
const text = (bytes) => bytes.toString('utf8');
const sortedObject = (entries) => Object.fromEntries(entries.sort(([left], [right]) => left.localeCompare(right)));
const isLiteral = (stub) => Array.isArray(stub.parts) && stub.parts.length > 0 && stub.parts.every((part) => typeof part === 'string');

/** 迁移只允许新增 block1 tail 与内容寻址 tools leaf；其他 id 形态必须人工审核而非静默写入。 */
const NEW_LEAF_PATTERNS = Object.freeze([
  /^sys\.block1\.(?:main|replay-worker|subagent)\.t\d+\.tail$/u,
  /^tools\.sha256\.[0-9a-f]{64}$/u,
]);
const NEW_RECIPE_PATTERNS = Object.freeze([
  /^sys\.block1\.(?:main|replay-worker|subagent)\.t\d+$/u,
]);

async function cassetteIds(fixtures) {
  const ids = [];
  for (const entry of await readdir(fixtures, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'world') continue;
    try { await readFile(path.join(fixtures, entry.name, 'cassette', 'manifest.json')); }
    catch { continue; }
    ids.push(entry.name);
  }
  return ids.sort();
}

function canonicalOf(raw, rules) {
  const expanded = expandTypedTemplateRules(rules, raw);
  return canonicalRecordedBody(raw, expanded.rules, expanded.bindings);
}

/** 迁移单个 cassette；返回是否发生变化并填充报告。 */
async function migrateCassette({ id, source, output, builder, slots, dryRun, report }) {
  const manifestBytes = await readFile(path.join(source, 'manifest.json'));
  const manifest = JSON.parse(text(manifestBytes));
  const sealBytes = await readFile(path.join(source, 'seal.json'));
  const seal = JSON.parse(text(sealBytes));
  if (manifest.formatVersion !== CASSETTE_FORMAT_VERSION || seal.formatVersion !== CASSETTE_FORMAT_VERSION
      || seal.manifestSha256 !== sha256(manifestBytes)) fail(`${id}: cassette 不是自洽的 v2`);
  if (!seal.files || !seal.requestMeta) fail(`${id}: cassette seal 缺少 files/requestMeta`);
  const stubFiles = manifest.entries.map((entry) => entry.request.stub);
  if (new Set(stubFiles).size !== stubFiles.length) fail(`${id}: manifest 中 stub 路径重复`);
  if (Object.keys(seal.files).length !== stubFiles.length || stubFiles.some((file) => !Object.hasOwn(seal.files, file))) {
    fail(`${id}: seal.files 未精确覆盖 stub`);
  }

  const sealedFiles = {};
  const requestMeta = {};
  const expectedCanonical = new Map();
  const stubOutputs = [];
  const responseOutputs = [];
  let changed = false;
  for (const entry of manifest.entries) {
    const stubFile = entry.request.stub;
    const stubBytes = await readFile(path.join(source, stubFile));
    if (seal.files[stubFile] !== sha256(stubBytes)) fail(`${id}/${stubFile}: stub 未纳入 seal`);
    const stub = JSON.parse(text(stubBytes));
    if (stub.v !== 2 || !Array.isArray(stub.parts) || !stub.parts.length) fail(`${id}/${stubFile}: stub 结构无效`);
    report.stubs += 1;
    let nextStub = stub;
    let nextStubBytes = stubBytes;
    let nextCanonical = null;
    if (stub.legacy || stub.parts.some((part) => part && typeof part === 'object' && part.raw !== undefined)) {
      report.legacyStubs += 1;
    } else if (!isLiteral(stub)) {
      report.refStubsUnchanged += 1;
    } else {
      report.literalStubs += 1;
      const raw = Buffer.from(stub.parts.join(''), 'utf8');
      if (sha256(raw) !== stub.rawSha256 || raw.length !== stub.rawBytes) {
        report.rawMismatches.push({ cassette: id, stub: stubFile, expected: stub.rawSha256, actual: sha256(raw) });
        fail(`${id}/${stubFile}: 字面量拼接与 rawSha256 不符`);
      }
      const rules = entry.requestRules ?? [];
      const canonical = canonicalOf(raw, rules);
      if (sha256(canonical) !== stub.canonicalSha256) {
        report.canonicalMismatches.push({ cassette: id, stub: stubFile, expected: stub.canonicalSha256, actual: sha256(canonical) });
        fail(`${id}/${stubFile}: 录制 canonical 重建失败`);
      }
      const encoded = encodeRequestStub(raw, { world: builder, slots });
      if (encoded.legacy) fail(`${id}/${stubFile}: 迁移退化为 legacy（${encoded.reason}）`);
      if (encoded.rawBytes !== stub.rawBytes || encoded.rawSha256 !== stub.rawSha256) {
        report.rawMismatches.push({ cassette: id, stub: stubFile, expected: stub.rawSha256, actual: encoded.rawSha256 });
        fail(`${id}/${stubFile}: 迁移改变 raw 哈希/长度`);
      }
      if (!collectWorldRefs(encoded.parts, builder).length) {
        fail(`${id}/${stubFile}: 迁移后不含任何 world ref，拒绝计为 migrated`);
      }
      const rebuilt = builder.renderParts(encoded.parts);
      if (!rebuilt.equals(raw)) {
        report.rebuildMismatches.push({ cassette: id, stub: stubFile });
        fail(`${id}/${stubFile}: 迁移后 world 渲染与原始 body 不一致`);
      }
      nextCanonical = canonicalOf(rebuilt, rules);
      if (nextCanonical !== canonical) {
        report.canonicalMismatches.push({ cassette: id, stub: stubFile });
        fail(`${id}/${stubFile}: 迁移改变 canonical body`);
      }
      nextStub = { ...encoded, canonicalSha256: sha256(canonical) };
      nextStubBytes = serializeRequestStub(nextStub);
      changed = true;
      report.migratedStubs += 1;
    }
    stubOutputs.push({ file: stubFile, bytes: nextStubBytes });
    sealedFiles[stubFile] = sha256(nextStubBytes);
    requestMeta[stubFile] = nextStub === stub
      ? seal.requestMeta[stubFile]
      : { requestCoreSha256: requestCoreSha256(nextStub), worldRefs: collectWorldRefs(nextStub.parts, builder) };
    if (!requestMeta[stubFile]?.requestCoreSha256 || !Array.isArray(requestMeta[stubFile]?.worldRefs)) {
      fail(`${id}/${stubFile}: 原 seal requestMeta 无效`);
    }
    expectedCanonical.set(`${id}/${stubFile}`, nextCanonical);

    const responseBytes = await readFile(path.join(source, entry.response.file));
    if (responseBytes.length !== entry.response.size || sha256(responseBytes) !== entry.response.sha256) {
      report.responseChanges.push({ cassette: id, file: entry.response.file });
      fail(`${id}/${entry.response.file}: 响应字节与 manifest 不符`);
    }
    report.responseFiles += 1;
    report.responseBytes += responseBytes.length;
    responseOutputs.push({ file: entry.response.file, bytes: responseBytes });
  }
  if (changed) report.changedCassettes.push(id);
  if (!dryRun && changed) {
    for (const { file, bytes } of stubOutputs) {
      await writeFile(path.join(output, 'requests', path.basename(file)), bytes, { mode: 0o600 });
    }
    for (const { file, bytes } of responseOutputs) {
      await writeFile(path.join(output, 'responses', path.basename(file)), bytes, { mode: 0o600 });
    }
    await writeFile(path.join(output, 'manifest.json'), manifestBytes, { mode: 0o600 });
    const nextSeal = {
      formatVersion: CASSETTE_FORMAT_VERSION,
      manifestSha256: sha256(manifestBytes),
      files: sortedObject(Object.entries(sealedFiles)),
      requestMeta: sortedObject(Object.entries(requestMeta)),
    };
    await writeFile(path.join(output, 'seal.json'), `${JSON.stringify(nextSeal)}\n`, { mode: 0o600 });
  }
  return { changed, expectedCanonical };
}

/**
 * 先换 world 再换 cassette；任一步失败按逆序恢复。
 * 备份目录位于 stagingBase 之外，回滚失败时不会被 finally 清理；错误中给出可人工恢复的准确路径。
 */
async function commit({ fixtures, worldDir, stagedWorldDir, stagedById, backupBase, renameOp, rmOp, mkdirOp, log = () => {} }) {
  const previousWorld = path.join(backupBase, 'world');
  const cassetteBackupRoot = path.join(backupBase, 'cassettes');
  const backups = [];
  let worldBackedUp = false;
  let worldSwapped = false;
  try {
    await renameOp(worldDir, previousWorld);
    worldBackedUp = true;
    await renameOp(stagedWorldDir, worldDir);
    worldSwapped = true;
    for (const [id, output] of stagedById) {
      const target = path.join(fixtures, id, 'cassette');
      const backup = path.join(cassetteBackupRoot, id, 'cassette');
      await mkdirOp(path.dirname(backup), { recursive: true });
      await renameOp(target, backup);
      backups.push({ target, backup });
      await renameOp(output, target);
    }
  } catch (error) {
    const rollbackErrors = [];
    const unrestoredBackups = [];
    for (const { target, backup } of [...backups].reverse()) {
      try { await rmOp(target, { recursive: true, force: true }); } catch (rollbackError) { rollbackErrors.push(rollbackError); }
      try { await renameOp(backup, target); }
      catch (rollbackError) {
        rollbackErrors.push(rollbackError);
        unrestoredBackups.push(backup);
      }
    }
    let worldRestored = false;
    if (worldBackedUp) {
      try {
        if (worldSwapped) await rmOp(worldDir, { recursive: true, force: true });
        await renameOp(previousWorld, worldDir);
        worldRestored = true;
      } catch (rollbackError) { rollbackErrors.push(rollbackError); }
    }
    if (rollbackErrors.length) {
      const kept = [];
      if (worldBackedUp) {
        kept.push(worldRestored ? `旧 world 已回滚到 ${worldDir}` : `旧 world: ${previousWorld}`);
      }
      if (unrestoredBackups.length) kept.push(`cassette 备份: ${[...new Set(unrestoredBackups)].join(', ')}`);
      throw new AggregateError(
        [error, ...rollbackErrors],
        `迁移替换失败且回滚失败；${kept.join('；') || `备份目录: ${backupBase}`}（对应备份已保留，请人工核对）`,
      );
    }
    await rmOp(backupBase, { recursive: true, force: true })
      .catch((cleanupError) => log(`回滚成功但备份清理失败：${backupBase}（${cleanupError.message}）`));
    throw error;
  }
  await rmOp(backupBase, { recursive: true, force: true })
    .catch((cleanupError) => log(`迁移完成但备份清理失败：${backupBase}（${cleanupError.message}）`));
}

/**
 * @returns {Promise<object>} 迁移报告；dryRun 时不写磁盘。
 */
export async function migrateReplayLiterals({ fixtures, dryRun = false, log = () => {}, ops = {} } = {}) {
  const renameOp = ops.rename ?? rename;
  const rmOp = ops.rm ?? rm;
  const mkdirOp = ops.mkdir ?? mkdir;
  const root = path.resolve(fixtures);
  const worldDir = path.join(root, 'world');
  const world = await loadWorld(worldDir);
  const builder = createWorldBuilderFromWorld(world);
  const { slots } = createSlotResolver({ world: builder, builder });
  const previousLeaves = new Map(world.leafIds().map((id) => [id, sha256(world.leafBytes(id))]));
  const previousRecipes = new Map(world.recipeIds().map((id) => [id, JSON.stringify(world.recipeParts(id))]));

  const report = {
    dryRun,
    fixtures: root,
    cassettes: 0,
    changedCassettes: [],
    stubs: 0,
    literalStubs: 0,
    migratedStubs: 0,
    refStubsUnchanged: 0,
    legacyStubs: 0,
    rawMismatches: [],
    canonicalMismatches: [],
    rebuildMismatches: [],
    responseFiles: 0,
    responseBytes: 0,
    responseChanges: [],
    newLeaves: [],
    newRecipes: [],
    oldLeavesChanged: [],
    oldRecipesChanged: [],
    written: null,
  };
  const ids = await cassetteIds(root);
  report.cassettes = ids.length;
  const stagingBase = await mkdtemp(path.join(root, '.migrate-refs-'));
  const stagedWorldDir = path.join(stagingBase, 'world');
  const stagedById = new Map();
  const expectedByCassette = new Map();

  try {
    for (const id of ids) {
      const source = path.join(root, id, 'cassette');
      const output = path.join(stagingBase, 'cassettes', id, 'cassette');
      if (!dryRun) {
        await mkdir(path.join(output, 'requests'), { recursive: true, mode: 0o700 });
        await mkdir(path.join(output, 'responses'), { recursive: true, mode: 0o700 });
      }
      const { changed, expectedCanonical } = await migrateCassette({ id, source, output, builder, slots, dryRun, report });
      if (!dryRun && changed) {
        stagedById.set(id, output);
        expectedByCassette.set(id, expectedCanonical);
      }
    }

    for (const id of previousLeaves.keys()) {
      if (!builder.hasLeaf(id) || sha256(builder.leafBytes(id)) !== previousLeaves.get(id)) report.oldLeavesChanged.push(id);
    }
    for (const [id, parts] of previousRecipes) {
      if (JSON.stringify(builder.recipeParts(id)) !== parts) report.oldRecipesChanged.push(id);
    }
    if (report.oldLeavesChanged.length || report.oldRecipesChanged.length) {
      fail(`迁移改写了既有 world 内容：leaves=${report.oldLeavesChanged.join(',')} recipes=${report.oldRecipesChanged.join(',')}`);
    }
    report.newLeaves = builder.leafIds().filter((id) => !previousLeaves.has(id));
    report.newRecipes = builder.recipeIds().filter((id) => !previousRecipes.has(id));
    const unexpected = [
      ...report.newLeaves.filter((id) => !NEW_LEAF_PATTERNS.some((pattern) => pattern.test(id))).map((id) => `leaf:${id}`),
      ...report.newRecipes.filter((id) => !NEW_RECIPE_PATTERNS.some((pattern) => pattern.test(id))).map((id) => `recipe:${id}`),
    ];
    if (unexpected.length) fail(`迁移新增了非预期形状的 world 条目：${unexpected.join(', ')}`);
    report.world = {
      before: { leaves: previousLeaves.size, recipes: previousRecipes.size },
      after: { leaves: builder.leafIds().length, recipes: builder.recipeIds().length },
    };

    if (dryRun) return report;

    const sealed = await builder.seal(stagedWorldDir);
    for (const [id, output] of stagedById) {
      const staged = await loadCassette(output, { worldDir: stagedWorldDir });
      if (staged.report.legacy.length || staged.report.worldDrift.length) fail(`${id}: staging 出现 legacy/world drift`);
      const expectedEntries = JSON.parse(await readFile(path.join(root, id, 'cassette', 'manifest.json'), 'utf8')).entries;
      if (staged.entries.size !== expectedEntries.length) fail(`${id}: staging entry 数量变化`);
      for (const entry of staged.entries.values()) {
        const canonical = expectedByCassette.get(id).get(`${id}/${entry.request.stub}`);
        if (canonical !== null && entry.request.canonicalBody !== canonical) fail(`${id}/${entry.request.stub}: staging canonical 不一致`);
      }
      log(`verified ${id}: ${staged.entries.size} entries`);
    }
    const backupBase = await mkdtemp(path.join(root, '.migrate-refs-backup-'));
    await commit({
      fixtures: root, worldDir, stagedWorldDir, stagedById, backupBase,
      renameOp, rmOp, mkdirOp, log,
    });
    report.written = {
      world: {
        generation: sealed.generation, manifestSha256: sealed.manifestSha256,
        leaves: sealed.leaves, recipes: sealed.recipes,
      },
      cassettes: [...stagedById.keys()],
    };
    return report;
  } finally {
    await rm(stagingBase, { recursive: true, force: true });
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const { values } = parseArgs({
    options: {
      fixtures: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      json: { type: 'boolean', default: true },
    },
  });
  const fixtures = path.resolve(values.fixtures ?? path.join(e2eRoot, 'fixtures/replay-v2'));
  const report = await migrateReplayLiterals({ fixtures, dryRun: values['dry-run'], log: (line) => console.error(line) });
  console.log(JSON.stringify(report, null, 2));
}
