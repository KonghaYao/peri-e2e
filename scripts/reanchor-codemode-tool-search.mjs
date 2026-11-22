#!/usr/bin/env node
/**
 * 一次性迁移（续）：把 codemode builtin skill 纳入 T05 回放请求里记录的
 * “工具搜索结果”文本。
 *
 * 前一迁移 `reanchor-codemode-skill.mjs` 只更新了 world leaf 中的系统提示词；
 * T05 的两个请求把 `mcp_read_resource` 的资源清单作为**字面量**编码在 stub 的
 * parts 里（不是 world leaf），因此需要单独重写：
 *   - `skill://builtin/cron/SKILL.md` 前插入
 *     `skill://builtin/codemode/SKILL.md, `（+35 字节）；
 *   - `(23 resources)` → `(24 resources)`（同长度）。
 *
 * 响应字节、world、cassette manifest 均不变；只重算 stub 的 raw/canonical
 * 哈希与 cassette seal。
 */
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const e2eRoot = path.resolve(here, '..');
const fixtures = path.join(e2eRoot, 'fixtures/replay-v2');
const worldDir = path.join(fixtures, 'world');
const scenario = 'T05';
const cassetteDir = path.join(fixtures, scenario, 'cassette');
const load = (relative) => import(pathToFileURL(path.join(e2eRoot, relative)).href);

const { loadWorld, serializeRequestStub, expandTypedTemplateRules, canonicalRecordedBody,
  collectWorldRefs, requestCoreSha256, CASSETTE_FORMAT_VERSION } = await load('llm-replay/world-store.mjs');
const { sha256 } = await load('llm-replay/matcher.mjs');
const { loadCassette } = await load('llm-replay/cassette.mjs');

const URI_OLD = 'skill://builtin/ultracode/SKILL.md, skill://builtin/cron/SKILL.md';
const URI_NEW = 'skill://builtin/ultracode/SKILL.md, skill://builtin/codemode/SKILL.md, skill://builtin/cron/SKILL.md';
const COUNT_OLD = '(23 resources)';
const COUNT_NEW = '(24 resources)';
const EXPECTED_DELTA = Buffer.byteLength(URI_NEW) - Buffer.byteLength(URI_OLD);
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const countOf = (haystack, needle) => haystack.split(needle).length - 1;
const sortedObject = (entries) => Object.fromEntries(entries.sort(([left], [right]) => left.localeCompare(right)));

const world = await loadWorld(worldDir);
const manifestBytes = await readFile(path.join(cassetteDir, 'manifest.json'));
const manifest = JSON.parse(manifestBytes.toString('utf8'));
const seal = JSON.parse(await readFile(path.join(cassetteDir, 'seal.json'), 'utf8'));
assert(manifest.formatVersion === CASSETTE_FORMAT_VERSION, 'T05 cassette 不是 v2');
assert(seal.formatVersion === CASSETTE_FORMAT_VERSION && seal.manifestSha256 === sha256(manifestBytes),
  'T05 cassette seal 或 manifest 校验失败');
assert(seal.requestMeta && seal.files, 'T05 seal 缺少文件清单');

const staging = await mkdtemp(path.join(fixtures, '.reanchor-codemode-tools-'));
const output = path.join(staging, scenario, 'cassette');
await mkdir(path.join(output, 'requests'), { recursive: true, mode: 0o700 });
await mkdir(path.join(output, 'responses'), { recursive: true, mode: 0o700 });

const sealedFiles = {};
const requestMeta = {};
const expectedCanonical = new Map();
let changed = 0;

for (const entry of manifest.entries) {
  const stubFile = entry.request.stub;
  const stubBytes = await readFile(path.join(cassetteDir, stubFile));
  assert(seal.files[stubFile] === sha256(stubBytes), `${stubFile}: stub 未纳入 seal`);
  const stub = JSON.parse(stubBytes.toString('utf8'));
  assert(stub.v === 2 && Array.isArray(stub.parts), `${stubFile}: stub 不是 v2`);

  const beforeBytes = world.renderParts(stub.parts);
  assert(sha256(beforeBytes) === stub.rawSha256, `${stubFile}: 逆推 rawSha256 不符`);
  const beforeExpanded = expandTypedTemplateRules(entry.requestRules ?? [], beforeBytes);
  const beforeCanonical = canonicalRecordedBody(beforeBytes, beforeExpanded.rules, beforeExpanded.bindings);
  assert(sha256(beforeCanonical) === stub.canonicalSha256, `${stubFile}: 逆推 canonicalSha256 不符`);

  const beforeText = beforeBytes.toString('utf8');
  const uriCount = countOf(beforeText, URI_OLD);
  const countCount = countOf(beforeText, COUNT_OLD);
  assert(uriCount === countCount, `${stubFile}: URI 与资源计数出现次数不一致`);
  assert(uriCount <= 1, `${stubFile}: 旧资源清单出现多次`);

  let nextParts = stub.parts;
  if (uriCount === 1) {
    let replaced = 0;
    nextParts = stub.parts.map((part) => {
      if (typeof part !== 'string' || !part.includes(URI_OLD)) return part;
      assert(countOf(part, URI_OLD) === 1, `${stubFile}: 单个字符串 part 内 URI 出现多次`);
      assert(countOf(part, COUNT_OLD) === 1, `${stubFile}: 单个字符串 part 内资源计数出现多次`);
      replaced += 1;
      return part.replace(URI_OLD, URI_NEW).replace(COUNT_OLD, COUNT_NEW);
    });
    assert(replaced === 1, `${stubFile}: 未能定位旧资源清单所在 part`);
    changed += 1;
  }

  const afterBytes = world.renderParts(nextParts);
  if (uriCount === 1) {
    assert(afterBytes.length - beforeBytes.length === EXPECTED_DELTA,
      `${stubFile}: 字节差应为 ${EXPECTED_DELTA}，实际 ${afterBytes.length - beforeBytes.length}`);
    // 系统提示词里已有一份 codemode URI；这里只要求比迁移前多一处。
    assert(countOf(afterBytes.toString('utf8'), 'codemode/SKILL.md')
      === countOf(beforeText, 'codemode/SKILL.md') + 1, `${stubFile}: 新 URI 未唯一写入`);
  } else {
    assert(afterBytes.equals(beforeBytes), `${stubFile}: 未命中却改写字节`);
  }
  const afterExpanded = expandTypedTemplateRules(entry.requestRules ?? [], afterBytes);
  const afterCanonical = canonicalRecordedBody(afterBytes, afterExpanded.rules, afterExpanded.bindings);
  if (uriCount === 1) {
    assert(countOf(afterCanonical, 'codemode/SKILL.md')
      === countOf(beforeCanonical, 'codemode/SKILL.md') + 1, `${stubFile}: canonical body 缺少新 URI`);
    assert(afterCanonical.length - beforeCanonical.length === EXPECTED_DELTA,
      `${stubFile}: canonical 字节差应为 ${EXPECTED_DELTA}`);
  } else {
    assert(afterCanonical === beforeCanonical, `${stubFile}: 未命中却改写 canonical`);
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
    worldRefs: collectWorldRefs(nextStub.parts, world),
  };
  expectedCanonical.set(stubFile, afterCanonical);

  const responseBytes = await readFile(path.join(cassetteDir, entry.response.file));
  assert(responseBytes.length === entry.response.size && sha256(responseBytes) === entry.response.sha256,
    `${entry.response.file}: 响应字节与 manifest 不符`);
  await writeFile(path.join(output, entry.response.file), responseBytes, { mode: 0o600 });
}

assert(changed === 2, `应更新 2 个 T05 stub，实际 ${changed}`);

await writeFile(path.join(output, 'manifest.json'), manifestBytes, { mode: 0o600 });
const nextSeal = {
  formatVersion: CASSETTE_FORMAT_VERSION,
  manifestSha256: sha256(manifestBytes),
  files: sortedObject(Object.entries(sealedFiles)),
  requestMeta: sortedObject(Object.entries(requestMeta)),
};
await writeFile(path.join(output, 'seal.json'), `${JSON.stringify(nextSeal)}\n`, { mode: 0o600 });

const staged = await loadCassette(output, { worldDir });
assert(staged.report.legacy.length === 0, 'staging 出现 legacy body');
assert(staged.report.worldDrift.length === 0, 'staging 出现 world drift');
for (const entry of staged.entries.values()) {
  assert(entry.request.canonicalBody === expectedCanonical.get(entry.request.stub),
    `${entry.request.stub}: staging canonical body 与重算值不一致`);
}

const backup = path.join(staging, 'backup', scenario, 'cassette');
await mkdir(path.dirname(backup), { recursive: true });
await rename(cassetteDir, backup);
try {
  await rename(output, cassetteDir);
} catch (error) {
  await rename(backup, cassetteDir).catch(() => {});
  throw error;
}
await rm(staging, { recursive: true, force: true }).catch((error) => {
  console.error(`cassette 已替换，但 staging 清理失败：${error}`);
});
console.log(`T05 re-anchored: 2 stubs, +${EXPECTED_DELTA} bytes each`);
