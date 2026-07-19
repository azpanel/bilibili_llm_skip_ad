(() => {
  const PANEL_ID = "bili-ai-ad-skip-panel";
  const TOAST_ID = "bili-ai-ad-skip-toast";
  let toastTimer = null;
  let currentBvid = null;
  const PANEL_LAYOUT_KEY = "panelLayout";
  let state = { subtitle: "等待视频", analysis: "未开始", model: "读取中", progress: 0, progressLabel: "", progressState: "idle", transcription: null, segments: [], debug: null, autoSkip: true, localPrompt: false, debugOpen: false };
  let localRequestId = null;
  let renderedSegmentsKey = null;
  let skipped = new Set();

  chrome.runtime.onMessage.addListener((message) => {
    if (message.type !== "LOCAL_TRANSCRIPTION_PROGRESS" || message.requestId !== localRequestId) return;
    if (message.status === "completed") {
      state = { ...state, transcription: null, subtitle: "字幕生成完成", analysis: "分析中", progress: 70, progressLabel: "正在等待模型分析", progressState: "active" };
    } else {
      state = {
        ...state,
        subtitle: message.status === "downloading" ? "获取音频中" : "本机识别中",
        analysis: message.message || "本机识别中",
        progress: Math.max(20, Math.min(69, message.progress || 0)),
        progressLabel: message.message || "正在本机识别",
        progressState: "active",
        transcription: message.transcription
      };
    }
    render();
  });
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

  function formatEta(seconds) {
    if (seconds == null || !Number.isFinite(seconds)) return "计算中";
    return seconds < 1 ? "即将完成" : `约 ${format(seconds)}`;
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
    const progress = Math.max(0, Math.min(100, state.progress));
    const transcription = state.transcription;
    const transcriptionProgress = Math.max(0, Math.min(100, transcription?.progress || 0));

    panel.querySelector("#bili-ai-subtitle").textContent = state.subtitle;
    panel.querySelector("#bili-ai-analysis").textContent = state.analysis;
    panel.querySelector("#bili-ai-model").textContent = state.model;

    const progressView = panel.querySelector("#bili-ai-progress");
    progressView.hidden = state.progressState === "idle";
    progressView.setAttribute("aria-valuenow", String(progress));
    panel.querySelector("#bili-ai-progress-fill").className = `bili-ai-progress-fill bili-ai-progress-${state.progressState}`;
    panel.querySelector("#bili-ai-progress-fill").style.width = `${progress}%`;
    panel.querySelector("#bili-ai-progress-label").textContent = `总流程：${state.progressLabel} · ${progress}%`;

    const transcriptionView = panel.querySelector("#bili-ai-transcription");
    transcriptionView.hidden = !transcription;
    if (transcription) {
      panel.querySelector("#bili-ai-transcription-percent").textContent = transcription.progress == null ? "处理中" : `${transcription.progress.toFixed(1)}%`;
      panel.querySelector("#bili-ai-transcription-fill").style.width = `${transcriptionProgress}%`;
      panel.querySelector("#bili-ai-transcription-meta").textContent = `已处理 ${format(transcription.seconds)}${transcription.duration ? ` / ${format(transcription.duration)}` : ""} · 剩余时间：${formatEta(transcription.eta)}`;
    }

    panel.querySelector("#bili-ai-local-prompt").hidden = !state.localPrompt;
    const autoSkip = panel.querySelector("#bili-ai-auto");
    if (autoSkip.checked !== state.autoSkip) autoSkip.checked = state.autoSkip;
    panel.querySelector("#bili-ai-debug-view").hidden = !state.debugOpen;
    panel.querySelector("#bili-ai-debug-subtitle").textContent = formatDebug(state.debug?.subtitle, "暂无字幕调试信息。");
    panel.querySelector("#bili-ai-debug-request").textContent = formatDebug(state.debug?.request, "尚未发起 AI 请求。");
    panel.querySelector("#bili-ai-debug-response").textContent = formatDebug(state.debug?.response, "尚未收到 AI 响应。");

    const segmentsKey = JSON.stringify(state.segments);
    if (segmentsKey === renderedSegmentsKey) return;
    renderedSegmentsKey = segmentsKey;
    const segments = panel.querySelector("#bili-ai-segments");
    segments.replaceChildren();
    if (!state.segments.length) {
      const empty = document.createElement("p");
      empty.textContent = "尚未识别到广告时间段。";
      segments.append(empty);
      return;
    }
    state.segments.forEach((segment, index) => {
      const button = document.createElement("button");
      button.className = "bili-ai-segment";
      button.dataset.index = String(index);
      const time = document.createElement("b");
      time.textContent = `${format(segment.start)}–${format(segment.end)}`;
      const reason = document.createElement("span");
      reason.textContent = segment.reason || "广告或推广内容";
      button.append(time, reason);
      segments.append(button);
    });
  }

  function bindPanelEvents(panel) {
    panel.querySelector("#bili-ai-auto").addEventListener("change", (event) => { state.autoSkip = event.target.checked; });
    panel.querySelector("#bili-ai-retry").addEventListener("click", () => startAnalysis(true));
    panel.querySelector("#bili-ai-local-confirm").addEventListener("click", () => runLocalTranscription());
    panel.querySelector("#bili-ai-local-cancel").addEventListener("click", () => {
      state = { ...state, localPrompt: false, analysis: "已取消本次本机识别", progressState: "failed", progressLabel: "流程已取消" };
      render();
    });
    panel.querySelector("#bili-ai-debug").addEventListener("click", () => {
      state = { ...state, debugOpen: !state.debugOpen };
      render();
    });
    panel.querySelector("#bili-ai-segments").addEventListener("click", (event) => {
      const button = event.target.closest(".bili-ai-segment");
      const segment = state.segments[Number(button?.dataset.index)];
      const video = document.querySelector("video");
      if (video && segment) video.currentTime = segment.end;
    });
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
    panel.innerHTML = `
      <div class="bili-ai-title" id="bili-ai-drag-handle"><span class="bili-ai-title-icon">AI</span><span class="bili-ai-title-copy"><b>AI 广告跳过</b><small>智能识别 · 自动略过</small></span><span class="bili-ai-drag-hint">拖动</span></div>
      <div class="bili-ai-status"><span>字幕</span><strong id="bili-ai-subtitle"></strong></div>
      <div class="bili-ai-status"><span>AI</span><strong id="bili-ai-analysis"></strong></div>
      <div id="bili-ai-progress" class="bili-ai-progress" role="progressbar" aria-label="总流程进度" aria-valuemin="0" aria-valuemax="100"><div class="bili-ai-progress-track"><i id="bili-ai-progress-fill" class="bili-ai-progress-fill"></i></div><small id="bili-ai-progress-label"></small></div>
      <section id="bili-ai-transcription" class="bili-ai-transcription" aria-live="polite"><div class="bili-ai-transcription-heading"><b>语音转文本</b><span id="bili-ai-transcription-percent"></span></div><div class="bili-ai-progress-track"><i id="bili-ai-transcription-fill" class="bili-ai-progress-fill bili-ai-progress-active"></i></div><small id="bili-ai-transcription-meta"></small></section>
      <section id="bili-ai-local-prompt" class="bili-ai-local-prompt" aria-live="polite"><b>当前视频没有可用字幕</b><p>是否允许在本机使用语音识别？音频仅发送到本机服务；识别后的字幕仍会发送给你配置的 OpenRouter。</p><div><button id="bili-ai-local-confirm">仅本次识别</button><button id="bili-ai-local-cancel">取消</button></div></section>
      <div class="bili-ai-status"><span>模型</span><strong id="bili-ai-model" class="bili-ai-model"></strong></div>
      <label class="bili-ai-toggle"><input id="bili-ai-auto" type="checkbox"> 自动跳过</label>
      <div class="bili-ai-actions"><button id="bili-ai-retry">重新分析</button><button id="bili-ai-debug">调试信息</button></div>
      <div id="bili-ai-segments" class="bili-ai-segments"></div>
      <section id="bili-ai-debug-view" class="bili-ai-debug"><details open><summary>字幕获取</summary><pre id="bili-ai-debug-subtitle"></pre></details><details><summary>AI 请求</summary><pre id="bili-ai-debug-request"></pre></details><details><summary>AI 响应</summary><pre id="bili-ai-debug-response"></pre></details></section>
      <div id="bili-ai-resize-handle" aria-label="调整面板大小"></div>`;
    document.documentElement.append(panel);
    bindPanelEvents(panel);
    bindPanelLayout(panel);
    render();
    restorePanelLayout(panel);
  }

  async function runLocalTranscription(force = false) {
    const identity = getVideoIdentity();
    const requestId = crypto.randomUUID();
    localRequestId = requestId;
    const video = document.querySelector("video");
    state = { ...state, localPrompt: false, subtitle: "获取音频中", analysis: "本机识别中", progress: 20, progressLabel: "正在提交本机识别任务", progressState: "active", debug: null };
    render();
    const isSupportedAudioUrl = (value) => {
      try {
        const url = new URL(value);
        const host = url.hostname.toLowerCase().replace(/\.$/, "");
        return url.protocol === "https:" && /-(?:30216|30232|30250|30251|30280)\.m4s$/i.test(url.pathname) && (host.endsWith(".hdslb.com") || host.endsWith(".bilivideo.cn") || host.endsWith(".bilivideo.com") || host === "bilivideo.com" || host.endsWith(".edge.mountaintoys.cn"));
      } catch {
        return false;
      }
    };
    const source = video?.currentSrc || video?.src || "";
    const audioUrls = [...new Set([
      ...(isSupportedAudioUrl(source) ? [source] : []),
      ...performance.getEntriesByType("resource").map((entry) => entry.name).filter(isSupportedAudioUrl)
    ])].sort((left, right) => {
      const score = (value) => /-(?:30216|30232|30280)\.m4s(?:\?|$)/i.test(value) ? 2 : /-\d+\.m4s(?:\?|$)/i.test(value) ? 1 : 0;
      return score(right) - score(left);
    });
    if (!audioUrls.length) {
      state = { ...state, subtitle: "音频获取失败", analysis: "未找到独立音频流", progress: 20, progressLabel: "请播放片刻后重试", progressState: "failed" };
      render();
      return;
    }
    const result = await send({ type: "TRANSCRIBE_LOCAL", requestId, identity, audioUrls, duration: video?.duration });
    if (currentBvid !== identity.key) return;
    if (result.status !== "ready" || !result.timeline) {
      state = { ...state, subtitle: "本机识别失败", analysis: result.error || "无法生成字幕", progress: 20, progressLabel: "流程未完成", progressState: "failed" };
      render();
      return;
    }
    state = { ...state, transcription: null, subtitle: "已获取（本机语音识别）", analysis: "分析中", progress: 70, progressLabel: "正在等待模型分析", progressState: "active" };
    render();
    const analyzed = await send({ type: "ANALYZE", bvid: identity.bvid || `aid-${identity.aid}`, cacheKey: `${identity.key}:local`, timeline: result.timeline, duration: video?.duration, force: true });
    state = { ...state, analysis: analyzed.status === "completed" ? `已完成（${analyzed.segments.length} 段）` : analyzed.error || "分析失败", progress: analyzed.status === "completed" ? 100 : 90, progressLabel: analyzed.status === "completed" ? "分析完成" : "流程未完成", progressState: analyzed.status === "completed" ? "completed" : "failed", segments: analyzed.segments || [], debug: { request: analyzed.requestDebug || "", response: analyzed.responseDebug || "" } };
    render();
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
      if (subtitles.status === "no-subtitles") {
        state = { ...state, subtitle: "没有可用字幕", analysis: "等待选择本机识别", progress: 20, progressLabel: "请确认是否使用本机语音识别", progressState: "active", localPrompt: true, debug: { subtitle: subtitles.debug || "" } };
      } else {
        state = { ...state, subtitle: "获取失败", analysis: subtitles.error || "无法分析", progressLabel: "流程未完成", progressState: "failed", debug: { subtitle: subtitles.debug || subtitles.error || "" } };
      }
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
