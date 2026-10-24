// ==UserScript==
// @name         YouTube — скачать субтитры и текст
// @namespace    local.youtube.subtitle-export
// @version      1.0.0
// @homepageURL  https://github.com/omiusgm/youtube-subtitles-tampermonkey
// @supportURL   https://github.com/omiusgm/youtube-subtitles-tampermonkey/issues
// @downloadURL  https://raw.githubusercontent.com/omiusgm/youtube-subtitles-tampermonkey/main/youtube-subtitles.user.js
// @updateURL    https://raw.githubusercontent.com/omiusgm/youtube-subtitles-tampermonkey/main/youtube-subtitles.meta.js
// @description  Скачивание доступных субтитров YouTube в TXT, SRT и VTT. Выбор языка, автосубтитры и экспорт расшифровки.
// @match        https://www.youtube.com/*
// @match        https://m.youtube.com/*
// @match        https://youtube.com/*
// @run-at       document-start
// @sandbox      raw
// @grant        none
// @noframes
// ==/UserScript==

(() => {
  'use strict';

  // Parsing/formatting also run under Node for offline regression tests.
  const Core = (() => {
    const textOf = value => {
      if (typeof value === 'string') return value;
      if (value?.simpleText) return value.simpleText;
      if (Array.isArray(value?.runs)) return value.runs.map(r => r.text || '').join('');
      if (typeof value?.content === 'string') return value.content;
      return '';
    };
    const clean = text => String(text || '').replace(/\r/g, '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u200b]/g, '')
      .split('\n').map(line => line.replace(/[\t \u00a0]+/g, ' ').trim()).join('\n').trim();
    const entityText = text => String(text).replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (match, code) => {
      const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
      if (code[0] !== '#') return named[code.toLowerCase()] ?? match;
      const num = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : Number(code.slice(1));
      return num > 0 && num <= 0x10ffff && !(num >= 0xd800 && num <= 0xdfff) ? String.fromCodePoint(num) : match;
    });
    function normalize(input) {
      const sorted = input.map(c => ({ start: Number(c.start), end: Number(c.end), text: clean(c.text) }))
        .filter(c => c.text && Number.isFinite(c.start) && c.start >= 0)
        .sort((a, b) => a.start - b.start);
      const nextStarts = new Array(sorted.length);
      let nextStart = NaN;
      for (let i = sorted.length - 1; i >= 0; i--) {
        if (i + 1 < sorted.length && sorted[i + 1].start > sorted[i].start) nextStart = sorted[i + 1].start;
        nextStarts[i] = nextStart;
      }
      const seen = new Set();
      return sorted.filter((c, index) => {
        if (!Number.isFinite(c.end) || c.end <= c.start) {
          c.end = Number.isFinite(nextStarts[index]) ? nextStarts[index] : c.start + 2000;
        }
        c.start = Math.round(c.start);
        c.end = Math.max(c.start + 1, Math.round(c.end));
        const key = `${c.start}|${c.end}|${c.text}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }
    function fromJson3(data) {
      if (!Array.isArray(data?.events)) return [];
      return normalize(data.events.filter(e => Array.isArray(e.segs)).map(e => ({
        start: e.tStartMs,
        end: Number(e.tStartMs) + Number(e.dDurationMs || 0),
        text: e.segs.map(s => s.utf8 || '').join(''),
      })));
    }
    function timeMs(value) {
      const parts = String(value).trim().replace(',', '.').split(':').map(Number);
      if (parts.length < 2 || parts.length > 3 || parts.some(n => !Number.isFinite(n) || n < 0)) return NaN;
      return Math.round(parts.reduce((total, n) => total * 60 + n, 0) * 1000);
    }
    function fromVtt(text) {
      const cues = [];
      for (const block of text.replace(/^\uFEFF/, '').replace(/\r/g, '').split(/\n\s*\n/)) {
        const lines = block.split('\n');
        const index = lines.findIndex(l => /\d:[\d.,]+\s+-->\s+/.test(l));
        if (index < 0 || /^(NOTE|STYLE|REGION)(\s|$)/.test(lines[0])) continue;
        const match = lines[index].match(/([\d:.,]+)\s+-->\s+([\d:.,]+)/);
        if (!match) continue;
        cues.push({ start: timeMs(match[1]), end: timeMs(match[2]),
          text: entityText(lines.slice(index + 1).join('\n').replace(/<[^>]*>/g, '')) });
      }
      return normalize(cues);
    }
    function fromXml(text, Parser) {
      const doc = new Parser().parseFromString(text, 'text/xml');
      if (doc.querySelector('parsererror') || !['transcript', 'timedtext'].includes(doc.documentElement?.localName)) return [];
      const content = node => Array.from(node.childNodes).map(n => n.nodeType === 3 ? n.nodeValue : n.localName === 'br' ? '\n' : content(n)).join('');
      return normalize(Array.from(doc.querySelectorAll('text, body p')).map(node => {
        const old = node.localName === 'text';
        const start = Number(node.getAttribute(old ? 'start' : 't')) * (old ? 1000 : 1);
        const duration = Number(node.getAttribute(old ? 'dur' : 'd')) * (old ? 1000 : 1);
        const plain = entityText(content(node)).replace(/<br\s*\/?>/gi, '\n').replace(/<\/?(?:b|i|u|font)(?:\s[^>]*)?>/gi, '');
        return { start, end: start + duration, text: plain };
      }));
    }
    function parseCaptions(raw, Parser) {
      if (typeof raw === 'object' && raw) return fromJson3(raw);
      const text = String(raw || '').trim();
      if (!text) return [];
      if (text.startsWith('{')) { try { return fromJson3(JSON.parse(text)); } catch { return []; } }
      if (text.replace(/^\uFEFF/, '').startsWith('WEBVTT')) return fromVtt(text);
      if (text.startsWith('<') && Parser) return fromXml(text, Parser);
      return [];
    }
    function walk(root, visitor) {
      const queue = [root];
      const seen = new WeakSet();
      let index = 0;
      for (; index < queue.length && index < 160000; index++) {
        const node = queue[index];
        if (!node || typeof node !== 'object' || seen.has(node)) continue;
        seen.add(node);
        visitor(node);
        for (const value of Object.values(node)) if (value && typeof value === 'object') queue.push(value);
      }
      return index === queue.length;
    }
    function fromTranscript(data) {
      const cues = [];
      let language = '', incomplete = false;
      const complete = walk(data, node => {
        const segment = node.transcriptSegmentRenderer || node.transcriptSegmentViewModel;
        if (segment) cues.push({ start: segment.startMs ?? segment.startTimeMs,
          end: segment.endMs ?? segment.endTimeMs, text: textOf(segment.snippet || segment.text) });
        const menu = node.sortFilterSubMenuRenderer?.subMenuItems;
        if (menu) language = textOf(menu.find(item => item.selected)?.title) || language;
        // Language-switch commands use reloadContinuationData, not continuationItemRenderer.
        if (node.continuationItemRenderer || node.initialSegments && node.continuations?.length) incomplete = true;
      });
      return { cues: normalize(cues), language, incomplete: incomplete || !complete };
    }
    function stamp(ms, separator = ',') {
      const n = Math.max(0, Math.round(ms));
      const pad = (value, size = 2) => String(value).padStart(size, '0');
      return `${pad(Math.floor(n / 3600000))}:${pad(Math.floor(n / 60000) % 60)}:${pad(Math.floor(n / 1000) % 60)}${separator}${pad(n % 1000, 3)}`;
    }
    function filename(title, videoId, lang, format) {
      const safe = s => String(s || '').normalize('NFC').replace(/[<>:"/\\|?*\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '_')
        .replace(/\s+/g, ' ').replace(/^[. ]+|[. ]+$/g, '');
      const ext = format === 'timed' ? 'txt' : format;
      const truncate = (value, maxBytes) => {
        let output = '', bytes = 0;
        for (const char of value) {
          const size = new TextEncoder().encode(char).length;
          if (bytes + size > maxBytes) break;
          output += char;
          bytes += size;
        }
        return output;
      };
      return `${truncate(safe(title) || 'YouTube', 160)} [${safe(videoId)}].${truncate(safe(lang) || 'transcript', 40)}.${ext}`;
    }
    function format(cues, type, meta) {
      if (!cues.length) throw new Error('Нет текста для сохранения.');
      const escaped = text => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      if (type === 'srt') return cues.map((c, i) => `${i + 1}\n${stamp(c.start)} --> ${stamp(c.end)}\n${escaped(c.text)}`).join('\n\n') + '\n';
      if (type === 'vtt') return 'WEBVTT\n\n' + cues.map(c => `${stamp(c.start, '.')} --> ${stamp(c.end, '.')}\n${escaped(c.text)}`).join('\n\n') + '\n';
      const header = `${clean(meta.title)}\n${meta.url}\nЯзык: ${clean(meta.language)}\n\n`;
      return header + cues.map(c => type === 'timed' ? `[${stamp(c.start, '.').split('.')[0]}] ${c.text}` : c.text).join('\n') + '\n';
    }
    function captionUrl(value) {
      try {
        const url = new URL(value);
        return url.protocol === 'https:' && /^(www\.|m\.)?youtube\.com$/.test(url.hostname) && url.pathname === '/api/timedtext' ? url : null;
      } catch { return null; }
    }
    function identity(url) {
      return ['lang', 'kind', 'tlang', 'name'].map(name => url.searchParams.get(name) || '').join('|');
    }
    return { textOf, clean, normalize, parseCaptions, fromTranscript, stamp, filename, format, captionUrl, identity, timeMs };
  })();

  if (typeof window === 'undefined') {
    if (typeof module !== 'undefined') module.exports = Core;
    return;
  }
  if (window.top !== window.self || window.__ytSubtitleExportV1) return;
  window.__ytSubtitleExportV1 = true;

  const HOST_ID = 'yt-subtitle-export-v1';
  const PANEL = '__transcript_panel__';
  const MAX_BYTES = 16 * 1024 * 1024;
  const originalFetch = window.fetch;
  const nativeFetch = originalFetch.bind(window);
  const state = { videoId: '', epoch: 0, tracks: [], records: new Map(), urls: new Map(), panel: null,
    selected: '', busy: false, open: false, ui: null, result: null };
  const stalePanelRoots = new WeakSet();
  const transcriptElements = () => document.querySelectorAll('ytd-transcript-renderer, ytd-transcript-search-panel-renderer, ytd-transcript-segment-list-renderer');
  function invalidatePanelDom() {
    for (const element of transcriptElements()) if (element.data && typeof element.data === 'object') stalePanelRoots.add(element.data);
  }
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const videoId = () => {
    const url = new URL(location.href);
    const id = url.pathname === '/watch' ? url.searchParams.get('v') : url.pathname.match(/^\/(?:shorts|live)\/([^/]+)/)?.[1];
    return /^[\w-]{11}$/.test(id || '') ? id : '';
  };
  const player = () => document.querySelector('#movie_player');
  const session = () => ({ videoId: state.videoId, epoch: state.epoch });
  const valid = token => token.videoId === videoId() && token.videoId === state.videoId && token.epoch === state.epoch;
  function assertCurrent(token) { if (!valid(token)) throw new Error('Видео сменилось. Открой меню субтитров для нового ролика.'); }
  function syncVideo() {
    const id = videoId();
    if (id !== state.videoId) {
      if (state.videoId) invalidatePanelDom();
      state.videoId = id;
      state.epoch++;
      state.tracks = [];
      state.urls.clear();
      state.records.clear();
      state.panel = state.result = null;
      state.selected = '';
      if (state.ui) { state.ui.preview.hidden = true; state.ui.preview.value = ''; }
      closePanel();
    }
    if (state.ui) state.ui.host.hidden = !id;
  }
  function requestMeta(input) {
    syncVideo();
    try {
      const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input?.url, location.href);
      if (!state.videoId || url.origin !== location.origin) return null;
      const captions = Core.captionUrl(url.href);
      if (captions && url.searchParams.get('v') === state.videoId && !url.searchParams.has('sq')) {
        rememberUrl(url);
        return { ...session(), type: 'captions', url: url.href };
      }
      if (url.pathname === '/youtubei/v1/get_transcript') {
        invalidatePanelDom();
        state.panel = null;
        return { ...session(), type: 'panel' };
      }
    } catch { /* A malformed or unrelated request belongs to the page, not to this script. */ }
    return null;
  }
  function rememberUrl(url) {
    if (url.origin !== location.origin || url.searchParams.get('v') !== state.videoId || url.searchParams.has('sq')) return;
    const key = Core.identity(url);
    const list = state.urls.get(key) || [];
    state.urls.set(key, [url.href, ...list.filter(s => s !== url.href)].slice(0, 3));
  }
  function capture(meta, body) {
    if (!meta || !valid(meta) || typeof body === 'string' && body.length > MAX_BYTES) return;
    try {
      if (meta.type === 'captions') {
        const cues = Core.parseCaptions(body, DOMParser);
        if (!cues.length) return;
        const url = Core.captionUrl(meta.url);
        if (!url) return;
        const record = { cues, language: url.searchParams.get('tlang') || url.searchParams.get('lang') || 'не указан',
          source: 'субтитры плеера', url: url.href };
        state.records.set(Core.identity(url), record);
      } else {
        const result = Core.fromTranscript(typeof body === 'string' ? JSON.parse(body) : body);
        if (result.cues.length && !result.incomplete) state.panel = { ...result, source: 'расшифровка YouTube' };
      }
    } catch { /* Never let a decoding error affect YouTube playback. */ }
  }

  // Observe only caption/transcript responses. Keep the original response and rejection semantics.
  window.fetch = function (...args) {
    let meta;
    try { meta = requestMeta(args[0]); } catch { /* page request still runs */ }
    const promise = Reflect.apply(originalFetch, this, args);
    if (meta) promise.then(response => {
      if (response.ok && Number(response.headers.get('content-length') || 0) <= MAX_BYTES) {
        response.clone().text().then(body => capture(meta, body)).catch(() => {});
      }
    }).catch(() => {});
    return promise;
  };
  const xhrMeta = new WeakMap();
  const xhrOpen = XMLHttpRequest.prototype.open;
  const xhrSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (...args) {
    try { xhrMeta.set(this, requestMeta(String(args[1]))); } catch { xhrMeta.delete(this); }
    return Reflect.apply(xhrOpen, this, args);
  };
  XMLHttpRequest.prototype.send = function (...args) {
    const meta = xhrMeta.get(this);
    if (meta) this.addEventListener('load', () => {
      try {
        if (this.status >= 200 && this.status < 300) {
          if (this.responseType === 'json') capture(meta, this.response);
          else if (!this.responseType || this.responseType === 'text') capture(meta, this.responseText);
        }
      } catch { /* Leave the player's request untouched. */ }
    }, { once: true });
    return Reflect.apply(xhrSend, this, args);
  };

  function responseData() {
    let response;
    try { response = player()?.getPlayerResponse?.(); } catch { /* Try initial response below. */ }
    if (response?.videoDetails?.videoId === state.videoId) return response;
    const initial = window.ytInitialPlayerResponse;
    if (initial?.videoDetails?.videoId === state.videoId) return initial;
    return null;
  }
  function discover() {
    syncVideo();
    const response = responseData();
    const rawTracks = response?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
    const tracks = new Map();
    for (const raw of rawTracks) {
      const url = Core.captionUrl(raw.baseUrl);
      if (!url || url.origin !== location.origin || url.searchParams.get('v') !== state.videoId) continue;
      const key = Core.identity(url);
      tracks.set(key, { key, raw, url: url.href, code: raw.languageCode || url.searchParams.get('lang'),
        label: `${Core.textOf(raw.name) || raw.languageCode}${raw.kind === 'asr' ? ' · авто' : ''}` });
    }
    for (const [key, urls] of state.urls) {
      if (tracks.has(key)) continue;
      const url = Core.captionUrl(urls[0]);
      const source = url.searchParams.get('lang') || '?';
      const translation = url.searchParams.get('tlang');
      const code = translation || source;
      let name = code;
      try { name = new Intl.DisplayNames(['ru'], { type: 'language' }).of(code) || code; } catch { /* keep language code */ }
      tracks.set(key, { key, url: url.href, code, raw: null,
        label: `${name}${translation ? ` · перевод с ${source}` : url.searchParams.get('kind') === 'asr' ? ' · авто' : ''}` });
    }
    state.tracks = [...tracks.values()];
    if (!state.selected || state.selected !== PANEL && !tracks.has(state.selected)) {
      const preferred = state.tracks.find(t => t.code === 'ru' && t.raw?.kind !== 'asr') || state.tracks.find(t => /^ru\b/.test(t.code)) || state.tracks[0];
      state.selected = preferred?.key || PANEL;
    }
    return response;
  }
  function scanLoadedUrls() {
    try {
      for (const entry of performance.getEntriesByType('resource')) {
        const url = Core.captionUrl(entry.name);
        if (url) rememberUrl(url);
      }
    } catch { /* Resource timings are an optional fallback for an already-open page. */ }
  }
  function status(text, error = false) {
    if (!state.ui) return;
    state.ui.status.textContent = text;
    state.ui.status.dataset.error = String(error);
  }
  function renderTracks() {
    const ui = state.ui;
    if (!ui) return;
    ui.language.replaceChildren();
    for (const track of state.tracks) ui.language.add(new Option(track.label, track.key));
    ui.language.add(new Option('Из расшифровки YouTube · язык её панели', PANEL));
    ui.language.value = state.selected;
    ui.title.textContent = responseData()?.videoDetails?.title || document.title.replace(/\s*[-–] YouTube$/, '') || 'Видео YouTube';
  }
  async function fetchCaption(urlValue, token) {
    assertCurrent(token);
    const url = Core.captionUrl(urlValue);
    if (!url || url.origin !== location.origin || url.searchParams.get('v') !== token.videoId) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 7000);
    try {
      const response = await nativeFetch(url.href, { credentials: 'same-origin', signal: controller.signal });
      if (!response.ok || Number(response.headers.get('content-length') || 0) > MAX_BYTES) return null;
      const body = await response.text();
      assertCurrent(token);
      if (body.length > MAX_BYTES) return null;
      const cues = Core.parseCaptions(body, DOMParser);
      if (!cues.length) return null;
      const result = { cues, language: url.searchParams.get('tlang') || url.searchParams.get('lang') || '?', source: 'субтитры YouTube' };
      state.records.set(Core.identity(url), result);
      return result;
    } catch (error) {
      assertCurrent(token);
      return null;
    } finally { clearTimeout(timer); }
  }
  async function viaPlayer(track, token) {
    const api = player();
    if (!track.raw || typeof api?.setOption !== 'function' || typeof api?.getOption !== 'function') return null;
    let previous, switched = false;
    try {
      previous = api.getOption('captions', 'track');
      // If the current state cannot be read, do not change the player's settings.
      if (previous === undefined && document.querySelector('.ytp-subtitles-button')?.getAttribute('aria-pressed') !== 'false') return null;
      previous = JSON.parse(JSON.stringify(previous || {}));
      const target = { languageCode: track.raw.languageCode, kind: track.raw.kind || '', vssId: track.raw.vssId || '' };
      api.loadModule?.('captions');
      await sleep(150);
      assertCurrent(token);
      api.setOption('captions', 'track', target);
      switched = true;
      const tried = new Set();
      for (let i = 0; i < 32; i++) {
        await sleep(250);
        assertCurrent(token);
        const record = state.records.get(track.key);
        if (record) return record;
        const urls = state.urls.get(track.key);
        if (urls?.length && urls[0].includes('pot=') && !tried.has(urls[0])) {
          tried.add(urls[0]);
          const result = await fetchCaption(urls[0], token);
          if (result) return result;
        }
      }
      return null;
    } catch (error) {
      assertCurrent(token);
      return null;
    } finally {
      if (switched && valid(token)) {
        try {
          const current = api.getOption('captions', 'track');
          // Restore only our own selection, preserving a manual change made by the viewer.
          if (current?.languageCode === track.raw.languageCode && (current?.kind || '') === (track.raw.kind || '')) {
            api.setOption('captions', 'track', previous);
          }
        } catch { /* Player navigation/teardown can remove the captions module. */ }
      }
    }
  }
  async function loadTrack(track, token) {
    const cached = state.records.get(track.key);
    if (cached) return cached;
    status('Получаю субтитры…');
    const candidates = [...(state.urls.get(track.key) || [])];
    const base = Core.captionUrl(track.url);
    base.searchParams.set('fmt', 'json3');
    candidates.push(base.href);
    for (const url of [...new Set(candidates)].slice(0, 3)) {
      const result = await fetchCaption(url, token);
      if (result) return result;
    }
    status('Запрашиваю дорожку через плеер. Субтитры могут ненадолго включиться…');
    const result = await viaPlayer(track, token);
    if (result) return result;
    throw new Error('YouTube не отдал текст этой дорожки. Включи CC на плеере, выбери нужный язык и повтори скачивание. Можно также выбрать «Из расшифровки YouTube».');
  }
  function panelData() {
    if (state.panel) return state.panel;
    for (const element of transcriptElements()) {
      if (!element.data || stalePanelRoots.has(element.data)) continue;
      const result = Core.fromTranscript(element.data);
      if (result.cues.length && !result.incomplete) return { ...result, source: 'расшифровка YouTube' };
    }
    return null;
  }
  function transcriptButton() {
    return Array.from(document.querySelectorAll('ytd-video-description-transcript-section-renderer button, #description button, #description ytd-button-renderer'))
      .find(el => /показать текст видео|show transcript|текст видео|transkript anzeigen|mostrar transcripci[oó]n|afficher la transcription/i.test(el.textContent || '') && el.getClientRects().length);
  }
  async function loadPanel(token) {
    let result = panelData();
    if (result) return result;
    status('Открываю расшифровку YouTube…');
    let button = transcriptButton();
    if (!button) {
      const expand = document.querySelector('#description-inline-expander #expand, ytd-text-inline-expander #expand');
      if (expand?.getClientRects().length) expand.click();
      await sleep(350);
      assertCurrent(token);
      button = transcriptButton();
    }
    if (button) button.click();
    else throw new Error('У этого видео не найдена расшифровка. Если в меню CC нет языков, скачать субтитры нельзя: YouTube их не предоставляет. Если «Показать текст видео» есть в описании — открой его вручную и повтори.');
    for (let i = 0; i < 40; i++) {
      await sleep(250);
      assertCurrent(token);
      result = panelData();
      if (result) return result;
    }
    throw new Error('Расшифровка не загрузилась полностью. Открой «Показать текст видео» в описании ролика, дождись текста и повтори. Пустой или неполный файл не сохранён.');
  }
  function setBusy(value) {
    state.busy = value;
    if (!state.ui) return;
    for (const element of [state.ui.language, state.ui.format, state.ui.download, state.ui.copy, state.ui.refresh]) element.disabled = value;
    state.ui.download.textContent = value ? 'Загрузка…' : '↓ Скачать';
  }
  async function run(copy = false) {
    if (state.busy) return;
    discover();
    const token = session();
    const selected = state.selected;
    const type = state.ui.format.value;
    setBusy(true);
    try {
      assertCurrent(token);
      const response = responseData();
      if (response?.videoDetails?.isLive || response?.microformat?.playerMicroformatRenderer?.liveBroadcastDetails?.isLiveNow) {
        throw new Error('Идёт прямой эфир. Полные субтитры можно скачать после его завершения и обработки YouTube.');
      }
      const track = state.tracks.find(t => t.key === selected);
      const result = selected === PANEL ? await loadPanel(token) : track ? await loadTrack(track, token) : null;
      assertCurrent(token);
      if (!result?.cues.length) throw new Error('Субтитры пока не найдены. Нажми «Обновить список» после загрузки видео.');
      const title = responseData()?.videoDetails?.title || document.title.replace(/\s*[-–] YouTube$/, '');
      const language = result.language || (track?.label ?? 'язык панели YouTube');
      const text = Core.format(result.cues, type, { title, language, url: `https://www.youtube.com/watch?v=${token.videoId}` });
      state.result = result;
      state.ui.preview.hidden = false;
      state.ui.preview.value = text;
      if (copy) {
        try { await navigator.clipboard.writeText(text); status(`Скопировано · фрагментов: ${result.cues.length} · ${language}`); }
        catch { state.ui.preview.focus(); state.ui.preview.select(); status('Текст выделен ниже. Нажми ⌘C на Mac или Ctrl+C на Windows.'); }
      } else {
        const name = Core.filename(title, token.videoId, track?.code || 'transcript', type);
        const blob = new Blob(['\uFEFF', text], { type: type === 'vtt' ? 'text/vtt;charset=utf-8' : 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = name;
        link.hidden = true;
        document.documentElement.append(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 60000);
        status(`Передано в загрузки Chrome · фрагментов: ${result.cues.length} · ${language}`);
      }
    } catch (error) { if (valid(token)) status(error?.message || 'Не удалось получить субтитры. Повтори после перезагрузки страницы.', true); }
    finally { setBusy(false); }
  }
  function closePanel() {
    state.open = false;
    if (state.ui) { state.ui.panel.hidden = true; state.ui.launch.setAttribute('aria-expanded', 'false'); }
  }
  function togglePanel() {
    if (state.open) { closePanel(); return; }
    discover();
    scanLoadedUrls();
    discover();
    renderTracks();
    state.open = true;
    state.ui.panel.hidden = false;
    state.ui.launch.setAttribute('aria-expanded', 'true');
    status(state.tracks.length ? 'Выбери язык и формат. TXT — текст, SRT/VTT — субтитры с таймкодами.' : 'Дорожки субтитров пока не найдены. Можно попробовать экспорт расшифровки YouTube.');
    state.ui.language.focus();
  }
  function mount() {
    if (!document.documentElement || state.ui) return;
    const host = document.createElement('div');
    host.id = HOST_ID;
    host.style.cssText = 'position:fixed;right:20px;bottom:22px;z-index:2147483000;color-scheme:dark;';
    const root = host.attachShadow({ mode: 'open' });
    // This template is static. All page titles, language names and captions use textContent/value.
    root.innerHTML = `
      <style>
        :host{all:initial;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#f5f5f5;color-scheme:dark}
        *{box-sizing:border-box} [hidden]{display:none!important}
        button,select,textarea{font:inherit} button{cursor:pointer;color:inherit;border:1px solid #555;background:#303030;border-radius:10px;padding:9px 13px}
        button:hover{background:#424242}button:focus-visible,select:focus-visible,textarea:focus-visible{outline:2px solid #8bbcff;outline-offset:2px}
        button:disabled,select:disabled{opacity:.55;cursor:wait}
        #launch{float:right;background:#242424;box-shadow:0 4px 18px #0005;font-weight:600}
        #panel{position:absolute;bottom:53px;right:0;width:min(420px,calc(100vw - 32px));max-height:calc(100dvh - 110px);overflow:auto;padding:20px;border:1px solid #555;border-radius:16px;background:#202020;box-shadow:0 14px 60px #0009}
        header{display:flex;align-items:center;justify-content:space-between;gap:10px}h2{font-size:18px;margin:0}#close{border:0;background:transparent;font-size:22px;padding:0 7px}
        #title{color:#bfbfbf;font-size:12px;max-height:54px;overflow:hidden;margin:8px 0 16px}
        label{display:block;font-size:12px;color:#ccc;margin:11px 0 5px}select{width:100%;border:1px solid #555;border-radius:8px;background:#303030;color:#fff;padding:10px}
        .row{display:flex;gap:8px;margin-top:15px}.row button{flex:1}#download{background:#e8e8e8;color:#151515;border-color:#e8e8e8;font-weight:650}#download:hover{background:white}
        #status{margin:14px 0 8px;color:#c6d8ee;white-space:pre-line;font-size:13px;overflow-wrap:anywhere}#status[data-error=true]{color:#ffb5a9}
        #refresh{font-size:12px;padding:4px 0;border:0;background:none;color:#a6c9ff}
        #preview{display:block;width:100%;height:150px;resize:vertical;margin:10px 0;border:1px solid #555;border-radius:8px;padding:9px;background:#151515;color:#eee;font-size:12px}
        .note{color:#aaa;font-size:11px;margin:10px 0 0}
        @media(max-width:500px){:host{font-size:13px}#panel{padding:16px}}
      </style>
      <section id="panel" role="dialog" aria-labelledby="heading" hidden>
        <header><h2 id="heading">Скачать субтитры</h2><button id="close" type="button" aria-label="Закрыть">×</button></header>
        <p id="title"></p>
        <label for="language">Язык / источник</label><select id="language"></select>
        <label for="format">Формат файла</label><select id="format">
          <option value="txt">TXT — только текст</option><option value="timed">TXT — текст с таймкодами</option>
          <option value="srt">SRT — субтитры для плеера</option><option value="vtt">VTT — субтитры для веба</option>
        </select>
        <div class="row"><button id="download" type="button">↓ Скачать</button><button id="copy" type="button">Копировать</button></div>
        <p id="status" role="status" aria-live="polite"></p>
        <button id="refresh" type="button">Обновить список</button>
        <textarea id="preview" readonly aria-label="Текст подготовленного файла" hidden></textarea>
        <p class="note">Скачиваются готовые субтитры YouTube, включая автоматические. Скрипт не распознаёт аудио. Для перевода выбери язык в панели YouTube и экспорт из расшифровки.</p>
      </section>
      <button id="launch" type="button" aria-controls="panel" aria-expanded="false">↓ Субтитры</button>`;
    const ui = { host, root };
    for (const id of ['panel', 'launch', 'close', 'title', 'language', 'format', 'download', 'copy', 'status', 'refresh', 'preview']) ui[id] = root.getElementById(id);
    state.ui = ui;
    ui.launch.addEventListener('click', togglePanel);
    ui.close.addEventListener('click', () => { closePanel(); ui.launch.focus(); });
    ui.language.addEventListener('change', () => { state.selected = ui.language.value; ui.preview.hidden = true; status('Язык выбран. Нажми «Скачать» или «Копировать».'); });
    ui.format.addEventListener('change', () => { ui.preview.hidden = true; });
    ui.download.addEventListener('click', () => run());
    ui.copy.addEventListener('click', () => run(true));
    ui.refresh.addEventListener('click', () => { discover(); scanLoadedUrls(); discover(); renderTracks(); status(`Найдено дорожек: ${state.tracks.length}.`); });
    root.addEventListener('keydown', event => { if (event.key === 'Escape') { event.stopPropagation(); closePanel(); ui.launch.focus(); } });
    document.addEventListener('pointerdown', event => { if (state.open && !event.composedPath().includes(host)) closePanel(); }, true);
    document.documentElement.append(host);
    syncVideo();
  }
  syncVideo();
  if (document.documentElement) mount();
  else document.addEventListener('DOMContentLoaded', mount, { once: true });
  for (const name of ['yt-navigate-finish', 'yt-page-data-updated', 'popstate']) window.addEventListener(name, syncVideo);
  // Covers Shorts and navigation variants that do not emit YouTube's custom events.
  setInterval(syncVideo, 1800);
})();
