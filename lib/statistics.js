function localDateKey(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function aggregateDailyStatistics(records, days, now = Date.now()) {
  const windowDays = [3, 7, 15, 30].includes(Number(days)) ? Number(days) : 7;
  const end = new Date(now);
  end.setHours(12, 0, 0, 0);
  const rows = [];
  const byDate = new Map();
  for (let offset = windowDays - 1; offset >= 0; offset -= 1) {
    const date = new Date(end);
    date.setDate(end.getDate() - offset);
    const key = localDateKey(date);
    const row = { key, label: `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`, adSeconds: 0, tokens: 0, cost: 0 };
    rows.push(row);
    byDate.set(key, row);
  }
  for (const record of Array.isArray(records) ? records : []) {
    const row = byDate.get(localDateKey(record?.recognizedAt));
    if (!row) continue;
    row.adSeconds += (Array.isArray(record.segments) ? record.segments : []).reduce((total, segment) => {
      const start = Number(segment?.start);
      const endTime = Number(segment?.end);
      return total + (Number.isFinite(start) && Number.isFinite(endTime) && endTime > start ? endTime - start : 0);
    }, 0);
    const tokens = Number(record.usage?.totalTokens);
    const cost = Number(record.usage?.cost);
    if (Number.isFinite(tokens) && tokens >= 0) row.tokens += tokens;
    if (Number.isFinite(cost) && cost >= 0) row.cost += cost;
  }
  return rows.map((row) => ({ ...row, adSeconds: Number(row.adSeconds.toFixed(3)), tokens: Math.round(row.tokens), cost: Number(row.cost.toFixed(8)) }));
}

export function dailyMetricBreakdown(records, dateKey, metric, exchangeRate = 1) {
  const rate = Number.isFinite(Number(exchangeRate)) && Number(exchangeRate) > 0 ? Number(exchangeRate) : 1;
  return (Array.isArray(records) ? records : []).filter((record) => localDateKey(record?.recognizedAt) === dateKey).map((record) => {
    let value = 0;
    if (metric === "duration") {
      value = (Array.isArray(record.segments) ? record.segments : []).reduce((total, segment) => {
        const start = Number(segment?.start);
        const end = Number(segment?.end);
        return total + (Number.isFinite(start) && Number.isFinite(end) && end > start ? end - start : 0);
      }, 0);
    } else if (metric === "tokens") {
      value = Number(record.usage?.totalTokens) || 0;
    } else if (metric === "cost") {
      value = (Number(record.usage?.cost) || 0) * rate;
    }
    return { label: record.title || record.bvid || (record.aid ? `av${record.aid}` : "未知视频"), value: Number(Math.max(0, value).toFixed(8)) };
  }).filter((item) => item.value > 0).sort((left, right) => right.value - left.value);
}

export function buildViewingActivity(records, days = 7, now = Date.now()) {
  const windowDays = [3, 7, 15, 30, 45].includes(Number(days)) ? Number(days) : 7;
  const end = new Date(now);
  end.setHours(12, 0, 0, 0);
  const dates = [];
  for (let offset = windowDays - 1; offset >= 0; offset -= 1) {
    const date = new Date(end);
    date.setDate(end.getDate() - offset);
    const day = String(date.getDate());
    dates.push({ key: localDateKey(date), label: date.getDate() === 1 ? `${date.getMonth() + 1}-${day}` : day });
  }
  const validDates = new Set(dates.map((date) => date.key));
  const counts = new Map();
  for (const record of Array.isArray(records) ? records : []) {
    const date = new Date(record?.recognizedAt);
    const key = localDateKey(date);
    if (!key || !validDates.has(key)) continue;
    const hour = date.getHours();
    const cellKey = `${key}:${hour}`;
    counts.set(cellKey, (counts.get(cellKey) || 0) + 1);
  }
  const maxCount = Math.max(0, ...counts.values());
  const hours = Array.from({ length: 24 }, (_, hour) => ({
    hour,
    label: String(hour),
    cells: dates.map((date) => {
      const count = counts.get(`${date.key}:${hour}`) || 0;
      return { ...date, hour, count, level: count && maxCount ? Math.max(1, Math.ceil(count / maxCount * 4)) : 0 };
    })
  }));
  const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
  return { dates, hours, total, maxCount };
}
