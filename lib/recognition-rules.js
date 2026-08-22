export const RECOGNITION_RULE_KEYS = Object.freeze({
  threshold: "durationThresholdMinutes",
  mode: "longVideoMode",
  headTail: "headTailMinutes",
  chunk: "chunkMinutes"
});

export const DEFAULT_RECOGNITION_RULES = Object.freeze({
  durationThresholdMinutes: 30,
  longVideoMode: "chunks",
  headTailMinutes: 5,
  chunkMinutes: 10
});

const MODES = new Set(["full", "headTail", "chunks"]);

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 1 && number <= 1440 ? number : fallback;
}

export function normalizeRecognitionRules(value = {}) {
  return {
    durationThresholdMinutes: positiveInteger(value.durationThresholdMinutes, DEFAULT_RECOGNITION_RULES.durationThresholdMinutes),
    longVideoMode: MODES.has(value.longVideoMode) ? value.longVideoMode : DEFAULT_RECOGNITION_RULES.longVideoMode,
    headTailMinutes: positiveInteger(value.headTailMinutes, DEFAULT_RECOGNITION_RULES.headTailMinutes),
    chunkMinutes: positiveInteger(value.chunkMinutes, DEFAULT_RECOGNITION_RULES.chunkMinutes)
  };
}

export function recognitionRuleFingerprint(rules) {
  const value = normalizeRecognitionRules(rules);
  return [value.durationThresholdMinutes, value.longVideoMode, value.headTailMinutes, value.chunkMinutes].join(":");
}

export function planRecognitionRanges(duration, rules) {
  const seconds = Number(duration);
  const value = normalizeRecognitionRules(rules);
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds <= value.durationThresholdMinutes * 60 || value.longVideoMode === "full") {
    return { mode: "full", ranges: [{ start: 0, end: Number.isFinite(seconds) && seconds > 0 ? seconds : Infinity }] };
  }
  if (value.longVideoMode === "headTail") {
    const length = value.headTailMinutes * 60;
    if (length * 2 >= seconds) return { mode: "full", ranges: [{ start: 0, end: seconds }] };
    return { mode: "headTail", ranges: [{ start: 0, end: length }, { start: seconds - length, end: seconds }] };
  }
  const size = value.chunkMinutes * 60;
  const ranges = [];
  for (let start = 0; start < seconds; start += size) ranges.push({ start, end: Math.min(seconds, start + size) });
  return { mode: "chunks", ranges };
}

export function subtitleItemsForRanges(items, ranges, contextSeconds = 15) {
  if (!Array.isArray(items) || !Array.isArray(ranges)) return [];
  const seen = new Set();
  return items.filter((item, index) => {
    const start = Number(item?.start ?? item?.from);
    const end = Number(item?.end ?? item?.to);
    const included = Number.isFinite(start) && Number.isFinite(end) && ranges.some((range) => end > Math.max(0, range.start - contextSeconds) && start < range.end + contextSeconds);
    if (!included) return false;
    const key = `${start}:${end}:${item?.text ?? item?.content ?? ""}:${index}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
