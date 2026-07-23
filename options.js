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
const SKIPPED_UPLOADER_MIDS_KEY = "skippedUploaderMids";
const form = document.querySelector("#settings");
const keyInput = document.querySelector("#api-key");
const modelInput = document.querySelector("#model");
const promptInput = document.querySelector("#prompt");
const skipMidInput = document.querySelector("#skip-mid-input");
const skipMidError = document.querySelector("#skip-mid-error");
const skipMidList = document.querySelector("#skip-mid-list");
const hint = document.querySelector("#key-hint");
const status = document.querySelector("#status");
const saveButton = document.querySelector("#save-settings");
const tabs = [...document.querySelectorAll("[role=tab]")];
const panels = [...document.querySelectorAll("[role=tabpanel]")];
let skippedUploaderMids = [];
let editingSkipMid = null;
let uploaderProfiles = new Map();
let loadingUploaderMids = new Set();

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

function activateTab(tabId, moveFocus = false) {
  tabs.forEach((tab) => {
    const selected = tab.dataset.tab === tabId;
    tab.setAttribute("aria-selected", String(selected));
    tab.tabIndex = selected ? 0 : -1;
  });
  panels.forEach((panel) => {
    panel.hidden = panel.dataset.panel !== tabId;
  });
  if (moveFocus) tabs.find((tab) => tab.dataset.tab === tabId)?.focus();
}

function setStatus(message = "", state = "") {
  status.textContent = message;
  status.dataset.state = state;
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
    if (result?.status !== "completed") throw new Error(result?.error || "暂时无法获取昵称。");
    Object.entries(result.profiles || {}).forEach(([mid, profile]) => {
      if (skippedUploaderMids.includes(mid)) uploaderProfiles.set(mid, profile);
    });
  } catch (error) {
    requestedMids.forEach((mid) => {
      if (skippedUploaderMids.includes(mid) && !uploaderProfiles.get(mid)?.name) uploaderProfiles.set(mid, { status: "error", error: "暂时无法获取昵称。" });
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

    const identity = document.createElement("div");
    identity.className = "skip-uploader-identity";
    const badge = document.createElement("span");
    badge.className = "skip-uploader-badge";
    badge.textContent = "UP";
    badge.setAttribute("aria-hidden", "true");
    const copy = document.createElement("div");
    copy.className = "skip-uploader-copy";
    const name = document.createElement("strong");
    name.className = "skip-uploader-name";
    name.textContent = profile?.name || (loading ? "正在查询昵称…" : "昵称暂不可用");
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
        createActionButton("刷新", "skip-uploader-action", () => loadUploaderProfiles([mid], true), loading),
        createActionButton("编辑", "skip-uploader-action", () => {
          editingSkipMid = mid;
          renderSkippedUploaderMids();
          requestAnimationFrame(() => skipMidList.querySelector(`[data-edit-mid="${mid}"]`)?.focus());
        }, loading),
        createActionButton("删除", "skip-uploader-delete", () => removeSkippedUploaderMid(mid), loading)
      );
    }
    item.append(identity, actions);

    if (editingSkipMid === mid) {
      const editForm = document.createElement("div");
      editForm.className = "skip-uploader-edit-form";
      const label = document.createElement("label");
      label.textContent = "新 MID";
      const input = document.createElement("input");
      input.type = "text";
      input.inputMode = "numeric";
      input.autocomplete = "off";
      input.value = mid;
      input.dataset.editMid = mid;
      input.setAttribute("aria-label", "新的投稿用户 MID");
      const error = document.createElement("span");
      error.className = "skip-uploader-edit-error";
      const save = createActionButton("保存", "skip-uploader-save", () => updateSkippedUploaderMid(mid, input.value, error));
      const cancel = createActionButton("取消", "skip-uploader-action", () => {
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
      editForm.append(label, input, save, cancel, error);
      item.append(editForm);
    }
    skipMidList.append(item);
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
  hint.textContent = apiKey ? `已保存密钥（末四位：${apiKey.slice(-4)}）。如不修改可留空。` : "尚未保存 API Key。";
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

[modelInput, promptInput].forEach((input) => input.addEventListener("input", () => clearFieldError(input)));
skipMidInput.addEventListener("input", () => setSkipMidError());
document.querySelector("#add-skip-mid").addEventListener("click", addSkippedUploaderMid);
skipMidInput.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  addSkippedUploaderMid();
});

try {
  const [local, sync] = await Promise.all([
    chrome.storage.local.get("openRouterApiKey"),
    chrome.storage.sync.get(["model", "prompt", SKIPPED_UPLOADER_MIDS_KEY])
  ]);
  modelInput.value = sync.model || "deepseek/deepseek-chat";
  promptInput.value = sync.prompt || DEFAULT_PROMPT;
  skippedUploaderMids = normalizeSkippedUploaderMids(sync[SKIPPED_UPLOADER_MIDS_KEY]);
  renderSkippedUploaderMids();
  loadUploaderProfiles(skippedUploaderMids);
  updateKeyHint(local.openRouterApiKey);
} catch (error) {
  modelInput.value = "deepseek/deepseek-chat";
  promptInput.value = DEFAULT_PROMPT;
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
    showFieldError(promptInput, "rules", "请填写识别广告提示词。");
    return;
  }
  setSaveState(true);
  setStatus("正在保存设置…");
  try {
    const writes = [chrome.storage.sync.set({ model, prompt, [SKIPPED_UPLOADER_MIDS_KEY]: skippedUploaderMids })];
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
