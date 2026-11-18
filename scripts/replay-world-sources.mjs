/**
 * world 快照与当前源码之间的显式映射。迁移、world:sync 与 drift 校验共用同一份定义，
 * 避免“哪个 leaf 可以变化”出现两套口径。
 */
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { canonicalJson } from '../llm-replay/matcher.mjs';
import { AGENT_LEAF_PREFIX, BASH_TOOL_LEAVES, BLOCK1_PREFIX_LEAVES, STABLE_LEAVES } from '../llm-replay/world-mapping.mjs';

export { AGENT_LEAF_PREFIX, BASH_TOOL_LEAVES, BLOCK1_PREFIX_LEAVES, STABLE_LEAVES };

export const SOURCE_FILES = Object.freeze({
  skills: 'peri-acp/prompts/sections/13_skills.md',
  bashDescription: 'mcp-packages/workspace/src/descriptions/bash.md',
  agentDescription: 'peri-middlewares/src/subagent/tool/descriptions/agent.md',
  agentSchema: 'peri-middlewares/src/subagent/tool/define/sub_agent_tool.rs',
  // v5 把 define.rs 拆成 mod 声明与具体定义；旧 pin 仍只有单文件布局。
  agentSchemaLegacy: 'peri-middlewares/src/subagent/tool/define.rs',
  compactSummary: 'peri-agent/src/agent/compact_v2/descriptions/summary_system_prompt.md',
  compactUser: 'peri-agent/src/agent/compact_v2/descriptions/summary_user_prompt.md',
});

/**
 * Full Compact 首轮提示词的长度目标。U06 录制时 fixture 模型 output limit=32000，
 * summary_max_tokens 默认 16000；`full_compact.rs` 取 min(16000, 32000) / 2 = 8000。
 * world 只保存渲染后的冻结快照，因此同步时按运行时同名替换写入具体数值。
 */
export const COMPACT_USER_TARGET_TOKENS = 8000;
export const COMPACT_USER_PLACEHOLDER = '{summary_target_tokens}';

/** 与 `full_compact.rs::summary_instruction` 一致：替换全部占位符后冻结进 world。 */
export function renderCompactUserPrompt(source) {
  return source.replaceAll(COMPACT_USER_PLACEHOLDER, String(COMPACT_USER_TARGET_TOKENS));
}

/** block0 是 01–06 段的组合体；顺序必须与 BASE_SECTIONS 的 Cached zone 一致。 */
export const BLOCK0_SECTIONS = Object.freeze([
  '01_intro', '02_system', '03_doing_tasks', '04_actions', '05_using_tools', '06_tone_style',
]);

/**
 * BASE_SECTIONS 的完整固定集合（01–06 Cached、07_runtime Uncached、env Environment）。
 * 新增/缺失/zone/顺序/include_str 路径变化都会改变请求结构，必须显式失败而不是只校验 block0 前缀。
 */
export const BASE_SECTION_LAYOUT = Object.freeze([
  ...BLOCK0_SECTIONS.map((id, index) => Object.freeze({ id, zone: 'Cached', order: index + 1 })),
  Object.freeze({ id: '07_runtime', zone: 'Uncached', order: 1 }),
  Object.freeze({ id: 'env', zone: 'Environment', order: 0 }),
]);

/**
 * #443 把 section 文件从 peri-acp 迁到 peri-middlewares。目录都不存在时显式失败，
 * 避免把“源码布局不认识”误判成“内容未变化”。
 */
export const SECTION_DIR_CANDIDATES = Object.freeze([
  'peri-middlewares/prompts/sections',
  'peri-acp/prompts/sections',
]);

export async function resolveSectionsDir(periRoot) {
  for (const relative of SECTION_DIR_CANDIDATES) {
    try {
      if ((await stat(path.join(periRoot, relative))).isDirectory()) return relative;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  throw new Error(`Peri 源码缺少 prompt sections 目录，已尝试：${SECTION_DIR_CANDIDATES.join(', ')}`);
}

/**
 * block1 prefix 的源码段与结构锚点。prefix = 07_runtime / 10_hitl /
 * 11_subagent(catalog) / 12_ask_user，join 规则与 PromptTemplate::render 一致。
 * 首句或标题变化会直接失败，避免把“段被替换/重排”误判成合法源漂移。
 */
export const BLOCK1_SECTIONS = Object.freeze([
  Object.freeze({ id: '07_runtime', anchor: 'The environment values in the final environment block were captured at the start of the session;' }),
  Object.freeze({ id: '10_hitl', anchor: '# Human-in-the-Loop (HITL) Approval Mode' }),
  Object.freeze({ id: '11_subagent', anchor: '# SubAgent Delegation' }),
  Object.freeze({ id: '12_ask_user', anchor: '# Asking the User (AskUserQuestion)' }),
]);

export const AVAILABLE_AGENTS_PLACEHOLDER = '{{available_agents}}';

/**
 * 动态段的固定模板：catalog 与 subagent persona 取自录制时的 wire 快照，
 * 不属于 Peri 源码。模板必须逐字节固定，模板外的变化仍按录制内容校验。
 */
export const BLOCK1_PREFIX_TEMPLATES = Object.freeze({
  [BLOCK1_PREFIX_LEAVES.main]: 'block1.main.catalog.txt',
  [BLOCK1_PREFIX_LEAVES['replay-worker']]: 'block1.replay-worker.catalog.txt',
  [BLOCK1_PREFIX_LEAVES.subagent]: 'block1.subagent.persona.txt',
});

const BLOCK1_PREFIX_TEMPLATE_DIR = new URL('../llm-replay/world-source-templates/', import.meta.url);

async function loadBlock1PrefixTemplates() {
  const templates = new Map();
  for (const [id, file] of Object.entries(BLOCK1_PREFIX_TEMPLATES)) {
    const source = await readFile(new URL(file, BLOCK1_PREFIX_TEMPLATE_DIR), 'utf8');
    if (!source || source !== source.trim()) {
      throw new Error(`${id}: 模板 ${file} 为空或首尾含空白，拒绝同步 block1 prefix`);
    }
    templates.set(id, source);
  }
  return templates;
}

/**
 * 组合 block1 prefix。main / replay-worker 使用源码四个段落；subagent 只有
 * persona（Agent 定义正文）与 07_runtime。分隔符固定为 `\n\n`，尾部保留到
 * skills 的 join 分隔符，与 wire 上 `prefix + skills + tail` 的拆分边界一致。
 */
export function renderBlock1Prefix(cls, sections, templates) {
  if (!Object.hasOwn(BLOCK1_PREFIX_LEAVES, cls)) throw new Error(`未知 block1 prefix 分类：${cls}`);
  const runtime = sections.get('07_runtime');
  if (cls === 'subagent') {
    const persona = templates.get(BLOCK1_PREFIX_LEAVES.subagent);
    if (!persona || persona.includes('\n')) throw new Error('subagent persona 模板必须是单行正文');
    return `${persona}\n\n\n\n${runtime}\n\n`;
  }
  const subagentSection = sections.get('11_subagent');
  const occurrences = subagentSection.split(AVAILABLE_AGENTS_PLACEHOLDER).length - 1;
  if (occurrences !== 1) {
    throw new Error(`11_subagent.md 必须恰好包含一个 ${AVAILABLE_AGENTS_PLACEHOLDER}，实际 ${occurrences} 个`);
  }
  const renderedSubagent = subagentSection.replace(
    AVAILABLE_AGENTS_PLACEHOLDER,
    templates.get(BLOCK1_PREFIX_LEAVES[cls]),
  );
  return [
    runtime, sections.get('10_hitl'), renderedSubagent, sections.get('12_ask_user'),
  ].join('\n\n') + '\n\n';
}

const sectionRelativePath = (id) => `peri-acp/prompts/sections/${id}.md`;
const currentSectionSuffix = (id) => `prompts/sections/${id}.md`;

/**
 * 组合 block0。trim 对齐 wire 侧 split_system_blocks：单 block 的 system 文本会被 trim，
 * 因此组合后必须整体 trim 才能与请求中的 system[0] 逐字节一致。
 */
export async function composeBlock0(periRoot, sectionsDir) {
  const relative = sectionsDir ?? await resolveSectionsDir(periRoot);
  const texts = [];
  for (const id of BLOCK0_SECTIONS) {
    const text = await readFile(path.join(periRoot, relative, `${id}.md`), 'utf8');
    if (text.trim()) texts.push(text);
  }
  return texts.join('\n\n').trim();
}

const OWNERS_SOURCE = 'peri-acp-types/src/meta_harness/owners.rs';

/** 从 declare_owners! 宏体解析 SectionSpec；缺失、未闭合、重复或空集合都显式失败。 */
function parseSectionSpecs(source) {
  const marker = /declare_owners!\s*\{/u.exec(source);
  if (!marker) throw new Error('无法解析 peri-acp-types declare_owners，拒绝同步 block0');
  const start = marker.index + marker[0].length;
  let depth = 1;
  let end = -1;
  for (let index = start; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    else if (source[index] === '}' && --depth === 0) { end = index; break; }
  }
  if (end < 0) throw new Error('peri-acp-types declare_owners 宏体未闭合，拒绝同步 block0');
  const specs = new Map();
  for (const match of source.slice(start, end).matchAll(/([A-Z][A-Z0-9_]*)\("([a-z0-9_]+)",\s*(Cached|Uncached|Environment),\s*(\d+)\)/gu)) {
    const [, name, id, zone, order] = match;
    if (specs.has(name)) throw new Error(`declare_owners 中 SectionSpec ${name} 重复声明，拒绝同步 block0`);
    specs.set(name, { id, zone, order: Number(order) });
  }
  if (specs.size === 0) throw new Error('declare_owners 中没有 SectionSpec 声明，拒绝同步 block0');
  return specs;
}

/** BASE_SECTIONS 的顺序/zone/路径变化会让 block0 组合或请求结构失效，必须在同步前显式失败。 */
export async function assertBlock0SectionOrder(periRoot) {
  const source = await readFile(path.join(periRoot, 'peri-middlewares/src/default_system_prompt/mod.rs'), 'utf8');
  const table = /const BASE_SECTIONS[^=]*=\s*&?\s*\[([\s\S]*?)\n\];/u.exec(source)?.[1];
  if (!table) throw new Error('无法解析 peri-middlewares BASE_SECTIONS，拒绝同步 block0');
  const legacyShape = /PromptSectionZone::/u.test(table);
  const specShape = /sections::/u.test(table);
  if (legacyShape === specShape) {
    throw new Error('BASE_SECTIONS 声明形状无法识别（zone/order 四元组与 SectionSpec 引用必须二选一），拒绝同步 block0');
  }
  let entries;
  if (legacyShape) {
    entries = [...table.matchAll(/\(\s*"([a-z0-9_]+)",\s*include_str!\(([\s\S]*?)\),\s*PromptSectionZone::(\w+),\s*(\d+),\s*\)/gu)]
      .map((match) => ({ id: match[1], includeSource: match[2], zone: match[3], order: Number(match[4]) }));
    const zoneMentions = table.match(/PromptSectionZone::/gu)?.length ?? 0;
    if (entries.length !== BASE_SECTION_LAYOUT.length || zoneMentions !== entries.length) {
      throw new Error(`BASE_SECTIONS 条目集合与预期不一致：期望 ${BASE_SECTION_LAYOUT.length} 项，解析到 ${entries.length} 项 / ${zoneMentions} 个 zone 声明`);
    }
  } else {
    const matches = [...table.matchAll(/\(\s*sections::([A-Z][A-Z0-9_]*)\s*,\s*include_str!\(([\s\S]*?)\)\s*,?\s*\)/gu)];
    const specRefs = table.match(/sections::/gu)?.length ?? 0;
    const includeRefs = table.match(/include_str!/gu)?.length ?? 0;
    if (matches.length !== BASE_SECTION_LAYOUT.length || specRefs !== matches.length || includeRefs !== matches.length) {
      throw new Error(`BASE_SECTIONS 条目集合与预期不一致：期望 ${BASE_SECTION_LAYOUT.length} 项，解析到 ${matches.length} 项 / ${specRefs} 个 SectionSpec 引用 / ${includeRefs} 个 include_str`);
    }
    const specs = parseSectionSpecs(await readFile(path.join(periRoot, OWNERS_SOURCE), 'utf8'));
    entries = matches.map((match) => {
      const spec = specs.get(match[1]);
      if (!spec) throw new Error(`BASE_SECTIONS 引用了未声明的 SectionSpec sections::${match[1]}，拒绝同步 block0`);
      return { ...spec, includeSource: match[2] };
    });
  }
  for (const [index, expected] of BASE_SECTION_LAYOUT.entries()) {
    const entry = entries[index];
    const includePath = [...entry.includeSource.matchAll(/"([^"]+)"/gu)]
      .map((match) => match[1].replaceAll('\\', '/'))
      .filter((value) => value.endsWith('.md'))
      .at(-1);
    const expectedSuffix = legacyShape ? sectionRelativePath(expected.id) : currentSectionSuffix(expected.id);
    if (entry.id !== expected.id || entry.zone !== expected.zone || entry.order !== expected.order
        || !includePath?.endsWith(expectedSuffix)) {
      throw new Error(`BASE_SECTIONS 顺序/zone/include_str 与 block0 组合不一致：期望 ${expected.id} ${expected.zone} #${expected.order} ${expectedSuffix}，实际 ${entry.id} ${entry.zone} #${entry.order} ${includePath ?? '(缺失)'}`);
    }
  }
  return entries.map(({ id, zone, order }) => ({ id, zone, order }));
}

/**
 * Agent tool 的非管理字段（name、其余 schema）只能来自这份全量模板，不能从当前 world 反推。
 * 当前 world 被篡改并重封后，模板仍是未受污染的完整定义，因此 drift 会被判为未锚定。
 * 模板由录制时的 wire 定义快照而来；非管理字段变化必须重录并显式更新模板，不能由 world:sync 静默改写。
 */
export const AGENT_TOOL_TEMPLATES = Object.freeze({
  [`${AGENT_LEAF_PREFIX}anthropic`]: 'Agent.anthropic.json',
  [`${AGENT_LEAF_PREFIX}responses`]: 'Agent.responses.json',
});

const AGENT_TOOL_TEMPLATE_DIR = new URL('../llm-replay/world-source-templates/', import.meta.url);

async function loadAgentToolTemplates() {
  const templates = new Map();
  for (const [id, file] of Object.entries(AGENT_TOOL_TEMPLATES)) {
    const source = await readFile(new URL(file, AGENT_TOOL_TEMPLATE_DIR), 'utf8');
    let tool;
    try { tool = JSON.parse(source); }
    catch { throw new Error(`Agent 全量模板 ${file} 不是合法 JSON`); }
    agentSchemaOf(tool);
    templates.set(id, tool);
  }
  return templates;
}

/**
 * Bash description 由内置 MCP 的 bash.md 加固定 server 前缀组成；name/input_schema 来自
 * 录制 wire 模板。模板 description 只是录制快照，同步时会被源文本整体替换。
 */
export const BASH_DESCRIPTION_PREFIX = '[MCP:peri] ';
export const BASH_TOOL_TEMPLATES = Object.freeze({
  [BASH_TOOL_LEAVES.anthropic]: 'Bash.anthropic.json',
  [BASH_TOOL_LEAVES.responses]: 'Bash.responses.json',
});

async function loadBashToolTemplates() {
  const templates = new Map();
  for (const [id, file] of Object.entries(BASH_TOOL_TEMPLATES)) {
    const source = await readFile(new URL(file, AGENT_TOOL_TEMPLATE_DIR), 'utf8');
    let tool;
    try { tool = JSON.parse(source); }
    catch { throw new Error(`${id}: Bash 全量模板 ${file} 不是合法 JSON`); }
    if (typeof tool.description !== 'string' || !tool.description.startsWith(BASH_DESCRIPTION_PREFIX)) {
      throw new Error(`${id}: Bash 模板 description 必须以 ${BASH_DESCRIPTION_PREFIX} 开头，拒绝同步`);
    }
    templates.set(id, tool);
  }
  return templates;
}

/** description 是唯一管理字段；name/schema 等必须与录制模板逐字段一致。 */
function assertBashToolAnchored(id, current, template) {
  const nonManaged = (tool) => {
    const copy = structuredClone(tool);
    delete copy.description;
    return copy;
  };
  if (canonicalJson(nonManaged(current)) !== canonicalJson(nonManaged(template))) {
    throw new Error(`${id}: name/schema 等非管理字段与录制模板不一致；非管理字段变化必须重录并显式更新模板，不能由 world:sync 放行`);
  }
}

/** 只允许说明与 send_only 由源码同步；其余字段必须与全量模板逐字段一致。 */
function assertAgentToolAnchored(id, current, template) {
  const nonManaged = (tool) => {
    const copy = structuredClone(tool);
    delete copy.description;
    delete agentSchemaOf(copy).properties.send_only;
    return copy;
  };
  if (canonicalJson(nonManaged(current)) !== canonicalJson(nonManaged(template))) {
    throw new Error(`${id}: name/schema 等非管理字段与全量模板不一致；非管理字段变化必须重录并显式更新模板，不能由 world:sync 放行`);
  }
}

/** 当前布局优先；旧 pin 只有 define.rs 时回退，路径都不存在则显式失败。 */
async function readAgentSchema(periRoot) {
  const candidates = [SOURCE_FILES.agentSchema, SOURCE_FILES.agentSchemaLegacy];
  for (const relative of candidates) {
    try { return await readFile(path.join(periRoot, relative), 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  throw new Error(`Peri 源码缺少 Agent schema，已尝试：${candidates.join(', ')}`);
}

/** 所有源派生 leaf 的唯一期望字节；world:sync 与 source-anchored verify 共用。 */
export async function loadSourceLeaves(world, periRoot) {
  await assertBlock0SectionOrder(periRoot);
  const sectionsDir = await resolveSectionsDir(periRoot);
  const [block0, skills, compactSummary, compactUserSource, bashDescription, agentDescription, agentSchema] = await Promise.all([
    composeBlock0(periRoot, sectionsDir),
    readFile(path.join(periRoot, sectionsDir, '13_skills.md'), 'utf8'),
    readFile(path.join(periRoot, SOURCE_FILES.compactSummary), 'utf8'),
    readFile(path.join(periRoot, SOURCE_FILES.compactUser), 'utf8'),
    readFile(path.join(periRoot, SOURCE_FILES.bashDescription), 'utf8'),
    readFile(path.join(periRoot, SOURCE_FILES.agentDescription), 'utf8'),
    readAgentSchema(periRoot),
  ]);
  const compactUser = renderCompactUserPrompt(compactUserSource);
  const block1Sections = new Map(await Promise.all(
    BLOCK1_SECTIONS.map(async ({ id, anchor }) => {
      const text = await readFile(path.join(periRoot, sectionsDir, `${id}.md`), 'utf8');
      if (!text.startsWith(anchor)) {
        throw new Error(`block1 源段 ${id}.md 的首句/标题与固定布局不符，拒绝同步 prefix`);
      }
      return [id, text];
    }),
  ));
  for (const id of [STABLE_LEAVES.block0, STABLE_LEAVES.skills, STABLE_LEAVES.compactSummary, STABLE_LEAVES.compactUser]) {
    if (!world.hasLeaf(id)) throw new Error(`world 缺少稳定 leaf ${id}，无法映射对应源文件`);
  }
  const expected = new Map([
    [STABLE_LEAVES.block0, Buffer.from(block0, 'utf8')],
    [STABLE_LEAVES.skills, Buffer.from(skills, 'utf8')],
    [STABLE_LEAVES.compactSummary, Buffer.from(compactSummary, 'utf8')],
    [STABLE_LEAVES.compactUser, Buffer.from(compactUser, 'utf8')],
  ]);
  for (const id of Object.values(BLOCK1_PREFIX_LEAVES)) {
    if (!world.hasLeaf(id)) throw new Error(`world 缺少稳定 leaf ${id}，无法映射 block1 prefix`);
  }
  const block1Templates = await loadBlock1PrefixTemplates();
  for (const cls of Object.keys(BLOCK1_PREFIX_LEAVES)) {
    expected.set(BLOCK1_PREFIX_LEAVES[cls], Buffer.from(renderBlock1Prefix(cls, block1Sections, block1Templates), 'utf8'));
  }
  const sendOnly = expectedSendOnly(agentSchema);
  const templates = await loadAgentToolTemplates();
  const leafIds = agentDescriptionLeafIds(world).sort();
  const templateIds = Object.keys(AGENT_TOOL_TEMPLATES).sort();
  if (JSON.stringify(leafIds) !== JSON.stringify(templateIds)) {
    throw new Error(`world 的 Agent tool leaf 集合与全量模板不一致：期望 ${templateIds.join(', ')}，实际 ${leafIds.join(', ')}`);
  }
  for (const id of templateIds) {
    const currentText = world.leafBytes(id).toString('utf8');
    let current;
    try { current = JSON.parse(currentText); }
    catch { throw new Error(`${id}: leaf 不是合法 JSON，拒绝改写`); }
    if (JSON.stringify(current) !== currentText) throw new Error(`${id}: leaf JSON 无法无损往返，拒绝改写`);
    assertAgentToolAnchored(id, current, templates.get(id));
    const next = structuredClone(templates.get(id));
    next.description = agentDescription;
    agentSchemaOf(next).properties.send_only = structuredClone(sendOnly);
    expected.set(id, Buffer.from(JSON.stringify(next), 'utf8'));
  }
  const bashTemplates = await loadBashToolTemplates();
  const bashTemplateIds = Object.keys(BASH_TOOL_TEMPLATES).sort();
  for (const id of bashTemplateIds) {
    if (!world.hasLeaf(id)) throw new Error(`world 缺少稳定 leaf ${id}，无法映射 Bash description`);
    const currentText = world.leafBytes(id).toString('utf8');
    let current;
    try { current = JSON.parse(currentText); }
    catch { throw new Error(`${id}: leaf 不是合法 JSON，拒绝改写`); }
    if (JSON.stringify(current) !== currentText) throw new Error(`${id}: leaf JSON 无法无损往返，拒绝改写`);
    assertBashToolAnchored(id, current, bashTemplates.get(id));
    const next = structuredClone(bashTemplates.get(id));
    next.description = `${BASH_DESCRIPTION_PREFIX}${bashDescription}`;
    expected.set(id, Buffer.from(JSON.stringify(next), 'utf8'));
  }
  return expected;
}

/** Agent 与 Bash 工具 description 有稳定来源；其余 tool 文本仍是录制内容，不做源码同步。 */
export function agentDescriptionLeafIds(world) {
  const ids = world.leaves.filter((id) => id.startsWith(AGENT_LEAF_PREFIX));
  if (!ids.length) throw new Error(`world 缺少 ${AGENT_LEAF_PREFIX}* leaf，无法映射 Agent description`);
  return ids;
}

/**
 * block1 的前缀语义：主 Agent（含/不含 replay-worker catalog）与子 Agent 的短 prompt。
 * 分类冲突时由调用方显式失败，而不是静默合并到同一个 leaf。
 */
export { classifyBlock1Prefix } from '../llm-replay/world-mapping.mjs';

const SEND_ONLY = Object.freeze({
  type: 'boolean',
  default: false,
  description: 'When true, only queue a non-empty prompt to the live background sub-agent identified by resume_thread_id. If it has no live receiver, fail without loading or resuming a persisted thread.',
});

/** 复用旧生成器的契约检查：Agent schema 的 send_only 定义变化时必须显式失败。 */
export function expectedSendOnly(defineSource) {
  const field = defineSource.match(/"send_only": \{([\s\S]*?)\n\s*\},/u)?.[1] ?? '';
  if (!field.includes('"type": "boolean"') || !field.includes('"default": false')
      || !field.includes(JSON.stringify(SEND_ONLY.description))) {
    throw new Error('send_only fixture schema does not match current Agent schema contract');
  }
  return structuredClone(SEND_ONLY);
}

/** Agent tool 对象可能是 Anthropic 的 input_schema，也可能是 Responses 的 parameters。 */
export function agentSchemaOf(tool) {
  const schema = tool.input_schema ?? tool.parameters;
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)
      || !schema.properties || typeof schema.properties !== 'object' || Array.isArray(schema.properties)) {
    throw new Error('Agent tool 缺少可更新的 input_schema/parameters.properties');
  }
  return schema;
}
