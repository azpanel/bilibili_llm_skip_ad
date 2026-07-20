export function formatTimestamp(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const clock = `${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  return hours > 0 ? `${String(hours).padStart(2, "0")}:${clock}` : clock;
}

export function normalizeSubtitleBodies(body) {
  if (!Array.isArray(body)) return [];

  return body
    .map((item) => ({
      start: Number(item.from ?? item.start),
      end: Number(item.to ?? item.end),
      text: typeof (item.content ?? item.text) === "string" ? (item.content ?? item.text).replace(/\s+/g, " ").trim() : ""
    }))
    .filter((item) => Number.isFinite(item.start) && Number.isFinite(item.end) && item.end > item.start && item.text);
}

export function toTimelineText(items) {
  return normalizeSubtitleBodies(items)
    .map((item) => `[${formatTimestamp(item.start)} - ${formatTimestamp(item.end)}] ${item.text}`)
    .join("\n");
}
