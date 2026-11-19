import { describe, expect, it } from "vitest";
import {
  collapsedGroupCount, collapsedGroupRows, expandCollapsedGroup, expandCollapsedGroups, type TranscriptTui,
} from "./transcript-groups.js";

/** 屏幕逐步变化的假终端：每次 clickAt 推进到下一帧，waitFor 只读当前帧。 */
function fakeTranscript(frames: string[]) {
  const state = { index: 0 };
  const clicks: Array<[number, number]> = [];
  const tui: TranscriptTui = {
    async screen() { return frames[state.index]!; },
    async waitFor(predicate, description) {
      if (predicate(frames[state.index]!)) return frames[state.index]!;
      throw new Error(`${description}\n${frames[state.index]}`);
    },
    async clickAt(column, row) {
      clicks.push([column, row]);
      state.index = Math.min(state.index + 1, frames.length - 1);
    },
  };
  return { tui, clicks };
}

describe("正文空档折叠组行解析", () => {
  it("识别居中正文带内的组行并按 ▸ 列给出 1-based 点击坐标", () => {
    const screen = [
      "              ▸  Agent",
      "              ⠼  replay-worker",
      "              ▸  Read · Reminder",
      "              ▸  Read · 1 failed",
    ].join("\n");
    expect(collapsedGroupRows(screen)).toEqual([
      { row: 0, column: 15, title: "Agent" },
      { row: 2, column: 15, title: "Read · Reminder" },
      { row: 3, column: 15, title: "Read · 1 failed" },
    ]);
    expect(collapsedGroupCount(screen, /\bAgent\b/u)).toBe(1);
    expect(collapsedGroupCount(screen, /\bRead\b/u)).toBe(2);
  });

  it("展开后的 ▾ 行、子 Agent 状态行与正文里的 ▸ 都不算折叠组", () => {
    const screen = [
      "    ▾  Reminder · Write",
      "    │  ✓  Write  split-参数.txt",
      "    ✓  replay-worker",
      "    │  quote ▸ is body text",
    ].join("\n");
    expect(collapsedGroupRows(screen)).toEqual([]);
  });
});

describe("展开折叠组", () => {
  it("点击标题匹配组行的 header，等待原位出现 ▾", async () => {
    const collapsed = ["    ▸  Reminder · Agent", "    ▸  Agent"].join("\n");
    const expanded = ["    ▾  Reminder · Agent", "    ▾  Agent  A01-spawn", "    ▸  Agent"].join("\n");
    const { tui, clicks } = fakeTranscript([collapsed, expanded]);
    expect(await expandCollapsedGroup(tui, /Agent$/u)).toBe(expanded);
    expect(clicks).toEqual([[5, 1]]);
  });

  it("逐组展开到没有 ▸ 行为止，每次点击都落在对应行", async () => {
    const frames = [
      ["  ▸  Agent", "  ▸  Read · Reminder"].join("\n"),
      ["  ▾  Agent", "  ▾  Agent  A01-spawn", "  ▸  Read · Reminder"].join("\n"),
      ["  ▾  Agent", "  ▾  Agent  A01-spawn", "  ▾  Read · Reminder", "  ▾  Read  a03-child.txt — 3 lines"].join("\n"),
    ];
    const { tui, clicks } = fakeTranscript(frames);
    const expanded = await expandCollapsedGroups(tui);
    expect(expanded).toContain("Read  a03-child.txt — 3 lines");
    expect(collapsedGroupRows(expanded)).toEqual([]);
    expect(clicks).toEqual([[3, 1], [3, 3]]);
  });

  it("超过上限仍残留折叠组时显式失败，不静默通过", async () => {
    // 流式追加场景：每次展开都会在组尾长出新组，上限用于终止这种无限增长。
    const { tui } = fakeTranscript([
      "  ▸  Agent",
      ["  ▾  Agent", "  ✓  Agent", "  ▸  Agent"].join("\n"),
    ]);
    await expect(expandCollapsedGroups(tui, 1)).rejects.toThrow(/展开折叠组超过 1 个后仍有 ▸ 行/u);
  });
});
