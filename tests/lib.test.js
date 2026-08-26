import test from "node:test";
import assert from "node:assert/strict";
import { formatTimestamp, normalizeSubtitleBodies, toTimelineText } from "../lib/subtitles.js";
import { extractJson, normalizeSegments, parseSegmentTimestamp } from "../lib/segments.js";
import { filterModels, formatModelPrices, normalizeOpenRouterCatalog } from "../lib/model-catalog.js";
import { diffLines } from "../lib/text-diff.js";
import { normalizeHistoryRecord, upsertHistory } from "../lib/history.js";
import { normalizeRecognitionRules, planRecognitionRanges, recognitionRuleFingerprint, subtitleItemsForRanges } from "../lib/recognition-rules.js";
import { aggregateDailyStatistics, dailyMetricBreakdown } from "../lib/statistics.js";

test("统计按本地日期聚合广告时长、token 和成本并补零", () => {
  const now = new Date(2026, 7, 23, 18).getTime();
  const rows = aggregateDailyStatistics([
    { recognizedAt: new Date(2026, 7, 23, 9).getTime(), segments: [{ start: 10, end: 40 }, { start: 50, end: 65 }], usage: { totalTokens: 1200, cost: 0.0123 } },
    { recognizedAt: new Date(2026, 7, 23, 20).getTime(), segments: [{ start: 0, end: 5 }], usage: { totalTokens: 300, cost: 0.001 } }
  ], 3, now);
  assert.deepEqual(rows.map((row) => row.label), ["08-21", "08-22", "08-23"]);
  assert.deepEqual(rows.map((row) => row.adSeconds), [0, 0, 50]);
  assert.equal(rows[2].tokens, 1500);
  assert.equal(rows[2].cost, 0.0133);
});

test("统计数据点可按视频拆分当日指标", () => {
  const date = new Date(2026, 7, 23, 12).getTime();
  const records = [
    { title: "视频 A", recognizedAt: date, segments: [{ start: 0, end: 30 }], usage: { totalTokens: 100, cost: .01 } },
    { title: "视频 B", recognizedAt: date, segments: [{ start: 0, end: 10 }], usage: { totalTokens: 200, cost: .02 } }
  ];
  assert.deepEqual(dailyMetricBreakdown(records, "2026-08-23", "duration"), [{ label: "视频 A", value: 30 }, { label: "视频 B", value: 10 }]);
  assert.deepEqual(dailyMetricBreakdown(records, "2026-08-23", "cost", 7), [{ label: "视频 B", value: .14 }, { label: "视频 A", value: .07 }]);
});

test("识别规则使用安全默认值并生成稳定指纹", () => {
  const rules = normalizeRecognitionRules({ durationThresholdMinutes: 0, longVideoMode: "bad", headTailMinutes: 7, chunkMinutes: 12 });
  assert.deepEqual(rules, { durationThresholdMinutes: 30, longVideoMode: "chunks", headTailMinutes: 7, chunkMinutes: 12 });
  assert.equal(recognitionRuleFingerprint(rules), "30:chunks:7:12");
});

test("按阈值、首尾和逐片模式规划检查范围", () => {
  assert.deepEqual(planRecognitionRanges(1800, {}), { mode: "full", ranges: [{ start: 0, end: 1800 }] });
  assert.deepEqual(planRecognitionRanges(3600, { durationThresholdMinutes: 30, longVideoMode: "headTail", headTailMinutes: 5 }), { mode: "headTail", ranges: [{ start: 0, end: 300 }, { start: 3300, end: 3600 }] });
  assert.deepEqual(planRecognitionRanges(1500, { durationThresholdMinutes: 10, longVideoMode: "headTail", headTailMinutes: 20 }), { mode: "full", ranges: [{ start: 0, end: 1500 }] });
  assert.deepEqual(planRecognitionRanges(1500, { durationThresholdMinutes: 10, longVideoMode: "chunks", chunkMinutes: 10 }), { mode: "chunks", ranges: [{ start: 0, end: 600 }, { start: 600, end: 1200 }, { start: 1200, end: 1500 }] });
});

test("字幕范围保留边界上下文和原始时间戳", () => {
  const items = [{ start: 580, end: 590, text: "前文" }, { start: 600, end: 610, text: "边界" }, { start: 700, end: 710, text: "后文" }];
  assert.deepEqual(subtitleItemsForRanges(items, [{ start: 600, end: 650 }]), items.slice(0, 2));
});

test("字幕时间线使用可读的时间戳并忽略无效字幕", () => {
  assert.equal(formatTimestamp(3661), "01:01:01");
  assert.equal(toTimelineText([{ from: 1.2, to: 3.9, content: "  品牌   推广 " }, { from: 4, to: 4, content: "无效" }]), "[00:01 - 00:03] 品牌 推广");
});

test("B 站与本机字幕统一为可展示的条目", () => {
  assert.deepEqual(normalizeSubtitleBodies([
    { from: 1.2, to: 3.9, content: "  B 站   字幕 " },
    { start: 4, end: 6, text: " 本机字幕 " },
    { from: 6, to: 6, content: "无效" },
    { start: 7, end: 8, text: "   " }
  ]), [
    { start: 1.2, end: 3.9, text: "B 站 字幕" },
    { start: 4, end: 6, text: "本机字幕" }
  ]);
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

test("模型时间戳支持 MM:SS 和 HH:MM:SS，同时兼容旧的秒数", () => {
  assert.equal(parseSegmentTimestamp("14:11"), 851);
  assert.equal(parseSegmentTimestamp("01:02:03.5"), 3723.5);
  assert.equal(parseSegmentTimestamp(14.11), 14.11);
  assert.ok(Number.isNaN(parseSegmentTimestamp("14:61")));
  assert.deepEqual(normalizeSegments({ segments: [
    { start: "14:11", end: "14:41", reason: "游戏联动推广" }
  ] }, 904), [
    { start: 851, end: 881, reason: "游戏联动推广" }
  ]);
});

test("逐行提示词差异保留行号并标记新增和删除", () => {
  assert.deepEqual(diffLines("第一行\n旧规则\n相同行", "第一行\n新规则\n相同行"), [
    { type: "equal", text: "第一行", beforeLine: 1, afterLine: 1 },
    { type: "add", text: "新规则", beforeLine: null, afterLine: 2 },
    { type: "remove", text: "旧规则", beforeLine: 2, afterLine: null },
    { type: "equal", text: "相同行", beforeLine: 3, afterLine: 3 }
  ]);
});

test("识别历史接受无广告的已完成识别并按视频去重更新", () => {
  const noAd = normalizeHistoryRecord({ bvid: "BV1clean", title: "无广告视频", segments: [], usage: { totalTokens: 50 } });
  assert.deepEqual(noAd.segments, []);
  assert.equal(noAd.usage.totalTokens, 50);
  const first = normalizeHistoryRecord({ bvid: "BV1demo", title: "视频", segments: [{ start: 10, end: 20, reason: "推广" }], usage: { totalTokens: 100, cost: 0.01 }, recognizedAt: 1 });
  const updated = normalizeHistoryRecord({ bvid: "BV1demo", title: "新标题", segments: [{ start: 30, end: 40, reason: "赞助" }], recognizedAt: 2 });
  assert.deepEqual(upsertHistory([first], updated), [updated]);
  assert.equal(first.id, "bv1demo");
  assert.equal(first.usage.totalTokens, 100);
});

test("识别历史保存模型与字幕来源并兼容旧记录", () => {
  const current = normalizeHistoryRecord({ bvid: "BV1source", model: "openai/gpt-demo", subtitleSource: "local", segments: [{ start: 1, end: 2 }] });
  const legacy = normalizeHistoryRecord({ bvid: "BV1legacy", segments: [{ start: 1, end: 2 }] });
  assert.equal(current.model, "openai/gpt-demo");
  assert.equal(current.subtitleSource, "local");
  assert.equal(legacy.model, "");
  assert.equal(legacy.subtitleSource, "");
});

test("OpenRouter 目录只保留可用于文本聊天的公开模型", () => {
  const compatible = {
    slug: "openai/gpt-demo",
    name: "OpenAI: GPT Demo",
    short_name: "GPT Demo",
    author: "openai",
    author_display_name: "OpenAI",
    created_at: "2026-08-05T19:48:07.643Z",
    input_modalities: ["text"],
    output_modalities: ["text"],
    has_text_output: true,
    context_length: 128000,
    endpoint: {
      has_chat_completions: true,
      is_free: false,
      provider_info: { icon: { url: "/images/icons/OpenAI.svg" } },
      display_pricing: [
        { sku_label: "Input Price", price: "0.00000125", displayMultiplier: 1000000, unitLabel: "/M tokens" },
        { sku_label: "Output Price", price: "0.00000425", displayMultiplier: 1000000, unitLabel: "/M tokens" }
      ]
    }
  };
  const models = normalizeOpenRouterCatalog({ data: [
    compatible,
    compatible,
    { ...compatible, name: "OpenAI: GPT Demo (batch)", endpoint: { ...compatible.endpoint, variant: "batch" } },
    { ...compatible, slug: "openai/transcribe", input_modalities: ["audio"], output_modalities: ["transcription"], has_text_output: false },
    { ...compatible, slug: "openai/hidden", hidden: true },
    { ...compatible, slug: "openai/disabled", endpoint: { ...compatible.endpoint, is_disabled: true } }
  ] });

  assert.equal(models.length, 1);
  assert.equal(models[0].slug, "openai/gpt-demo");
  assert.equal(models[0].name, "OpenAI: GPT Demo");
  assert.equal(models[0].createdAt, "2026-08-05T19:48:07.643Z");
  assert.equal(models[0].iconUrl, "https://openrouter.ai/images/icons/OpenAI.svg");
  assert.deepEqual(formatModelPrices(models[0]), ["Input Price $1.25/M tokens", "Output Price $4.25/M tokens"]);
});

test("OpenRouter 目录排除 batch 端点并保留同 slug 的标准端点", () => {
  const base = {
    slug: "anthropic/claude-sonnet-demo",
    short_name: "Claude Sonnet Demo",
    author: "anthropic",
    input_modalities: ["text"],
    output_modalities: ["text"],
    has_text_output: true,
    endpoint: {
      has_chat_completions: true,
      is_free: false,
      display_pricing: []
    }
  };
  const models = normalizeOpenRouterCatalog({ data: [
    { ...base, name: "Anthropic: Claude Sonnet Demo (batch)", endpoint: { ...base.endpoint, variant: "batch" } },
    { ...base, name: "Anthropic: Claude Sonnet Demo", endpoint: { ...base.endpoint, variant: "standard" } }
  ] });

  assert.equal(models.length, 1);
  assert.equal(models[0].name, "Anthropic: Claude Sonnet Demo");
});

test("模型市场支持组合搜索、开发者筛选和特殊价格状态", () => {
  const models = [
    { slug: "deepseek/chat", name: "DeepSeek Chat", shortName: "Chat", author: "deepseek", authorName: "DeepSeek" },
    { slug: "openai/gpt", name: "GPT", shortName: "GPT", author: "openai", authorName: "OpenAI" }
  ];
  assert.deepEqual(filterModels(models, "chat", "deepseek").map((model) => model.slug), ["deepseek/chat"]);
  assert.deepEqual(filterModels(models, "OPENAI").map((model) => model.slug), ["openai/gpt"]);
  assert.deepEqual(formatModelPrices({ isFree: true, pricing: [] }), ["免费"]);
  assert.deepEqual(formatModelPrices({ isFree: false, pricing: [] }), ["价格未知"]);
  assert.throws(() => normalizeOpenRouterCatalog({ data: null }), /格式无效/);
});
