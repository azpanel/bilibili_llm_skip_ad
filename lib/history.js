export const ANALYSIS_HISTORY_KEY = "analysisHistory";
export const ANALYSIS_HISTORY_LIMIT = 500;

function cleanText(value, maxLength) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

export function normalizeHistoryRecord(value) {
  if (!value || !Array.isArray(value.segments)) return null;
  const bvid = /^BV[\w]+$/i.test(String(value.bvid || "")) ? String(value.bvid) : "";
  const aid = /^\d+$/.test(String(value.aid || "")) ? String(value.aid) : "";
  const videoId = bvid || (aid ? `av${aid}` : "");
  if (!videoId) return null;
  const segments = value.segments
    .map((segment) => ({
      start: finiteNumber(segment?.start),
      end: finiteNumber(segment?.end),
      reason: cleanText(segment?.reason, 240)
    }))
    .filter((segment) => segment.start !== null && segment.end !== null && segment.end > segment.start);
  return {
    id: videoId.toLocaleLowerCase(),
    bvid,
    aid,
    title: cleanText(value.title, 500) || videoId,
    uploaderName: cleanText(value.uploaderName, 100) || "未知 UP 主",
    uploaderFace: /^https:\/\//i.test(String(value.uploaderFace || "")) ? String(value.uploaderFace).slice(0, 1000) : "",
    model: cleanText(value.model, 200),
    subtitleSource: value.subtitleSource === "bilibili" || value.subtitleSource === "local" ? value.subtitleSource : "",
    segments,
    usage: {
      promptTokens: finiteNumber(value.usage?.promptTokens),
      completionTokens: finiteNumber(value.usage?.completionTokens),
      totalTokens: finiteNumber(value.usage?.totalTokens),
      cost: finiteNumber(value.usage?.cost)
    },
    recognizedAt: finiteNumber(value.recognizedAt) || Date.now()
  };
}

export function upsertHistory(records, record, limit = ANALYSIS_HISTORY_LIMIT) {
  const normalized = normalizeHistoryRecord(record);
  if (!normalized) return Array.isArray(records) ? records : [];
  return [normalized, ...(Array.isArray(records) ? records : []).filter((item) => item?.id !== normalized.id)]
    .slice(0, limit);
}
