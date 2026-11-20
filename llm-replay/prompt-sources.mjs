/**
 * 交互式新会话注入的客户端提示词正文：录制时冻结在 world leaf，回放期望侧改读当前
 * Peri checkout。注册表只登记源码路径与适用会话，避免 fixture 自行决定读取任意文件。
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ReplayError, sha256 } from './matcher.mjs';

export const PROMPT_SOURCES = Object.freeze({
  tuiSessionInstructions: Object.freeze({
    path: 'peri-tui/prompts/tui.md',
    // 只有新建/clear 后的交互式会话注入该正文；恢复会话继续使用创建时冻结的 tail。
    scope: 'interactive-fresh',
  }),
});

const detail = (extra) => (extra ? { ...extra } : {});
const fail = (code, message, details) => { throw new ReplayError(code, message, details); };

export function promptSourceRecord(id) {
  if (typeof id !== 'string' || !id) fail('unknown_prompt_source', '提示词源 id 必须为非空字符串', { source: id });
  const record = PROMPT_SOURCES[id];
  if (!record) fail('unknown_prompt_source', `未登记的提示词源: ${id}`, { source: id, registered: Object.keys(PROMPT_SOURCES) });
  return { id, ...record };
}

/**
 * 原样读取源码字节（保留末尾换行），不 trim、不补换行。任何失败都把场景、调用、
 * 字段带回调用方，便于在 CI 日志里直接定位。
 */
export async function loadPromptSource(id, root, context = {}) {
  const record = promptSourceRecord(id);
  if (!root) {
    fail('prompt_source_root_missing', '回放提示词正文需要显式设置 PERI_SOURCE_ROOT', {
      ...detail(context), source: id, path: record.path,
    });
  }
  const file = path.join(root, record.path);
  let bytes;
  try {
    bytes = await readFile(file);
  } catch (error) {
    fail('prompt_source_missing', `提示词源文件缺失: ${record.path}`, {
      ...detail(context), source: id, path: record.path, root, reason: error.code ?? String(error),
    });
  }
  try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch {
    fail('prompt_source_invalid', `提示词源不是合法 UTF-8: ${record.path}`, {
      ...detail(context), source: id, path: record.path,
    });
  }
  if (bytes.length === 0) {
    fail('prompt_source_invalid', `提示词源为空: ${record.path}`, { ...detail(context), source: id, path: record.path });
  }
  return Object.freeze({
    id, path: record.path, scope: record.scope, bytes, sha256: sha256(bytes),
  });
}

/** 同一 cassettes 载入会重复请求同一正文；每个 run 只读一次。 */
export function createPromptSourceCache(root, context = {}) {
  const cache = new Map();
  return {
    async load(id) {
      if (cache.has(id)) return cache.get(id);
      const value = await loadPromptSource(id, root, context);
      cache.set(id, value);
      return value;
    },
    root: root ?? null,
  };
}
