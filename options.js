import { filterModels, formatModelPrices } from "./lib/model-catalog.js";
import { diffLines } from "./lib/text-diff.js";
import { DEFAULT_RECOGNITION_RULES, normalizeRecognitionRules } from "./lib/recognition-rules.js";
import { aggregateDailyStatistics, buildViewingActivity, dailyMetricBreakdown } from "./lib/statistics.js";

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
{"segments":[{"start":"00:12","end":"00:46","reason":"与主线无关的商业推广"}]}
规则：
- 顶层只能包含 "segments"
- "segments" 必须是数组
- 每个片段只能包含 "start"、"end"、"reason"
- start、end 必须是与字幕相同格式的时间戳字符串（"MM:SS"；超过一小时用 "HH:MM:SS"）
- 禁止把时间戳写成小数：例如字幕中的 14:11 必须输出 "14:11"，绝不能输出 14.11
- end 必须大于 start
- reason 为简短中文原因
- 没有明确结果时必须输出 {"segments":[]}
- 禁止 Markdown 代码块、解释文字、注释、单引号、额外字段
- 回复第一个字符必须是 {，最后一个字符必须是 }
现在输出 JSON：`;
const SKIPPED_UPLOADER_MIDS_KEY = "skippedUploaderMids";
const HIDE_OVERLAY_IN_FULLSCREEN_KEY = "hideOverlayInFullscreen";
const MODEL_CANDIDATES_KEY = "modelCandidates";
const MODEL_MARKET_PAGE_SIZE = 40;
const form = document.querySelector("#settings");
const keyInput = document.querySelector("#api-key");
const modelInput = document.querySelector("#model");
const promptInput = document.querySelector("#prompt");
const durationThresholdInput = document.querySelector("#duration-threshold");
const headTailMinutesInput = document.querySelector("#head-tail-minutes");
const chunkMinutesInput = document.querySelector("#chunk-minutes");
const longVideoModeInputs = [...document.querySelectorAll('[name="longVideoMode"]')];
const rulePreview = document.querySelector("#duration-rule-preview");
const promptDiffElement = document.querySelector("#prompt-diff");
const promptDiffSummary = document.querySelector("#prompt-diff-summary");
const promptDiffModalElement = document.querySelector("#prompt-diff-modal");
const historyList = document.querySelector("#history-list");
const historyNotice = document.querySelector("#history-notice");
const historyPagination = document.querySelector("#history-pagination");
const historyOnlyWithAdsInput = document.querySelector("#history-only-with-ads");
const statisticsNotice = document.querySelector("#statistics-notice");
const statisticsWindowButtons = [...document.querySelectorAll("[data-statistics-days]")];
const statisticsBreakdown = document.querySelector("#statistics-breakdown");
const viewingActivitySummary = document.querySelector("#viewing-activity-summary");
const viewingActivityHours = document.querySelector("#viewing-activity-hours");
const viewingActivityDates = document.querySelector("#viewing-activity-dates");
const viewingActivityGrid = document.querySelector("#viewing-activity-grid");
const deleteHistoryModalElement = document.querySelector("#delete-history-modal");
const currencySettingsModalElement = document.querySelector("#currency-settings-modal");
const currencySelect = document.querySelector("#currency-select");
const currencyRateMeta = document.querySelector("#currency-rate-meta");
const currencySettingsNotice = document.querySelector("#currency-settings-notice");
const refreshExchangeRateButton = document.querySelector("#refresh-exchange-rate");
const saveCurrencySettingsButton = document.querySelector("#save-currency-settings");
const confirmDeleteHistoryButton = document.querySelector("#confirm-delete-history");
const hideOverlayInFullscreenInput = document.querySelector("#hide-overlay-in-fullscreen");
const skipMidInput = document.querySelector("#skip-mid-input");
const skipMidError = document.querySelector("#skip-mid-error");
const skipMidList = document.querySelector("#skip-mid-list");
const modelCandidatesElement = document.querySelector("#model-candidates");
const modelMarketElement = document.querySelector("#model-market");
const modelMarketSearch = document.querySelector("#model-market-search");
const modelMarketAuthor = document.querySelector("#model-market-author");
const modelMarketMeta = document.querySelector("#model-market-meta");
const modelMarketNotice = document.querySelector("#model-market-notice");
const modelMarketResults = document.querySelector("#model-market-results");
const loadMoreModelsButton = document.querySelector("#load-more-models");
const refreshModelMarketButton = document.querySelector("#refresh-model-market");
const hint = document.querySelector("#key-hint");
const status = document.querySelector("#status");
const saveButton = document.querySelector("#save-settings");
const tabs = [...document.querySelectorAll('[data-bs-toggle="tab"]')];
let skippedUploaderMids = [];
let editingSkipMid = null;
let uploaderProfiles = new Map();
let loadingUploaderMids = new Set();
let lastAddedMid = null;
let statusHideTimer = null;
let modelCandidates = [];
let marketModels = [];
let visibleMarketModels = MODEL_MARKET_PAGE_SIZE;
let marketLoading = false;
let historyRecords = [];
let historyLoaded = false;
let historyPage = 1;
let historyOnlyWithAds = false;
const HISTORY_PAGE_SIZE = 10;
let historyPageTransitioning = false;
let pendingHistoryDelete = null;
let statisticsDays = 7;
const statisticsCharts = new Map();
let statisticsRows = [];
let statisticsBreakdownChart = null;
let displayCurrency = "USD";
let exchangeRate = { quote: "USD", rate: 1, fetchedAt: Date.now(), cached: true };
let currenciesLoaded = false;
const modelMarket = tabler.Modal.getOrCreateInstance(modelMarketElement);
const promptDiffModal = tabler.Modal.getOrCreateInstance(promptDiffModalElement);
const deleteHistoryModal = tabler.Modal.getOrCreateInstance(deleteHistoryModalElement);
const currencySettingsModal = tabler.Modal.getOrCreateInstance(currencySettingsModalElement);

function formatHistoryTime(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor(total % 3600 / 60);
  const rest = total % 60;
  return hours
    ? `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

function formatTokenCount(value) {
  return Number.isFinite(value) ? new Intl.NumberFormat("zh-CN").format(value) : "未知";
}

function formatCost(value) {
  if (!Number.isFinite(value)) return "未知";
  return `$${value.toFixed(value < 0.01 ? 6 : 4)}`;
}

function formatDisplayCost(value, currency = displayCurrency) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "未知";
  try {
    return new Intl.NumberFormat("zh-CN", { style: "currency", currency, minimumFractionDigits: number && Math.abs(number) < 0.01 ? 4 : 2, maximumFractionDigits: number && Math.abs(number) < 0.01 ? 6 : 4 }).format(number);
  } catch {
    return `${currency} ${number.toFixed(4)}`;
  }
}

function setCurrencyNotice(message = "", type = "info") {
  if (!message) {
    currencySettingsNotice.className = "alert d-none mt-3 mb-0";
    return;
  }
  currencySettingsNotice.textContent = message;
  currencySettingsNotice.className = `alert alert-${type === "error" ? "danger" : type} mt-3 mb-0`;
}

function renderCurrencyRateMeta(rate = exchangeRate) {
  if (!rate || !Number.isFinite(Number(rate.rate))) {
    currencyRateMeta.textContent = "尚未获取汇率。";
    return;
  }
  const time = rate.fetchedAt ? new Date(rate.fetchedAt).toLocaleString("zh-CN") : "未知时间";
  const value = document.createElement("b");
  value.textContent = `1 USD = ${Number(rate.rate).toLocaleString("zh-CN", { maximumFractionDigits: 6 })} ${rate.quote}`;
  const meta = document.createElement("small");
  meta.textContent = `数据日期：${rate.date || "基准货币"} · 获取于 ${time}${rate.stale ? " · 当前为过期缓存" : ""}`;
  currencyRateMeta.replaceChildren(value, meta);
}

async function ensureExchangeRate(currency = displayCurrency, forceRefresh = false) {
  const result = await chrome.runtime.sendMessage({ type: "GET_EXCHANGE_RATE", currency, forceRefresh });
  if (result?.status !== "completed") throw new Error(result?.error || "无法获取汇率。");
  exchangeRate = result;
  renderCurrencyRateMeta(result);
  if (result.warning) setCurrencyNotice(`${result.warning}，已继续使用缓存汇率。`, "warning");
  return result;
}

async function loadCurrencies() {
  if (currenciesLoaded) return;
  const fallback = { USD: "US Dollar", CNY: "Chinese Yuan", EUR: "Euro", JPY: "Japanese Yen", GBP: "British Pound", HKD: "Hong Kong Dollar", TWD: "New Taiwan Dollar", KRW: "South Korean Won", CAD: "Canadian Dollar", AUD: "Australian Dollar", SGD: "Singapore Dollar" };
  const result = await chrome.runtime.sendMessage({ type: "GET_CURRENCIES" });
  const values = result?.status === "completed" && result.currencies?.length ? result.currencies : Object.entries(fallback).map(([code, name]) => ({ code, name }));
  currencySelect.replaceChildren(...values.sort((left, right) => left.code.localeCompare(right.code)).map(({ code, name }) => {
    const option = document.createElement("option");
    option.value = code;
    option.textContent = `${code} — ${name}`;
    return option;
  }));
  if (![...currencySelect.options].some((option) => option.value === displayCurrency)) {
    const option = new Option(displayCurrency, displayCurrency);
    currencySelect.prepend(option);
  }
  currencySelect.value = displayCurrency;
  currenciesLoaded = true;
  if (result?.status !== "completed") setCurrencyNotice("货币列表暂时不可用，已显示常用货币。", "warning");
}

function formatDurationValue(seconds) {
  const value = Math.max(0, Math.round(Number(seconds) || 0));
  if (value < 60) return `${value} 秒`;
  const minutes = Math.floor(value / 60);
  const rest = value % 60;
  return rest ? `${minutes} 分 ${rest} 秒` : `${minutes} 分钟`;
}

function chartOptions(metric, name, data, categories, color, formatter) {
  const allowMotion = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const labelStep = categories.length > 14 ? Math.ceil((categories.length - 1) / 10) : 1;
  const visibleLabels = new Set(categories.filter((_label, index) => index % labelStep === 0 || index === categories.length - 1));
  return {
    chart: { type: "area", height: 250, fontFamily: "inherit", foreColor: "#667382", toolbar: { show: false }, zoom: { enabled: false }, animations: { enabled: allowMotion, easing: "easeinout", speed: 520, animateGradually: { enabled: allowMotion, delay: 45 }, dynamicAnimation: { enabled: allowMotion, speed: 420 } }, events: { dataPointSelection: (_event, _context, config) => { const row = statisticsRows[config.dataPointIndex]; if (row) showStatisticsBreakdown(metric, row); } } },
    series: [{ name, data }],
    colors: [color],
    dataLabels: { enabled: false },
    stroke: { curve: "smooth", width: 3 },
    markers: { size: 4, strokeWidth: 0, hover: { size: 7 } },
    fill: { type: "gradient", gradient: { shadeIntensity: .2, opacityFrom: .36, opacityTo: .04, stops: [0, 88, 100] } },
    grid: { borderColor: "#e7edf4", strokeDashArray: 4, padding: { left: 8, right: 12 } },
    xaxis: { categories, axisBorder: { show: false }, axisTicks: { show: false }, labels: { rotate: 0, hideOverlappingLabels: true, trim: false, formatter: (value) => visibleLabels.has(value) ? value : "" } },
    yaxis: { min: 0, forceNiceScale: true, labels: { formatter } },
    tooltip: { theme: "light", shared: false, intersect: true, y: { formatter } },
    legend: { show: false }
  };
}

function breakdownFormatter(metric, value) {
  if (metric === "duration") return formatDurationValue(value);
  if (metric === "tokens") return `${new Intl.NumberFormat("zh-CN").format(Math.round(value))} tokens`;
  return formatDisplayCost(value);
}

function truncateChartLabel(value, maxLength = 32) {
  const label = String(value || "");
  return label.length > maxLength ? `${label.slice(0, maxLength)}...` : label;
}

function hideStatisticsBreakdown() {
  statisticsBreakdown.hidden = true;
  statisticsBreakdownChart?.destroy();
  statisticsBreakdownChart = null;
  document.querySelector("#statistics-breakdown-chart").replaceChildren();
}

function showStatisticsBreakdown(metric, row) {
  const rate = exchangeRate.quote === displayCurrency ? Number(exchangeRate.rate) || 1 : 1;
  const source = dailyMetricBreakdown(historyRecords, row.key, metric, rate);
  const metricName = metric === "duration" ? "广告时长" : metric === "tokens" ? "Token 数" : `成本（${displayCurrency}）`;
  const values = source;
  hideStatisticsBreakdown();
  statisticsBreakdown.hidden = false;
  document.querySelector("#statistics-breakdown-title").textContent = `${row.label} · ${metricName}组成`;
  const total = source.reduce((sum, item) => sum + item.value, 0);
  document.querySelector("#statistics-breakdown-summary").textContent = source.length ? `${source.length} 个视频，合计 ${breakdownFormatter(metric, total)}` : "当日没有可展示的组成数据。";
  if (!values.length) return;
  const allowMotion = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  statisticsBreakdownChart = new window.ApexCharts(document.querySelector("#statistics-breakdown-chart"), {
    chart: { type: "pie", height: 330, fontFamily: "inherit", animations: { enabled: allowMotion, easing: "easeinout", speed: 480 } },
    series: values.map((item) => item.value),
    labels: values.map((item) => item.label),
    legend: { position: "right", fontSize: "12px", formatter: (seriesName) => truncateChartLabel(seriesName) },
    dataLabels: { enabled: true, formatter: (percentage) => percentage >= 4 ? `${percentage.toFixed(1)}%` : "" },
    stroke: { colors: ["#fff"], width: 2 },
    tooltip: { y: { formatter: (value) => breakdownFormatter(metric, value) } },
    responsive: [{ breakpoint: 700, options: { chart: { height: 390 }, legend: { position: "bottom" } } }]
  });
  statisticsBreakdownChart.render();
  statisticsBreakdown.scrollIntoView({ behavior: allowMotion ? "smooth" : "auto", block: "nearest" });
}

function upsertStatisticsChart(key, selector, options) {
  const existing = statisticsCharts.get(key);
  if (existing) {
    existing.updateOptions({ xaxis: options.xaxis }, false, true);
    existing.updateSeries(options.series, true);
    return;
  }
  const chart = new window.ApexCharts(document.querySelector(selector), options);
  statisticsCharts.set(key, chart);
  chart.render();
}

function renderViewingActivity() {
  const activityDays = 45;
  const activity = buildViewingActivity(historyRecords, activityDays);
  viewingActivitySummary.textContent = `根据识别历史，最近 ${activityDays} 日共观看 ${new Intl.NumberFormat("zh-CN").format(activity.total)} 个视频`;
  viewingActivityHours.replaceChildren();
  viewingActivityDates.replaceChildren();
  viewingActivityGrid.replaceChildren();
  viewingActivityDates.style.setProperty("--activity-days", activity.dates.length);
  viewingActivityGrid.style.setProperty("--activity-days", activity.dates.length);
  for (const date of activity.dates) {
    const label = document.createElement("span");
    label.textContent = date.label;
    viewingActivityDates.append(label);
  }
  for (const hour of activity.hours) {
    const hourLabel = document.createElement("span");
    hourLabel.textContent = hour.label;
    viewingActivityHours.append(hourLabel);
    for (const day of hour.cells) {
      const cell = document.createElement("span");
      cell.className = "viewing-activity-day";
      cell.dataset.level = String(day.level);
      const description = `${day.key} ${String(day.hour).padStart(2, "0")}:00–${String(day.hour).padStart(2, "0")}:59：观看 ${day.count} 个视频`;
      cell.title = description;
      cell.setAttribute("aria-label", description);
      cell.tabIndex = 0;
      viewingActivityGrid.append(cell);
    }
  }
}

function renderStatistics() {
  renderViewingActivity();
  if (!window.ApexCharts) {
    statisticsNotice.textContent = "ApexCharts 加载失败，无法绘制统计图表。";
    statisticsNotice.className = "alert alert-danger";
    return;
  }
  statisticsNotice.classList.add("d-none");
  hideStatisticsBreakdown();
  const rows = aggregateDailyStatistics(historyRecords, statisticsDays);
  statisticsRows = rows;
  const categories = rows.map((row) => row.label);
  const adSeconds = rows.map((row) => row.adSeconds);
  const tokens = rows.map((row) => row.tokens);
  const rate = exchangeRate.quote === displayCurrency ? Number(exchangeRate.rate) || 1 : 1;
  const costs = rows.map((row) => row.cost * rate);
  const number = new Intl.NumberFormat("zh-CN");
  document.querySelector("#statistics-duration-total").textContent = `${statisticsDays} 日累计 ${formatDurationValue(adSeconds.reduce((sum, value) => sum + value, 0))}`;
  document.querySelector("#statistics-token-total").textContent = `${statisticsDays} 日累计 ${number.format(tokens.reduce((sum, value) => sum + value, 0))}`;
  document.querySelector("#statistics-cost-total").textContent = `${statisticsDays} 日累计 ${formatDisplayCost(costs.reduce((sum, value) => sum + value, 0))}`;
  upsertStatisticsChart("duration", "#statistics-duration-chart", chartOptions("duration", "广告时长", adSeconds, categories, "#f59f00", formatDurationValue));
  upsertStatisticsChart("tokens", "#statistics-token-chart", chartOptions("tokens", "Token 数", tokens, categories, "#206bc4", (value) => number.format(Math.round(value))));
  upsertStatisticsChart("cost", "#statistics-cost-chart", chartOptions("cost", `成本（${displayCurrency}）`, costs, categories, "#2fb344", (value) => formatDisplayCost(Number(value))));
}

function renderHistory() {
  historyList.replaceChildren();
  historyPagination.replaceChildren();
  const visibleRecords = historyOnlyWithAds
    ? historyRecords.filter((record) => Array.isArray(record.segments) && record.segments.length)
    : historyRecords;
  if (!visibleRecords.length) {
    const empty = document.createElement("div");
    empty.className = "history-empty";
    empty.textContent = historyOnlyWithAds ? "还没有识别到广告的视频记录。" : "还没有已完成的识别记录。";
    historyList.append(empty);
    return;
  }

  const pageCount = Math.max(1, Math.ceil(visibleRecords.length / HISTORY_PAGE_SIZE));
  historyPage = Math.min(Math.max(1, historyPage), pageCount);
  const pageRecords = visibleRecords.slice((historyPage - 1) * HISTORY_PAGE_SIZE, historyPage * HISTORY_PAGE_SIZE);
  let recordIndex = 0;
  for (const record of pageRecords) {
    const card = document.createElement("article");
    card.className = "history-card history-page-enter";
    card.style.setProperty("--history-enter-delay", `${Math.min(recordIndex, 8) * 35}ms`);
    const main = document.createElement("div");
    main.className = "history-main";
    const title = document.createElement("h3");
    title.className = "history-title";
    title.textContent = record.title || record.bvid || `av${record.aid}`;
    title.title = title.textContent;
    const uploader = document.createElement("div");
    uploader.className = "history-uploader";
    const avatar = document.createElement(record.uploaderFace ? "img" : "span");
    avatar.className = "history-avatar avatar avatar-sm rounded-circle bg-blue-lt";
    if (record.uploaderFace) {
      avatar.src = record.uploaderFace;
      avatar.alt = "";
      avatar.referrerPolicy = "no-referrer";
    } else {
      avatar.textContent = (record.uploaderName || "UP").slice(0, 1);
    }
    const uploaderName = document.createElement("span");
    uploaderName.textContent = record.uploaderName || "未知 UP 主";
    uploader.append(avatar, uploaderName);
    const videoLink = document.createElement("a");
    videoLink.className = "history-video-link";
    videoLink.href = `https://www.bilibili.com/video/${encodeURIComponent(record.bvid || `av${record.aid}`)}`;
    videoLink.target = "_blank";
    videoLink.rel = "noopener noreferrer";
    videoLink.textContent = record.bvid || `av${record.aid}`;
    const recognizedAt = document.createElement("time");
    recognizedAt.className = "history-recognized-at";
    const recognizedDate = new Date(record.recognizedAt);
    recognizedAt.dateTime = Number.isNaN(recognizedDate.getTime()) ? "" : recognizedDate.toISOString();
    recognizedAt.innerHTML = '<i class="ti ti-clock" aria-hidden="true"></i>';
    recognizedAt.append(` ${Number.isNaN(recognizedDate.getTime()) ? "识别时间未知" : recognizedDate.toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })}`);
    const recordMeta = document.createElement("div");
    recordMeta.className = "history-record-meta";
    const model = document.createElement("span");
    model.innerHTML = '<i class="ti ti-robot" aria-hidden="true"></i>';
    model.append(` ${record.model || "模型未知"}`);
    model.title = record.model || "旧记录未保存模型信息";
    const subtitleSource = document.createElement("span");
    subtitleSource.innerHTML = '<i class="ti ti-subtitles" aria-hidden="true"></i>';
    subtitleSource.append(` ${record.subtitleSource === "bilibili" ? "B 站字幕" : record.subtitleSource === "local" ? "本机识别" : "字幕来源未知"}`);
    recordMeta.append(model, subtitleSource);
    const detailsRow = document.createElement("div");
    detailsRow.className = "history-details-row";
    detailsRow.append(recognizedAt, recordMeta);
    main.append(title, uploader, videoLink, detailsRow);

    const segments = document.createElement("div");
    segments.className = "history-segments";
    for (const segment of record.segments || []) {
      const badge = document.createElement("span");
      badge.className = "badge bg-orange-lt history-segment";
      badge.textContent = `${formatHistoryTime(segment.start)}–${formatHistoryTime(segment.end)}`;
      badge.title = segment.reason || "广告或推广内容";
      badge.setAttribute("data-bs-toggle", "tooltip");
      badge.setAttribute("data-bs-placement", "top");
      segments.append(badge);
      tabler.Tooltip.getOrCreateInstance(badge);
    }
    if (!record.segments?.length) {
      const noAd = document.createElement("span");
      noAd.className = "history-no-ad";
      noAd.innerHTML = '<i class="ti ti-circle-check me-1 text-success" aria-hidden="true"></i>未识别到广告';
      segments.append(noAd);
    }

    const usage = document.createElement("div");
    usage.className = "history-usage";
    const token = document.createElement("span");
    token.innerHTML = '<i class="ti ti-coins" aria-hidden="true"></i>';
    token.append(` ${formatTokenCount(record.usage?.totalTokens)} tokens`);
    token.title = `输入 ${formatTokenCount(record.usage?.promptTokens)} · 输出 ${formatTokenCount(record.usage?.completionTokens)}`;
    token.setAttribute("data-bs-toggle", "tooltip");
    const cost = document.createElement("span");
    cost.innerHTML = '<i class="ti ti-currency-dollar" aria-hidden="true"></i>';
    cost.append(` ${formatCost(record.usage?.cost)}`);
    usage.append(token, cost);
    tabler.Tooltip.getOrCreateInstance(token);

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "btn btn-sm btn-outline-danger history-delete";
    remove.innerHTML = '<i class="ti ti-trash me-1" aria-hidden="true"></i>删除';
    remove.addEventListener("click", () => {
      pendingHistoryDelete = record.id;
      deleteHistoryModal.show();
    });
    card.append(main, segments, usage, remove);
    historyList.append(card);
    recordIndex += 1;
  }
  renderHistoryPagination(pageCount);
}

function renderHistoryPagination(pageCount) {
  if (pageCount <= 1) return;
  const addButton = (label, page, options = {}) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `history-page-button${options.active ? " is-active" : ""}`;
    button.textContent = label;
    button.disabled = Boolean(options.disabled);
    if (options.active) button.setAttribute("aria-current", "page");
    button.addEventListener("click", () => switchHistoryPage(page));
    historyPagination.append(button);
  };
  addButton("上一页", historyPage - 1, { disabled: historyPage === 1 });
  const start = Math.max(1, Math.min(historyPage - 2, pageCount - 4));
  const end = Math.min(pageCount, start + 4);
  for (let page = start; page <= end; page += 1) addButton(String(page), page, { active: page === historyPage });
  addButton("下一页", historyPage + 1, { disabled: historyPage === pageCount });
}

function switchHistoryPage(page) {
  if (historyPageTransitioning || page === historyPage) return;
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const commit = () => {
    historyPage = page;
    renderHistory();
    historyList.classList.remove("history-page-leave");
    historyPageTransitioning = false;
    document.querySelector("#panel-history")?.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "start" });
  };
  if (reducedMotion) {
    commit();
    return;
  }
  historyPageTransitioning = true;
  historyList.classList.add("history-page-leave");
  window.setTimeout(commit, 150);
}

async function loadHistory(force = false) {
  if (historyLoaded && !force) return;
  historyNotice.classList.add("d-none");
  historyList.innerHTML = '<div class="history-empty"><span class="spinner-border spinner-border-sm me-2"></span>正在读取识别历史…</div>';
  const result = await chrome.runtime.sendMessage({ type: "GET_ANALYSIS_HISTORY" });
  if (result?.status !== "completed") {
    historyNotice.textContent = result?.error || "无法读取识别历史。";
    historyNotice.className = "alert alert-danger";
    historyList.replaceChildren();
    return;
  }
  historyRecords = Array.isArray(result.records) ? result.records : [];
  historyPage = 1;
  historyLoaded = true;
  renderHistory();
}

function renderPromptDiff() {
  const lines = diffLines(DEFAULT_PROMPT, promptInput.value);
  const added = lines.filter((line) => line.type === "add").length;
  const removed = lines.filter((line) => line.type === "remove").length;
  promptDiffSummary.textContent = added || removed
    ? `${added} 行新增，${removed} 行删除`
    : "当前提示词与插件默认提示词完全一致";
  promptDiffElement.replaceChildren();

  for (const line of lines) {
    const row = document.createElement("div");
    row.className = `prompt-diff-line prompt-diff-${line.type}`;
    row.setAttribute("role", "row");
    const beforeNumber = document.createElement("span");
    beforeNumber.className = "prompt-diff-number";
    beforeNumber.textContent = line.beforeLine ?? "";
    const afterNumber = document.createElement("span");
    afterNumber.className = "prompt-diff-number";
    afterNumber.textContent = line.afterLine ?? "";
    const marker = document.createElement("span");
    marker.className = "prompt-diff-marker";
    marker.textContent = line.type === "add" ? "+" : line.type === "remove" ? "−" : " ";
    const content = document.createElement("span");
    content.className = "prompt-diff-content";
    content.textContent = line.text || " ";
    row.append(beforeNumber, afterNumber, marker, content);
    promptDiffElement.append(row);
  }
}

function normalizeUploaderMid(value) {
  const trimmed = String(value ?? "").trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const normalized = trimmed.replace(/^0+/, "");
  return normalized || null;
}

function normalizeSkippedUploaderMids(value) {
  if (!Array.isArray(value)) return [];
  const mids = [];
  for (const item of value) {
    const mid = normalizeUploaderMid(item);
    if (mid && !mids.includes(mid)) mids.push(mid);
  }
  return mids;
}

function normalizeModelCandidates(value) {
  if (!Array.isArray(value)) return [];
  const candidates = [];
  for (const item of value) {
    const slug = typeof item === "string" ? item.trim() : "";
    if (slug && !candidates.includes(slug)) candidates.push(slug);
  }
  return candidates;
}

function getDeveloperColorIndex(slug) {
  const developer = String(slug || "").split("/")[0].toLocaleLowerCase();
  let hash = 0;
  for (const character of developer) hash = ((hash * 31) + character.codePointAt(0)) >>> 0;
  return hash % 8;
}

function formatPublishedDate(value) {
  if (!value) return "发布时间未知";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "发布时间未知";
  return `发布于 ${date.toLocaleString("zh-CN", {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false
  })}`;
}

async function persistModelCandidates(nextCandidates) {
  try {
    await chrome.storage.local.set({ [MODEL_CANDIDATES_KEY]: nextCandidates });
    modelCandidates = nextCandidates;
    renderModelCandidates();
    renderModelMarketResults();
    return true;
  } catch (error) {
    setStatus(`保存候选模型失败：${getStorageErrorMessage(error)}`, "error");
    return false;
  }
}

function renderModelCandidates() {
  modelCandidatesElement.replaceChildren();
  modelCandidates.forEach((slug) => {
    const chip = document.createElement("span");
    chip.className = `model-candidate model-candidate-color-${getDeveloperColorIndex(slug)}`;
    const select = document.createElement("button");
    select.type = "button";
    select.className = "model-candidate-select";
    select.textContent = slug;
    select.title = `使用模型 ${slug}`;
    select.addEventListener("click", () => {
      modelInput.value = slug;
      clearFieldError(modelInput);
      modelInput.focus();
    });
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "model-candidate-remove";
    remove.textContent = "×";
    remove.setAttribute("aria-label", `从候选名单移除 ${slug}`);
    remove.addEventListener("click", () => persistModelCandidates(modelCandidates.filter((item) => item !== slug)));
    chip.append(select, remove);
    modelCandidatesElement.append(chip);
  });
}

function setModelMarketNotice(message = "", type = "info") {
  modelMarketNotice.className = `alert alert-${type}${message ? "" : " d-none"}`;
  modelMarketNotice.textContent = message;
}

function updateModelMarketAuthors() {
  const selected = modelMarketAuthor.value;
  const counts = new Map();
  marketModels.forEach((model) => counts.set(model.author, (counts.get(model.author) || 0) + 1));
  const authors = [...counts.keys()].sort((left, right) => {
    const leftName = marketModels.find((model) => model.author === left)?.authorName || left;
    const rightName = marketModels.find((model) => model.author === right)?.authorName || right;
    return leftName.localeCompare(rightName, "zh-CN");
  });
  modelMarketAuthor.replaceChildren(new Option("全部开发者", ""));
  authors.forEach((author) => {
    const model = marketModels.find((item) => item.author === author);
    modelMarketAuthor.append(new Option(`${model?.authorName || author} (${counts.get(author)})`, author));
  });
  modelMarketAuthor.value = counts.has(selected) ? selected : "";
}

function renderModelMarketResults() {
  if (marketLoading) return;
  const filtered = filterModels(marketModels, modelMarketSearch.value, modelMarketAuthor.value);
  const displayed = filtered.slice(0, visibleMarketModels);
  modelMarketResults.replaceChildren();
  if (!displayed.length) {
    const empty = document.createElement("div");
    empty.className = "model-market-empty";
    empty.textContent = marketModels.length ? "没有符合搜索或筛选条件的模型。" : "暂无可展示的兼容模型。";
    modelMarketResults.append(empty);
  }

  displayed.forEach((model) => {
    const card = document.createElement("article");
    card.className = "model-market-card";
    const header = document.createElement("div");
    header.className = "model-market-card-header";
    const identityGroup = document.createElement("div");
    identityGroup.className = "model-market-identity";
    const icon = document.createElement("span");
    icon.className = `model-market-icon model-candidate-color-${getDeveloperColorIndex(model.slug)}`;
    icon.textContent = (model.authorName || model.author || "?").trim().slice(0, 2).toLocaleUpperCase();
    icon.setAttribute("aria-hidden", "true");
    if (model.iconUrl) {
      const image = document.createElement("img");
      image.alt = "";
      image.loading = "lazy";
      image.decoding = "async";
      image.referrerPolicy = "no-referrer";
      image.addEventListener("error", () => image.remove(), { once: true });
      image.src = model.iconUrl;
      icon.append(image);
    }
    const identity = document.createElement("div");
    identity.style.minWidth = "0";
    const name = document.createElement("div");
    name.className = "model-market-card-name fw-bold";
    name.textContent = model.name;
    name.title = model.name;
    const slug = document.createElement("div");
    slug.className = "model-market-card-slug";
    slug.textContent = model.slug;
    slug.title = model.slug;
    identity.append(name, slug);
    identityGroup.append(icon, identity);
    const author = document.createElement("span");
    author.className = "badge bg-blue-lt";
    author.textContent = model.authorName || model.author;
    header.append(identityGroup, author);

    const prices = document.createElement("div");
    prices.className = "model-market-prices";
    formatModelPrices(model).forEach((price) => {
      const item = document.createElement("span");
      item.className = "model-market-meta-item";
      const priceIcon = document.createElement("i");
      priceIcon.className = `ti ${/^Input Price/i.test(price) ? "ti-login" : /^Output Price/i.test(price) ? "ti-logout" : "ti-coins"}`;
      priceIcon.setAttribute("aria-hidden", "true");
      item.append(priceIcon, document.createTextNode(price));
      prices.append(item);
    });

    const published = document.createElement("div");
    published.className = "model-market-published model-market-meta-item";
    const publishedIcon = document.createElement("i");
    publishedIcon.className = "ti ti-calendar-time";
    publishedIcon.setAttribute("aria-hidden", "true");
    published.append(publishedIcon, document.createTextNode(formatPublishedDate(model.createdAt)));

    const footer = document.createElement("div");
    footer.className = "model-market-card-footer mt-auto";
    const context = document.createElement("span");
    context.className = "text-secondary small model-market-meta-item";
    context.textContent = model.contextLength ? `上下文 ${model.contextLength.toLocaleString("en-US")} tokens` : "上下文长度未知";
    const contextIcon = document.createElement("i");
    contextIcon.className = "ti ti-brackets-contain";
    contextIcon.setAttribute("aria-hidden", "true");
    context.prepend(contextIcon);
    const add = document.createElement("button");
    add.type = "button";
    add.className = "btn btn-sm btn-primary";
    const alreadyAdded = modelCandidates.includes(model.slug);
    add.disabled = alreadyAdded;
    add.textContent = alreadyAdded ? "已添加" : "添加";
    add.addEventListener("click", () => persistModelCandidates([...modelCandidates, model.slug]));
    footer.append(context, add);
    card.append(header, prices, published, footer);
    modelMarketResults.append(card);
  });

  loadMoreModelsButton.classList.toggle("d-none", displayed.length >= filtered.length);
  modelMarketMeta.dataset.count = String(filtered.length);
  const timestamp = modelMarketMeta.dataset.fetchedAt;
  modelMarketMeta.textContent = `${filtered.length} 个兼容模型${timestamp ? ` · 更新于 ${timestamp}` : ""}`;
}

async function loadModelMarket(forceRefresh = false) {
  if (marketLoading) return;
  marketLoading = true;
  refreshModelMarketButton.disabled = true;
  refreshModelMarketButton.classList.add("btn-loading");
  modelMarketResults.replaceChildren();
  const loading = document.createElement("div");
  loading.className = "model-market-empty";
  loading.textContent = "正在加载模型目录…";
  modelMarketResults.append(loading);
  loadMoreModelsButton.classList.add("d-none");
  setModelMarketNotice();
  try {
    const result = await chrome.runtime.sendMessage({ type: "GET_OPENROUTER_MODELS", forceRefresh });
    if (result?.status !== "completed") throw new Error(result?.error || "无法获取模型目录。");
    marketModels = Array.isArray(result.models) ? result.models : [];
    visibleMarketModels = MODEL_MARKET_PAGE_SIZE;
    modelMarketMeta.dataset.fetchedAt = result.fetchedAt
      ? new Date(result.fetchedAt).toLocaleString("zh-CN", { hour12: false })
      : "";
    updateModelMarketAuthors();
    if (result.stale) setModelMarketNotice(`刷新失败，当前显示缓存数据：${result.error || "网络不可用。"}`, "warning");
  } catch (error) {
    marketModels = [];
    modelMarketMeta.dataset.fetchedAt = "";
    setModelMarketNotice(error.message || "无法获取模型目录，请稍后重试。", "danger");
  } finally {
    marketLoading = false;
    refreshModelMarketButton.disabled = false;
    refreshModelMarketButton.classList.remove("btn-loading");
    renderModelMarketResults();
  }
}

function activateTab(tabId) {
  const tabEl = tabs.find((tab) => tab.dataset.tab === tabId);
  if (tabEl) tabler.Tab.getOrCreateInstance(tabEl).show();
}

function setStatus(message = "", state = "") {
  clearTimeout(statusHideTimer);
  if (!message) {
    status.classList.remove("show");
    statusHideTimer = setTimeout(() => status.classList.add("d-none"), 260);
    return;
  }
  status.className = "alert mb-0 " + (state === "success" ? "alert-success" : state === "error" ? "alert-danger" : "alert-info");
  status.textContent = message;
  status.classList.remove("d-none");
  requestAnimationFrame(() => status.classList.add("show"));
}

function setSkipMidError(message = "") {
  skipMidError.textContent = message;
  if (message) skipMidInput.setAttribute("aria-invalid", "true");
  else skipMidInput.removeAttribute("aria-invalid");
}

function getStorageErrorMessage(error) {
  return error instanceof Error && error.message ? error.message : "请检查扩展存储权限后重试。";
}

async function persistSkippedUploaderMids(nextMids) {
  try {
    await chrome.storage.sync.set({ [SKIPPED_UPLOADER_MIDS_KEY]: nextMids });
    return true;
  } catch (error) {
    setStatus(`保存跳过用户名单失败：${getStorageErrorMessage(error)}`, "error");
    return false;
  }
}

async function loadUploaderProfiles(mids, forceRefresh = false) {
  const requestedMids = mids.filter((mid) => skippedUploaderMids.includes(mid));
  if (!requestedMids.length) return;
  requestedMids.forEach((mid) => loadingUploaderMids.add(mid));
  renderSkippedUploaderMids();
  try {
    const result = await chrome.runtime.sendMessage({ type: "GET_UPLOADER_PROFILES", mids: requestedMids, forceRefresh });
    if (result?.status !== "completed") throw new Error(result?.error || "暂时无法获取用户资料。");
    Object.entries(result.profiles || {}).forEach(([mid, profile]) => {
      if (skippedUploaderMids.includes(mid)) uploaderProfiles.set(mid, profile);
    });
  } catch (error) {
    requestedMids.forEach((mid) => {
      if (skippedUploaderMids.includes(mid) && !uploaderProfiles.get(mid)?.name) uploaderProfiles.set(mid, { status: "error", error: "暂时无法获取用户资料。" });
    });
  } finally {
    requestedMids.forEach((mid) => loadingUploaderMids.delete(mid));
    renderSkippedUploaderMids();
  }
}

function createActionButton(label, className, onClick, disabled = false) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.textContent = label;
  button.disabled = disabled;
  button.addEventListener("click", onClick);
  return button;
}

function renderSkippedUploaderMids() {
  const enteringMid = lastAddedMid;
  lastAddedMid = null;
  skipMidList.replaceChildren();
  if (!skippedUploaderMids.length) {
    const empty = document.createElement("li");
    empty.className = "skip-mid-empty";
    empty.textContent = "尚未添加跳过用户。";
    skipMidList.append(empty);
    return;
  }

  skippedUploaderMids.forEach((mid) => {
    const profile = uploaderProfiles.get(mid);
    const loading = loadingUploaderMids.has(mid);
    const item = document.createElement("li");
    item.className = "skip-uploader-item";
    item.dataset.mid = mid;
    if (editingSkipMid === mid) item.style.gridColumn = "1 / -1";

    const identity = document.createElement("div");
    identity.className = "skip-uploader-identity";
    const badge = document.createElement("span");
    badge.className = "skip-uploader-badge avatar avatar-sm bg-blue-lt rounded";
    badge.textContent = "UP";
    badge.setAttribute("aria-hidden", "true");
    if (profile?.face) {
      const avatar = document.createElement("img");
      avatar.className = "skip-uploader-avatar";
      avatar.alt = "";
      avatar.decoding = "async";
      avatar.referrerPolicy = "no-referrer";
      avatar.addEventListener("error", () => {
        profile.face = "";
        avatar.remove();
        badge.textContent = "UP";
      }, { once: true });
      avatar.src = profile.face;
      badge.replaceChildren(avatar);
    }
    const copy = document.createElement("div");
    copy.className = "skip-uploader-copy";
    const name = document.createElement("strong");
    name.className = "skip-uploader-name";
    name.textContent = profile?.name || (loading ? "正在查询用户资料…" : "昵称暂不可用");
    const midText = document.createElement("span");
    midText.className = "skip-uploader-mid";
    midText.textContent = `MID ${mid}`;
    copy.append(name, midText);
    if (profile?.error) {
      const feedback = document.createElement("span");
      feedback.className = "skip-uploader-feedback";
      feedback.textContent = profile.error;
      copy.append(feedback);
    }
    identity.append(badge, copy);

    const actions = document.createElement("div");
    actions.className = "skip-uploader-actions";
    if (editingSkipMid !== mid) {
      actions.append(
        createActionButton("刷新", "btn btn-sm btn-outline-secondary skip-uploader-action", () => loadUploaderProfiles([mid], true), loading),
        createActionButton("编辑", "btn btn-sm btn-outline-secondary skip-uploader-action", () => {
          editingSkipMid = mid;
          renderSkippedUploaderMids();
          requestAnimationFrame(() => skipMidList.querySelector(`[data-edit-mid="${mid}"]`)?.focus());
        }, loading),
        createActionButton("删除", "btn btn-sm btn-outline-danger skip-uploader-delete", () => removeSkippedUploaderMid(mid), loading)
      );
    }
    item.append(identity, actions);

    if (editingSkipMid === mid) {
      const editForm = document.createElement("div");
      editForm.className = "skip-uploader-edit-form";
      const input = document.createElement("input");
      input.type = "text";
      input.className = "form-control form-control-sm";
      input.inputMode = "numeric";
      input.autocomplete = "off";
      input.value = mid;
      input.dataset.editMid = mid;
      input.setAttribute("aria-label", "新的投稿用户 MID");
      const error = document.createElement("span");
      error.className = "skip-uploader-edit-error";
      const save = createActionButton("保存", "btn btn-sm btn-primary skip-uploader-save", () => updateSkippedUploaderMid(mid, input.value, error));
      const cancel = createActionButton("取消", "btn btn-sm btn-outline-secondary skip-uploader-action", () => {
        editingSkipMid = null;
        renderSkippedUploaderMids();
      });
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") updateSkippedUploaderMid(mid, input.value, error);
        if (event.key === "Escape") {
          editingSkipMid = null;
          renderSkippedUploaderMids();
        }
      });
      editForm.append(input, save, cancel, error);
      item.append(editForm);
    }
    skipMidList.append(item);
    if (mid === enteringMid) {
      item.classList.add("skip-item-enter");
      requestAnimationFrame(() => requestAnimationFrame(() => item.classList.remove("skip-item-enter")));
    }
  });
}

async function addSkippedUploaderMid() {
  const mid = normalizeUploaderMid(skipMidInput.value);
  if (!mid) {
    setSkipMidError("请输入有效的投稿用户 MID。");
    skipMidInput.focus();
    return;
  }
  if (skippedUploaderMids.includes(mid)) {
    setSkipMidError("该 MID 已在跳过名单中。");
    skipMidInput.focus();
    return;
  }
  const nextMids = [...skippedUploaderMids, mid];
  if (!await persistSkippedUploaderMids(nextMids)) return;
  skippedUploaderMids = nextMids;
  skipMidInput.value = "";
  setSkipMidError();
  setStatus("跳过用户名单已保存。", "success");
  lastAddedMid = mid;
  loadUploaderProfiles([mid]);
  renderSkippedUploaderMids();
}

async function updateSkippedUploaderMid(previousMid, value, errorElement) {
  const mid = normalizeUploaderMid(value);
  if (!mid) {
    errorElement.textContent = "请输入有效的投稿用户 MID。";
    return;
  }
  if (mid !== previousMid && skippedUploaderMids.includes(mid)) {
    errorElement.textContent = "该 MID 已在跳过名单中。";
    return;
  }
  const nextMids = skippedUploaderMids.map((itemMid) => itemMid === previousMid ? mid : itemMid);
  if (!await persistSkippedUploaderMids(nextMids)) {
    errorElement.textContent = "保存失败，未更改 MID。";
    return;
  }
  skippedUploaderMids = nextMids;
  uploaderProfiles.delete(previousMid);
  editingSkipMid = null;
  setStatus("跳过用户名单已保存。", "success");
  loadUploaderProfiles([mid]);
  renderSkippedUploaderMids();
}

async function removeSkippedUploaderMid(mid) {
  const item = skipMidList.querySelector(`[data-mid="${mid}"]`);
  if (item) {
    item.classList.add("skip-item-exit");
    await new Promise((resolve) => {
      item.addEventListener("transitionend", resolve, { once: true });
      setTimeout(resolve, 250);
    });
  }
  const nextMids = skippedUploaderMids.filter((itemMid) => itemMid !== mid);
  if (!await persistSkippedUploaderMids(nextMids)) return;
  skippedUploaderMids = nextMids;
  uploaderProfiles.delete(mid);
  loadingUploaderMids.delete(mid);
  setStatus("跳过用户名单已保存。", "success");
  renderSkippedUploaderMids();
}

function setSaveState(saving) {
  saveButton.disabled = saving;
  saveButton.classList.toggle("btn-loading", saving);
  saveButton.setAttribute("aria-label", saving ? "正在保存…" : "保存设置");
  form.setAttribute("aria-busy", String(saving));
}

function showFieldError(input, tabId, message) {
  input.setAttribute("aria-invalid", "true");
  activateTab(tabId);
  input.focus();
  setStatus(message, "error");
}

function clearFieldError(input) {
  input.removeAttribute("aria-invalid");
}

function selectedLongVideoMode() {
  return longVideoModeInputs.find((input) => input.checked)?.value || DEFAULT_RECOGNITION_RULES.longVideoMode;
}

function renderDurationRule() {
  const mode = selectedLongVideoMode();
  document.querySelectorAll(".long-video-option").forEach((option) => option.classList.toggle("is-selected", option.dataset.mode === mode));
  document.querySelectorAll(".long-video-parameter").forEach((parameter) => { parameter.hidden = parameter.dataset.mode !== mode; });
  const threshold = durationThresholdInput.value || DEFAULT_RECOGNITION_RULES.durationThresholdMinutes;
  const description = mode === "full" ? "超过阈值后仍发送全部字幕" : mode === "headTail"
    ? `超过阈值后检查首尾各 ${headTailMinutesInput.value || DEFAULT_RECOGNITION_RULES.headTailMinutes} 分钟`
    : `超过阈值后每 ${chunkMinutesInput.value || DEFAULT_RECOGNITION_RULES.chunkMinutes} 分钟逐片检查`;
  rulePreview.querySelector("strong").textContent = `≤ ${threshold} 分钟：完整检查`;
  rulePreview.querySelector("span").textContent = description;
  rulePreview.dataset.mode = mode;
}

function validateMinuteInput(input, label) {
  const value = Number(input.value);
  if (Number.isInteger(value) && value >= 1 && value <= 1440) return value;
  showFieldError(input, "rules", `${label}必须是 1–1440 的整数分钟。`);
  return null;
}

function updateKeyHint(apiKey) {
  hint.textContent = apiKey ? `已保存密钥（末四位：${apiKey.slice(-4)}）。如不修改可留空。` : "尚未保存 API Key。";
}

document.querySelectorAll('[data-bs-toggle="tooltip"]').forEach((el) => tabler.Tooltip.getOrCreateInstance(el));

[modelInput, promptInput, durationThresholdInput, headTailMinutesInput, chunkMinutesInput].forEach((input) => input.addEventListener("input", () => { clearFieldError(input); renderDurationRule(); }));
longVideoModeInputs.forEach((input) => input.addEventListener("change", renderDurationRule));
skipMidInput.addEventListener("input", () => setSkipMidError());
document.querySelector("#add-skip-mid").addEventListener("click", addSkippedUploaderMid);
skipMidInput.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  addSkippedUploaderMid();
});
document.querySelector("#open-model-market").addEventListener("click", () => {
  modelMarket.show();
  if (!marketModels.length) loadModelMarket();
});
document.querySelector("#compare-prompt").addEventListener("click", () => {
  renderPromptDiff();
  promptDiffModal.show();
});
modelMarketElement.addEventListener("shown.bs.modal", () => modelMarketSearch.focus());
modelMarketSearch.addEventListener("input", () => {
  visibleMarketModels = MODEL_MARKET_PAGE_SIZE;
  renderModelMarketResults();
});
modelMarketAuthor.addEventListener("change", () => {
  visibleMarketModels = MODEL_MARKET_PAGE_SIZE;
  renderModelMarketResults();
});
refreshModelMarketButton.addEventListener("click", () => loadModelMarket(true));
loadMoreModelsButton.addEventListener("click", () => {
  visibleMarketModels += MODEL_MARKET_PAGE_SIZE;
  renderModelMarketResults();
});
document.querySelector("#tab-history").addEventListener("shown.bs.tab", () => loadHistory());
document.querySelector("#tab-statistics").addEventListener("shown.bs.tab", async () => {
  await loadHistory(true);
  if (!historyLoaded) {
    statisticsNotice.textContent = "无法读取识别历史。";
    statisticsNotice.className = "alert alert-danger";
    return;
  }
  try {
    await ensureExchangeRate(displayCurrency);
  } catch (error) {
    statisticsNotice.textContent = error.message || "无法获取汇率。";
    statisticsNotice.className = "alert alert-danger";
    return;
  }
  requestAnimationFrame(renderStatistics);
});
statisticsWindowButtons.forEach((button) => button.addEventListener("click", () => {
  statisticsDays = Number(button.dataset.statisticsDays);
  statisticsWindowButtons.forEach((item) => item.classList.toggle("is-active", item === button));
  renderStatistics();
}));
document.querySelector("#close-statistics-breakdown").addEventListener("click", hideStatisticsBreakdown);
document.querySelector("#open-currency-settings").addEventListener("click", async () => {
  setCurrencyNotice();
  currencySettingsModal.show();
  await loadCurrencies();
  currencySelect.value = displayCurrency;
  try {
    await ensureExchangeRate(displayCurrency);
  } catch (error) {
    setCurrencyNotice(error.message || "无法获取汇率。", "error");
  }
});
refreshExchangeRateButton.addEventListener("click", async () => {
  refreshExchangeRateButton.disabled = true;
  refreshExchangeRateButton.classList.add("btn-loading");
  setCurrencyNotice("正在刷新汇率…");
  try {
    await ensureExchangeRate(currencySelect.value, true);
    if (!exchangeRate.warning) setCurrencyNotice("汇率已刷新。", "success");
  } catch (error) {
    setCurrencyNotice(error.message || "汇率刷新失败。", "error");
  } finally {
    refreshExchangeRateButton.disabled = false;
    refreshExchangeRateButton.classList.remove("btn-loading");
  }
});
saveCurrencySettingsButton.addEventListener("click", async () => {
  const currency = currencySelect.value;
  saveCurrencySettingsButton.disabled = true;
  saveCurrencySettingsButton.classList.add("btn-loading");
  setCurrencyNotice("正在保存货币设置…");
  try {
    await ensureExchangeRate(currency);
    await chrome.storage.sync.set({ displayCurrency: currency });
    displayCurrency = currency;
    document.querySelector("#statistics-currency-code").textContent = currency;
    renderStatistics();
    currencySettingsModal.hide();
  } catch (error) {
    setCurrencyNotice(error.message || "无法保存货币设置。", "error");
  } finally {
    saveCurrencySettingsButton.disabled = false;
    saveCurrencySettingsButton.classList.remove("btn-loading");
  }
});
document.querySelector("#refresh-history").addEventListener("click", () => loadHistory(true));
historyOnlyWithAdsInput.addEventListener("change", () => {
  historyOnlyWithAds = historyOnlyWithAdsInput.checked;
  historyPage = 1;
  renderHistory();
});
confirmDeleteHistoryButton.addEventListener("click", async () => {
  if (!pendingHistoryDelete) return;
  confirmDeleteHistoryButton.disabled = true;
  confirmDeleteHistoryButton.classList.add("btn-loading");
  const id = pendingHistoryDelete;
  try {
    const result = await chrome.runtime.sendMessage({ type: "DELETE_ANALYSIS_HISTORY", id });
    if (result?.status !== "completed") throw new Error(result?.error || "删除失败。");
    historyRecords = historyRecords.filter((record) => record.id !== id);
    pendingHistoryDelete = null;
    deleteHistoryModal.hide();
    renderHistory();
    if (statisticsCharts.size) renderStatistics();
  } catch (error) {
    setStatus(error.message || "删除识别记录失败。", "error");
  } finally {
    confirmDeleteHistoryButton.disabled = false;
    confirmDeleteHistoryButton.classList.remove("btn-loading");
  }
});
deleteHistoryModalElement.addEventListener("hidden.bs.modal", () => { pendingHistoryDelete = null; });

try {
  const [local, sync] = await Promise.all([
    chrome.storage.local.get(["openRouterApiKey", MODEL_CANDIDATES_KEY]),
    chrome.storage.sync.get(["model", "prompt", SKIPPED_UPLOADER_MIDS_KEY, HIDE_OVERLAY_IN_FULLSCREEN_KEY, "durationThresholdMinutes", "longVideoMode", "headTailMinutes", "chunkMinutes", "displayCurrency"])
  ]);
  modelInput.value = sync.model || "deepseek/deepseek-chat";
  const hasStoredCandidates = Object.prototype.hasOwnProperty.call(local, MODEL_CANDIDATES_KEY);
  modelCandidates = hasStoredCandidates ? normalizeModelCandidates(local[MODEL_CANDIDATES_KEY]) : [modelInput.value];
  renderModelCandidates();
  if (!hasStoredCandidates) chrome.storage.local.set({ [MODEL_CANDIDATES_KEY]: modelCandidates }).catch(() => {});
  promptInput.value = sync.prompt || DEFAULT_PROMPT;
  const recognitionRules = normalizeRecognitionRules(sync);
  durationThresholdInput.value = recognitionRules.durationThresholdMinutes;
  headTailMinutesInput.value = recognitionRules.headTailMinutes;
  chunkMinutesInput.value = recognitionRules.chunkMinutes;
  const modeInput = longVideoModeInputs.find((input) => input.value === recognitionRules.longVideoMode);
  if (modeInput) modeInput.checked = true;
  renderDurationRule();
  displayCurrency = /^[A-Z]{3}$/.test(sync.displayCurrency || "") ? sync.displayCurrency : "USD";
  document.querySelector("#statistics-currency-code").textContent = displayCurrency;
  hideOverlayInFullscreenInput.checked = sync[HIDE_OVERLAY_IN_FULLSCREEN_KEY] === true;
  skippedUploaderMids = normalizeSkippedUploaderMids(sync[SKIPPED_UPLOADER_MIDS_KEY]);
  renderSkippedUploaderMids();
  loadUploaderProfiles(skippedUploaderMids);
  updateKeyHint(local.openRouterApiKey);
} catch (error) {
  modelInput.value = "deepseek/deepseek-chat";
  modelCandidates = [modelInput.value];
  renderModelCandidates();
  promptInput.value = DEFAULT_PROMPT;
  durationThresholdInput.value = DEFAULT_RECOGNITION_RULES.durationThresholdMinutes;
  headTailMinutesInput.value = DEFAULT_RECOGNITION_RULES.headTailMinutes;
  chunkMinutesInput.value = DEFAULT_RECOGNITION_RULES.chunkMinutes;
  longVideoModeInputs.find((input) => input.value === DEFAULT_RECOGNITION_RULES.longVideoMode).checked = true;
  renderDurationRule();
  renderSkippedUploaderMids();
  updateKeyHint();
  setStatus(`无法读取已保存的设置：${getStorageErrorMessage(error)}`, "error");
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const model = modelInput.value.trim();
  const prompt = promptInput.value.trim();
  const apiKey = keyInput.value.trim();
  if (!model) {
    showFieldError(modelInput, "connection", "请填写模型名称。");
    return;
  }
  if (!prompt) {
    showFieldError(promptInput, "prompt", "请填写识别广告提示词。");
    return;
  }
  const durationThresholdMinutes = validateMinuteInput(durationThresholdInput, "完整检查阈值");
  const headTailMinutes = validateMinuteInput(headTailMinutesInput, "首尾检查时长");
  const chunkMinutes = validateMinuteInput(chunkMinutesInput, "切片时长");
  if (durationThresholdMinutes == null || headTailMinutes == null || chunkMinutes == null) return;
  setSaveState(true);
  setStatus("正在保存设置…");
  try {
    const writes = [chrome.storage.sync.set({
      model,
      prompt,
      [SKIPPED_UPLOADER_MIDS_KEY]: skippedUploaderMids,
      [HIDE_OVERLAY_IN_FULLSCREEN_KEY]: hideOverlayInFullscreenInput.checked,
      durationThresholdMinutes,
      longVideoMode: selectedLongVideoMode(),
      headTailMinutes,
      chunkMinutes
    })];
    if (apiKey) writes.push(chrome.storage.local.set({ openRouterApiKey: apiKey }));
    await Promise.all(writes);
    keyInput.value = "";
    if (apiKey) updateKeyHint(apiKey);
    setStatus("设置已保存。", "success");
  } catch (error) {
    setStatus(`保存失败，无法确认所有设置均已保存：${getStorageErrorMessage(error)}`, "error");
  } finally {
    setSaveState(false);
  }
});
