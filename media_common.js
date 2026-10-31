/* VietWeb AI — helpers shared by the YouTube and image content scripts (same isolated world, loaded idempotently). */
(() => {
  'use strict';
  if (globalThis.VIWEB_MEDIA) return;
  const DEFAULTS = {
    enabled: true, autoMode: 'all', siteModes: {}, visualMode: 'translate',
    excludedDomains: 'mail.google.com\naccounts.google.com\noutlook.live.com\noutlook.office.com\nlocalhost',
    youtubeMode: 'bilingual', youtubeSize: 'medium', youtubeAhead: 150, youtubeAutoCC: true,
    imageMode: 'hover', imageStyle: 'replace', imageMaxSide: 1536, imageMinSize: 160, imageAutoLimit: 12
  };
  async function load() {
    return {...DEFAULTS, ...(await chrome.storage.local.get(null))};
  }
  // Same rules as the page translator: global mode, per-site override, exclusion list.
  function allowed(conf, host) {
    const mode = ['all', 'selected', 'off'].includes(conf.autoMode) ? conf.autoMode : (conf.enabled === false ? 'selected' : 'all');
    if (mode === 'off') return false;
    const site = conf.siteModes?.[host];
    if (site === 'off') return false;
    if (site === 'auto') return true;
    if (mode === 'selected') return false;
    return !(conf.excludedDomains || '').split(/[\n,;]/).map(x => x.trim().toLowerCase().replace(/^\*\./, '')).filter(Boolean)
      .some(rule => host === rule || host.endsWith('.' + rule));
  }
  async function send(message) {
    try { return await chrome.runtime.sendMessage(message); }
    catch (error) { return {ok: false, error: String(error?.message || error)}; }
  }
  function onSettings(callback) {
    chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local') callback(changes); });
  }
  // Shadow-rooted host so page CSS cannot restyle our UI and our CSS cannot leak into the page.
  function shadowHost(css, hostStyle = '') {
    const host = document.createElement('div');
    host.setAttribute('data-vietweb-ui', '');
    host.style.cssText = 'all:initial;' + hostStyle;
    const root = host.attachShadow({mode: 'open'});
    const style = document.createElement('style');
    style.textContent = css;
    root.append(style);
    return {host, root};
  }
  globalThis.VIWEB_MEDIA = {DEFAULTS, load, allowed, send, onSettings, shadowHost};
})();
