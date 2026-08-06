const TEXT_INPUT = "text";
const TEXT_OUTPUT = "text";

function includesValue(value, expected) {
  return Array.isArray(value) && value.includes(expected);
}

function normalizeDisplayPrice(item) {
  const price = Number(item?.price);
  const multiplier = Number(item?.displayMultiplier ?? 1);
  if (!Number.isFinite(price) || !Number.isFinite(multiplier)) return null;
  return {
    label: typeof item?.sku_label === "string" ? item.sku_label.trim() : "",
    value: price * multiplier,
    unit: typeof item?.unitLabel === "string" ? item.unitLabel.trim() : ""
  };
}

function normalizeDate(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function normalizeIconUrl(...values) {
  const value = values.find((item) => typeof item === "string" && item.trim())?.trim();
  if (!value) return null;
  try {
    const url = new URL(value, "https://openrouter.ai");
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

export function normalizeOpenRouterCatalog(payload) {
  if (!payload || !Array.isArray(payload.data)) throw new Error("模型目录响应格式无效。");
  const models = [];
  const seen = new Set();

  for (const item of payload.data) {
    const endpoint = item?.endpoint;
    const slug = typeof item?.slug === "string" ? item.slug.trim() : "";
    const compatible = slug
      && includesValue(item?.input_modalities, TEXT_INPUT)
      && includesValue(item?.output_modalities, TEXT_OUTPUT)
      && item?.has_text_output === true
      && endpoint?.has_chat_completions === true
      && item?.hidden !== true
      && item?.is_private !== true
      && endpoint?.is_hidden !== true
      && endpoint?.is_private !== true
      && endpoint?.is_disabled !== true;
    if (!compatible || seen.has(slug)) continue;

    const displayPricing = Array.isArray(endpoint?.display_pricing)
      ? endpoint.display_pricing.map(normalizeDisplayPrice).filter(Boolean)
      : [];
    models.push({
      slug,
      name: typeof item?.name === "string" && item.name.trim() ? item.name.trim() : slug,
      shortName: typeof item?.short_name === "string" ? item.short_name.trim() : "",
      author: typeof item?.author === "string" && item.author.trim() ? item.author.trim() : slug.split("/")[0],
      authorName: typeof item?.author_display_name === "string" && item.author_display_name.trim()
        ? item.author_display_name.trim()
        : (typeof item?.author === "string" ? item.author.trim() : slug.split("/")[0]),
      iconUrl: normalizeIconUrl(
        item?.author_icon_uri,
        endpoint?.model?.author_icon_uri,
        endpoint?.provider_info?.icon?.url
      ),
      createdAt: normalizeDate(item?.created_at),
      contextLength: Number.isFinite(Number(item?.context_length)) ? Number(item.context_length) : null,
      isFree: endpoint?.is_free === true,
      pricing: displayPricing
    });
    seen.add(slug);
  }

  return models.sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
}

export function filterModels(models, query = "", author = "") {
  const needle = String(query).trim().toLocaleLowerCase();
  return (Array.isArray(models) ? models : []).filter((model) => {
    if (author && model.author !== author) return false;
    if (!needle) return true;
    return [model.name, model.shortName, model.slug, model.author, model.authorName]
      .some((value) => String(value || "").toLocaleLowerCase().includes(needle));
  });
}

export function formatModelPrices(model) {
  if (model?.isFree) return ["免费"];
  const rows = Array.isArray(model?.pricing) ? model.pricing : [];
  const primary = rows.filter((row) => /input|output/i.test(row.label));
  const selected = primary.length ? primary : rows.slice(0, 2);
  if (!selected.length) return ["价格未知"];
  return selected.map((row) => {
    const value = Number(row.value);
    const formatted = value === 0 ? "0" : value.toLocaleString("en-US", { maximumFractionDigits: 6 });
    return `${row.label || "价格"} $${formatted}${row.unit || ""}`;
  });
}
