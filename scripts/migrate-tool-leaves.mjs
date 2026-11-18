#!/usr/bin/env node
/**
 * 一次性迁移：把遗留的整体工具数组 leaf（tools.sha256.*）替换为命名 recipe，
 * 让 Bash/Agent 的 source-anchored leaf 能进入这些录制。
 *
 * 迁移是显式重锚：只允许目标 recipe 与旧 leaf 在受管 description 上不同，
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

const RECIPE_CANDIDATES = ['tools.anthropic.main', 'tools.anthropic.sub'];
const LEGACY_PREFIX = 'tools.sha256.';

/** 只允许 Bash 的 description 不同；其余工具字段必须完全一致。 */
function assertOnlyBashDescriptionDiff(legacyBytes, recipeBytes, id, recipe) {
  const legacy = JSON.parse(legacyBytes.toString('utf8'));
  const current = JSON.parse(recipeBytes.toString('utf8'));
  if (!Array.isArray(legacy) || !Array.isArray(current) || legacy.length !== current.length) {
    throw new Error(`${id}: 工具数组与 ${recipe} 结构不一致，拒绝迁移`);
  }
  const describe = (tool) => JSON.stringify({ ...tool, description: undefined });
  for (let index = 0; index < legacy.length; index += 1) {
    const left = legacy[index];
    const right = current[index];
    if (left?.name !== right?.name) throw new Error(`${id}: 工具顺序 ${index} 不一致，拒绝迁移`);
    if (left?.name !== 'Bash' && JSON.stringify(left) !== JSON.stringify(right)) {
      throw new Error(`${id}: 工具 ${left?.name} 与 ${recipe} 不一致，拒绝迁移`);
    }
    if (left?.name === 'Bash' && describe(left) !== describe(right)) {
      throw new Error(`${id}: Bash 非 description 字段与 ${recipe} 不一致，拒绝迁移`);
    }
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
          assertOnlyBashDescriptionDiff(legacyBytes, recipeBytes, part.leaf, recipe);
          selected = recipe;
          break;
        } catch { /* 尝试下一个候选，全部失败时由下方显式报错 */ }
      }
      if (!selected) throw new Error(`${part.leaf}: 与已知工具 recipe 的差异超出 Bash description，拒绝迁移`);
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
