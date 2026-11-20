/**
 * MAIN world 注入脚本（v0.3）
 * 职责：把页面里的**英文字幕轨**捞出来，postMessage 给隔离世界的 content.js。
 *
 * v0.3 关键修正：
 *   YouTube 的 timedtext 带 `tlang=` 参数时返回的是「自动翻译后的」字幕（可能是中文）。
 *   之前照单全收，导致抓到的中文被当成英文原文 → 出现「两行中文」。
 *   现在三层过滤：① URL 里带 tlang 的直接丢弃 ② lang 不是 en 的丢弃 ③ 文本含 CJK 的丢弃。
 */
(() => {
  'use strict';

  const SRC = '__BI_SUB__';
  if (window.__biSubInjected) return;
  window.__biSubInjected = true;

  const emitted = new Set();
  const MAX_SEEN = 5000;
  const CJK = /[\u3400-\u9FFF\uF900-\uFAFF]/;

  function post(msg) {
    try { window.postMessage(Object.assign({ source: SRC }, msg), '*'); } catch (_) {}
  }
  function status(state, detail) {
    post({ type: 'status', state, detail: detail || '' });
  }

  /* ---------- 判断这条字幕轨是不是英文 ---------- */
  function isEnglishSource(rawUrl) {
    let u;
    try { u = new URL(rawUrl, location.href); } catch (_) { return false; }
    // 自动翻译轨：tlang 存在就意味着内容已经变成目标语言了
    if (u.searchParams.get('tlang')) return false;
    const lang = (u.searchParams.get('lang') || '').toLowerCase();
    if (lang && !lang.startsWith('en')) return false;
    const kind = (u.searchParams.get('kind') || '').toLowerCase();
    if (kind && kind !== 'asr' && kind !== '') { /* 其它 kind 也放行，靠 lang 判定 */ }
    return true;
  }

  /* ---------- 解析 json3 ---------- */
  function parseJson3(text, lang) {
    let data;
    try { data = JSON.parse(text); } catch (_) { return []; }
    if (!data || !Array.isArray(data.events)) return [];

    const cues = [];
    for (const ev of data.events) {
      if (!ev.segs) continue;
      let t = ev.segs.map((s) => s.utf8 || '').join('');
      t = t.replace(/\s+/g, ' ').trim();
      if (!t) continue;
      // 含中日韩字符 → 不是英文原文，丢弃
      if (CJK.test(t)) continue;

      const start = (ev.tStartMs || 0) / 1000;
      const dur = ev.dDurationMs ? ev.dDurationMs / 1000 : 0;
      const key = start.toFixed(2) + '|' + t;
      if (emitted.has(key)) continue;
      emitted.add(key);
      cues.push({ start, dur, text: t, lang: lang || '' });
    }

    if (emitted.size > MAX_SEEN) {
      const drop = [...emitted].slice(0, MAX_SEEN / 2);
      for (const d of drop) emitted.delete(d);
    }
    return cues;
  }

  function urlWithJson3(u) {
    let out = u;
    try {
      const p = new URL(u, location.href);
      p.searchParams.set('fmt', 'json3');
      out = p.toString();
    } catch (_) {
      out = u + (u.indexOf('?') >= 0 ? '&' : '?') + 'fmt=json3';
    }
    return out;
  }

  /** 老式 XML 字幕兜底：<text start="1.2" dur="3.4">…</text> */
  function parseXml(text) {
    const out = [];
    const re = /<text[^>]*\bstart="([\d.]+)"[^>]*\bdur="([\d.]+)"[^>]*>([\s\S]*?)<\/text>/g;
    let m;
    while ((m = re.exec(text))) {
      let t = m[3]
        .replace(/<[^>]+>/g, '')
        .replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
        .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/\s+/g, ' ')
        .trim();
      if (!t || CJK.test(t)) continue;
      const start = Number(m[1]);
      const key = start.toFixed(2) + '|' + t;
      if (emitted.has(key)) continue;
      emitted.add(key);
      out.push({ start, dur: Number(m[2]) || 0, text: t, lang: 'en' });
    }
    return out;
  }

  function emitCues(cues) {
    if (!cues || !cues.length) return;
    post({ type: 'cues', cues });
  }

  /* ---------- ① 主动抓字幕轨 ---------- */
  let activeTrackUrl = null;

  function pickEnglishTrack(tracks) {
    if (!Array.isArray(tracks) || !tracks.length) return null;
    const en = tracks.filter((t) => (t.languageCode || '').toLowerCase().startsWith('en'));
    if (!en.length) return null;
    const manual = en.find((t) => t.kind !== 'asr');
    return manual || en[0];
  }

  async function pullTrack(track) {
    if (!track || !track.baseUrl) return;
    if (activeTrackUrl === track.baseUrl) return;
    activeTrackUrl = track.baseUrl;

    const label = (track.name && (track.name.simpleText || track.name.runs?.[0]?.text)) || track.languageCode || 'en';
    status('track-found', `${label}${track.kind === 'asr' ? '（自动生成）' : ''}`);

    try {
      let cues = [];

      // 第一次：json3
      const res = await fetch(urlWithJson3(track.baseUrl), { credentials: 'include' });
      if (res.ok) {
        const txt = await res.text();
        cues = parseJson3(txt, track.languageCode);
        if (!cues.length) cues = parseXml(txt);
      }

      // 第二次：不带 fmt 的原始响应
      if (!cues.length) {
        try {
          const res2 = await fetch(track.baseUrl, { credentials: 'include' });
          if (res2.ok) {
            const t2 = await res2.text();
            cues = parseJson3(t2, track.languageCode);
            if (!cues.length) cues = parseXml(t2);
          }
        } catch (_) {}
      }

      if (cues.length) {
        status('track-loaded', `${cues.length} 条`);
        emitCues(cues);
      } else {
        // 直接抓不到就安静地等网络钩子，不弹吓人的提示
        status('track-silent', '');
      }
    } catch (e) {
      status('track-silent', '');
    }
  }

  function tryPlayerResponse() {
    try {
      const pr = window.ytInitialPlayerResponse;
      const list = pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
      if (!list) return false;
      const track = pickEnglishTrack(list);
      if (!track) { status('no-english', '没有英文字幕轨'); return false; }
      pullTrack(track);
      return true;
    } catch (_) { return false; }
  }

  /* ---------- ② 兜底 hook 网络 ---------- */
  function handleText(url, text) {
    if (!url || url.indexOf('/api/timedtext') === -1) return;
    if (!isEnglishSource(url)) return;          // ★ 关键：丢掉翻译轨
    const cues = parseJson3(text, 'en');
    if (cues.length) emitCues(cues);
  }

  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function (...args) {
      const p = origFetch.apply(this, args);
      try {
        const req = args[0];
        const url = typeof req === 'string' ? req : (req && req.url) || '';
        if (url && url.indexOf('/api/timedtext') !== -1 && isEnglishSource(url)) {
          p.then((res) => {
            try { res.clone().text().then((t) => handleText(url, t)).catch(() => {}); } catch (_) {}
          }).catch(() => {});
        }
      } catch (_) {}
      return p;
    };
  }

  const OrigXHR = window.XMLHttpRequest;
  if (typeof OrigXHR === 'function') {
    const open = OrigXHR.prototype.open;
    const send = OrigXHR.prototype.send;
    OrigXHR.prototype.open = function (method, url, ...rest) {
      try { this.__biUrl = url; } catch (_) {}
      return open.call(this, method, url, ...rest);
    };
    OrigXHR.prototype.send = function (...args) {
      try {
        this.addEventListener('load', () => {
          try {
            const u = this.__biUrl || this.responseURL || '';
            if (u.indexOf('/api/timedtext') !== -1 && typeof this.responseText === 'string') {
              handleText(u, this.responseText);
            }
          } catch (_) {}
        });
      } catch (_) {}
      return send.apply(this, args);
    };
  }

  /* ---------- 启动 ---------- */
  status('injected', location.hostname);

  let tries = 0;
  const timer = setInterval(() => {
    tries += 1;
    if (tryPlayerResponse() || tries > 40) clearInterval(timer);
  }, 500);

  window.addEventListener('yt-navigate-finish', () => {
    activeTrackUrl = null;
    emitted.clear();
    setTimeout(() => { tryPlayerResponse(); }, 800);
  });

  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (d && d.source === SRC && d.type === 'request-track') tryPlayerResponse();
  });
})();
