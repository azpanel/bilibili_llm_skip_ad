import test from "node:test";
import assert from "node:assert/strict";
import { formatTimestamp, toTimelineText } from "../lib/subtitles.js";
import { extractJson, normalizeSegments } from "../lib/segments.js";

test("字幕时间线使用可读的时间戳并忽略无效字幕", () => {
  assert.equal(formatTimestamp(3661), "01:01:01");
  assert.equal(toTimelineText([{ from: 1.2, to: 3.9, content: "  品牌   推广 " }, { from: 4, to: 4, content: "无效" }]), "[00:01 - 00:03] 品牌 推广");
});

test("支持从 Markdown 代码块提取模型 JSON", () => {
  assert.deepEqual(extractJson("```json\n{\"segments\":[]}\n```"), { segments: [] });
  assert.throws(() => extractJson("没有 JSON"), /JSON/);
});

test("区间会校验、裁剪、排序并合并相邻广告", () => {
  const result = normalizeSegments({ segments: [
    { start: 30, end: 40, reason: "推广" },
    { start: -5, end: 10, reason: "广告" },
    { start: 10.5, end: 20, reason: "带货" },
    { start: 90, end: 130, reason: "越界" },
    { start: 8, end: 8, reason: "无效" }
  ] }, 100);
  assert.deepEqual(result, [
    { start: 0, end: 20, reason: "广告；带货" },
    { start: 30, end: 40, reason: "推广" },
    { start: 90, end: 100, reason: "越界" }
  ]);
});
