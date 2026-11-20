import type { ReplayTui } from "../../helpers/llm-replay-tui.js";

/**
 * 正文空档折叠组：正文段落之间的工具 / thinking / 普通通知合成一行，默认 `▸`；
 * 点击组行（header）后整组展开为 `▾`，组内成员保留各自的折叠态（默认单行），
 * 点击成员标题只切换该成员（Peri #504）。
 */
const ARROW_ROW = /^(\s*)([▸▾])\s+(\S.*)$/u;
/** 可折叠的成员标题行：工具卡状态符号、提醒箭头或子 Agent 组头。 */
const MEMBER_ROW = /^(\s*)([▸▾✓×\u2800-\u28ff])\s+(\S.*)$/u;
/**
 * 组行标题只由成员类型统计构成（`Read ×2 · Thought ×1 · running`，渲染层另追加
 * `· N failed`）；成员标题在标签后还有自由文本（`✓ Write a.txt · +1`、
 * `System reminder · Task · subagent · Info`），因此不满足该语法。
 */
const GROUP_TITLE_SEGMENT = String.raw`(?:Skill \([^)]*\)|[^\s·]+(?: ×\d+)?|\d+ (?:steps?|failed)|running)`;
const GROUP_TITLE_ROW = new RegExp(`^${GROUP_TITLE_SEGMENT}(?: · ${GROUP_TITLE_SEGMENT})*$`, "u");

export type TranscriptTui = Pick<ReplayTui, "screen" | "waitFor" | "clickAt">;

export interface TranscriptRow {
  /** 0-based 视口行号；SGR 点击坐标需 +1。 */
  row: number;
  /** 1-based 视口列号，落在行首符号（居中正文带内）。 */
  column: number;
  title: string;
  expanded: boolean;
}

export interface CollapsedGroupRow {
  row: number;
  column: number;
  title: string;
}

/** 去掉 `g`：同一正则跨轮询复用 `test` 时 lastIndex 会漂移。 */
function matches(title: string, pattern: RegExp): boolean {
  return new RegExp(pattern.source, pattern.flags.replace("g", "")).test(title);
}

function parseRows(screen: string, pattern: RegExp): TranscriptRow[] {
  return screen.split("\n").flatMap((line, row) => {
    const match = pattern.exec(line);
    if (!match) return [];
    return [{
      row, column: match[1]!.length + 1, title: match[3]!.trimEnd(), expanded: match[2] === "▾",
    }];
  });
}

function arrowRows(screen: string): TranscriptRow[] {
  return parseRows(screen, ARROW_ROW);
}

/** 组行判定只用于 `▸`/`▾` 行：组内成员标题不满足组名统计语法。 */
function isGroupRow(entry: TranscriptRow): boolean {
  return matches(entry.title, GROUP_TITLE_ROW);
}

/** 折叠成员（含未分组的可折叠卡）标题行；组行单独排除，避免被当成成员点开。 */
function collapsedMemberRows(screen: string): TranscriptRow[] {
  return parseRows(screen, MEMBER_ROW).filter((entry) => !entry.expanded && !isGroupRow(entry));
}

export function collapsedGroupRows(screen: string): CollapsedGroupRow[] {
  return arrowRows(screen)
    .filter((entry) => !entry.expanded && isGroupRow(entry))
    .map(({ row, column, title }) => ({ row, column, title }));
}

export function collapsedGroupCount(screen: string, title: RegExp): number {
  return collapsedGroupRows(screen).filter((entry) => matches(entry.title, title)).length;
}

/** 展开行按标题计数：同屏可有多行同名（重复组），只认目标标题新增的 `▾`。 */
function expandedCount(screen: string, title: string | RegExp): number {
  return arrowRows(screen).filter((entry) => entry.expanded
    && (typeof title === "string" ? entry.title === title : matches(entry.title, title))).length;
}

/** 展开标题匹配的第一个折叠组，返回展开后的屏幕（组行必须已在视口内）。 */
export async function expandCollapsedGroup(tui: TranscriptTui, title: RegExp): Promise<string> {
  const visible = await tui.waitFor(
    (screen) => collapsedGroupRows(screen).some((entry) => matches(entry.title, title)),
    `collapsed transcript group ${String(title)} is visible`,
  );
  const target = collapsedGroupRows(visible).find((entry) => matches(entry.title, title))!;
  const before = expandedCount(visible, target.title);
  await tui.clickAt(target.column, target.row + 1);
  return tui.waitFor(
    (screen) => expandedCount(screen, target.title) > before,
    `transcript group ${target.title} expands to ▾`,
    10_000,
  );
}

/**
 * 逐组点击当前视口内的折叠组，直到没有组行 `▸`；每次等待同名组行出现 `▾`。
 *
 * 组展开后成员仍可能是折叠行（如提醒成员自带 `▸`），因此只点击组行——
 * 展开成员留给需要卡体证据的用例用 [`expandGroupMember`]。
 */
export async function expandCollapsedGroups(tui: TranscriptTui, limit = 16): Promise<string> {
  let screen = await tui.screen();
  for (let clicked = 0; ; clicked++) {
    const target = collapsedGroupRows(screen)[0];
    if (!target) return screen;
    if (clicked >= limit) {
      throw new Error(`展开折叠组超过 ${limit} 个后仍有 ▸ 组行：\n${screen}`);
    }
    const before = expandedCount(screen, target.title);
    await tui.clickAt(target.column, target.row + 1);
    screen = await tui.waitFor(
      (next) => expandedCount(next, target.title) > before,
      `transcript group ${target.title} expands to ▾`,
      10_000,
    );
  }
}

/**
 * 点开已展开组内的折叠成员（工具卡 / 普通通知），只切换该成员，组头与同组
 * 其他成员不变。组头仍折叠时成员不可见，需先 `expandCollapsedGroup`。
 */
export async function expandGroupMember(tui: TranscriptTui, title: RegExp): Promise<string> {
  const visible = await tui.waitFor(
    (screen) => collapsedMemberRows(screen).some((entry) => matches(entry.title, title)),
    `collapsed group member ${String(title)} is visible`,
  );
  const target = collapsedMemberRows(visible).find((entry) => matches(entry.title, title))!;
  const before = expandedCount(visible, title);
  await tui.clickAt(target.column, target.row + 1);
  return tui.waitFor(
    (screen) => expandedCount(screen, title) > before,
    `group member ${target.title} expands to ▾`,
    10_000,
  );
}
