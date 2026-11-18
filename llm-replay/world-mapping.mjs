/**
 * world leaf 与源码的单一映射：world:sync 只改写 here 列出的 leaf，
 * 加载器的 drift 校验复用同一集合，未映射 leaf 的变化不能被“漂移”解释。
 */
export const STABLE_LEAVES = Object.freeze({
  block0: 'sys.block0.main',
  skills: 'sys.skills',
  compactSummary: 'sys.compact.summary',
  compactUser: 'sys.compact.user',
});

export const AGENT_LEAF_PREFIX = 'tools.Agent.';

/**
 * Bash tool 的 description 来自内置 workspace MCP 的 bash.md；name/schema 仍由录制模板锚定。
 * 两个协议各有一个 leaf，必须显式列出，不能用前缀通配其它工具。
 */
export const BASH_TOOL_LEAVES = Object.freeze({
  anthropic: 'tools.Bash.anthropic',
  responses: 'tools.Bash.responses',
});

/**
 * block1 prefix 的固定分类 leaf。prefix 由源码段（07_runtime / 10_hitl /
 * 11_subagent / 12_ask_user）加固定 catalog/persona 模板组合；带内容哈希的
 * `sys.block1.<class>.prefix.<sha8>` 变体不在映射内，仍按录制内容严格校验。
 */
export const BLOCK1_PREFIX_LEAVES = Object.freeze({
  main: 'sys.block1.main.prefix',
  'replay-worker': 'sys.block1.replay-worker.prefix',
  subagent: 'sys.block1.subagent.prefix',
});

/** block0 由 01–06 源文件组合，和 skills / compact summary/user 一样属于源派生 leaf。 */
const SYNCED = new Set([
  STABLE_LEAVES.block0,
  STABLE_LEAVES.skills,
  STABLE_LEAVES.compactSummary,
  STABLE_LEAVES.compactUser,
  ...Object.values(BLOCK1_PREFIX_LEAVES),
  ...Object.values(BASH_TOOL_LEAVES),
]);

/** 只有 world:sync 能更新这些 leaf；其余 leaf 必须与录制快照逐字节一致。 */
export function isSyncedWorldLeaf(id) {
  return SYNCED.has(id) || id.startsWith(AGENT_LEAF_PREFIX);
}

/**
 * block1 的前缀语义：主 Agent（含/不含 replay-worker catalog）与子 Agent 的短 prompt。
 * 分类冲突时由调用方显式失败，而不是静默合并到同一个 leaf。
 */
export function classifyBlock1Prefix(prefix) {
  if (prefix.startsWith('Complete the delegated task with the available workspace tools.')) return 'subagent';
  if (prefix.includes('replay-worker [')) return 'replay-worker';
  return 'main';
}
