#!/usr/bin/env node
/**
 * 一次性迁移：把遗留的整体工具数组 leaf（tools.sha256.*）替换为命名 recipe，
 * 让工具 description 的 source-anchored leaf 与受控重锚文案能进入这些录制。
 *
 * 迁移是显式重锚：只允许工具 description（含 schema 内嵌 description）与旧 leaf 不同，
 * 其余工具字段必须逐字段一致；stub 的 raw/canonical 哈希、seal 文件哈希与
 * requestMeta 同步更新。默认 dry-run，--write 才落盘。
 */
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const here = path.dirname(fileURLToPath(import.meta.url));
const e2eRoot = path.resolve(here, '..');
const load = (relative) => import(pathToFileURL(path.join(e2eRoot, relative)));
const { sha256 } = await load('llm-replay/matcher.mjs');
const {
  canonicalRecordedBody, collectWorldRefs, decodeRequestStub, expandTypedTemplateRules,
  loadWorld, requestCoreSha256, serializeRequestStub,
} = await load('llm-replay/world-store.mjs');
const { values } = parseArgs({
  options: {
    fixtures: { type: 'string', default: path.join(e2eRoot, 'fixtures/replay-v2') },
    write: { type: 'boolean', default: false },
  },
});

const fixturesRoot = path.resolve(values.fixtures);
const world = await loadWorld(path.join(fixturesRoot, 'world'));

const RECIPE_CANDIDATES = ['tools.anthropic.main', 'tools.anthropic.sub', 'tools.responses.main'];
const LEGACY_PREFIX = 'tools.sha256.';

/** 允许 description（含 schema 内嵌）差异；key 顺序与其余字段必须逐项一致。 */
function assertDescriptionOnly(left, right, at) {
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      throw new Error(`${at}: 数组结构不一致，拒绝迁移`);
    }
    left.forEach((value, index) => assertDescriptionOnly(value, right[index], `${at}[${index}]`));
    return;
  }
  if (left && typeof left === 'object' && right && typeof right === 'object') {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    if (leftKeys.join('\u0000') !== rightKeys.join('\u0000')) {
      throw new Error(`${at}: key 集合或顺序不一致（${leftKeys} != ${rightKeys}），拒绝迁移`);
    }
    for (const key of leftKeys) {
      // 参数名本身可以叫 description；只有 schema 关键字上的字符串 description 才可放宽。
      if (key === 'description' && typeof left[key] === 'string' && typeof right[key] === 'string') continue;
      assertDescriptionOnly(left[key], right[key], `${at}.${key}`);
    }
    return;
  }
  if (!Object.is(left, right)) throw new Error(`${at}: 非 description 字段不一致，拒绝迁移`);
}

/** 逐工具允许 description 差异；工具 name/顺序与其余字段必须完全一致。 */
function assertOnlyDescriptionDiff(legacyBytes, recipeBytes, id, recipe) {
  const legacy = JSON.parse(legacyBytes.toString('utf8'));
  const current = JSON.parse(recipeBytes.toString('utf8'));
  if (!Array.isArray(legacy) || !Array.isArray(current) || legacy.length !== current.length) {
    throw new Error(`${id}: 工具数组与 ${recipe} 结构不一致，拒绝迁移`);
  }
  for (let index = 0; index < legacy.length; index += 1) {
    const left = legacy[index];
    const right = current[index];
    if (left?.name !== right?.name) throw new Error(`${id}: 工具顺序 ${index} 不一致，拒绝迁移`);
    assertDescriptionOnly(left, right, `${recipe}[${index}].${left?.name}`);
  }
}

const cassettes = (await readdir(fixturesRoot, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'world')
  .map((entry) => entry.name)
  .sort();

const changed = [];
for (const cassetteId of cassettes) {
  const directory = path.join(fixturesRoot, cassetteId, 'cassette');
  let manifest;
  let seal;
  try {
    manifest = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8'));
    seal = JSON.parse(await readFile(path.join(directory, 'seal.json'), 'utf8'));
  } catch { continue; }
  let cassetteChanged = false;
  for (const entry of manifest.entries) {
    const stubFile = path.join(directory, entry.request.stub);
    const stub = JSON.parse(await readFile(stubFile, 'utf8'));
    let nextStub = structuredClone(stub);
    let replaced = false;
    for (const [index, part] of nextStub.parts.entries()) {
      if (!part || typeof part !== 'object' || Array.isArray(part) || typeof part.leaf !== 'string'
          || !part.leaf.startsWith(LEGACY_PREFIX)) continue;
      const legacyBytes = world.leafBytes(part.leaf);
      if (!legacyBytes) throw new Error(`${part.leaf}: world 缺少 leaf，拒绝迁移`);
      let selected = null;
      for (const recipe of RECIPE_CANDIDATES) {
        const recipeBytes = world.render({ recipe });
        try {
          assertOnlyDescriptionDiff(legacyBytes, recipeBytes, part.leaf, recipe);
          selected = recipe;
          break;
        } catch { /* 尝试下一个候选，全部失败时由下方显式报错 */ }
      }
      if (!selected) throw new Error(`${part.leaf}: 与已知工具 recipe 的差异超出 description，拒绝迁移`);
      nextStub.parts[index] = { recipe: selected };
      replaced = true;
      console.log(`${cassetteId} ${entry.identity.call}: ${part.leaf} -> ${selected}`);
    }
    if (!replaced) continue;
    const bytes = world.renderParts(nextStub.parts);
    nextStub = {
      ...nextStub,
      rawBytes: bytes.length,
      rawSha256: sha256(bytes),
    };
    const expanded = expandTypedTemplateRules(entry.requestRules ?? [], bytes);
    const canonical = canonicalRecordedBody(bytes, expanded.rules, expanded.bindings);
    nextStub.canonicalSha256 = sha256(canonical);
    const stubBytes = serializeRequestStub(nextStub);
    const relative = entry.request.stub;
    seal.files[relative] = sha256(stubBytes);
    seal.requestMeta[relative] = {
      requestCoreSha256: requestCoreSha256(nextStub),
      worldRefs: collectWorldRefs(nextStub.parts, world),
    };
    changed.push({ cassetteId, call: entry.identity.call, file: stubFile, bytes: stubBytes });
    cassetteChanged = true;
  }
  if (cassetteChanged) {
    seal.manifestSha256 = sha256(await readFile(path.join(directory, 'manifest.json')));
    changed.push({ cassetteId, seal: path.join(directory, 'seal.json'), bytes: Buffer.from(`${JSON.stringify(seal)}\n`) });
  }
}

console.log(JSON.stringify({
  changed: changed.filter((item) => item.file).length,
  cassettes: [...new Set(changed.map((item) => item.cassetteId))],
  write: values.write,
}, null, 2));

if (values.write) {
  for (const item of changed) await writeFile(item.file ?? item.seal, item.bytes);
}
