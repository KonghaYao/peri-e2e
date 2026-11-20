/**
 * 录制/迁移的 world slot 解析：把请求里可 world 化的字段映射到稳定 leaf 或 recipe。
 *
 * 只有 block0、block1 与 tools 走语义 id；其余字段返回 null，由编码器写入内容寻址 leaf。
 * 语义 id 让 prompt-only 变更只改 leaf 文件，不扩散到 stub。
 */
import { ReplayError, sha256 } from './matcher.mjs';
import { promptSourceRecord } from './prompt-sources.mjs';
import { STABLE_LEAVES, classifyBlock1Prefix } from './world-mapping.mjs';

const BLOCK1_CLASSES = ['main', 'replay-worker', 'subagent'];
const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
const tailPattern = (cls) => new RegExp(`^sys\\.block1\\.${escape(cls)}\\.t([0-9]+)\\.tail$`, 'u');
const prefixLeaf = (cls) => `sys.block1.${cls}.prefix`;
const recipePrefix = (cls) => `sys.block1.${cls}`;

const fail = (code, message, details) => { throw new ReplayError(code, message, details); };
const textOf = (bytes) => bytes.toString('utf8');
const sha8 = (value) => sha256(Buffer.from(value, 'utf8')).slice(0, 8);
const padded = (index) => String(index).padStart(2, '0');

/**
 * 把 block1 tail 中唯一出现的客户端提示词正文拆出，前后字节保持原样。
 * source 只由注册表声明；正文缺失或出现多次时显式失败，避免把错误范围锚到源码。
 */
export function splitPromptSourceTail(text, { sourceId, body, field, session }) {
  const record = promptSourceRecord(sourceId);
  if (session !== record.scope) {
    fail('prompt_source_scope_mismatch', '提示词正文的会话范围与注册表不符', {
      source: sourceId, expected: record.scope, actual: session ?? null, field,
    });
  }
  const source = Buffer.isBuffer(body) ? textOf(body) : body;
  if (typeof source !== 'string' || !source.length) {
    fail('prompt_source_invalid', '提示词正文为空，拒绝拆分 tail', { source: sourceId, field });
  }
  const at = text.indexOf(source);
  if (at < 0) {
    fail('prompt_source_missing', '提示词正文未出现在 tail 中', { source: sourceId, field });
  }
  if (text.indexOf(source, at + source.length) >= 0) {
    fail('prompt_source_ambiguous', '提示词正文在 tail 中出现多次', { source: sourceId, field });
  }
  return { head: text.slice(0, at), body: source, suffix: text.slice(at + source.length) };
}

/** 供 world recipe 使用；field/session 与实际请求字段和注册表范围一并冻结。 */
export function promptSourcePart(leaf, { sourceId, field, session }) {
  const record = promptSourceRecord(sourceId);
  if (session !== record.scope) {
    fail('prompt_source_scope_mismatch', '提示词正文的会话范围与注册表不符', {
      source: sourceId, expected: record.scope, actual: session ?? null, field,
    });
  }
  return { leaf, source: sourceId, field, session };
}

function assertView(world, label) {
  for (const method of ['hasLeaf', 'leafBytes', 'leafIds', 'recipeParts', 'recipeIds', 'renderParts']) {
    if (typeof world?.[method] !== 'function') fail('invalid_world_writer', `${label} 缺少 ${method}()`);
  }
}

/**
 * @param {object} options
 * @param {object} options.world  已封存 world 或可读取的 builder
 * @param {object} [options.builder] 新 leaf 的写入目标；默认与 world 相同（builder 场景）
 * @param {boolean} [options.allowCreate] 允许创建新 leaf/recipe；false 时未知内容返回 null
 */
export function createSlotResolver({ world, builder = world, allowCreate = true } = {}) {
  assertView(world, 'slot world');
  assertView(builder, 'slot builder');
  if (allowCreate && typeof builder.addLeaf !== 'function') fail('invalid_world_writer', 'slot builder 缺少 addLeaf()');
  if (allowCreate && typeof builder.addRecipe !== 'function') fail('invalid_world_writer', 'slot builder 缺少 addRecipe()');
  if (!world.hasLeaf(STABLE_LEAVES.skills)) {
    fail('missing_world_leaf', 'slot 解析需要 sys.skills；先运行 world:sync 建立共享 world', { leaf: STABLE_LEAVES.skills });
  }
  const skillsText = textOf(world.leafBytes(STABLE_LEAVES.skills));
  const tailByContent = new Map();
  const nextTail = new Map();
  let tailIndexed = false;
  let toolsIndex = null;
  const stats = { addedLeaves: [], addedRecipes: [], reusedRecipes: new Set() };

  const indexTails = () => {
    if (tailIndexed) return;
    tailIndexed = true;
    for (const cls of BLOCK1_CLASSES) {
      const pattern = tailPattern(cls);
      for (const id of world.leafIds()) {
        const match = pattern.exec(id);
        if (!match) continue;
        nextTail.set(cls, Math.max(nextTail.get(cls) ?? 0, Number(match[1])));
        const recipe = id.slice(0, -'.tail'.length);
        const parts = world.recipeParts(recipe);
        if (parts) {
          // 复用必须同时匹配 prefix leaf：不同 prefix 的同名 tail 不能共享 recipe。
          const prefix = parts[0]?.leaf;
          if (prefix) tailByContent.set(`${prefix}\u0000${world.leafBytes(id).toString('base64')}`, recipe);
        }
      }
    }
  };

  const addLeaf = (id, content) => {
    const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    if (builder.hasLeaf(id)) {
      if (!builder.leafBytes(id).equals(bytes)) {
        fail('duplicate_world_leaf', `${id} 已存在且内容不同`, { leaf: id });
      }
      return id;
    }
    if (!allowCreate) return null;
    builder.addLeaf(id, bytes);
    stats.addedLeaves.push(id);
    return id;
  };

  const addRecipe = (id, parts) => {
    const existing = builder.recipeParts(id);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(parts)) fail('duplicate_world_recipe', `${id} 已存在且结构不同`, { recipe: id });
      return id;
    }
    if (!allowCreate) return null;
    builder.addRecipe(id, parts);
    stats.addedRecipes.push(id);
    return id;
  };

  const verifyRecipe = (id, expected) => {
    try { return textOf(world.renderParts([{ recipe: id }])) === expected; }
    catch { return false; }
  };

  const matchStableText = (leaf, text) => {
    const existing = world.leafBytes(leaf);
    return existing && textOf(existing) === text ? { leaf, as: 'json-string' } : null;
  };

  /** 只有首个 system 段可以在空 world 中建立 block0；compact summary 复用稳定 leaf。 */
  const firstSystemSlot = (text) => {
    const block0 = matchStableText(STABLE_LEAVES.block0, text);
    if (block0) return block0;
    const compact = matchStableText(STABLE_LEAVES.compactSummary, text);
    if (compact) return compact;
    const existing = world.leafBytes(STABLE_LEAVES.block0);
    if (existing) return null;
    if (!allowCreate) return null;
    addLeaf(STABLE_LEAVES.block0, text);
    return { leaf: STABLE_LEAVES.block0, as: 'json-string' };
  };

  const matchBlock0 = (text) => matchStableText(STABLE_LEAVES.block0, text);

  const matchBlock1 = (text) => {
    indexTails();
    const skillsAt = text.indexOf(skillsText);
    // 只有唯一一处 skills 才能无歧义拆成 prefix + skills + tail。
    if (skillsAt < 0 || text.indexOf(skillsText, skillsAt + skillsText.length) >= 0) return null;
    let prefix = null;
    let prefixClass = null;
    let prefixLength = -1;
    for (const cls of BLOCK1_CLASSES) {
      const id = prefixLeaf(cls);
      const bytes = world.leafBytes(id);
      if (!bytes) continue;
      const candidate = textOf(bytes);
      if (!text.startsWith(candidate) || skillsAt < candidate.length || candidate.length <= prefixLength) continue;
      prefix = id;
      prefixClass = cls;
      prefixLength = candidate.length;
    }
    if (!prefix) {
      if (!allowCreate) return null;
      const prefixText = text.slice(0, skillsAt);
      if (!prefixText) return null;
      prefixClass = classifyBlock1Prefix(prefixText);
      prefix = addLeaf(`${prefixLeaf(prefixClass)}.${sha8(prefixText)}`, prefixText);
      if (!prefix) return null;
    }
    const tailText = text.slice(skillsAt + skillsText.length);
    const skillsPart = { leaf: STABLE_LEAVES.skills };
    if (!tailText) {
      const recipe = addRecipe(`${recipePrefix(prefixClass)}.empty.${sha8(prefix)}`, [{ leaf: prefix }, skillsPart]);
      return recipe ? { recipe, as: 'json-string' } : null;
    }
    const key = `${prefix}\u0000${Buffer.from(tailText, 'utf8').toString('base64')}`;
    const existing = tailByContent.get(key);
    if (existing) {
      stats.reusedRecipes.add(existing);
      return verifyRecipe(existing, text) ? { recipe: existing, as: 'json-string' } : null;
    }
    if (!allowCreate) return null;
    const index = (nextTail.get(prefixClass) ?? 0) + 1;
    nextTail.set(prefixClass, index);
    const tailId = `${recipePrefix(prefixClass)}.t${padded(index)}.tail`;
    addLeaf(tailId, tailText);
    const recipeId = `${recipePrefix(prefixClass)}.t${padded(index)}`;
    addRecipe(recipeId, [{ leaf: prefix }, skillsPart, { leaf: tailId }]);
    tailByContent.set(key, recipeId);
    return { recipe: recipeId, as: 'json-string' };
  };

  const matchTools = (bytes) => {
    if (!toolsIndex) {
      toolsIndex = new Map();
      const ids = [...world.recipeIds()].filter((id) => id.startsWith('tools.')).sort((left, right) => left.localeCompare(right));
      for (const id of ids) {
        try { toolsIndex.set(sha256(world.renderParts([{ recipe: id }])), id); } catch { /* seal 会统一拒绝不可渲染 recipe */ }
      }
    }
    const id = toolsIndex.get(sha256(bytes));
    if (!id) return null;
    stats.reusedRecipes.add(id);
    return { recipe: id, as: 'raw' };
  };

  /**
   * encodeRequestStub 的字段回调；第二个参数是原始 body 文本，用于取 tools 的原字节。
   * 返回 null 表示交给编码器生成内容寻址 leaf。
   */
  const slots = (field, rawText) => {
    if (field.kind === 'tools') return matchTools(Buffer.from(rawText.slice(field.start, field.end), 'utf8'));
    if (field.kind === 'compact-user') return matchStableText(STABLE_LEAVES.compactUser, field.text);
    if (field.kind !== 'system') return null;
    if (field.path === '/system' || field.path === '/system/0/text') return firstSystemSlot(field.text);
    return matchBlock0(field.text) ?? matchBlock1(field.text);
  };

  return { slots, stats };
}
