/**
 * Offscreen 文档（v0.6 —— 流式识别）
 *
 * 两种模式：
 *   stream（默认）—— 每 ~0.4 秒把 PCM 推给 /v1/stream/feed，服务端增量返回文本，
 *                    延迟 0.1–0.4 秒；sherpa-onnx 这类流式模型用这个。
 *   chunk         —— 攒 2.5–5 秒一段，POST /v1/audio/transcriptions（Whisper 用这个）。
 *
 * 音频回放：sourceNode 直连 destination，保证标签页声音正常；
 * 识别支路经 0 增益节点，只为驱动回调，不叠加声音。
 */

'use strict';

const TARGET = 'offscreen';
const SR = 16000;
const BUF_SIZE = 4096;

let audioCtx = null;
let mediaStream = null;
let sourceNode = null;
let procNode = null;
let procGain = null;
let srcRate = 48000;

let running = false;
let cfg = {};
let mode = 'stream';
let sessionId = 's' + Date.now();

/* 流式状态 */
let pcmChunks = [];
let pcmSamples = 0;
let streamBusy = false;
let lastTranslateAt = 0;
let lastTextLen = 0;
let silentFeeds = 0;

/* 分块状态 */
let chunks = [];
let totalSamples = 0;
let silenceMs = 0;
let busy = false;

const CJK = /[\u3400-\u9FFF\uF900-\uFAFF]/;const NOTE_RE = /[♪♫♬♩]+/g;
const NOISE_WORDS =
  'music|musical|applause|laughter|laughs|silence|silent|blank|inaudible|indistinct|' +
  'unintelligible|noise|cheer|cheers|beep|cough|sigh|speaking|foreign|background|sound|audio';
const NOISE_RE = new RegExp(
  '\\[[^\\]]*(?:' + NOISE_WORDS + ')[^\\]]*\\]' +
  '|\\([^)]*(?:' + NOISE_WORDS + ')[^)]*\\)',
  'gi'
);

function log(...a) { console.log('[offscreen]', ...a); }

function tell(type, payload) {
  chrome.runtime.sendMessage(Object.assign({ target: 'background', type }, payload)).catch(() => {});
}

/* ---------- 文本清理 ---------- */
function cleanText(raw) {
  let s = String(raw || '');
  s = s.replace(NOISE_RE, ' ').replace(NOTE_RE, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  if (!s) return '';
  if (!/[A-Za-z0-9\u00C0-\u024F]/.test(s)) return '';
  if (CJK.test(s)) return '';
  const words = s.split(' ');
  if (words.length >= 10) {
    const uniq = new Set(words.map((w) => w.toLowerCase()));
    if (uniq.size <= 2) return '';
  }
  return s;
}

/* ---------- 降采样 / PCM 转换 ---------- */
function downsample(buf, from, to) {
  if (from === to) return buf;
  const ratio = from / to;
  const len = Math.floor(buf.length / ratio);
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    const idx = i * ratio;
    const i0 = Math.floor(idx);
    const i1 = Math.min(i0 + 1, buf.length - 1);
    const frac = idx - i0;
    out[i] = buf[i0] * (1 - frac) + buf[i1] * frac;
  }
  return out;
}

function toPcm16(f32) {
  const out = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) {
    const s = Math.max(-1, Math.min(1, f32[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

/* ---------- WAV 编码（分块模式用） ---------- */
function encodeWav(float32, sampleRate) {
  const len = float32.length;
  const buf = new ArrayBuffer(44 + len * 2);
  const v = new DataView(buf);
  const w = (off, s) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + len * 2, true); w(8, 'WAVE');
  w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
  v.setUint16(22, 1, true); v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, len * 2, true);
  let off = 44;
  for (let i = 0; i < len; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    v.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    off += 2;
  }
  return new Blob([buf], { type: 'audio/wav' });
}

/* ---------- 翻译（先本地内置，再回落 DeepSeek） ---------- */
let builtinTranslator = null;
let builtinTried = false;

async function getBuiltin() {
  if (builtinTried) return builtinTranslator;
  builtinTried = true;
  try {
    const F = window.Translator
      || (window.translation && { create: window.translation.createTranslator })
      || (window.ai && window.ai.translator);
    if (F && F.create) {
      builtinTranslator = await F.create({ sourceLanguage: 'en', targetLanguage: 'zh' });
    }
  } catch (_) { builtinTranslator = null; }
  return builtinTranslator;
}

/** 本机内置翻译，通常 50–150ms，用来给中间结果抢时间 */
async function translateLocal(text) {
  try {
    const t = await getBuiltin();
    if (!t) return '';
    const r = await t.translate(text);
    return r ? String(r).trim() : '';
  } catch (_) { return ''; }
}

async function translate(text) {
  try {
    const resp = await chrome.runtime.sendMessage({ target: 'background', type: 'translate', texts: [text] });
    if (resp && resp.ok && resp.items && resp.items[0]) return resp.items[0];
  } catch (_) {}
  return '';
}

/* ================= 流式模式 ================= */
async function flushStream() {
  if (streamBusy || !pcmSamples) return;
  streamBusy = true;

  const merged = new Int16Array(pcmSamples);
  let o = 0;
  for (const c of pcmChunks) { merged.set(c, o); o += c.length; }
  pcmChunks = [];
  pcmSamples = 0;

  const base = String(cfg.asrBaseUrl || '').replace(/\/+$/, '').replace(/\/v1$/, '');
  try {
    // 客户端音量诊断：跟着请求一起报给服务端
    let sum = 0;
    for (let i = 0; i < merged.length; i++) { const v = merged[i] / 32768; sum += v * v; }
    const clientRms = merged.length ? Math.sqrt(sum / merged.length) : 0;

    // 静音看门狗：连续 ~5 秒抓不到声音就明确告警，而不是默默什么都不出
    if (clientRms < 0.0015) {
      silentFeeds++;
      if (silentFeeds === 12) {
        tell('asr-error', { detail: '抓到的音频是静音：请刷新页面（F5）后重新启动一次' });
      }
    } else {
      silentFeeds = 0;
    }

    const res = await fetch(`${base}/v1/stream/feed?session=${encodeURIComponent(sessionId)}&rms=${clientRms.toFixed(5)}&n=${merged.length}`, {
      method: 'POST',
      body: merged.buffer
    });

    // 服务端不支持流式（比如还在跑 whisper）→ 自动退回分块模式
    if (res.status === 404) {
      mode = 'chunk';
      tell('asr-status', { state: 'running', detail: 'fallback-chunk' });
      return;
    }
    if (!res.ok) throw new Error('stream HTTP ' + res.status);

    const j = await res.json();
    const text = cleanText(j.text || '');
    if (text) {
      // ① 英文立刻送出去，绝不等翻译
      tell('asr-segment', { text, zh: '', partial: !j.endpoint });

      // ② 翻译异步补一条；内容侧按原文缓存，不会串到别的句子上
      const now = Date.now();
      const grew = text.length > lastTextLen + 6;
      if (j.endpoint || (grew && now - lastTranslateAt > 700)) {
        lastTranslateAt = now;
        lastTextLen = text.length;
        const target = text;
        (async () => {
          let zh = await translateLocal(target);      // 本机，先抢速度
          if (!zh) zh = await translate(target);      // 回落 DeepSeek
          if (zh) tell('asr-segment', { text: target, zh, partial: !j.endpoint });
        })().catch(() => {});
      }
    }
    if (j.endpoint) { lastTextLen = 0; lastTranslateAt = 0; }
  } catch (e) {
    tell('asr-error', { detail: String(e && e.message || e) });
  } finally {
    streamBusy = false;
  }
}

/* ================= 分块模式 ================= */
async function flushChunk() {
  if (!totalSamples) return;
  const sec = totalSamples / SR;
  if (sec < (cfg.minChunkSec || 2.5)) return;
  if (busy) { chunks = []; totalSamples = 0; silenceMs = 0; return; }
  busy = true;

  const merged = new Float32Array(totalSamples);
  let o = 0;
  for (const c of chunks) { merged.set(c, o); o += c.length; }
  chunks = []; totalSamples = 0; silenceMs = 0;

  const blob = encodeWav(merged, SR);
  const base = String(cfg.asrBaseUrl || '').replace(/\/+$/, '').replace(/\/v1$/, '');
  try {
    const fd = new FormData();
    fd.append('file', blob, 'chunk.wav');
    fd.append('model', cfg.asrModel || 'whisper');
    fd.append('language', 'en');
    fd.append('response_format', 'json');
    const res = await fetch(base + '/v1/audio/transcriptions', { method: 'POST', body: fd });
    if (!res.ok) throw new Error('ASR HTTP ' + res.status);
    const j = await res.json();
    const text = cleanText(j.text || '');
    if (text) tell('asr-segment', { text, zh: await translate(text), partial: false });
  } catch (e) {
    tell('asr-error', { detail: String(e && e.message || e) });
  } finally {
    busy = false;
  }
}

/* ================= 音频回调 ================= */
function onAudio(ev) {
  if (!running) return;
  const raw = ev.inputBuffer.getChannelData(0);
  const mono = downsample(raw, srcRate, SR);

  if (mode === 'stream') {
    pcmChunks.push(toPcm16(mono));
    pcmSamples += mono.length;
    // 每 ~0.4 秒推一次
    if (!streamBusy && pcmSamples >= SR * 0.4) flushStream();
    return;
  }

  // 分块模式
  let sum = 0;
  for (let i = 0; i < raw.length; i++) sum += raw[i] * raw[i];
  const rms = Math.sqrt(sum / raw.length);

  chunks.push(mono);
  totalSamples += mono.length;
  const ms = (mono.length / SR) * 1000;
  if (rms < (cfg.silenceRms || 0.008)) silenceMs += ms; else silenceMs = 0;

  const sec = totalSamples / SR;
  if (sec >= (cfg.maxChunkSec || 5)) { flushChunk(); return; }
  if (sec >= (cfg.minChunkSec || 2.5) && silenceMs >= 500) { flushChunk(); return; }
}

/* ================= 启停 ================= */
async function start(streamId, settings) {
  await stop(true);
  cfg = settings || {};
  mode = cfg.asrMode || 'stream';
  sessionId = 's' + Date.now();

  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
    video: false
  });

  // 拿到静音流时提前报错，免得用户以为在识别
  const track = mediaStream.getAudioTracks()[0];
  if (!track || track.readyState !== 'live') {
    throw new Error('抓不到标签页音频（请刷新页面后重试一次）');
  }

  audioCtx = new AudioContext();
  srcRate = audioCtx.sampleRate;
  sourceNode = audioCtx.createMediaStreamSource(mediaStream);

  // ① 原样回放，否则标签页会静音
  sourceNode.connect(audioCtx.destination);

  // ② 识别支路：0 增益，只驱动回调
  procNode = audioCtx.createScriptProcessor(BUF_SIZE, 1, 1);
  procNode.onaudioprocess = onAudio;
  procGain = audioCtx.createGain();
  procGain.gain.value = 0;
  sourceNode.connect(procNode);
  procNode.connect(procGain);
  procGain.connect(audioCtx.destination);

  try { await audioCtx.resume(); } catch (_) {}

  running = true;
  tell('asr-status', { state: 'running', detail: mode });
  log('started mode=' + mode);
}

async function stop(silent) {
  running = false;
  busy = false;
  streamBusy = false;
  try { if (procNode) { procNode.onaudioprocess = null; procNode.disconnect(); } } catch (_) {}
  try { if (procGain) procGain.disconnect(); } catch (_) {}
  try { if (sourceNode) sourceNode.disconnect(); } catch (_) {}
  try { if (audioCtx) await audioCtx.close(); } catch (_) {}
  try { if (mediaStream) mediaStream.getTracks().forEach((t) => t.stop()); } catch (_) {}
  procNode = null; procGain = null; sourceNode = null; audioCtx = null; mediaStream = null;
  chunks = []; totalSamples = 0; silenceMs = 0;
  pcmChunks = []; pcmSamples = 0;
  lastTextLen = 0; lastTranslateAt = 0;
  if (!silent) tell('asr-status', { state: 'stopped' });
}

/* ================= 消息 ================= */
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target !== TARGET) return;

  if (msg.type === 'start') {
    start(msg.streamId, msg.settings)
      .then(() => sendResponse({ ok: true }))
      .catch((e) => {
        const detail = String(e && e.message || e);
        tell('asr-error', { detail });
        sendResponse({ ok: false, error: detail });
      });
    return true;
  }

  if (msg.type === 'stop') {
    stop(false).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (msg.type === 'ping') {
    sendResponse({ ok: true, running, mode });
    return true;
  }
});
