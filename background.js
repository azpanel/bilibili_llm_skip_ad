import { normalizeSubtitleBodies, toTimelineText } from "./lib/subtitles.js";
import { extractJson, normalizeSegments } from "./lib/segments.js";

const DEFAULT_PROMPT = `你是视频跳过片段识别助手。你的唯一任务是：根据视频标题、简介和带时间戳字幕，找出“与视频主线无关、观众跳过后不影响理解视频主要内容”的商业植入/赞助推广片段。

【视频主线】
先根据标题、简介、字幕上下文判断本视频主要讨论的主题、对象和内容目标。
判断广告时，必须考虑某个品牌、产品、平台是否本来就是该视频主题的一部分。

【只识别以下片段】
识别与视频主线无关或关联很弱的商业推广，例如：
1. 视频中途突然介绍某个品牌、App、平台、商品、服务；
2. 明确的赞助商口播、植入广告、带货推广；
3. 引导用户下载、注册、购买、领取优惠、使用邀请码、点击链接、进入店铺；
4. 推广课程、社群、咨询服务、会员、工具、插件、产品或其他商业服务；
5. 明显可独立删除，删除后不影响视频主线理解的品牌宣传内容。

常见广告信号包括但不限于：
- “本期视频由……赞助/感谢……支持”
- “有需要可以去……购买/下载/注册”
- “输入邀请码/使用优惠券/点击链接”
- “官方补贴/限时优惠/新人福利”
- 连续介绍某产品功能、价格、卖点，并带有推荐或行动号召
- 与前后内容话题明显断裂，随后又回到原本主题

【绝对不要识别为广告】
以下情况即使出现品牌、商品或平台，也不要输出：
1. 品牌/产品/平台本身就是视频主题、评测对象、新闻事件对象或案例对象。
   - 例如：数码评测视频讨论手机、电脑、拼多多、京东等购物渠道；
   - 社会事件评论视频讨论涉事公司、品牌或平台；
   - 教程视频正常讲解所需的软件、工具或产品；
   - 购物分享、开箱、测评、探店、品牌历史等以商品/品牌为主题的视频。
2. 正常内容中的顺带提及、个人使用体验、创作者自我介绍。
3. 视频开头的普通问候、关注点赞提醒、频道介绍。
4. 与主线相关的推荐、评价、信息说明，但没有明显商业推广或行动号召。
5. 无法确定是否为广告的片段。宁可漏掉，不要误报。

【关键判定标准】
只有同时满足以下条件时，才输出：
A. 该片段存在明显商业推广、赞助、带货或引流意图；
B. 该推广对象不是视频主线的核心讨论对象；
C. 删除该片段后，观众仍能理解后续主要内容；
D. 从上下文看，该片段与前后主线存在明显切换或可独立跳过。

特别注意：
- “提到拼多多”不等于广告。只有在数码内容中突然开始推荐拼多多、介绍优惠活动、引导下单，而拼多多并非该视频核心讨论对象时，才可能是广告。
- “提到某款产品”不等于广告。只有社会事件、生活分享等视频中突然插入其功效、品牌、购买渠道或优惠信息时，才可能是广告。
- 视频中突然出现“转转/爱回收”的回收服务介绍、估价流程、优惠或下载引导，且删掉后不影响视频主线表达，通常应识别为广告。

【时间范围要求】
- start：广告真正开始的第一句推广话术的开始时间。
- end：广告结束、恢复原视频主线的时间。
- 不要把广告前后的正常内容包含进去。
- 相邻且属于同一个广告的字幕应合并为一个片段。
- 如果没有符合条件的片段，返回空数组。

【输出协议：必须严格遵守】
你的回复必须是可被 JSON.parse() 直接解析的合法 JSON 对象。
除了 JSON 本身，不得输出任何字符。
唯一允许的结构：
{"segments":[]}
或：
{"segments":[{"start":12.3,"end":45.6,"reason":"与主线无关的商业推广"}]}
规则：
- 顶层只能包含 "segments"
- "segments" 必须是数组
- 每个片段只能包含 "start"、"end"、"reason"
- start、end 必须是数字，不得加引号
- end 必须大于 start
- reason 为简短中文原因
- 没有明确结果时必须输出 {"segments":[]}
- 禁止 Markdown 代码块、解释文字、注释、单引号、额外字段
- 回复第一个字符必须是 {，最后一个字符必须是 }
现在输出 JSON：`;

const LOCAL_TRANSCRIBER_URL = "http://127.0.0.1:8765";
const LOCAL_REQUEST_TIMEOUT = 10000;
const LOCAL_STATUS_TIMEOUT = 10000;
const LOCAL_TOTAL_TIMEOUT = 15 * 60 * 1000;
const LOCAL_POLL_INTERVAL = 1200;

function apiUrl(path) {
  return path.startsWith("//") ? `https:${path}` : path;
}

async function fetchLocal(path, options = {}, timeout = LOCAL_REQUEST_TIMEOUT) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(`${LOCAL_TRANSCRIBER_URL}${path}`, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function localError(error, fallback) {
  return error.name === "AbortError" ? "本机识别服务请求超时，请检查服务状态或重试。" : error.message || fallback;
}

async function transcribeLocally({ requestId, identity, audioUrls, duration }, tabId) {
  let lastReportedProgress = null;
  const reportProgress = (job) => {
    if (tabId == null) return;
    const transcription = job.transcription || null;
    const progress = [job.status, job.progress, job.message, transcription?.progress, transcription?.seconds, transcription?.duration, transcription?.eta];
    const progressKey = JSON.stringify(progress);
    if (progressKey === lastReportedProgress) return;
    lastReportedProgress = progressKey;
    chrome.tabs.sendMessage(tabId, {
      type: "LOCAL_TRANSCRIPTION_PROGRESS",
      requestId,
      status: job.status,
      progress: job.progress,
      message: job.message,
      transcription
    }).catch(() => {});
  };
  const health = await fetchLocal("/v1/health");
  if (!health.ok) throw new Error(`本机识别服务不可用（${health.status}）。`);
  const created = await fetchLocal("/v1/transcriptions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ requestId, video: { ...identity, duration }, audio: { urls: audioUrls }, options: { language: "zh" } })
  });
  if (!created.ok) throw new Error(`提交本机识别任务失败（${created.status}）。`);
  const { jobId } = await created.json();
  const deadline = Date.now() + LOCAL_TOTAL_TIMEOUT;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, LOCAL_POLL_INTERVAL));
    const response = await fetchLocal(`/v1/transcriptions/${encodeURIComponent(jobId)}`, {}, LOCAL_STATUS_TIMEOUT);
    if (!response.ok) throw new Error(`查询本机识别任务失败（${response.status}）。`);
    const job = await response.json();
    reportProgress(job);
    if (job.status === "completed") {
      const subtitleItems = normalizeSubtitleBodies((job.segments || []).map((segment) => ({ from: segment.start, to: segment.end, content: segment.text })));
      return { status: "ready", subtitleName: "本机语音识别", subtitleItems, timeline: toTimelineText(subtitleItems) };
    }
    if (job.status === "failed" || job.status === "cancelled") throw new Error(job.error || job.message || "本机语音识别失败。");
  }
  throw new Error("本机语音识别任务超过 15 分钟仍未完成，请查看服务日志。");
}

async function cancelLocalTranscription(jobId) {
  if (!jobId) return;
  await fetch(`${LOCAL_TRANSCRIBER_URL}/v1/transcriptions/${encodeURIComponent(jobId)}`, { method: "DELETE" }).catch(() => {});
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "TRANSCRIBE_LOCAL") {
    transcribeLocally(message, _sender.tab?.id).then(sendResponse).catch((error) => sendResponse({ status: "failed", error: localError(error, "本机语音识别失败。") }));
    return true;
  }
  if (message.type === "CANCEL_LOCAL_TRANSCRIPTION") {
    cancelLocalTranscription(message.jobId).then(() => sendResponse({ status: "cancelled" }));
    return true;
  }
});

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
      const subtitleItems = normalizeSubtitleBodies(subtitle.body);
      const timeline = toTimelineText(subtitleItems);
      if (timeline) return { status: "ready", timeline, subtitleItems, subtitleName: subtitleInfo.lan_doc || subtitleInfo.lan || "字幕" };
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
    const message = payload?.choices?.[0]?.message;
    const content = message?.content;
    const reasoningDebug = typeof message?.reasoning === "string" ? message.reasoning : "";
    const segments = normalizeSegments(extractJson(content), duration);
    const result = { status: "completed", segments, requestDebug, responseDebug: responseText, reasoningDebug };
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
  if (message.type === "OPEN_OPTIONS") {
    chrome.runtime.openOptionsPage().then(() => sendResponse({ status: "opened" })).catch((error) => sendResponse({ status: "failed", error: error.message || "无法打开扩展设置页。" }));
    return true;
  }
  if (message.type === "ANALYZE") {
    analyze(message).then(sendResponse);
    return true;
  }
});
