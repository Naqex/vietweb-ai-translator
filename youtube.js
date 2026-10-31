/* VietWeb AI — YouTube subtitle translation (v1.5).
 * Captures the caption track the player loads (via youtube_main.js), translates a sliding window ahead of the
 * playhead through the normal cached pipeline, and draws its own overlay. Falls back to translating the live
 * on-screen caption text if no track can be captured. */
(() => {
  'use strict';
  const M = globalThis.VIWEB_MEDIA;
  if (!M || window.__vietwebYoutube) return;
  window.__vietwebYoutube = true;

  const BATCH_CUES = 16, BATCH_CHARS = 1600, MAX_INFLIGHT = 3, MAX_TRIES = 3, BEHIND = 5;
  let conf = {...M.DEFAULTS};
  let gen = 0, videoId = '', track = null, cues = [], inflight = 0, pumpAt = 0, ccAskedFor = '';
  let lastData = null, video = null, overlay = null, lastKey = '', liveText = '', noTrackSince = 0;
  const live = new Map();

  const STYLE_ID = 'viweb-yt-style';
  const CSS = `
    :host{all:initial}
    .wrap{position:absolute;left:0;right:0;display:flex;flex-direction:column;align-items:center;gap:.18em;
      text-align:center;pointer-events:none;padding:0 6%;transition:bottom .2s ease;
      font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif}
    .line{max-width:100%;padding:.12em .55em;border-radius:.5em;background:rgba(18,18,20,.72);color:#fff;
      -webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px);line-height:1.35;white-space:pre-wrap;
      text-shadow:0 1px 2px rgba(0,0,0,.45)}
    .vi{font-weight:600}
    .src{opacity:.72;font-size:.74em}
    .pending{opacity:.6}`;

  const active = () => M.allowed(conf, location.hostname) && conf.youtubeMode !== 'off' && conf.visualMode !== 'original';
  const player = () => document.getElementById('movie_player') || document.querySelector('.html5-video-player');
  const getVideo = () => document.querySelector('video.html5-main-video') || document.querySelector('video');
  function currentVideoId() {
    try {
      const url = new URL(location.href);
      if (url.searchParams.get('v')) return url.searchParams.get('v');
      const m = url.pathname.match(/^\/(?:embed|shorts|live)\/([\w-]{6,})/);
      return m ? m[1] : '';
    } catch { return ''; }
  }

  /* ---------- caption parsing ---------- */
  const decode = text => text.replace(/&amp;#39;|&#39;/g, "'").replace(/&amp;quot;|&quot;/g, '"').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
  function parseCues(body) {
    const out = [];
    const trimmed = body.trim();
    if (trimmed.startsWith('{')) {
      let json;
      try { json = JSON.parse(trimmed); } catch { return out; }
      for (const e of json.events || []) {
        if (!Array.isArray(e.segs)) continue;
        const text = decode(e.segs.map(s => s.utf8 || '').join(''));
        if (!text) continue;
        const start = (e.tStartMs || 0) / 1000;
        out.push({start, end: start + (e.dDurationMs || 2000) / 1000, text});
      }
    } else if (trimmed.startsWith('<')) {
      const xml = new DOMParser().parseFromString(trimmed, 'text/xml');
      for (const p of xml.getElementsByTagName('p')) {
        const text = decode(p.textContent || '');
        if (!text) continue;
        const start = (Number(p.getAttribute('t')) || 0) / 1000;
        out.push({start, end: start + (Number(p.getAttribute('d')) || 2000) / 1000, text});
      }
      if (!out.length) for (const t of xml.getElementsByTagName('text')) {
        const text = decode(t.textContent || '');
        if (!text) continue;
        const start = Number(t.getAttribute('start')) || 0;
        out.push({start, end: start + (Number(t.getAttribute('dur')) || 2), text});
      }
    }
    out.sort((a, b) => a.start - b.start);
    // Clamp each cue so it never overlaps the next one, and merge consecutive duplicates (ASR rolling lines).
    const merged = [];
    for (const cue of out) {
      const prev = merged[merged.length - 1];
      if (prev && prev.text === cue.text && cue.start <= prev.end + 0.3) { prev.end = Math.max(prev.end, cue.end); continue; }
      merged.push({...cue, vi: '', st: 0, tries: 0, retryAt: 0});
    }
    for (let i = 0; i < merged.length - 1; i++) if (merged[i].end > merged[i + 1].start + 0.05) merged[i].end = Math.max(merged[i].start + 0.4, merged[i + 1].start);
    return merged;
  }

  function onTrack(data) {
    if (data !== lastData) lastData = data;
    if (!active()) return;
    let url;
    try { url = new URL(data.url, location.href); } catch { return; }
    const lang = url.searchParams.get('lang') || '', kind = url.searchParams.get('kind') || '';
    if (url.searchParams.get('tlang') || /^vi(?:-|$)/i.test(lang)) return; // YouTube's own translation / already Vietnamese
    const id = url.searchParams.get('v') || currentVideoId();
    if (currentVideoId() !== videoId) resetForVideo();
    if (id && videoId && id !== videoId) return; // stale response from the previous video
    const key = [id, lang, kind, url.searchParams.get('name') || ''].join('|');
    if (track?.key === key) return;
    const parsed = parseCues(data.body);
    if (!parsed.length) return;
    gen++;
    track = {key, lang, kind};
    cues = parsed;
    inflight = 0;
    liveText = '';
    lastKey = '';
    syncNativeHiding();
    pumpAt = 0;
  }

  /* ---------- translation window ---------- */
  function lowerBound(time) {
    let lo = 0, hi = cues.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (cues[mid].start < time) lo = mid + 1; else hi = mid; }
    return lo;
  }
  function pump() {
    if (!active() || !cues.length || !video || inflight >= MAX_INFLIGHT) return;
    const t = video.currentTime, now = Date.now(), until = t + Math.max(30, Number(conf.youtubeAhead) || 150);
    let i = lowerBound(t - BEHIND - 8);
    while (i > 0 && cues[i - 1].end > t - BEHIND) i--;
    const pending = [];
    for (; i < cues.length && cues[i].start <= until && pending.length < 64; i++) {
      const cue = cues[i];
      if (cue.st === 0 && cue.tries < MAX_TRIES && now >= cue.retryAt) pending.push(i);
    }
    while (pending.length && inflight < MAX_INFLIGHT) {
      const batch = [];
      let chars = 0;
      while (pending.length && batch.length < BATCH_CUES && chars < BATCH_CHARS) { const idx = pending.shift(); batch.push(idx); chars += cues[idx].text.length; }
      run(batch, cues[batch[0]].start - t < 25 ? 0 : 1);
    }
  }
  async function run(batch, priority) {
    const myGen = gen;
    inflight++;
    for (const i of batch) cues[i].st = 1;
    const rows = batch.map(i => ({id: String(i), text: cues[i].text.slice(0, 600), context: i > 0 ? cues[i - 1].text.slice(0, 80) : ''}));
    const res = await M.send({type: 'VIWEB_TRANSLATE', rows, priority, page: {kind: 'video subtitles', lang: track?.lang || '', title: document.title.slice(0, 120)}});
    if (myGen !== gen) return;
    inflight = Math.max(0, inflight - 1);
    const byId = new Map((res?.translations || []).map(x => [String(x.id), x.text]));
    for (const i of batch) {
      const cue = cues[i], text = byId.get(String(i));
      if (typeof text === 'string' && text.trim()) { cue.vi = text.trim(); cue.st = 2; }
      else {
        cue.st = 0;
        if (!res?.cancelled) { cue.tries++; cue.retryAt = Date.now() + 2500 * cue.tries; }
      }
    }
    pumpAt = 0;
  }

  /* ---------- overlay ---------- */
  function ensureOverlay() {
    const host = player();
    if (!host) return null;
    if (overlay && overlay.host.isConnected && overlay.host.parentNode === host) return overlay;
    overlay?.host.remove();
    const {host: el, root} = M.shadowHost(CSS, 'position:absolute;left:0;right:0;top:0;bottom:0;z-index:58;pointer-events:none;');
    const wrap = document.createElement('div');
    wrap.className = 'wrap';
    root.append(wrap);
    host.append(el);
    overlay = {host: el, wrap};
    return overlay;
  }
  function hideOverlay() { if (overlay) { overlay.wrap.textContent = ''; overlay.host.style.display = 'none'; } lastKey = ''; }
  function draw(lines) {
    const o = ensureOverlay(), p = player();
    if (!o || !p) return;
    const key = JSON.stringify([lines, conf.youtubeMode, conf.youtubeSize]);
    o.host.style.display = '';
    const width = p.clientWidth || 640;
    const factor = {small: 0.8, large: 1.3}[conf.youtubeSize] || 1;
    o.wrap.style.fontSize = Math.max(13, Math.min(46, width / 36)) * factor + 'px';
    o.wrap.style.bottom = (p.classList.contains('ytp-autohide') ? '4%' : '14%');
    if (key === lastKey) return;
    lastKey = key;
    o.wrap.textContent = '';
    for (const [text, cls] of lines) {
      const div = document.createElement('div');
      div.className = 'line ' + cls;
      div.textContent = text;
      o.wrap.append(div);
    }
  }
  function render() {
    if (!active()) { hideOverlay(); return; }
    let lines = [];
    if (cues.length && video) {
      const t = video.currentTime;
      let i = lowerBound(t + 0.001) - 1;
      const shown = [];
      for (let n = 0; i >= 0 && n < 6 && shown.length < 2; i--, n++) if (cues[i].end > t) shown.unshift(cues[i]);
      for (const cue of shown) {
        if (conf.youtubeMode === 'bilingual') {
          lines.push([cue.text, 'src']);
          lines.push([cue.vi || cue.text, cue.vi ? 'vi' : 'vi pending']);
        } else lines.push([cue.vi || cue.text, cue.vi ? 'vi' : 'vi pending']);
      }
    } else if (liveText) {
      const vi = live.get(liveText);
      if (conf.youtubeMode === 'bilingual') lines.push([liveText, 'src']);
      lines.push([vi || liveText, vi ? 'vi' : 'vi pending']);
    }
    if (lines.length) draw(lines); else hideOverlay();
  }

  /* ---------- hiding native captions ---------- */
  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = 'html[data-vietweb-yt] .ytp-caption-window-container{visibility:hidden!important}';
    (document.head || document.documentElement).append(style);
  }
  function syncNativeHiding() {
    const on = active() && (cues.length > 0 || Boolean(liveText));
    if (on) { ensureStyle(); document.documentElement.setAttribute('data-vietweb-yt', ''); }
    else document.documentElement.removeAttribute('data-vietweb-yt');
  }

  /* ---------- fallback: translate the caption text the player draws ---------- */
  function pollLive() {
    if (!active() || cues.length) return;
    const text = [...document.querySelectorAll('.ytp-caption-segment')].map(n => n.textContent || '').join(' ').replace(/\s+/g, ' ').trim();
    if (text === liveText) return;
    liveText = text;
    syncNativeHiding();
    if (!text || live.has(text)) return;
    if (live.size > 400) live.delete(live.keys().next().value);
    const myGen = gen;
    M.send({type: 'VIWEB_TRANSLATE', priority: 0, rows: [{id: 'l', text: text.slice(0, 600), context: ''}], page: {kind: 'video subtitles', title: document.title.slice(0, 120)}})
      .then(res => { const vi = res?.translations?.[0]?.text; if (myGen === gen && typeof vi === 'string' && vi) { live.set(text, vi); lastKey = ''; } });
  }

  /* ---------- lifecycle ---------- */
  function resetForVideo() {
    gen++;
    videoId = currentVideoId();
    track = null; cues = []; inflight = 0; liveText = ''; noTrackSince = 0; ccAskedFor = '';
    lastKey = '';
    syncNativeHiding();
    hideOverlay();
  }
  function maybeEnableCaptions() {
    if (!conf.youtubeAutoCC || !active() || cues.length || liveText || !videoId || ccAskedFor === videoId) return;
    const now = Date.now();
    if (!noTrackSince) { noTrackSince = now; return; }
    if (now - noTrackSince < 2500 || !player()) return;
    ccAskedFor = videoId;
    window.postMessage({source: 'viweb-yt-cmd', type: 'enable-cc'}, location.origin);
  }
  let tickN = 0;
  function tick() {
    tickN++;
    if (currentVideoId() !== videoId) resetForVideo();
    video = getVideo();
    if (!video) return;
    render();
    if (tickN % 3 === 0) { pollLive(); maybeEnableCaptions(); }
    const now = Date.now();
    if (now >= pumpAt) { pumpAt = now + 500; pump(); }
  }

  window.addEventListener('message', event => {
    if (event.source !== window || event.origin !== location.origin) return;
    const data = event.data;
    if (data?.source === 'viweb-yt' && data.type === 'track' && typeof data.body === 'string') onTrack(data);
  });
  M.onSettings(async () => {
    conf = await M.load();
    if (!active()) { gen++; cues = []; track = null; liveText = ''; inflight = 0; hideOverlay(); }
    else if (!track && !cues.length) { noTrackSince = 0; if (lastData) onTrack(lastData); }
    syncNativeHiding();
    lastKey = '';
  });
  M.load().then(c => { conf = c; videoId = currentVideoId(); });
  document.addEventListener('yt-navigate-finish', () => { if (currentVideoId() !== videoId) resetForVideo(); });
  videoId = currentVideoId();
  setInterval(tick, 120);
})();
