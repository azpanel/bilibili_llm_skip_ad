export function extractJson(text) {
  if (typeof text !== "string") throw new Error("模型未返回文本内容。");
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("模型响应中没有 JSON 对象。");
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    throw new Error("模型返回的 JSON 格式无效。");
  }
}

export function normalizeSegments(value, duration = Infinity) {
  if (!value || !Array.isArray(value.segments)) throw new Error("模型 JSON 缺少 segments 数组。");
  const maxDuration = Number.isFinite(duration) && duration > 0 ? duration : Infinity;
  const prepared = value.segments
    .map((segment) => ({
      start: Number(segment.start),
      end: Number(segment.end),
      reason: typeof segment.reason === "string" ? segment.reason.trim().slice(0, 240) : "广告或推广内容"
    }))
    .filter((segment) => Number.isFinite(segment.start) && Number.isFinite(segment.end))
    .map((segment) => ({ ...segment, start: Math.max(0, segment.start), end: Math.min(maxDuration, segment.end) }))
    .filter((segment) => segment.end > segment.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);

  return prepared.reduce((merged, segment) => {
    const previous = merged.at(-1);
    if (previous && segment.start <= previous.end + 1) {
      previous.end = Math.max(previous.end, segment.end);
      if (segment.reason && !previous.reason.includes(segment.reason)) previous.reason += `；${segment.reason}`;
      return merged;
    }
    merged.push(segment);
    return merged;
  }, []);
}
