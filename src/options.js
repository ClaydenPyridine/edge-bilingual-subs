'use strict';

const DEFAULTS = {
  enabled: true,
  engine: 'auto',
  showOriginal: true,
  fontSize: 36,
  bottomOffset: 7,
  filterNoise: true,
  apiKey: '',
  model: 'deepseek-chat',
  baseUrl: 'https://api.deepseek.com',
  asrEnabled: true,
  asrMode: 'stream',
  asrBaseUrl: '',
  asrKey: '',
  asrModel: 'whisper-large-v3-turbo',
  minChunkSec: 1.5,
  maxChunkSec: 8
};

const $ = (id) => document.getElementById(id);

function setStatus(msg, ok) {
  const el = $('status');
  el.textContent = msg || '';
  el.className = 'status ' + (ok === true ? 'ok' : ok === false ? 'err' : '');
}

async function load() {
  const s = { ...DEFAULTS, ...(await chrome.storage.sync.get(DEFAULTS)) };
  $('engine').value = s.engine;
  $('apiKey').value = s.apiKey || '';
  $('model').value = s.model || 'deepseek-chat';
  $('baseUrl').value = s.baseUrl || 'https://api.deepseek.com';
  $('showOriginal').value = String(!!s.showOriginal);
  $('filterNoise').value = String(s.filterNoise !== false);
  $('asrMode').value = s.asrMode || 'stream';
  $('asrBaseUrl').value = s.asrBaseUrl || '';
  $('asrKey').value = s.asrKey || '';
  $('asrModel').value = s.asrModel || 'whisper-large-v3-turbo';
  $('fontSize').value = s.fontSize;
  $('bottomOffset').value = s.bottomOffset;
  syncLabels();

  // 报告内置翻译能力
  try {
    const f = window.Translator || (window.translation && { availability: window.translation.canTranslate });
    if (!f || !f.availability) {
      setStatus('内置翻译 API 不可用，将使用 DeepSeek。');
    } else {
      const a = await f.availability({ sourceLanguage: 'en', targetLanguage: 'zh' });
      if (a === 'available' || a === 'readily') setStatus('内置翻译可用（en → zh）。', true);
      else if (a === 'downloadable' || a === 'after-download') setStatus('内置翻译模型需要首次下载。');
      else setStatus('内置翻译不可用，将使用 DeepSeek。');
    }
  } catch (e) {
    setStatus('内置翻译检测失败，将使用 DeepSeek。');
  }
}

function syncLabels() {
  $('fontSizeVal').textContent = $('fontSize').value + 'px';
  $('bottomOffsetVal').textContent = $('bottomOffset').value + '%';
}

async function save() {
  const s = {
    engine: $('engine').value,
    apiKey: $('apiKey').value.trim(),
    model: $('model').value.trim() || 'deepseek-chat',
    baseUrl: $('baseUrl').value.trim() || 'https://api.deepseek.com',
    showOriginal: $('showOriginal').value === 'true',
    filterNoise: $('filterNoise').value === 'true',
    fontSize: Number($('fontSize').value),
    bottomOffset: Number($('bottomOffset').value),
    asrMode: $('asrMode').value,
    asrBaseUrl: $('asrBaseUrl').value.trim(),
    asrKey: $('asrKey').value.trim(),
    asrModel: $('asrModel').value.trim() || 'whisper-large-v3-turbo'
  };
  await chrome.storage.sync.set(s);
  setStatus('已保存。回到视频页按 F5 刷新即可生效。', true);

  // 通知所有标签页重载设置
  const tabs = await chrome.tabs.query({});
  for (const t of tabs) {
    if (!t.id) continue;
    try { await chrome.tabs.sendMessage(t.id, { type: 'settings-changed' }); } catch (_) {}
  }
}

async function test() {
  setStatus('测试中…');
  try {
    const resp = await chrome.runtime.sendMessage({
      type: 'translate',
      texts: ['The quick brown fox jumps over the lazy dog.']
    });
    if (resp && resp.ok) {
      const zh = resp.items && resp.items[0];
      if (zh) setStatus('翻译成功：' + zh, true);
      else setStatus('接口返回成功但译文为空，请检查密钥/模型。', false);
    } else {
      setStatus('失败：' + (resp && resp.error || '未知错误'), false);
    }
  } catch (e) {
    setStatus('失败：' + (e && e.message || e), false);
  }
}

$('fontSize').addEventListener('input', syncLabels);
$('bottomOffset').addEventListener('input', syncLabels);
$('save').addEventListener('click', save);
$('test').addEventListener('click', test);

load();
