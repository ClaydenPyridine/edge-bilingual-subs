/**
 * 隔离世界内容脚本
 * 职责：收字幕 → 对齐播放进度 → 翻译成中文 → 渲染双语浮层。
 *
 * v0.2 改动：
 *   1. 浮层改为「贴合视频画面底部」定位（不再固定视口底部），非全屏也精准
 *   2. 支持 bilibili 的 <bwp-video>（shadow DOM 里取 video）
 *   3. 状态标签只在出错时显示，4 秒自动消失
 *   4. 翻译不可用时给出明确提示
 */
(() => {
  'use strict';
  if (window.__biSubContentLoaded) return;
  window.__biSubContentLoaded = true;

  const SRC = '__BI_SUB__';

  /* ================= 配置 ================= */
  const DEFAULT_SETTINGS = {
    enabled: true,
    engine: 'auto',          // auto | builtin | deepseek
    showOriginal: true,
    fontSize: 36,
    bottomOffset: 7,         // 百分比：距视频底边的距离（占视频高度）
    filterNoise: true,       // 过滤 [Music] / [Applause] / ♪ 这类音效标注
    asrEnabled: true,        // 语音识别总开关（默认开）
    asrBaseUrl: ''           // 只有地址非空才算「已配置」
  };
  let settings = { ...DEFAULT_SETTINGS };
  let apiKeyConfigured = true;

  // 每个页面实例一个唯一标识：旧页面的识别结果会被这里直接丢弃
  const PAGE_ID = 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  /* ================= ASR 状态 ================= */
  let asrRunning = false;
  let live = null;          // { text, zh, at } —— 语音识别的最新一段
  let liveTimer = null;
  let widget = null;
  let widgetMsg = '';       // 临时提示（几秒后清空）
  let lastVideoEl = null;   // 用于检测换视频
  let segCount = 0;         // 已收到的识别片段数（显示在胶囊上，便于排查）
  let pendingSeg = null;    // 最新识别结果（还没上屏）
  let shownAt = 0;          // 当前上屏那条的换入时刻
  let lastSwapAt = 0;       // 上次换屏时刻（限速用）
  let lastZh = '';          // 最近一次拿到中文译文
  let lastZhText = '';      // 那句中文对应的英文原文
  let lumCanvas = null, lumAt = 0, lumLast = -1;

  /* ================= 字幕数据 ================= */
  const cues = [];
  const zhCache = new Map();
  const pending = new Set();
  const failed = new Set();
  const CJK = /[\u3400-\u9FFF\uF900-\uFAFF]/;   // 含中日韩字符 → 不是英文原文

  /* ---------- 音效标注过滤 ---------- */
  // 覆盖 [Music] [Applause] [Laughter] (upbeat music) ♪ 之类
  const NOISE_WORDS =
    'music|musical|applause|applauding|laughter|laughs|laughing|silence|silent|blank|' +
    'inaudible|indistinct|unintelligible|noise|noisy|cheer|cheers|cheering|beep|beeping|' +
    'cough|coughs|coughing|sigh|sighs|sighing|speaking|foreign|background|sound|audio|' +
    'typewriter|typing|door|footsteps|人声|音乐|掌声|笑声|沉默';
  const NOISE_RE = new RegExp(
    '\\[[^\\]]*(?:' + NOISE_WORDS + ')[^\\]]*\\]' +
    '|\\([^)]*(?:' + NOISE_WORDS + ')[^)]*\\)' +
    '|\\{[^}]*(?:' + NOISE_WORDS + ')[^}]*\\}',
    'gi'
  );
  const NOTE_RE = /[♪♫♬♩]+/g;

  function cleanCueText(raw) {
    let s = String(raw || '');
    if (!s) return '';
    s = s.replace(NOISE_RE, ' ');
    s = s.replace(NOTE_RE, ' ');
    s = s.replace(/\s+/g, ' ').trim();
    // 清理后只剩标点/空 → 整条丢掉
    if (!s) return '';
    if (!/[A-Za-z0-9\u00C0-\u024F]/.test(s)) return '';
    return s;
  }

  function insertCues(batch) {    let added = 0;
    for (const c of batch) {
      if (!c || typeof c.text !== 'string') continue;
      const text = settings.filterNoise ? cleanCueText(c.text) : c.text.trim();
      if (!text) continue;
      if (CJK.test(text)) continue;              // ★ 兜住翻译轨/中文字幕，避免「两行中文」
      const last = cues[cues.length - 1];
      if (last && Math.abs(last.start - c.start) < 0.001 && last.text === text) continue;
      cues.push({ start: c.start, dur: c.dur, text, lang: c.lang });
      added++;
    }
    if (added) cues.sort((a, b) => a.start - b.start);
    return added;
  }

  /** 换视频/换页面时清空旧字幕，否则 SPA 导航会把上个视频的台词带过来 */
  function clearCues() {
    cues.length = 0;
    live = null;
    pendingSeg = null;
    lastZh = '';
    lastZhText = '';
    lastVideoEl = null;
    if (host) host.classList.remove('bi-visible');
  }

  let lastPageChangeAt = 0;
  /**
   * 换视频 / 换页面：
   *   ① 清掉旧字幕
   *   ② 如果识别正在跑，重启一条全新的流 —— 否则旧音频的识别结果会继续渗进来
   */
  function onPageChanged() {
    clearCues();
    if (!asrRunning) return;
    const now = Date.now();
    if (now - lastPageChangeAt < 3000) return;   // 单页应用会连着触发，防抖
    lastPageChangeAt = now;
    chrome.runtime.sendMessage({ type: 'asr-restart', pageId: PAGE_ID }).catch(() => {});
  }

  function cueAt(t) {
    let lo = 0, hi = cues.length - 1, idx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (cues[mid].start <= t) { idx = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    if (idx < 0) return null;
    const c = cues[idx];
    const end = c.dur > 0 ? c.start + c.dur : (cues[idx + 1] ? cues[idx + 1].start : c.start + 4);
    return t <= end + 0.35 ? c : null;
  }

  /* ================= 翻译 ================= */
  let builtinTranslator = null;
  let builtinState = 'unknown';   // unknown | ready | unsupported

  function getTranslatorFactory() {
    if (typeof window.Translator !== 'undefined') return window.Translator;
    if (window.translation && typeof window.translation.createTranslator === 'function') {
      return { create: window.translation.createTranslator, availability: window.translation.canTranslate };
    }
    if (window.ai && window.ai.translator) return window.ai.translator;
    return null;
  }

  async function initBuiltin() {
    const f = getTranslatorFactory();
    if (!f) { builtinState = 'unsupported'; return false; }
    try {
      if (f.availability) {
        const a = await f.availability({ sourceLanguage: 'en', targetLanguage: 'zh' });
        if (a === 'unavailable') { builtinState = 'unsupported'; return false; }
      }
      builtinTranslator = await f.create({ sourceLanguage: 'en', targetLanguage: 'zh' });
      builtinState = 'ready';
      return true;
    } catch (e) {
      builtinState = 'unsupported';
      return false;
    }
  }

  async function translateBatch(texts) {
    const uniq = [...new Set(texts)].filter((t) => !zhCache.has(t) && !failed.has(t));
    if (!uniq.length) return;

    // ① 内置翻译（离线免费）
    if (settings.engine !== 'deepseek' && builtinState !== 'unsupported') {
      if (builtinState === 'unknown') await initBuiltin();
      if (builtinTranslator) {
        for (const t of uniq) {
          try {
            const r = await builtinTranslator.translate(t);
            if (r) zhCache.set(t, String(r).trim());
          } catch (_) { failed.add(t); }
        }
        return;
      }
    }

    // ② DeepSeek
    if (settings.engine === 'deepseek' || builtinState === 'unsupported') {
      for (let i = 0; i < uniq.length; i += 8) {
        const chunk = uniq.slice(i, i + 8);
        chunk.forEach((t) => pending.add(t));
        try {
          const resp = await chrome.runtime.sendMessage({ type: 'translate', texts: chunk });
          if (resp && resp.ok && Array.isArray(resp.items)) {
            resp.items.forEach((zh, k) => {
              const src = chunk[k];
              if (zh && src) zhCache.set(src, String(zh).trim());
              else if (src) failed.add(src);
            });
          } else {
            chunk.forEach((t) => failed.add(t));
            if (resp && /NO_API_KEY/.test(resp.error || '')) showStatus('翻译不可用：请到扩展选项里填 DeepSeek 密钥', 6000);
          }
        } catch (_) {
          chunk.forEach((t) => failed.add(t));
        } finally {
          chunk.forEach((t) => pending.delete(t));
        }
      }
    }
  }

  let translateTimer = null;
  function scheduleTranslate() {
    if (translateTimer) return;
    translateTimer = setTimeout(async () => {
      translateTimer = null;
      const v = videoEl();
      if (!v) return;
      const now = v.currentTime;
      const win = cues.filter((c) => c.start > now - 4 && c.start < now + 90);
      const todo = win.map((c) => c.text).filter((t) => !zhCache.has(t) && !pending.has(t) && !failed.has(t));
      if (!todo.length) return;
      const batch = todo.slice(0, 24);
      batch.forEach((t) => pending.add(t));
      await translateBatch(batch);
      batch.forEach((t) => pending.delete(t));
    }, 600);
  }

  /* ================= 浮层 ================= */
  let host = null, boxEn = null, boxZh = null, badge = null;
  let badgeTimer = null;

  function ensureOverlay() {
    if (host && host.isConnected) return host;
    host = document.createElement('div');
    host.className = 'bi-sub-host';
    host.innerHTML = `
      <div class="bi-sub-inner">
        <div class="bi-sub-badge"></div>
        <div class="bi-sub-en"></div>
        <div class="bi-sub-zh"></div>
      </div>`;
    boxEn = host.querySelector('.bi-sub-en');
    boxZh = host.querySelector('.bi-sub-zh');
    badge = host.querySelector('.bi-sub-badge');
    mountOverlay();
    return host;
  }

  function mountOverlay() {
    const fsEl = document.fullscreenElement;
    const parent = fsEl || document.body;
    if (!parent || !host) return;
    if (host.parentNode !== parent) parent.appendChild(host);
  }

  document.addEventListener('fullscreenchange', () => mountOverlay());
  document.addEventListener('webkitfullscreenchange', () => mountOverlay());

  function showStatus(text, ms) {
    ensureOverlay();
    if (!badge) return;
    if (badgeTimer) clearTimeout(badgeTimer);
    if (!text) { badge.style.display = 'none'; return; }
    badge.textContent = text;
    badge.style.display = '';
    badgeTimer = setTimeout(() => { if (badge) badge.style.display = 'none'; }, ms || 4000);
  }

  function applyStyle() {
    if (!host) return;
    host.style.setProperty('--bi-font', settings.fontSize + 'px');
    host.style.setProperty('--bi-pad', settings.bottomOffset + '%');
  }

  /** 把浮层盒子精确贴合到视频画面上 */
  let lastRect = { l: 0, t: 0, w: 0, h: 0 };
  function positionOverlay(video) {
    if (!host || !video) return;
    const r = video.getBoundingClientRect();
    if (r.width < 80 || r.height < 60) { host.style.visibility = 'hidden'; return; }
    host.style.visibility = '';

    // 只在变化超过 0.5px 时写样式，省开销
    if (Math.abs(r.left - lastRect.l) > 0.5 || Math.abs(r.top - lastRect.t) > 0.5 ||
        Math.abs(r.width - lastRect.w) > 0.5 || Math.abs(r.height - lastRect.h) > 0.5) {
      lastRect = { l: r.left, t: r.top, w: r.width, h: r.height };
      host.style.setProperty('--bi-l', r.left + 'px');
      host.style.setProperty('--bi-t', r.top + 'px');
      host.style.setProperty('--bi-w', r.width + 'px');
      host.style.setProperty('--bi-h', r.height + 'px');
    }

    // 右下角控制条贴着视频右下角
    if (widget) {
      widget.style.left = (r.right - 14) + 'px';
      widget.style.top = (r.bottom - 14) + 'px';
    }
  }

  function render(cue) {
    ensureOverlay();
    applyStyle();
    if (!cue) { host.classList.remove('bi-visible'); return; }
    const zh = zhCache.get(cue.text);
    const showEn = settings.showOriginal || !zh;
    boxEn.textContent = showEn ? cue.text : '';
    boxEn.style.display = showEn ? '' : 'none';
    boxZh.textContent = zh || '';
    host.classList.add('bi-visible');
    host.classList.toggle('bi-zh-only', !showEn);
    host.classList.toggle('bi-pending', !zh);
  }

  /* ================= 视频跟踪 ================= */
  let videoCache = [];
  let videoScanAt = 0;

  function collectVideos(root, out, depth) {
    if (!root || depth > 4) return;
    try { for (const v of root.querySelectorAll('video')) out.push(v); } catch (_) {}
    // 自定义播放器（bilibili 的 <bwp-video>、某些 web component）把 video 藏在 shadowRoot 里
    try {
      for (const el of root.querySelectorAll('*')) {
        if (el.shadowRoot) collectVideos(el.shadowRoot, out, depth + 1);
      }
    } catch (_) {}
  }

  function rescanVideos() {
    const out = [];
    collectVideos(document, out, 0);
    videoCache = out;
    videoScanAt = Date.now();
  }

  function videoEl() {
    if (Date.now() - videoScanAt > 2000) rescanVideos();
    const list = videoCache.filter((v) => v && v.isConnected && (v.readyState > 0 || v.currentSrc));
    if (!list.length) return null;
    let best = null, bestArea = 0;
    for (const v of list) {
      const r = v.getBoundingClientRect();
      const a = r.width * r.height;
      if (a > bestArea) { bestArea = a; best = v; }
    }
    return best || list[0];
  }

  /* ================= 右下角控制条 ================= */
  function ensureWidget() {
    if (widget && widget.isConnected) return widget;
    widget = document.createElement('div');
    widget.className = 'bi-sub-widget';
    widget.innerHTML = '<span class="bi-sub-dot"></span><span class="bi-sub-wlabel">语音字幕</span>';
    widget.addEventListener('click', onWidgetClick, true);
    document.body.appendChild(widget);
    updateWidget();
    return widget;
  }

  function updateWidget() {
    if (!widget) return;
    const configured = !!(settings.asrBaseUrl && String(settings.asrBaseUrl).trim());
    const label = widget.querySelector('.bi-sub-wlabel');

    let text;
    if (asrRunning) {
      if (live && live.text) {
        // 直接把识别结果露在胶囊上：浮层万一没显示，这里也能看到
        const t = live.text.length > 28 ? '…' + live.text.slice(-28) : live.text;
        text = '🎙 ' + t;
      } else {
        text = segCount ? ('语音字幕 · 识别中 · ' + segCount) : '语音字幕 · 识别中';
      }
    }
    else if (!configured) text = '语音字幕 · 未配置';
    else if (widgetMsg) text = widgetMsg;
    else text = '语音字幕 · 点此开启';

    if (label) label.textContent = text;
    widget.classList.toggle('bi-on', asrRunning);
    widget.classList.toggle('bi-warn', !asrRunning && !configured);
    widget.title = asrRunning
      ? '点击关闭语音识别'
      : configured
        ? '点击开始语音识别（若提示权限，请点工具栏上的扩展图标）'
        : '还没配置语音识别接口：右键扩展图标 → 选项';
  }

  function flashWidget(msg, ms) {
    widgetMsg = msg;
    updateWidget();
    setTimeout(() => { widgetMsg = ''; updateWidget(); }, ms || 8000);
  }

  function shortErr(s) {
    s = String(s || '');
    if (/tabCapture|user gesture|invoked|activeTab|not allowed|Permission|gesture/i.test(s)) {
      return '请点工具栏的扩展图标启动';
    }
    if (/ASR HTTP 401|401/.test(s)) return 'ASR 密钥无效';
    if (/ASR HTTP 429|429/.test(s)) return 'ASR 请求太频繁';
    if (/未配置 ASR/.test(s)) return '先去选项配置 ASR';
    return s.slice(0, 60);
  }

  async function onWidgetClick(e) {
    e.preventDefault();
    e.stopPropagation();

    const configured = !!(settings.asrBaseUrl && String(settings.asrBaseUrl).trim());
    if (!configured && !asrRunning) {
      flashWidget('语音字幕 · 先去选项配置', 6000);
      try { chrome.runtime.openOptionsPage(); } catch (_) {}
      return;
    }

    try {
      const r = await chrome.runtime.sendMessage({ type: 'asr-toggle', pageId: PAGE_ID });
      if (r && r.ok) {
        asrRunning = !!r.running;
        widgetMsg = '';
        if (asrRunning) showStatus('语音识别已启动（约 1–3 秒出字幕）', 4000);
        updateWidget();
      } else {
        flashWidget('语音字幕 · ' + shortErr(r && r.error), 9000);
      }
    } catch (err) {
      flashWidget('语音字幕 · ' + shortErr(err && err.message), 9000);
    }
  }

  function onAsrSegment(text, zh) {
    if (!text) return;
    if (zh) { zhCache.set(text, zh); lastZh = zh; lastZhText = text; }   // 译文晚到也能命中
    segCount++;
    pendingSeg = { text, zh: zh || zhCache.get(text) || '', at: Date.now() };
    if (liveTimer) clearTimeout(liveTimer);
    liveTimer = setTimeout(() => { live = null; pendingSeg = null; }, 12000);
    updateWidget();
  }

  /** 取画面亮度：能读到就用，读不到（跨域视频会让 canvas 污染）返回 -1 */
  function sampleLight(v) {
    const now = Date.now();
    if (now - lumAt < 700) return lumLast;
    lumAt = now;
    try {
      if (!lumCanvas) {
        lumCanvas = document.createElement('canvas');
        lumCanvas.width = 48; lumCanvas.height = 27;
      }
      const ctx = lumCanvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(v, 0, 0, 48, 27);
      const d = ctx.getImageData(0, 0, 48, 27).data;
      let s = 0;
      for (let i = 0; i < d.length; i += 4) {
        s += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      }
      lumLast = s / (d.length / 4) / 255;
    } catch (_) {
      lumLast = -1;     // 跨域画面读不到像素
    }
    return lumLast;
  }

  /**
   * 缓解字幕跳动：
   *   ① 同一句在变长（旧串是新串的前缀）→ 允许较快更新
   *   ② 出现修订或换句 → 等结果稳定 200ms，且上一句已显示满 1.2 秒才换
   *   ③ 全局限速，最快 260ms 换一次
   */
  function maybeSwapLive() {
    if (!pendingSeg) return;
    const now = Date.now();
    const next = pendingSeg;
    const cur = live;

    // ① 同一句在增长
    if (cur && next.text.startsWith(cur.text)) {
      if (next.text === cur.text) {
        // 只是译文补到了，直接更新（不重排英文）
        if (next.zh && next.zh !== cur.zh) { live = { ...cur, zh: next.zh }; }
        return;
      }
      // 至少多出 2 个字符才换，避免一个字母一个字母地抖
      if (next.text.length - cur.text.length >= 2 && now - lastSwapAt >= 300) {
        live = next; lastSwapAt = now; shownAt = now;
      }
      return;
    }

    // ② 修订或换句：等稳定 + 保证上一句停留时间
    const settled = now - next.at >= 200;
    const curShownLongEnough = !cur || (now - shownAt) >= 1200;
    if (settled && curShownLongEnough && now - lastSwapAt >= 300) {
      live = next;
      lastSwapAt = now;
      shownAt = now;
    }
  }

  function renderLive(seg) {
    ensureOverlay();
    applyStyle();
    let zh = seg.zh || zhCache.get(seg.text) || '';
    // 新句子还没有译文时，沿用上一句的中文，避免中文行一闪一空
    if (!zh && lastZh && lastZhText && seg.text.startsWith(lastZhText)) zh = lastZh;
    // 中文还没有时，一定把英文露出来，否则「只显示中文」模式下会出现空白
    const showEn = settings.showOriginal || !zh;
    boxEn.textContent = showEn ? seg.text : '';
    boxEn.style.display = showEn ? '' : 'none';
    boxZh.textContent = zh;
    host.classList.add('bi-visible');
    host.classList.toggle('bi-zh-only', !showEn);
    host.classList.toggle('bi-pending', !zh);
  }

  let rafId = null;
  function loop() {
    rafId = requestAnimationFrame(loop);

    const v = videoEl();
    if (!v) { if (host) host.classList.remove('bi-visible'); return; }
    positionOverlay(v);

    // 换了一个 <video> 元素 = 换了视频，清掉旧字幕
    if (lastVideoEl && v !== lastVideoEl) onPageChanged();
    lastVideoEl = v;

    // 画面偏亮时自动切成深色字（跨域视频读不到像素时会退化成默认白字描边）
    const lum = sampleLight(v);
    if (host) host.classList.toggle('bi-on-light', lum >= 0 && lum > 0.62);

    // 语音识别结果优先，且不受「字幕总开关」影响 —— 它是用户手动点开的
    maybeSwapLive();
    if (live) { renderLive(live); return; }

    // 字幕总开关只作用于「抓字幕轨」那条路
    if (!settings.enabled) {
      if (host) host.classList.remove('bi-visible');
      return;
    }

    const cue = cueAt(v.currentTime);
    render(cue);
    if (cue && !zhCache.has(cue.text)) scheduleTranslate();
  }

  /* ================= 通用 <track> 兜底 ================= */
  function attachGenericTracks() {
    if (!videoCache.length) rescanVideos();
    const out = videoCache;
    for (const v of out) {
      const tracks = v.textTracks;
      if (!tracks || !tracks.length) continue;
      for (let i = 0; i < tracks.length; i++) {
        const tt = tracks[i];
        if (tt.__biAttached) continue;
        const lang = String(tt.language || '').toLowerCase();
        if (!lang.startsWith('en')) continue;
        try {
          if (tt.mode === 'disabled') tt.mode = 'hidden';
        } catch (_) { continue; }
        tt.__biAttached = true;
        tt.addEventListener('cuechange', () => {
          const active = tt.activeCues ? [...tt.activeCues] : [];
          if (!active.length) return;
          const batch = active
            .map((c) => ({
              start: c.startTime,
              dur: Math.max(0, c.endTime - c.startTime),
              text: (c.text || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
            }))
            .filter((c) => c.text);
          if (batch.length) { insertCues(batch); ensureOverlay(); scheduleTranslate(); }
        });
      }
    }
  }

  /* ================= 消息 ================= */
  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || d.source !== SRC) return;

    if (d.type === 'cues') {
      const n = insertCues(d.cues);
      if (n) { ensureOverlay(); scheduleTranslate(); }
    } else if (d.type === 'status') {
      // 只在真正需要用户知道时才提示
      if (d.state === 'no-english') showStatus('这个视频没有英文字幕轨', 5000);
      else if (d.state === 'track-error') showStatus('字幕读取失败', 4000);
      else if (d.state === 'navigated') onPageChanged();
      else if (d.state === 'track-loaded' || d.state === 'track-silent' || d.state === 'track-found') showStatus('', 0);
    }
  });

  /* ================= 启动 ================= */
  async function boot() {
    try {
      const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
      settings = { ...DEFAULT_SETTINGS, ...stored };
      // v0.5 起默认字号/位置放大；v0.6.5 起修复被误关的「字幕总开关」
      if (!stored.uiRev || Number(stored.uiRev) < 6) {
        settings.fontSize = DEFAULT_SETTINGS.fontSize;
        settings.bottomOffset = DEFAULT_SETTINGS.bottomOffset;
        settings.enabled = true;
        try {
          await chrome.storage.sync.set({
            fontSize: settings.fontSize,
            bottomOffset: settings.bottomOffset,
            enabled: true,
            uiRev: 6
          });
        } catch (_) {}
      }
      apiKeyConfigured = !!(stored.apiKey && stored.apiKey.trim());
    } catch (_) {
      settings = { ...DEFAULT_SETTINGS };
    }
    ensureOverlay();
    ensureWidget();
    applyStyle();
    if (!rafId) loop();
    try {
      const st = await chrome.runtime.sendMessage({ type: 'asr-query' });
      if (st && st.ok) {
        // 如果正在跑的是别的页面实例的识别，说明本页不是主人 —— 停掉它，避免串台
        if (st.running && st.pageId && st.pageId !== PAGE_ID) {
          chrome.runtime.sendMessage({ type: 'asr-stop' }).catch(() => {});
          asrRunning = false;
        } else {
          asrRunning = !!st.running;
        }
        updateWidget();
      }
    } catch (_) {}
    window.postMessage({ source: SRC, type: 'request-track' }, '*');
    attachGenericTracks();
    setInterval(attachGenericTracks, 3000);
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg) return;
    if (msg.type === 'settings-changed') {
      chrome.storage.sync.get(DEFAULT_SETTINGS).then((s) => {
        settings = { ...DEFAULT_SETTINGS, ...s };
        apiKeyConfigured = !!(s.apiKey && String(s.apiKey).trim());
        applyStyle();
        sendResponse({ ok: true });
      });
      return true;
    }
    if (msg.type === 'toggle') {
      settings.enabled = !!msg.enabled;
      if (host) host.classList.remove('bi-visible');
      sendResponse({ ok: true, enabled: settings.enabled });
      return true;
    }
    if (msg.type === 'asr-state') {
      asrRunning = !!msg.running;
      ensureWidget();
      updateWidget();
      sendResponse({ ok: true });
      return true;
    }
    if (msg.type === 'asr-segment') {
      // 不是本页面的结果（旧页面 / 换过视频）直接丢弃
      if (msg.pageId && msg.pageId !== PAGE_ID) return;
      onAsrSegment(msg.text, msg.zh);
      sendResponse({ ok: true });
      return true;
    }
    if (msg.type === 'asr-error') {
      showStatus(shortErr(msg.detail), 7000);
      sendResponse({ ok: true });
      return true;
    }
  });

  // 页面被关掉 / 跳走 / 进缓存时，立刻停掉标签页音频采集，不留后台会话
  window.addEventListener('pagehide', () => {
    try { chrome.runtime.sendMessage({ type: 'asr-stop' }); } catch (_) {}
  });
  window.addEventListener('beforeunload', () => {
    try { chrome.runtime.sendMessage({ type: 'asr-stop' }); } catch (_) {}
  });

  boot();
})();
