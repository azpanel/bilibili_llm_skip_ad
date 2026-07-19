(() => {
  const PANEL_ID = "bili-ai-ad-skip-panel";
  const TOAST_ID = "bili-ai-ad-skip-toast";
  let toastTimer = null;
  let currentBvid = null;
  const PANEL_LAYOUT_KEY = "panelLayout";
  let state = { subtitle: "等待视频", analysis: "未开始", model: "读取中", progress: 0, progressLabel: "", progressState: "idle", segments: [], debug: null, autoSkip: true };
  let skipped = new Set();
  let lastJumpAt = 0;

  function getVideoIdentity() {
    const pageState = window.__INITIAL_STATE__ || {};
    const videoData = pageState.videoData || {};
    const episode = pageState.epInfo || pageState.epList?.find((item) => item.id === pageState.epInfo?.id) || {};
    const pageNumber = Math.max(1, Number(new URL(location.href).searchParams.get("p")) || 1);
    const page = videoData.pages?.[pageNumber - 1] || videoData.pages?.[0] || {};
    const pathBvid = location.pathname.match(/\/video\/(BV[\w]+)/i)?.[1];
    const pathAid = location.pathname.match(/\/video\/av(\d+)/i)?.[1];
    const bvid = pathBvid || videoData.bvid || episode.bvid || pageState.bvid || null;
    const aid = Number(pathAid || videoData.aid || episode.aid || pageState.aid) || null;
    const cid = page.cid || pageState.cid || episode.cid || null;
    return { bvid, aid, cid, pageNumber, key: bvid || aid || cid || null };
  }

  function send(message) {
    return chrome.runtime.sendMessage(message);
  }

  function format(seconds) {
    const total = Math.max(0, Math.floor(seconds || 0));
    return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
  }

  function formatDebug(value, emptyText) {
    if (!value) return emptyText;
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      return value;
    }
  }

  function render() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    panel.innerHTML = `
      <div class="bili-ai-title" id="bili-ai-drag-handle"><span class="bili-ai-title-icon">AI</span><span class="bili-ai-title-copy"><b>AI 广告跳过</b><small>智能识别 · 自动略过</small></span><span class="bili-ai-drag-hint">拖动</span></div>
      <div class="bili-ai-status"><span>字幕</span><strong>${state.subtitle}</strong></div>
      <div class="bili-ai-status"><span>AI</span><strong>${state.analysis}</strong></div>
      ${state.progressState !== "idle" ? `<div class="bili-ai-progress" role="progressbar" aria-label="分析进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${state.progress}"><div class="bili-ai-progress-track"><i class="bili-ai-progress-fill bili-ai-progress-${state.progressState}" style="width:${state.progress}%"></i></div><small>${state.progressLabel} · ${state.progress}%</small></div>` : ""}
      <div class="bili-ai-status"><span>模型</span><strong class="bili-ai-model">${escapeHtml(state.model)}</strong></div>
      <label class="bili-ai-toggle"><input id="bili-ai-auto" type="checkbox" ${state.autoSkip ? "checked" : ""}> 自动跳过</label>
      <div class="bili-ai-actions"><button id="bili-ai-retry">重新分析</button><button id="bili-ai-debug">调试信息</button></div>
      <div class="bili-ai-segments">${state.segments.length ? state.segments.map((segment, index) => `<button class="bili-ai-segment" data-index="${index}"><b>${format(segment.start)}–${format(segment.end)}</b><span>${escapeHtml(segment.reason)}</span></button>`).join("") : "<p>尚未识别到广告时间段。</p>"}</div>
      <section id="bili-ai-debug-view" class="bili-ai-debug" hidden>
        <details open><summary>字幕获取</summary><pre>${escapeHtml(formatDebug(state.debug?.subtitle, "暂无字幕调试信息。"))}</pre></details>
        <details><summary>AI 请求</summary><pre>${escapeHtml(formatDebug(state.debug?.request, "尚未发起 AI 请求。"))}</pre></details>
        <details><summary>AI 响应</summary><pre>${escapeHtml(formatDebug(state.debug?.response, "尚未收到 AI 响应。"))}</pre></details>
      </section><div id="bili-ai-resize-handle" aria-label="调整面板大小"></div>`;

    panel.querySelector("#bili-ai-auto").addEventListener("change", (event) => { state.autoSkip = event.target.checked; });
    panel.querySelector("#bili-ai-retry").addEventListener("click", () => startAnalysis(true));
    panel.querySelector("#bili-ai-debug").addEventListener("click", () => {
      const view = panel.querySelector("#bili-ai-debug-view");
      view.hidden = !view.hidden;
    });
    panel.querySelectorAll(".bili-ai-segment").forEach((button) => button.addEventListener("click", () => {
      const video = document.querySelector("video");
      const segment = state.segments[Number(button.dataset.index)];
      if (video && segment) video.currentTime = segment.end;
    }));
    bindPanelLayout(panel);
  }

  function escapeHtml(value) {
    const node = document.createElement("span");
    node.textContent = value || "广告或推广内容";
    return node.innerHTML;
  }

  function showSavedTime(seconds) {
    const savedSeconds = Math.max(1, Math.round(seconds));
    let toast = document.getElementById(TOAST_ID);
    if (!toast) {
      toast = document.createElement("aside");
      toast.id = TOAST_ID;
      document.documentElement.append(toast);
    }
    clearTimeout(toastTimer);
    toast.textContent = `已跳过广告，为你节省 ${savedSeconds} 秒`;
    toast.classList.remove("bili-ai-toast-hide");
    toastTimer = setTimeout(() => {
      toast.classList.add("bili-ai-toast-hide");
      setTimeout(() => toast.remove(), 250);
    }, 3000);
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function savePanelLayout(panel) {
    const rect = panel.getBoundingClientRect();
    chrome.storage.local.set({ [PANEL_LAYOUT_KEY]: { left: rect.left, top: rect.top, width: rect.width, height: rect.height } });
  }

  function bindPanelLayout(panel) {
    const dragHandle = panel.querySelector("#bili-ai-drag-handle");
    const resizeHandle = panel.querySelector("#bili-ai-resize-handle");
    const startInteraction = (event, mode) => {
      event.preventDefault();
      const rect = panel.getBoundingClientRect();
      const startX = event.clientX;
      const startY = event.clientY;
      panel.setPointerCapture?.(event.pointerId);
      const move = (moveEvent) => {
        if (mode === "move") {
          panel.style.left = `${clamp(rect.left + moveEvent.clientX - startX, 0, window.innerWidth - 80)}px`;
          panel.style.top = `${clamp(rect.top + moveEvent.clientY - startY, 0, window.innerHeight - 50)}px`;
          panel.style.right = "auto";
          panel.style.bottom = "auto";
        } else {
          panel.style.width = `${clamp(rect.width + moveEvent.clientX - startX, 240, window.innerWidth - rect.left)}px`;
          panel.style.height = `${clamp(rect.height + moveEvent.clientY - startY, 160, window.innerHeight - rect.top)}px`;
        }
      };
      const end = () => {
        document.removeEventListener("pointermove", move);
        document.removeEventListener("pointerup", end);
        savePanelLayout(panel);
      };
      document.addEventListener("pointermove", move);
      document.addEventListener("pointerup", end, { once: true });
    };
    dragHandle.addEventListener("pointerdown", (event) => startInteraction(event, "move"));
    resizeHandle.addEventListener("pointerdown", (event) => startInteraction(event, "resize"));
  }

  async function restorePanelLayout(panel) {
    const { [PANEL_LAYOUT_KEY]: layout } = await chrome.storage.local.get(PANEL_LAYOUT_KEY);
    if (!layout) return;
    const width = clamp(layout.width, 240, window.innerWidth);
    const height = clamp(layout.height, 160, window.innerHeight);
    panel.style.width = `${width}px`;
    panel.style.height = `${height}px`;
    panel.style.left = `${clamp(layout.left, 0, window.innerWidth - 80)}px`;
    panel.style.top = `${clamp(layout.top, 0, window.innerHeight - 50)}px`;
    panel.style.right = "auto";
    panel.style.bottom = "auto";
  }

  function ensurePanel() {
    if (document.getElementById(PANEL_ID)) return;
    const panel = document.createElement("section");
    panel.id = PANEL_ID;
    document.documentElement.append(panel);
    render();
    restorePanelLayout(panel);
  }

  async function startAnalysis(force = false) {
    const identity = getVideoIdentity();
    if (!identity.key) return;
    const { bvid, key } = identity;
    currentBvid = key;
    skipped = new Set();
    const model = await send({ type: "GET_MODEL" });
    state = { ...state, model: model.model, subtitle: "获取中", analysis: "等待字幕", progress: 15, progressLabel: "正在获取字幕", progressState: "active", segments: [], debug: null };
    render();
    const subtitles = await send({ type: "FETCH_SUBTITLES", ...identity });
    if (currentBvid !== key) return;
    if (subtitles.status !== "ready") {
      state = { ...state, subtitle: subtitles.status === "no-subtitles" ? "没有可用字幕" : "获取失败", analysis: subtitles.error || "无法分析", progressLabel: "流程未完成", progressState: "failed", debug: { subtitle: subtitles.debug || subtitles.error || "" } };
      render();
      return;
    }
    state = { ...state, subtitle: `已获取（${subtitles.subtitleName}）`, analysis: "分析中", progress: 70, progressLabel: "正在等待模型分析", progressState: "active" };
    render();
    const video = document.querySelector("video");
    const result = await send({ type: "ANALYZE", bvid: bvid || `aid-${identity.aid}`, cacheKey: key, timeline: subtitles.timeline, duration: video?.duration, force });
    state = { ...state, progress: 90, progressLabel: "正在解析识别结果", progressState: "active" };
    render();
    if (currentBvid !== key) return;
    state = {
      ...state,
      analysis: result.status === "completed" ? `已完成（${result.segments.length} 段）` : result.status === "needs-settings" ? "请先在扩展设置中填写 API Key 和模型" : result.error || "分析失败",
      progress: result.status === "completed" ? 100 : 90,
      progressLabel: result.status === "completed" ? "分析完成" : "流程未完成",
      progressState: result.status === "completed" ? "completed" : "failed",
      segments: result.segments || [],
      debug: { request: result.requestDebug || "", response: result.responseDebug || "" }
    };
    render();
  }

  document.addEventListener("timeupdate", (event) => {
    const video = event.target;
    if (!(video instanceof HTMLVideoElement) || !state.autoSkip || Date.now() - lastJumpAt < 500) return;
    const index = state.segments.findIndex((segment) => video.currentTime >= segment.start && video.currentTime < segment.end);
    if (index < 0 || skipped.has(index)) return;
    const segment = state.segments[index];
    const savedSeconds = segment.end - video.currentTime;
    skipped.add(index);
    lastJumpAt = Date.now();
    video.currentTime = segment.end;
    showSavedTime(savedSeconds);
  }, true);

  function checkPage() {
    const identity = getVideoIdentity();
    if (!identity.key || identity.key === currentBvid) return;
    ensurePanel();
    startAnalysis();
  }

  ensurePanel();
  checkPage();
  setInterval(checkPage, 1000);
})();
