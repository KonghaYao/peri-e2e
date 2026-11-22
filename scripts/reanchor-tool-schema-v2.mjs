#!/usr/bin/env node
/**
 * 一次性受控重锚（v2）：把 Peri #541 重写后的工具 description（含 schema 参数说明）
 * 落到 replay world 工具 leaf，并按实测请求重建三个工具 recipe。
 *
 * 与 #24 的差异：最新 main 的 world 已含 codemode 快照，recipe 仍声明
 * ExecuteExtraTool/SearchExtraTools，而运行时实测请求发出 ToolInvoke/ToolSearch；
 * 因此本脚本以实测请求为准重建 recipe 与对应 leaf。除 description 外，
 * name/order/type/required/default/min/max/strict 及所有其它字段必须逐字段一致。
 *
 * 只重建 world；legacy 工具数组 stub 随后由 `scripts/migrate-tool-leaves.mjs`
 * 迁到命名 recipe 并重算 raw/canonical、cassette seal 与 requestMeta。
 * 默认 dry-run，--write 才原子替换 world 目录。
 */
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const here = path.dirname(fileURLToPath(import.meta.url));
const e2eRoot = path.resolve(here, '..');
const fixtures = path.join(e2eRoot, 'fixtures/replay-v2');
const worldDir = path.join(fixtures, 'world');
const templateDir = path.join(e2eRoot, 'llm-replay/world-source-templates');
const load = (relative) => import(pathToFileURL(path.join(e2eRoot, relative)).href);

const {
  createWorldBuilder, loadWorld, WORLD_FORMAT_VERSION,
} = await load('llm-replay/world-store.mjs');
const { sha256 } = await load('llm-replay/matcher.mjs');
const { replaceWorldDirectory } = await load('scripts/world-sync-swap.mjs');

const { values } = parseArgs({
  options: {
    artifacts: { type: 'string' },
    fixtures: { type: 'string', default: fixtures },
    write: { type: 'boolean', default: false },
  },
});
if (!values.artifacts) throw new Error('缺少 --artifacts <失败请求 artifacts 目录>');
const fixturesRoot = path.resolve(values.fixtures);
const artifactsRoot = path.resolve(values.artifacts);
const targetWorldDir = path.join(fixturesRoot, 'world');

/** #541 只重写了这 6 个工具（tool description 与参数 description）。 */
const REWRITTEN_TOOLS = ['Bash', 'Edit', 'Glob', 'Grep', 'Read', 'Write'];
/** 子 Agent 的工具集不含 Agent/AskUserQuestion/ReadContextArchive。 */
const SUB_TOOL_NAMES = [
  'Bash', 'DiscoverSkillsTool', 'Edit', 'Glob', 'Grep', 'Read', 'SkillTool', 'TodoWrite',
  'ToolInvoke', 'ToolSearch', 'WebFetch', 'WebSearch', 'Write', 'artifact', 'folder_operations',
];
const LEGACY_PREFIX = 'tools.sha256.';
const RECIPE_IDS = ['tools.anthropic.main', 'tools.anthropic.sub', 'tools.responses.main'];

const assert = (condition, message) => { if (!condition) throw new Error(message); };
const compact = (value) => Buffer.from(JSON.stringify(value));

/** 允许 description（含 schema 内嵌）差异；key 顺序与其余字段必须逐项一致。 */
function assertDescriptionOnly(left, right, at) {
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      throw new Error(`${at}: 数组结构不一致，拒绝重锚`);
    }
    left.forEach((value, index) => assertDescriptionOnly(value, right[index], `${at}[${index}]`));
    return;
  }
  if (left && typeof left === 'object' && right && typeof right === 'object') {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    if (leftKeys.join('\u0000') !== rightKeys.join('\u0000')) {
      throw new Error(`${at}: key 集合或顺序不一致（${leftKeys} != ${rightKeys}），拒绝重锚`);
    }
    for (const key of leftKeys) {
      if (key === 'description' && typeof left[key] === 'string' && typeof right[key] === 'string') continue;
      assertDescriptionOnly(left[key], right[key], `${at}.${key}`);
    }
    return;
  }
  if (!Object.is(left, right)) throw new Error(`${at}: 非 description 字段不一致，拒绝重锚`);
}

/** 从失败请求 artifacts 中提取唯一的 tools 序列化；不同场景必须字节一致。 */
async function loadArtifactTools() {
  const byKind = new Map();
  for (const entry of await readdir(artifactsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const directory = path.join(artifactsRoot, entry.name);
    for (const file of await readdir(directory)) {
      if (!file.startsWith('replay-request-')) continue;
      const body = JSON.parse(await readFile(path.join(directory, file), 'utf8'));
      const kind = Array.isArray(body.tools) && 'messages' in body ? 'anthropic'
        : Array.isArray(body.input) ? 'responses' : null;
      assert(kind, `${entry.name}/${file}: 无法识别协议`);
      assert(Array.isArray(body.tools), `${entry.name}/${file}: 缺少 tools`);
      const serialized = JSON.stringify(body.tools);
      const existing = byKind.get(kind);
      assert(!existing || existing.serialized === serialized,
        `${entry.name}/${file}: ${kind} tools 序列化与其它实测请求不一致`);
      byKind.set(kind, { serialized, tools: body.tools });
    }
  }
  assert(byKind.has('anthropic') && byKind.has('responses'), 'artifacts 必须同时覆盖 anthropic 与 responses');
  return byKind;
}

function findLeafByToolNames(world, names) {
  const matches = [];
  for (const id of world.leaves) {
    if (!id.startsWith(LEGACY_PREFIX)) continue;
    const tools = JSON.parse(world.leafBytes(id).toString('utf8'));
    if (Array.isArray(tools) && tools.length === names.length
        && tools.every((tool, index) => tool?.name === names[index])) matches.push(id);
  }
  assert(matches.length === 1, `子 Agent 工具数组应唯一匹配 ${names.length} 个工具，实际 ${matches.length}`);
  return matches[0];
}

const artifacts = await loadArtifactTools();
const oldWorld = await loadWorld(targetWorldDir);
assert(oldWorld.manifest.formatVersion === WORLD_FORMAT_VERSION, 'world 不是 v2');

// 1) 12 个工具 leaf：整对象替换为实测 wire 文本，断言仅 description 变化。
const leafOverrides = new Map();
const changedLeaves = [];
for (const [kind, { tools }] of artifacts) {
  const suffix = kind === 'responses' ? '.responses' : '.anthropic';
  for (const name of REWRITTEN_TOOLS) {
    const id = `tools.${name}${suffix}`;
    const next = tools.find((tool) => tool.name === name);
    assert(next, `${id}: 实测请求缺少工具`);
    const previous = JSON.parse(oldWorld.leafBytes(id).toString('utf8'));
    assertDescriptionOnly(previous, next, id);
    assert(JSON.stringify(previous) !== JSON.stringify(next), `${id}: 实测请求与旧 leaf 完全相同`);
    leafOverrides.set(id, compact(next));
    changedLeaves.push(id);
  }
}

// 2) 子 Agent 的 ToolInvoke/ToolSearch 取自录制中的 15 工具数组：description 里的
//    可用工具清单必须与子 Agent 工具集一致，不能复用主 Agent 文案。
const subLegacyId = findLeafByToolNames(oldWorld, SUB_TOOL_NAMES);
const subLegacyTools = JSON.parse(oldWorld.leafBytes(subLegacyId).toString('utf8'));
const subToolOverrides = new Map();
for (const name of ['ToolInvoke', 'ToolSearch']) {
  const tool = subLegacyTools.find((item) => item.name === name);
  assert(tool, `${subLegacyId}: 缺少 ${name}`);
  subToolOverrides.set(`tools.${name}.anthropic.sub`, compact(tool));
}

// 3) 主 Agent / Responses 的 ToolInvoke/ToolSearch leaf 直接采用实测 wire 文本。
for (const [kind, { tools }] of artifacts) {
  const suffix = kind === 'responses' ? '.responses' : '.anthropic.main';
  for (const name of ['ToolInvoke', 'ToolSearch']) {
    const tool = tools.find((item) => item.name === name);
    assert(tool, `${kind}: 实测请求缺少 ${name}`);
    leafOverrides.set(`tools.${name}${suffix}`, compact(tool));
  }
}
for (const [id, bytes] of subToolOverrides) leafOverrides.set(id, bytes);

// 4) 重建三个 recipe：主/Responses 采用实测顺序，子 Agent 采用录制顺序。
function recipeParts(names, { kind, sub }) {
  const parts = [];
  names.forEach((name, index) => {
    if (index > 0) parts.push(',');
    const suffix = sub ? '.anthropic.sub' : kind === 'responses' ? '.responses' : '.anthropic.main';
    const leaf = name === 'ToolInvoke' || name === 'ToolSearch'
      ? `tools.${name}${suffix}`
      : `tools.${name}${kind === 'responses' ? '.responses' : '.anthropic'}`;
    parts.push({ leaf });
  });
  return ['[', ...parts, ']'];
}

const mainNames = artifacts.get('anthropic').tools.map((tool) => tool.name);
const responsesNames = artifacts.get('responses').tools.map((tool) => tool.name);
assert(mainNames.length === 18 && responsesNames.length === 18, '主 Agent 工具数应为 18');
assert(!mainNames.includes('ExecuteExtraTool') && !mainNames.includes('SearchExtraTools'),
  '实测请求不应再包含 ExecuteExtraTool/SearchExtraTools');
const recipeOverrides = new Map([
  ['tools.anthropic.main', recipeParts(mainNames, { kind: 'anthropic' })],
  ['tools.anthropic.sub', recipeParts(SUB_TOOL_NAMES, { kind: 'anthropic', sub: true })],
  ['tools.responses.main', recipeParts(responsesNames, { kind: 'responses' })],
]);

// 5) 在旧 world 基础上重建：保留全部未改动 leaf/recipe，替换 12+6 个 leaf 与 3 个 recipe。
const builder = createWorldBuilder();
for (const id of oldWorld.leaves) builder.addLeaf(id, leafOverrides.get(id) ?? oldWorld.leafBytes(id));
for (const [id, bytes] of leafOverrides) if (!oldWorld.hasLeaf(id)) builder.addLeaf(id, bytes);
for (const id of oldWorld.recipes) {
  if (!recipeOverrides.has(id)) builder.addRecipe(id, oldWorld.recipeParts(id));
}
for (const [id, parts] of recipeOverrides) builder.addRecipe(id, parts);

// 6) 渲染断言：主/Responses 与实测 tools 字节完全一致；子 Agent 仅 description 变化。
for (const [kind, { serialized, tools }] of artifacts) {
  const recipe = kind === 'responses' ? 'tools.responses.main' : 'tools.anthropic.main';
  const rendered = builder.render({ recipe }).toString('utf8');
  assert(rendered === serialized, `${recipe}: 渲染结果与实测请求不一致`);
  assert(JSON.parse(rendered).length === tools.length, `${recipe}: 工具数与实测请求不一致`);
}
{
  const rendered = builder.render({ recipe: 'tools.anthropic.sub' });
  assertDescriptionOnly(subLegacyTools, JSON.parse(rendered.toString('utf8')), 'tools.anthropic.sub');
}

const staging = await mkdtemp(path.join(fixturesRoot, '.reanchor-tool-schema-v2-'));
try {
  const stagedWorldDir = path.join(staging, 'world');
  const sealed = await builder.seal(stagedWorldDir);
  const staged = await loadWorld(stagedWorldDir);
  assert(staged.leaves.length === oldWorld.leaves.length + (leafOverrides.size - changedLeaves.length) - 0,
    `staged leaf 数异常：${staged.leaves.length}`);
  assert(staged.recipes.length === oldWorld.recipes.length, `staged recipe 数异常：${staged.recipes.length}`);
  assert(staged.manifest.generation !== oldWorld.manifest.generation, 'recipe/leaf 结构变化必须改变 generation');

  // Bash wire 模板与 leaf 必须逐字段一致（模板 description 会被源码同步覆盖）。
  const bashTemplates = new Map();
  for (const kind of ['anthropic', 'responses']) {
    const tool = artifacts.get(kind).tools.find((item) => item.name === 'Bash');
    assert(tool, `${kind}: 实测请求缺少 Bash`);
    const file = `Bash.${kind}.json`;
    const leaf = JSON.parse(staged.leafBytes(`tools.Bash.${kind === 'responses' ? 'responses' : 'anthropic'}`).toString('utf8'));
    assert(JSON.stringify(leaf) === JSON.stringify(tool), `${file}: Bash leaf 与实测请求不一致`);
    bashTemplates.set(file, compact(tool));
  }

  if (values.write) {
    const swap = await replaceWorldDirectory(targetWorldDir, stagedWorldDir, { validate: (dir) => loadWorld(dir) });
    if (!swap.removed) console.error(`world 已替换，但旧目录清理失败：${swap.previous}`);
    await mkdir(templateDir, { recursive: true });
    for (const [file, bytes] of bashTemplates) await writeFile(path.join(templateDir, file), bytes);
  }

  console.log(JSON.stringify({
    command: 'reanchor-tool-schema-v2',
    write: values.write,
    world: {
      generation: sealed.generation,
      previousGeneration: oldWorld.manifest.generation,
      leaves: staged.leaves.length,
      recipes: staged.recipes.length,
      changedLeaves: changedLeaves.sort(),
      addedLeaves: [...leafOverrides.keys()].filter((id) => !oldWorld.hasLeaf(id)).sort(),
      rebuiltRecipes: [...recipeOverrides.keys()].sort(),
      mainToolOrder: mainNames,
      subToolOrder: SUB_TOOL_NAMES,
      responsesToolOrder: responsesNames,
    },
    bashTemplates: [...bashTemplates.keys()].sort(),
    worldManifestSha256: sealed.manifestSha256,
  }, null, 2));
} finally {
  if (!process.env.PERI_KEEP_REANCHOR) await rm(staging, { recursive: true, force: true });
}
