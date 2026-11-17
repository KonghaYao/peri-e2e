#!/usr/bin/env node
/**
 * world:sync —— 把高频 prompt 源文件同步进 replay world 快照。
 *
 * 只更新受源码映射的 leaf（block0、skills、compact system/user prompt、Agent description/send_only）和 seal；
 * 其余 leaf 与 manifest 原样保留。源未变化时不写任何文件（幂等）。
 * 未映射（内容寻址）leaf 会在报告中列出，提醒审核而非静默忽略。
 *
 * --check 除源文件映射外，还与各 cassette seal 的录制 worldRefs 交叉校验：
 * world seal 只能证明快照自洽，手工重封无法解释未映射 leaf 的变化。
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import {
  STABLE_LEAVES, loadSourceLeaves,
} from './replay-world-sources.mjs';
import { compareRecordedWorldRefs, readRecordedWorldRefs } from './replay-world-recorded.mjs';
import { replaceWorldDirectory } from './world-sync-swap.mjs';
import { assertPeriRoot, resolvePeriRoot } from './peri-root.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const e2eRoot = path.resolve(here, '..');
const load = (relative) => import(pathToFileURL(path.join(e2eRoot, relative)));
const { sha256 } = await load('llm-replay/matcher.mjs');
const { WORLD_FORMAT_VERSION, loadWorld } = await load('llm-replay/world-store.mjs');

const { values } = parseArgs({
  options: {
    check: { type: 'boolean', default: false },
    world: { type: 'string' },
    'peri-root': { type: 'string' },
    json: { type: 'boolean', default: true },
  },
});
const periRoot = await assertPeriRoot(resolvePeriRoot(values['peri-root']));

const worldDir = path.resolve(values.world ?? path.join(e2eRoot, 'fixtures/replay-v2/world'));
const world = await loadWorld(worldDir);

function requiresLeaf(id) {
  if (!world.hasLeaf(id)) throw new Error(`world 缺少稳定 leaf ${id}，无法映射对应源文件`);
}

const updates = await loadSourceLeaves(world, periRoot);
requiresLeaf(STABLE_LEAVES.skills);
requiresLeaf(STABLE_LEAVES.block0);

function recipeReferences(parts, leaf, seen = new Set()) {
  return parts.some((part) => {
    if (part.leaf === leaf) return true;
    if (!part.recipe || seen.has(part.recipe)) return false;
    return recipeReferences(world.manifest.recipes[part.recipe] ?? [], leaf, new Set([...seen, part.recipe]));
  });
}
const skillsReferenced = Object.values(world.manifest.recipes)
  .some((parts) => recipeReferences(parts, STABLE_LEAVES.skills));
if (!skillsReferenced) throw new Error('world 中没有 recipe 引用 sys.skills，skills 变化不会进入请求');

const changed = [...updates].filter(([id, bytes]) => !world.hasLeaf(id) || !bytes.equals(world.leafBytes(id)));
const unmappedLeaves = world.leaves.filter((id) => id.startsWith('sys.sha256.') || id.startsWith('tools.sha256.'));
const report = {
  updated: changed.map(([id]) => id),
  stable: updates.size - changed.length,
  unmappedLeaves,
  world: { leaves: world.leaves.length, recipes: world.recipes.length, generation: world.manifest.generation },
};

if (values.check) {
  const recorded = compareRecordedWorldRefs(world, await readRecordedWorldRefs(path.dirname(worldDir)));
  // 源派生且已与源等值的 mapped drift 只需重封引用，不要求重录；其余 drift 仍要求重录。
  const sourceAnchoredDrift = recorded.mappedDrift.filter((id) => updates.get(id)?.equals(world.leafBytes(id)));
  const unanchoredDrift = recorded.mappedDrift.filter((id) => !sourceAnchoredDrift.includes(id));
  const staleReasons = [];
  if (changed.length) staleReasons.push('source_not_synced');
  if (recorded.unmappedDrift.length) staleReasons.push('cassette_unmapped_drift');
  if (recorded.missingLeaves.length) staleReasons.push('cassette_missing_leaf');
  const stale = staleReasons.length > 0;
  console.log(JSON.stringify({
    ...report,
    recorded: {
      ...recorded,
      requiresRerecord: unanchoredDrift.length > 0,
      sourceAnchoredDrift,
      unanchoredDrift,
    },
    staleReasons,
    stale,
  }, null, 2));
  process.exit(stale ? 1 : 0);
}
if (!changed.length) {
  console.log(JSON.stringify({ ...report, written: 0 }, null, 2));
  process.exit(0);
}

const stagingBase = await mkdtemp(path.join(path.dirname(worldDir), '.world-sync-'));
const staged = path.join(stagingBase, 'world');
try {
  await mkdir(staged);
  const leafHashes = {};
  for (const [id, meta] of Object.entries(world.manifest.leaves)) {
    const bytes = updates.get(id) ?? world.leafBytes(id);
    const file = path.join(staged, meta.file);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, bytes, { mode: 0o600 });
    leafHashes[id] = sha256(bytes);
  }
  const manifestBytes = await readFile(path.join(worldDir, 'manifest.json'));
  await writeFile(path.join(staged, 'manifest.json'), manifestBytes, { mode: 0o600 });
  const seal = {
    formatVersion: WORLD_FORMAT_VERSION,
    manifestSha256: sha256(manifestBytes),
    leaves: Object.fromEntries(Object.entries(leafHashes).sort(([left], [right]) => left.localeCompare(right))),
  };
  await writeFile(path.join(staged, 'seal.json'), `${JSON.stringify(seal)}\n`, { mode: 0o600 });
  await loadWorld(staged);
  const swap = await replaceWorldDirectory(worldDir, staged, { validate: (dir) => loadWorld(dir) });
  if (!swap.removed) console.error(`world 已替换，但旧目录清理失败：${swap.previous}`);
} finally {
  await rm(stagingBase, { recursive: true, force: true });
}
console.log(JSON.stringify({ ...report, written: changed.length }, null, 2));
