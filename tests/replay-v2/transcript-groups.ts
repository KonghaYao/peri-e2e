import type { ReplayTui } from "../../helpers/llm-replay-tui.js";

/**
 * 正文空档折叠组：正文段落之间的工具 / thinking / 普通通知合成一行，默认 `▸`；
 * 点击组行（header）后整组展开为 `▾`，组内成员原样显示、不再逐项折叠。
 */
const COLLAPSED_GROUP_ROW = /^(\s*)▸\s+(\S.*)$/u;
const EXPANDED_GROUP_ROW = /^\s*▾\s+/u;

export type TranscriptTui = Pick<ReplayTui, "screen" | "waitFor" | "clickAt">;

export interface CollapsedGroupRow {
  /** 0-based 视口行号；SGR 点击坐标需 +1。 */
  row: number;
  /** 1-based 视口列号，落在组行首字符（居中正文带内）。 */
  column: number;
  title: string;
}

/** 去掉 `g`：同一正则跨轮询复用 `test` 时 lastIndex 会漂移。 */
function matches(title: string, pattern: RegExp): boolean {
  return new RegExp(pattern.source, pattern.flags.replace("g", "")).test(title);
}

export function collapsedGroupRows(screen: string): CollapsedGroupRow[] {
  return screen.split("\n").flatMap((line, row) => {
    const match = COLLAPSED_GROUP_ROW.exec(line);
    if (!match) return [];
    return [{ row, column: match[1]!.length + 1, title: match[2]!.trimEnd() }];
  });
}

export function collapsedGroupCount(screen: string, title: RegExp): number {
  return collapsedGroupRows(screen).filter((entry) => matches(entry.title, title)).length;
}

function expandedInPlace(before: string, target: CollapsedGroupRow, screen: string): boolean {
  if (EXPANDED_GROUP_ROW.test(screen.split("\n")[target.row] ?? "")) return true;
  // 组行被流式追加顶离原行时，至少确认折叠行数减少，避免把未渲染误判为展开。
  return collapsedGroupRows(screen).length < collapsedGroupRows(before).length;
}

/** 展开标题匹配的第一个折叠组，返回展开后的屏幕（组行必须已在视口内）。 */
export async function expandCollapsedGroup(tui: TranscriptTui, title: RegExp): Promise<string> {
  const visible = await tui.waitFor(
    (screen) => collapsedGroupRows(screen).some((entry) => matches(entry.title, title)),
    `collapsed transcript group ${String(title)} is visible`,
  );
  const target = collapsedGroupRows(visible).find((entry) => matches(entry.title, title))!;
  await tui.clickAt(target.column, target.row + 1);
  return tui.waitFor(
    (screen) => expandedInPlace(visible, target, screen),
    `transcript group ${target.title} expands in place`,
    10_000,
  );
}

/** 逐组点击当前视口内的折叠组，直到没有 `▸` 行；每次等待原位变 `▾`，不用固定 sleep。 */
export async function expandCollapsedGroups(tui: TranscriptTui, limit = 16): Promise<string> {
  let screen = await tui.screen();
  for (let expanded = 0; ; expanded++) {
    const target = collapsedGroupRows(screen)[0];
    if (!target) return screen;
    if (expanded >= limit) {
      throw new Error(`展开折叠组超过 ${limit} 个后仍有 ▸ 行：\n${screen}`);
    }
    const before = screen;
    await tui.clickAt(target.column, target.row + 1);
    screen = await tui.waitFor(
      (next) => expandedInPlace(before, target, next),
      `transcript group ${target.title} expands in place`,
      10_000,
    );
  }
}
