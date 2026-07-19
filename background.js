import { toTimelineText } from "./lib/subtitles.js";
import { extractJson, normalizeSegments } from "./lib/segments.js";

const DEFAULT_PROMPT = `你是视频内容审核助手。根据带时间戳的字幕，识别明确的商业广告、品牌推广、带货、课程/社群/产品引流片段。不要把普通内容、口播开场、创作者自我介绍误判为广告；不确定时不要输出。仅返回 JSON，格式为 {"segments":[{"start":12.3,"end":45.6,"reason":"简短原因"}]}，start/end 必须是秒数。`;

function apiUrl(path) {
  return path.startsWith("//") ? `https:${path}` : path;
}

async function getVideoIdentity({ bvid, aid, cid, pageNumber = 1 }) {
  if (aid && cid) return { aid, cid };
  if (!bvid && !aid) throw new Error("未获取到视频标识。");
  const query = bvid ? `bvid=${encodeURIComponent(bvid)}` : `aid=${encodeURIComponent(aid)}`;
  const response = await fetch(`https://api.bilibili.com/x/web-interface/view?${query}`, { credentials: "include" });
  if (!response.ok) throw new Error(`视频信息请求失败（${response.status}）。`);
  const payload = await response.json();
  if (payload.code !== 0 || !payload.data) throw new Error(`视频信息接口返回异常：${payload.message || payload.code}。`);
  const page = payload.data.pages?.[Math.max(0, pageNumber - 1)] ?? payload.data.pages?.[0];
  if (!page?.cid) throw new Error("未获取到当前分 P 的 CID。");
  return { aid: payload.data.aid, cid: page.cid };
}

function orderSubtitles(subtitles) {
  return [...subtitles].sort((left, right) => {
    const score = (subtitle) => subtitle.lan_doc?.includes("中文") || subtitle.lan?.startsWith("zh") ? 1 : 0;
    return score(right) - score(left);
  });
}

async function fetchSubtitles(request) {
  const { bvid } = request;
  const { aid, cid } = await getVideoIdentity(request);
  const endpoints = [
    `https://api.bilibili.com/x/player/wbi/v2?aid=${encodeURIComponent(aid)}&cid=${encodeURIComponent(cid)}`,
    `https://api.bilibili.com/x/player/v2?aid=${encodeURIComponent(aid)}&cid=${encodeURIComponent(cid)}`
  ];
  let subtitles = [];
  let lastError = "";
  for (const endpoint of endpoints) {
    try {
      const response = await fetch(endpoint, { credentials: "include" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      subtitles = payload?.data?.subtitle?.subtitles || [];
      if (subtitles.length) break;
      lastError = payload?.message || "接口未返回字幕";
    } catch (error) {
      lastError = error.message;
    }
  }
  if (!subtitles.length) return { status: "no-subtitles", debug: `aid=${aid}，cid=${cid}；${lastError}` };

  let downloadError = "";
  for (const subtitleInfo of orderSubtitles(subtitles)) {
    try {
      const response = await fetch(apiUrl(subtitleInfo.subtitle_url), { credentials: "include" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const subtitle = await response.json();
      const timeline = toTimelineText(subtitle.body);
      if (timeline) return { status: "ready", timeline, subtitleName: subtitleInfo.lan_doc || subtitleInfo.lan || "字幕" };
      downloadError = "字幕内容为空";
    } catch (error) {
      downloadError = error.message;
    }
  }
  return { status: "no-subtitles", debug: `发现 ${subtitles.length} 个字幕候选，但均不可用：${downloadError}` };
}

async function analyze({ bvid, cacheKey = bvid, timeline, duration, force }) {
  const cached = await chrome.storage.session.get(`analysis:${cacheKey}`);
  if (!force && cached[`analysis:${cacheKey}`]) return { ...cached[`analysis:${cacheKey}`], cached: true };

  const [local, sync] = await Promise.all([chrome.storage.local.get("openRouterApiKey"), chrome.storage.sync.get(["model", "prompt"])]);
  if (!local.openRouterApiKey || !sync.model) return { status: "needs-settings" };

  const requestBody = {
    model: sync.model,
    temperature: 0,
    messages: [
      { role: "system", content: sync.prompt || DEFAULT_PROMPT },
      { role: "user", content: `视频 BV 号：${bvid}\n\n字幕时间线：\n${timeline}` }
    ]
  };
  const requestDebug = JSON.stringify({ url: "https://openrouter.ai/api/v1/chat/completions", body: requestBody }, null, 2);
  let responseText = "";
  try {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${local.openRouterApiKey}` },
      body: JSON.stringify(requestBody)
    });
    responseText = await response.text();
    if (!response.ok) throw new Error(`OpenRouter 请求失败（${response.status}）：${responseText.slice(0, 500)}`);
    const payload = JSON.parse(responseText);
    const content = payload?.choices?.[0]?.message?.content;
    const segments = normalizeSegments(extractJson(content), duration);
    const result = { status: "completed", segments, requestDebug, responseDebug: responseText };
    await chrome.storage.session.set({ [`analysis:${cacheKey}`]: result });
    return result;
  } catch (error) {
    return { status: "failed", error: error.message || "AI 分析失败。", requestDebug, responseDebug: responseText };
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "FETCH_SUBTITLES") {
    fetchSubtitles(message).then(sendResponse).catch((error) => sendResponse({ status: "failed", error: error.message || "字幕获取失败。" }));
    return true;
  }
  if (message.type === "GET_MODEL") {
    chrome.storage.sync.get("model").then(({ model }) => sendResponse({ model: model || "未配置模型" }));
    return true;
  }
  if (message.type === "ANALYZE") {
    analyze(message).then(sendResponse);
    return true;
  }
});
