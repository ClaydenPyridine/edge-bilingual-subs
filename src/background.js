/**
 * Service Worker（v0.5）
 * 职责：
 *   ① 字幕开关 / 翻译代理（DeepSeek）
 *   ② 语音识别编排：tabCapture 拿流 → 交给 offscreen 处理 → 把字幕转发给页面
 */
'use strict';

const DEFAULT_SETTINGS = {
  enabled: true,
  engine: 'auto',
  showOriginal: true,
  fontSize: 36,
  bottomOffset: 7,
  filterNoise: true,

  // 翻译（DeepSeek）
  apiKey: '',
  model: 'deepseek-chat',
  baseUrl: 'https://api.deepseek.com',

  // 语音识别（OpenAI 兼容接口）
  asrEnabled: true,
  asrMode: 'stream',        // stream=流式(sherpa) | chunk=分块(whisper)
  asrBaseUrl: '',
  asrKey: '',
  asrModel: 'whisper-large-v3-turbo',
  minChunkSec: 2.5,
  maxChunkSec: 5
};

const memCache = new Map();     // 原文 -> 中文
let asrTabId = null;
let asrRunning = false;

/* ================= 翻译 ================= */
async function deepseekTranslate(texts) {
  const s = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  const key = (s.apiKey || '').trim();
  if (!key) throw new Error('NO_API_KEY');

  const base = (s.baseUrl || 'https://api.deepseek.com').replace(/\/+$/, '');
  const model = s.model || 'deepseek-chat';

  const payload = {
    model,
    temperature: 0.2,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content:
          '你是专业的影视字幕翻译。把用户给出的每一条英文台词翻译成自然、口语化的简体中文。' +
          '要求：① 严格逐条对应，条数与输入完全一致；② 不要合并、不要拆分、不要添加解释；' +
          '③ 只输出 JSON，格式为 {"items":["译文1","译文2", ...]}。'
      },
      { role: 'user', content: JSON.stringify({ lines: texts }) }
    ]
  };

  const res = await fetch(base + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error('HTTP ' + res.status + ' ' + t.slice(0, 200));
  }

  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content || '';
  let items = [];
  try {
    const parsed = JSON.parse(content);
    if (Array.isArray(parsed)) items = parsed;
    else if (Array.isArray(parsed.items)) items = parsed.items;
  } catch (_) {
    items = content.split('\n').map((x) => x.replace(/^\s*\d+[.、)]\s*/, '').trim()).filter(Boolean);
  }
  return texts.map((_, i) => (typeof items[i] === 'string' ? items[i] : ''));
}

async function handleTranslate(texts) {
  const items = new Array(texts.length).fill('');
  const miss = [];
  texts.forEach((t, i) => {
    if (memCache.has(t)) items[i] = memCache.get(t);
    else miss.push(i);
  });
  if (miss.length) {
    const uniq = [...new Set(miss.map((i) => texts[i]))];
    const translated = await deepseekTranslate(uniq);
    const map = new Map();
    uniq.forEach((src, k) => {
      const zh = translated[k] || '';
      map.set(src, zh);
      if (zh) memCache.set(src, zh);
    });
    miss.forEach((i) => { items[i] = map.get(texts[i]) || ''; });
  }
  return items;
}

/* ================= Offscreen ================= */
async function ensureOffscreen() {
  try {
    if (chrome.offscreen && typeof chrome.offscreen.hasDocument === 'function') {
      if (await chrome.offscreen.hasDocument()) return;
    }
  } catch (_) {}
  try {
    await chrome.offscreen.createDocument({
      url: 'src/offscreen.html',
      reasons: ['USER_MEDIA'],
      justification: '捕获标签页音频，用于实时语音识别生成字幕'
    });
  } catch (e) {
    // 已经存在时会抛错，忽略
    if (!/single offscreen|already/i.test(String(e && e.message))) throw e;
  }
}

function badge(tabId, text, color) {
  try {
    chrome.action.setBadgeText({ text: text || '', tabId });
    if (color) chrome.action.setBadgeBackgroundColor({ color, tabId });
  } catch (_) {}
}

async function startASR(tabId) {
  await ensureOffscreen();

  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  const s = await chrome.storage.sync.get(DEFAULT_SETTINGS);

  if (!s.asrBaseUrl) {
    throw new Error('未配置 ASR 接口地址，请到扩展选项里填写');
  }

  asrTabId = tabId;
  try { await chrome.storage.session.set({ asrTabId: tabId }); } catch (_) {}
  const resp = await chrome.runtime.sendMessage({
    target: 'offscreen',
    type: 'start',
    streamId,
    settings: {
      asrBaseUrl: s.asrBaseUrl,
      asrKey: s.asrKey,
      asrModel: s.asrModel,
      asrMode: s.asrMode || 'stream',
      minChunkSec: Number(s.minChunkSec) || 2.5,
      maxChunkSec: Number(s.maxChunkSec) || 5
    }
  });

  if (resp && resp.ok === false) throw new Error(resp.error || '启动失败');

  asrRunning = true;
  badge(tabId, 'REC', '#d2453f');
  return true;
}

async function stopASR() {
  try { await chrome.runtime.sendMessage({ target: 'offscreen', type: 'stop' }); } catch (_) {}
  // 关键：把离屏文档整个销毁。否则同一个标签页反复 start/stop 后，
  // Chrome 的 tabCapture 会一直返回静音流，直到页面刷新为止。
  try {
    if (chrome.offscreen && typeof chrome.offscreen.closeDocument === 'function') {
      await chrome.offscreen.closeDocument();
    }
  } catch (_) {}
  asrRunning = false;
  if (asrTabId != null) badge(asrTabId, '');
  asrTabId = null;
  try { await chrome.storage.session.remove('asrTabId'); } catch (_) {}
  return true;
}

/** 把识别结果发给页面；background 可能被回收过，所以用会话存储兜底 */
async function forwardSegment(text, zh) {
  let tabId = asrTabId;
  if (tabId == null) {
    try {
      const s = await chrome.storage.session.get('asrTabId');
      tabId = s && s.asrTabId != null ? s.asrTabId : null;
    } catch (_) {}
  }
  if (tabId == null) return;
  try { await chrome.tabs.sendMessage(tabId, { type: 'asr-segment', text, zh }); } catch (_) {}
}

async function toggleASR(tabId) {
  if (asrRunning) { await stopASR(); return { running: false }; }
  await startASR(tabId);
  return { running: true };
}

/* ================= 图标点击 ================= */
chrome.action.onClicked.addListener(async (tab) => {
  try {
    const r = await toggleASR(tab.id);
    try { await chrome.tabs.sendMessage(tab.id, { type: 'asr-state', running: r.running }); } catch (_) {}
  } catch (e) {
    const msg = String(e && e.message || e);
    try { await chrome.tabs.sendMessage(tab.id, { type: 'asr-error', detail: msg }); } catch (_) {}
  }
});

/* ================= 消息路由 ================= */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;

  /* --- 页面请求翻译 --- */
  if (msg.type === 'translate') {
    (async () => {
      const texts = (msg.texts || []).map(String);
      if (!texts.length) return sendResponse({ ok: true, items: [] });
      try {
        sendResponse({ ok: true, items: await handleTranslate(texts) });
      } catch (e) {
        sendResponse({ ok: false, error: String(e && e.message || e) });
      }
    })();
    return true;
  }

  /* --- 页面请求启停 ASR --- */
  if (msg.type === 'asr-toggle') {
    (async () => {
      const tabId = (sender && sender.tab && sender.tab.id) || msg.tabId;
      try {
        const r = await toggleASR(tabId);
        sendResponse({ ok: true, running: r.running });
      } catch (e) {
        sendResponse({ ok: false, error: String(e && e.message || e) });
      }
    })();
    return true;
  }

  if (msg.type === 'asr-query') {
    sendResponse({ ok: true, running: asrRunning });
    return true;
  }

  /* --- offscreen 回传 --- */
  if (msg.target === 'background') {
    if (msg.type === 'asr-segment') {
      forwardSegment(msg.text, msg.zh);
    }
    if (msg.type === 'asr-status') {
      asrRunning = msg.state === 'running';
      if (asrTabId != null) badge(asrTabId, asrRunning ? 'REC' : '', '#d2453f');
      if (asrTabId != null) {
        try { chrome.tabs.sendMessage(asrTabId, { type: 'asr-state', running: asrRunning }); } catch (_) {}
      }
    }
    if (msg.type === 'asr-error' && asrTabId != null) {
      try { chrome.tabs.sendMessage(asrTabId, { type: 'asr-error', detail: msg.detail }); } catch (_) {}
      badge(asrTabId, 'ERR', '#d2453f');
    }
    return;
  }
});

/* 标签页关闭时收尾 */
chrome.tabs.onRemoved.addListener((tabId) => {
  if (asrTabId === tabId) stopASR();
});

/* 标签页跳到别的网址（整页导航）时停掉识别，
   否则会把上一个页面的声音继续识别、显示到新页面上 */
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (asrTabId === tabId && changeInfo.status === 'loading') stopASR();
});
