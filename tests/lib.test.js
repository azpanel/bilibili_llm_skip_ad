import test from "node:test";
import assert from "node:assert/strict";
import { formatTimestamp, normalizeSubtitleBodies, toTimelineText } from "../lib/subtitles.js";
import { extractJson, normalizeSegments } from "../lib/segments.js";
import { filterModels, formatModelPrices, normalizeOpenRouterCatalog } from "../lib/model-catalog.js";

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
    { ...compatible, slug: "openai/transcribe", input_modalities: ["audio"], output_modalities: ["transcription"], has_text_output: false },
    { ...compatible, slug: "openai/hidden", hidden: true },
    { ...compatible, slug: "openai/disabled", endpoint: { ...compatible.endpoint, is_disabled: true } }
  ] });

  assert.equal(models.length, 1);
  assert.equal(models[0].slug, "openai/gpt-demo");
  assert.equal(models[0].createdAt, "2026-08-05T19:48:07.643Z");
  assert.equal(models[0].iconUrl, "https://openrouter.ai/images/icons/OpenAI.svg");
  assert.deepEqual(formatModelPrices(models[0]), ["Input Price $1.25/M tokens", "Output Price $4.25/M tokens"]);
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
