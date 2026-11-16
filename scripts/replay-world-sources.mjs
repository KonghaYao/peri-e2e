/**
 * world 快照与当前源码之间的显式映射。迁移、world:sync 与 drift 校验共用同一份定义，
 * 避免“哪个 leaf 可以变化”出现两套口径。
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { AGENT_LEAF_PREFIX, STABLE_LEAVES } from '../llm-replay/world-mapping.mjs';

export { AGENT_LEAF_PREFIX, STABLE_LEAVES };

export const SOURCE_FILES = Object.freeze({
  skills: 'peri-acp/prompts/sections/13_skills.md',
  agentDescription: 'peri-middlewares/src/subagent/tool/descriptions/agent.md',
  agentSchema: 'peri-middlewares/src/subagent/tool/define.rs',
  compactSummary: 'peri-agent/src/agent/compact_v2/descriptions/summary_system_prompt.md',
});

/** block0 是 01–06 段的组合体；顺序必须与 BASE_SECTIONS 的 Cached zone 一致。 */
export const BLOCK0_SECTIONS = Object.freeze([
  '01_intro', '02_system', '03_doing_tasks', '04_actions', '05_using_tools', '06_tone_style',
]);

const sectionFile = (root, id) => path.join(root, 'peri-acp/prompts/sections', `${id}.md`);

/**
 * 组合 block0。trim 对齐 wire 侧 split_system_blocks：单 block 的 system 文本会被 trim，
 * 因此组合后必须整体 trim 才能与请求中的 system[0] 逐字节一致。
 */
export async function composeBlock0(periRoot) {
  const texts = [];
  for (const id of BLOCK0_SECTIONS) {
    const text = await readFile(sectionFile(periRoot, id), 'utf8');
    if (text.trim()) texts.push(text);
  }
  return texts.join('\n\n').trim();
}

/** BASE_SECTIONS 的顺序/zone 变化会让 block0 组合失效，必须在同步前显式失败。 */
export async function assertBlock0SectionOrder(periRoot) {
  const source = await readFile(path.join(periRoot, 'peri-middlewares/src/default_system_prompt/mod.rs'), 'utf8');
  const table = /const BASE_SECTIONS[^=]*=\s*\[([\s\S]*?)\n\];/u.exec(source)?.[1];
  if (!table) throw new Error('无法解析 peri-middlewares BASE_SECTIONS，拒绝同步 block0');
  const entries = [...table.matchAll(/\(\s*"([a-z0-9_]+)"[\s\S]*?PromptSectionZone::(\w+),\s*(\d+),/gu)]
    .map((match) => ({ id: match[1], zone: match[2], order: Number(match[3]) }));
  const first = entries.slice(0, BLOCK0_SECTIONS.length);
  if (first.length !== BLOCK0_SECTIONS.length) throw new Error('BASE_SECTIONS 条目不足，拒绝同步 block0');
  for (const [index, entry] of first.entries()) {
    if (entry.id !== BLOCK0_SECTIONS[index] || entry.zone !== 'Cached' || entry.order !== index + 1) {
      throw new Error(`BASE_SECTIONS 顺序/zone 与 block0 组合不一致：期望 ${BLOCK0_SECTIONS[index]} Cached #${index + 1}，实际 ${entry.id} ${entry.zone} #${entry.order}`);
    }
  }
  return entries;
}

/** 所有源派生 leaf 的唯一期望字节；world:sync 与 source-anchored verify 共用。 */
export async function loadSourceLeaves(world, periRoot) {
  await assertBlock0SectionOrder(periRoot);
  const [block0, skills, compactSummary, agentDescription, agentSchema] = await Promise.all([
    composeBlock0(periRoot),
    readFile(path.join(periRoot, SOURCE_FILES.skills), 'utf8'),
    readFile(path.join(periRoot, SOURCE_FILES.compactSummary), 'utf8'),
    readFile(path.join(periRoot, SOURCE_FILES.agentDescription), 'utf8'),
    readFile(path.join(periRoot, SOURCE_FILES.agentSchema), 'utf8'),
  ]);
  for (const id of [STABLE_LEAVES.block0, STABLE_LEAVES.skills, STABLE_LEAVES.compactSummary]) {
    if (!world.hasLeaf(id)) throw new Error(`world 缺少稳定 leaf ${id}，无法映射对应源文件`);
  }
  const expected = new Map([
    [STABLE_LEAVES.block0, Buffer.from(block0, 'utf8')],
    [STABLE_LEAVES.skills, Buffer.from(skills, 'utf8')],
    [STABLE_LEAVES.compactSummary, Buffer.from(compactSummary, 'utf8')],
  ]);
  const sendOnly = expectedSendOnly(agentSchema);
  for (const id of agentDescriptionLeafIds(world)) {
    const current = world.leafBytes(id).toString('utf8');
    let tool;
    try { tool = JSON.parse(current); }
    catch { throw new Error(`${id}: leaf 不是合法 JSON，拒绝改写`); }
    if (JSON.stringify(tool) !== current) throw new Error(`${id}: leaf JSON 无法无损往返，拒绝改写`);
    tool.description = agentDescription;
    agentSchemaOf(tool).properties.send_only = structuredClone(sendOnly);
    expected.set(id, Buffer.from(JSON.stringify(tool), 'utf8'));
  }
  return expected;
}

/** Agent 工具 description 的稳定来源；其他 tool 文本仍是录制内容，不做源码同步。 */
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

/** 复用旧生成器的契约检查：define.rs 的 send_only 定义变化时必须显式失败。 */
export function expectedSendOnly(defineSource) {
  const field = defineSource.match(/"send_only": \{([\s\S]*?)\n\s*\},/u)?.[1] ?? '';
  if (!field.includes('"type": "boolean"') || !field.includes('"default": false')
      || !field.includes(JSON.stringify(SEND_ONLY.description))) {
    throw new Error('send_only fixture schema does not match current define.rs contract');
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
