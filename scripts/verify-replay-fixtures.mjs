#!/usr/bin/env node
/**
 * 校验 replay-v2 fixture 的 world seal 与全部 cassette；输出计数供 CI/PR 引用。
 *
 * strict（默认）要求 worldDrift=0；source-anchored 只放行“源派生且与当前 Peri 源等值”
 * 的 mapped drift，其余 drift 仍失败。非 drift entry 始终走 loadCassette 的严格校验。
 */
import { access, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const here = path.dirname(fileURLToPath(import.meta.url));
const e2eRoot = path.resolve(here, '..');
const fixtures = path.join(e2eRoot, 'fixtures/replay-v2');
const load = (relative) => import(pathToFileURL(path.join(e2eRoot, relative)));
const { values } = parseArgs({
  options: {
    'drift-policy': { type: 'string', default: 'strict' },
    'peri-root': { type: 'string' },
    fixtures: { type: 'string' },
  },
});
const policy = values['drift-policy'];
if (!['strict', 'source-anchored'].includes(policy)) throw new Error('--drift-policy 只能是 strict 或 source-anchored');
const fixturesRoot = path.resolve(values.fixtures ?? fixtures);

const { loadCassette } = await load('llm-replay/cassette.mjs');
const { loadWorld } = await load('llm-replay/world-store.mjs');
const { sha256 } = await load('llm-replay/matcher.mjs');
const { isSyncedWorldLeaf } = await load('llm-replay/world-mapping.mjs');
const { loadSourceLeaves } = await load('scripts/replay-world-sources.mjs');
const { assertPeriRoot, resolvePeriRoot } = await load('scripts/peri-root.mjs');

const world = await loadWorld(path.join(fixturesRoot, 'world'));
const ids = (await readdir(fixturesRoot, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'world')
  .map((entry) => entry.name)
  .sort();

const errors = [];
const drift = [];
let cassettes = 0;
let entries = 0;
let legacy = 0;
let driftEntries = 0;
let driftLeafCount = 0;
const formatVersions = new Set();
for (const id of ids) {
  const directory = path.join(fixturesRoot, id, 'cassette');
  try { await access(path.join(directory, 'manifest.json')); }
  catch { continue; }
  let cassette;
  try {
    cassette = await loadCassette(directory);
  } catch (error) {
    errors.push({
      cassette: id, code: error.code ?? 'load_failed', message: error.message,
      leaf: error.details?.leaf ?? null, details: error.details,
    });
    continue;
  }
  entries += cassette.entries.size;
  cassettes += 1;
  legacy += cassette.report.legacy.length;
  for (const item of cassette.report.worldDrift) {
    driftEntries += 1;
    driftLeafCount += item.leaves.length;
    drift.push({ cassette: id, ...item });
  }
  formatVersions.add(cassette.manifest.formatVersion);
}

let approvedDrift = [];
if (policy === 'source-anchored' && drift.length) {
  const periRoot = await assertPeriRoot(resolvePeriRoot(values['peri-root']));
  const expected = await loadSourceLeaves(world, periRoot);
  for (const item of drift) {
    const seal = JSON.parse(await readFile(path.join(fixturesRoot, item.cassette, 'cassette', 'seal.json'), 'utf8'));
    const meta = seal.requestMeta?.[`requests/${item.entry}.stub.json`];
    for (const leaf of item.leaves) {
      const current = world.leafBytes(leaf);
      const source = expected.get(leaf);
      const recorded = meta?.worldRefs?.find((ref) => ref.id === leaf)?.sha256;
      if (!isSyncedWorldLeaf(leaf)) {
        errors.push({ cassette: item.cassette, entry: item.entry, leaf, code: 'world_drift_unmapped_leaf' });
      } else if (!source || !current?.equals(source)) {
        errors.push({
          cassette: item.cassette, entry: item.entry, leaf, code: 'world_drift_source_mismatch',
          recordedSha: recorded ?? null, currentSha: current ? sha256(current) : null, sourceSha: source ? sha256(source) : null,
        });
      } else {
        approvedDrift.push({
          cassette: item.cassette, entry: item.entry, leaf,
          recordedSha: recorded ?? null, currentSha: sha256(current), sourceSha: sha256(source),
        });
      }
    }
  }
}
if (policy === 'strict') {
  for (const item of drift) {
    for (const leaf of item.leaves) errors.push({ cassette: item.cassette, entry: item.entry, leaf, code: 'world_drift_strict' });
  }
}

const approvedOk = policy === 'source-anchored' ? approvedDrift.length === driftLeafCount : driftEntries === 0;
const passed = errors.length === 0 && legacy === 0 && approvedOk
  && formatVersions.size === 1 && formatVersions.has(2);
const report = {
  passed,
  driftPolicy: policy,
  cassettes,
  entries,
  legacy,
  worldDrift: driftEntries,
  driftLeaves: driftLeafCount,
  approvedDrift,
  errors,
  formatVersions: [...formatVersions].sort(),
  world: { leaves: world.leaves.length, recipes: world.recipes.length, generation: world.manifest.generation },
};
console.log(JSON.stringify(report, null, 2));
if (!passed) process.exitCode = 1;
