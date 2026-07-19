const DEFAULT_PROMPT = `你是视频内容审核助手。根据带时间戳的字幕，识别明确的商业广告、品牌推广、带货、课程/社群/产品引流片段。不要把普通内容、口播开场、创作者自我介绍误判为广告；不确定时不要输出。仅返回 JSON，格式为 {"segments":[{"start":12.3,"end":45.6,"reason":"简短原因"}]}，start/end 必须是秒数。`;
const form = document.querySelector("#settings");
const keyInput = document.querySelector("#api-key");
const modelInput = document.querySelector("#model");
const promptInput = document.querySelector("#prompt");
const hint = document.querySelector("#key-hint");
const status = document.querySelector("#status");
const saveButton = document.querySelector("#save-settings");
const tabs = [...document.querySelectorAll("[role=tab]")];
const panels = [...document.querySelectorAll("[role=tabpanel]")];

function activateTab(tabId, moveFocus = false) {
  tabs.forEach((tab) => {
    const selected = tab.dataset.tab === tabId;
    tab.setAttribute("aria-selected", String(selected));
    tab.tabIndex = selected ? 0 : -1;
  });

  panels.forEach((panel) => {
    panel.hidden = panel.dataset.panel !== tabId;
  });

  if (moveFocus) {
    tabs.find((tab) => tab.dataset.tab === tabId)?.focus();
  }
}

function setStatus(message = "", state = "") {
  status.textContent = message;
  status.dataset.state = state;
}

function setSaveState(saving) {
  saveButton.disabled = saving;
  saveButton.textContent = saving ? "正在保存…" : "保存设置";
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

function updateKeyHint(apiKey) {
  hint.textContent = apiKey
    ? `已保存密钥（末四位：${apiKey.slice(-4)}）。如不修改可留空。`
    : "尚未保存 API Key。";
}

function getStorageErrorMessage(error) {
  return error instanceof Error && error.message ? error.message : "请检查扩展存储权限后重试。";
}

tabs.forEach((tab, index) => {
  tab.addEventListener("click", () => activateTab(tab.dataset.tab));
  tab.addEventListener("keydown", (event) => {
    const navigationKeys = ["ArrowLeft", "ArrowUp", "ArrowRight", "ArrowDown", "Home", "End"];
    if (!navigationKeys.includes(event.key)) return;

    event.preventDefault();
    let nextIndex = index;
    if (event.key === "ArrowLeft" || event.key === "ArrowUp") nextIndex = (index - 1 + tabs.length) % tabs.length;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") nextIndex = (index + 1) % tabs.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = tabs.length - 1;
    activateTab(tabs[nextIndex].dataset.tab, true);
  });
});

[modelInput, promptInput].forEach((input) => {
  input.addEventListener("input", () => clearFieldError(input));
});

try {
  const [local, sync] = await Promise.all([
    chrome.storage.local.get("openRouterApiKey"),
    chrome.storage.sync.get(["model", "prompt"])
  ]);
  modelInput.value = sync.model || "deepseek/deepseek-chat";
  promptInput.value = sync.prompt || DEFAULT_PROMPT;
  updateKeyHint(local.openRouterApiKey);
} catch (error) {
  modelInput.value = "deepseek/deepseek-chat";
  promptInput.value = DEFAULT_PROMPT;
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
    showFieldError(promptInput, "rules", "请填写识别广告提示词。");
    return;
  }

  setSaveState(true);
  setStatus("正在保存设置…");

  try {
    const writes = [chrome.storage.sync.set({ model, prompt })];
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
