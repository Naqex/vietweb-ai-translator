/* VietWeb AI — YouTube page-world hook (v1.5). Runs in the page's own JavaScript world so it can observe the
 * caption requests the player itself makes (those carry YouTube's anti-abuse tokens, which a plain fetch lacks).
 * It only forwards caption payloads to the extension; it never changes requests or responses. */
(() => {
  'use strict';
  if (window.__vietwebYtHook) return;
  window.__vietwebYtHook = true;
  const OUT = 'viweb-yt', IN = 'viweb-yt-cmd';
  const isCaption = url => typeof url === 'string' && /\/api\/timedtext(?:[?/]|$)/.test(url);
  const forward = (url, body) => {
    if (typeof body !== 'string' || !body) return;
    try { window.postMessage({source: OUT, type: 'track', url: String(url), body}, location.origin); } catch {}
  };

  const nativeFetch = window.fetch;
  if (typeof nativeFetch === 'function') {
    window.fetch = function (input, init) {
      const promise = nativeFetch.apply(this, arguments);
      try {
        const url = typeof input === 'string' ? input : (input && input.url) || String(input);
        if (isCaption(url)) {
          promise.then(resp => resp.clone().text().then(text => forward(resp.url || url, text)).catch(() => {})).catch(() => {});
        }
      } catch {}
      return promise;
    };
  }

  const nativeOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    try { this.__vietwebUrl = String(url); } catch {}
    return nativeOpen.apply(this, arguments);
  };
  const nativeSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function () {
    try {
      if (isCaption(this.__vietwebUrl)) {
        this.addEventListener('load', () => {
          if (this.responseType === '' || this.responseType === 'text') forward(this.responseURL || this.__vietwebUrl, this.responseText);
        });
      }
    } catch {}
    return nativeSend.apply(this, arguments);
  };

  // Optional: switch the player's captions on so a track gets requested (the extension asks for it per its settings).
  window.addEventListener('message', event => {
    if (event.source !== window || event.data?.source !== IN) return;
    if (event.data.type !== 'enable-cc') return;
    try {
      const player = document.getElementById('movie_player') || document.querySelector('.html5-video-player');
      if (!player || typeof player.toggleSubtitlesOn !== 'function') return;
      const current = typeof player.getOption === 'function' ? player.getOption('captions', 'track') : null;
      if (current && Object.keys(current).length) return;
      const tracks = typeof player.getOption === 'function' ? player.getOption('captions', 'tracklist') : null;
      if (Array.isArray(tracks) && !tracks.length) return;
      player.toggleSubtitlesOn();
    } catch {}
  });
})();
