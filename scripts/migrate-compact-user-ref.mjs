#!/usr/bin/env node
/**
 * 一次性迁移：把 U06 manual-compact 请求里的 summary user prompt literal 改写为
 * sys.compact.user ref。
 *
 * 混合结构不能走 `migrate-replay-literals.mjs`（它只处理纯 literal stub）。这里只替换
 * 已录制 prompt 对应的 JSON 字符串跨度；raw/canonical/response 三类字节必须保持等价，
 * 且迁移后该条 compact 请求必须不再产生 worldDrift。
 */
import { cp, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const here = path.dirname(fileURLToPath(import.meta.url));
const e2eRoot = path.resolve(here, '..');
const load = (relative) => import(pathToFileURL(path.join(e2eRoot, relative)));
const { identityKey, sha256 } = await load('llm-replay/matcher.mjs');
const {
  CASSETTE_FORMAT_VERSION, canonicalRecordedBody, collectWorldRefs, createWorldBuilderFromWorld,
  expandTypedTemplateRules, loadWorld, requestCoreSha256, serializeRequestStub,
} = await load('llm-replay/world-store.mjs');
const { loadCassette } = await load('llm-replay/cassette.mjs');
const { STABLE_LEAVES, SOURCE_FILES, renderCompactUserPrompt } = await load('scripts/replay-world-sources.mjs');
const { assertPeriRoot, resolvePeriRoot } = await load('scripts/peri-root.mjs');

const { values } = parseArgs({
  options: {
    fixtures: { type: 'string' },
    'peri-root': { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
  },
});

const fail = (message) => { throw new Error(message); };
const sortedObject = (entries) => Object.fromEntries(entries.sort(([left], [right]) => left.localeCompare(right)));
const canonicalOf = (bytes, rules) => {
  const expanded = expandTypedTemplateRules(rules, bytes);
  return canonicalRecordedBody(bytes, expanded.rules, expanded.bindings);
};

/** 在 stub 字面量中定位录制 prompt 的唯一 JSON 字符串跨度。 */
function locatePrompt(parts, encoded) {
  const hits = [];
  for (const [index, part] of parts.entries()) {
    if (typeof part !== 'string') continue;
    let from = 0;
    while ((from = part.indexOf(encoded, from)) !== -1) {
      hits.push({ index, at: from });
      from += encoded.length;
    }
  }
  if (hits.length !== 1) fail(`U06 compact stub 中 prompt literal 出现 ${hits.length} 次，期望恰好 1 次；请先对齐 Peri 源与录制`);
  return hits[0];
}

const fixtures = path.resolve(values.fixtures ?? path.join(e2eRoot, 'fixtures/replay-v2'));
const periRoot = await assertPeriRoot(resolvePeriRoot(values['peri-root']));
const worldDir = path.join(fixtures, 'world');
const cassetteDir = path.join(fixtures, 'U06/cassette');
const userLeafId = STABLE_LEAVES.compactUser;

const world = await loadWorld(worldDir);
const manifestBytes = await readFile(path.join(cassetteDir, 'manifest.json'));
const sealBytes = await readFile(path.join(cassetteDir, 'seal.json'));
const manifest = JSON.parse(manifestBytes.toString('utf8'));
const seal = JSON.parse(sealBytes.toString('utf8'));
if (manifest.formatVersion !== CASSETTE_FORMAT_VERSION || seal.formatVersion !== CASSETTE_FORMAT_VERSION
    || seal.manifestSha256 !== sha256(manifestBytes)) fail('U06 cassette 不是自洽的 v2');

const compactEntry = manifest.entries.find((entry) => entry.identity?.purpose === 'compact');
if (!compactEntry) fail('U06 cassette 缺少 purpose=compact 的请求');
const compactEntryId = sha256(identityKey(compactEntry.identity));
const stubFile = compactEntry.request.stub;
const stubBytes = await readFile(path.join(cassetteDir, stubFile));
if (seal.files?.[stubFile] !== sha256(stubBytes)) fail('U06 compact stub 未纳入 seal');
const stub = JSON.parse(stubBytes.toString('utf8'));
if (stub.v !== 2 || !Array.isArray(stub.parts) || !stub.parts.length) fail('U06 compact stub 结构无效');
if (stub.parts.some((part) => part && typeof part === 'object' && part.leaf === userLeafId)) {
  console.log(JSON.stringify({ skipped: true, reason: 'already-migrated', stub: stubFile }));
  process.exit(0);
}

const sourcePrompt = renderCompactUserPrompt(await readFile(path.join(periRoot, SOURCE_FILES.compactUser), 'utf8'));
const encodedPrompt = JSON.stringify(sourcePrompt);
const raw = world.renderParts(stub.parts);
if (raw.length !== stub.rawBytes || sha256(raw) !== stub.rawSha256) {
  fail('U06 compact 请求与当前 world 不一致；请先运行 world:sync 或重录后再迁移');
}
const rules = compactEntry.requestRules ?? [];
const recordedCanonical = canonicalOf(raw, rules);
if (sha256(recordedCanonical) !== stub.canonicalSha256) fail('U06 compact 录制 canonical 重建失败');

const hit = locatePrompt(stub.parts, encodedPrompt);
const literal = stub.parts[hit.index];
const nextParts = [
  ...stub.parts.slice(0, hit.index),
  ...(hit.at ? [literal.slice(0, hit.at)] : []),
  { leaf: userLeafId, as: 'json-string' },
  ...(hit.at + encodedPrompt.length < literal.length ? [literal.slice(hit.at + encodedPrompt.length)] : []),
  ...stub.parts.slice(hit.index + 1),
];
const nextStub = { ...stub, parts: nextParts };
const builder = createWorldBuilderFromWorld(world);
const promptBytes = Buffer.from(sourcePrompt, 'utf8');
if (builder.hasLeaf(userLeafId) && !builder.leafBytes(userLeafId).equals(promptBytes)) {
  fail(`world 已存在内容不同的 ${userLeafId}；请先审核并 world:sync`);
}
builder.addLeaf(userLeafId, promptBytes);

const rebuilt = builder.renderParts(nextParts);
if (!rebuilt.equals(raw)) fail('迁移后 world 渲染与原始 body 不一致');
if (sha256(rebuilt) !== stub.rawSha256) fail('迁移改变 raw 哈希');
if (canonicalOf(rebuilt, rules) !== recordedCanonical) fail('迁移改变 canonical body');

const stagingBase = await mkdtemp(path.join(fixtures, '.migrate-compact-user-'));
const stagedWorldDir = path.join(stagingBase, 'world');
const stagedCassetteDir = path.join(stagingBase, 'U06/cassette');
let committed = false;
try {
  await builder.seal(stagedWorldDir);
  const stagedWorld = await loadWorld(stagedWorldDir);

  await cp(cassetteDir, stagedCassetteDir, { recursive: true });
  const nextStubBytes = serializeRequestStub(nextStub);
  await writeFile(path.join(stagedCassetteDir, stubFile), nextStubBytes, { mode: 0o600 });
  const nextSeal = {
    formatVersion: CASSETTE_FORMAT_VERSION,
    manifestSha256: sha256(manifestBytes),
    files: sortedObject(Object.entries({ ...seal.files, [stubFile]: sha256(nextStubBytes) })),
    requestMeta: sortedObject(Object.entries({
      ...seal.requestMeta,
      [stubFile]: {
        requestCoreSha256: requestCoreSha256(nextStub),
        worldRefs: collectWorldRefs(nextStub.parts, stagedWorld),
      },
    })),
  };
  await writeFile(path.join(stagedCassetteDir, 'seal.json'), `${JSON.stringify(nextSeal)}\n`, { mode: 0o600 });

  // 未迁移的请求仍可能有已批准的 block0/Agent drift；只要求目标 compact 请求归零。
  const before = await loadCassette(cassetteDir, { world });
  const after = await loadCassette(stagedCassetteDir, { world: stagedWorld });
  if (after.report.legacy.length) fail(`迁移后出现 legacy stub：${JSON.stringify(after.report.legacy)}`);
  if (after.report.worldDrift.some((item) => item.entry === compactEntryId)) {
    fail(`迁移后 compact 请求仍存在 worldDrift：${JSON.stringify(after.report.worldDrift)}`);
  }
  const beforeDrift = before.report.worldDrift.map((item) => item.entry).sort();
  const afterDrift = after.report.worldDrift.map((item) => item.entry).sort();
  if (JSON.stringify(beforeDrift) !== JSON.stringify(afterDrift)) {
    fail(`迁移改变了其它请求的 worldDrift：${JSON.stringify({ before: before.report.worldDrift, after: after.report.worldDrift })}`);
  }

  const report = {
    dryRun: values['dry-run'],
    entry: compactEntryId,
    stub: stubFile,
    leaf: userLeafId,
    promptBytes: promptBytes.length,
    rawBytes: raw.length,
    rawSha256: stub.rawSha256,
    canonicalSha256: stub.canonicalSha256,
    requestCoreSha256: nextSeal.requestMeta[stubFile].requestCoreSha256,
    worldRefs: nextSeal.requestMeta[stubFile].worldRefs.map((ref) => ref.id),
    existingWorldDrift: after.report.worldDrift,
    worldGeneration: stagedWorld.manifest.generation,
  };
  if (!values['dry-run']) {
    const previousWorld = path.join(stagingBase, 'previous-world');
    const previousCassette = path.join(stagingBase, 'previous-cassette');
    await rename(worldDir, previousWorld);
    await rename(stagedWorldDir, worldDir);
    let cassetteBackedUp = false;
    try {
      await rename(cassetteDir, previousCassette);
      cassetteBackedUp = true;
      await rename(stagedCassetteDir, cassetteDir);
    } catch (error) {
      const rollback = [];
      if (cassetteBackedUp) {
        try {
          await rm(cassetteDir, { recursive: true, force: true });
          await rename(previousCassette, cassetteDir);
        } catch (restoreError) {
          rollback.push(restoreError);
        }
      }
      try {
        await rm(worldDir, { recursive: true, force: true });
        await rename(previousWorld, worldDir);
      } catch (restoreError) {
        rollback.push(restoreError);
      }
      if (rollback.length) {
        throw new AggregateError(
          [error, ...rollback],
          `迁移替换失败且回滚失败；旧 world/cassette 保留在 ${stagingBase}，请人工恢复`,
        );
      }
      throw error;
    }
    await rm(previousWorld, { recursive: true, force: true });
    await rm(previousCassette, { recursive: true, force: true });
    committed = true;
    await rm(stagingBase, { recursive: true, force: true })
      .catch((error) => console.error(`迁移完成但 staging 清理失败：${stagingBase}（${error.message}）`));
    console.log(JSON.stringify({ ...report, written: true }, null, 2));
  } else {
    console.log(JSON.stringify({ ...report, written: false }, null, 2));
  }
} finally {
  if (!committed) await rm(stagingBase, { recursive: true, force: true });
}

// 提交后复核真实目录；失败时留下准确位置供人工恢复。
if (!values['dry-run']) {
  const reloaded = await loadCassette(cassetteDir);
  if (reloaded.report.worldDrift.some((item) => item.entry === compactEntryId)) {
    fail(`提交后 compact 请求仍存在 worldDrift：${JSON.stringify(reloaded.report.worldDrift)}`);
  }
}
