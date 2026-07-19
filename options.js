const DEFAULT_PROMPT = `你是视频内容审核助手。根据带时间戳的字幕，识别明确的商业广告、品牌推广、带货、课程/社群/产品引流片段。不要把普通内容、口播开场、创作者自我介绍误判为广告；不确定时不要输出。仅返回 JSON，格式为 {"segments":[{"start":12.3,"end":45.6,"reason":"简短原因"}]}，start/end 必须是秒数。`;
const form = document.querySelector("#settings");
const keyInput = document.querySelector("#api-key");
const modelInput = document.querySelector("#model");
const promptInput = document.querySelector("#prompt");
const hint = document.querySelector("#key-hint");
const status = document.querySelector("#status");

const [local, sync] = await Promise.all([chrome.storage.local.get("openRouterApiKey"), chrome.storage.sync.get(["model", "prompt"])]);
modelInput.value = sync.model || "deepseek/deepseek-chat";
promptInput.value = sync.prompt || DEFAULT_PROMPT;
if (local.openRouterApiKey) hint.textContent = `已保存密钥（末四位：${local.openRouterApiKey.slice(-4)}）。如不修改可留空。`;

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const model = modelInput.value.trim();
  const prompt = promptInput.value.trim();
  if (!model || !prompt) return;
  const writes = [chrome.storage.sync.set({ model, prompt })];
  if (keyInput.value.trim()) writes.push(chrome.storage.local.set({ openRouterApiKey: keyInput.value.trim() }));
  await Promise.all(writes);
  keyInput.value = "";
  hint.textContent = "密钥已保存，输入框不会回显完整密钥。";
  status.textContent = "设置已保存。";
});
