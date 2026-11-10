/**
 * 解析 Peri 源码根：显式 --peri-root 优先，其次 PERI_SOURCE_ROOT。
 * 只有 world:sync / migrate 需要读取 Peri 源码；普通 replay 只需要 PERI_BINARY。
 */
import { access } from 'node:fs/promises';
import path from 'node:path';

export function resolvePeriRoot(explicit) {
  const value = explicit ?? process.env.PERI_SOURCE_ROOT;
  if (!value) {
    throw new Error('缺少 Peri 源码目录：传入 --peri-root <dir> 或设置 PERI_SOURCE_ROOT');
  }
  return path.resolve(value);
}

export async function assertPeriRoot(root) {
  try {
    await access(path.join(root, 'Cargo.toml'));
  } catch {
    throw new Error(`Peri 源码目录无效（缺少 Cargo.toml）：${root}`);
  }
  return root;
}
