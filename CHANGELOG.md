# Changelog

## 1.4.0 — Apple-style UI, streaming, measured Gemini defaults

- **Streaming**: the service worker reads SSE from CLIProxyAPI and pushes each finished fragment to the tab (`VIWEB_PARTIAL`) so text appears while the batch is still generating. A broken stream keeps the fragments already received and re-requests only the missing ones. Falls back to plain JSON if the proxy does not stream. Toggle: Options → Hiệu năng → Streaming.
- **Priority scheduling**: viewport batches (priority 0) overtake prefetch batches; idle timeout re-armed on every chunk.
- **Defaults chosen from live benchmarks** (see `docs/BENCHMARK.md`): model `gemini-3-flash` (no thinking), fallback `gemini-3.5-flash-lite`. `gemini-3.8-flash(low)` is **not** a valid CLIProxyAPI model id; effort is a suffix on a registered id, e.g. `gemini-3.8-flash-high(low)`.
- **Prompt fix**: faster Gemini models were returning ~55% of English/mixed fragments untranslated; the prompt now explicitly requires translating every non-Vietnamese fragment.
- New Apple-style UI (light/dark, SF font stack, grouped rows, segmented control, switches, focus rings, reduced-motion/forced-colors support) for popup and options.
- Gemini preset: 8 parallel, 16 items / 4800 chars per batch, 6-item first batch.
- Tests: `tests/stream_smoke.py`, extended `background_smoke.js`, live tools `tests/live_e2e.js` and `tests/effort_probe.js` (read the key from `.env.local`, which is git-ignored).

## 1.3.0 — Gemini-optimized pipeline

- Compact JSON protocol (`{"1":"vi",...}`) with partial results: only missing IDs are re-requested; failed batches are split in halves and translated in parallel. Context is sent only for short items. A custom prompt keeps the legacy array protocol.
- Global scheduler with AIMD concurrency: HTTP 429 halves concurrency and honors `Retry-After`; it grows back after successes, up to the preset ceiling.
- Optional fallback models (cooldown per model) for 429/model errors.
- Request cancellation when the page/frame changes (`VIWEB_CANCEL`).
- Request shaping: temperature 0.1, bounded `max_tokens`, `response_format: json_object`; automatically retried without these params if the proxy rejects them.
- Adaptive batches: small first batch for the viewport, large batches for prefetch; retry of missing/failed fragments.
- New short prompt with Vietnamese style rules and few-shot example.
- API metrics (p50/p95, 429, fallbacks, cache hit, tokens) in Options and the popup; time-to-first-translation.
- New **Gemini** preset, model list button (`/models`), fallback-models field.
- Cache is LRU-ish and namespaced as v3: the existing translation cache is invalidated on upgrade. Settings are preserved.
- Added `tests/bench.js` (real CLIProxyAPI benchmark) and `CHROMIUM_PATH` env var for Playwright tests.

## 1.2.1 — Popup, input labels and iframe support

- Enable content script in permitted iframes; inherit opt-in for same-site and same-origin inherited frames.
- Translate dynamically created modal text, button labels, placeholder/title/aria-label without reading input values.
- Fix attribute translation validation to accept attributes tracked in `attributeStates` (instead of rejecting because they are not in `states`).
- Keep third-party frames opt-in by host for privacy.
- Add real Chromium regression test for popup/buttons/attributes/form data preservation.

## 1.2.0 — Persistent website allowlist and autosave

- Three global modes: **All websites**, **Selected websites**, **Off all**.
- Fix: previously global `enabled:false` made individually enabled sites ineffective even though `siteModes` was saved.
- Migrate existing global Off settings to Selected websites while retaining previous `siteModes` entries.
- Manage saved auto-translation domains with add/remove in Settings. Popup enables/disables the active domain and persists the override.
- Turning a site on while in Off all selects the **Selected websites** mode, instead of silently leaving it inactive.
- Performance preset, API parameters, prompt and exclusions auto-save; explicit **Lưu hiệu năng** also available.
- App stays Auto Detect → Vietnamese with CLIProxyAPI at `127.0.0.1:8317/v1` by default.
- Added Node-based persistence/policy tests; Chromium test remains environment-dependent.

# Changelog

## v1.1.0 — initial standalone package

- Mặc định Auto Detect → Vietnamese, prompt dịch chuyên biệt.
- Endpoint EasyCLIProxyAPI `127.0.0.1:8317/v1`, model ID có cấu hình Thinking Low ở dạng hậu tố (phụ thuộc proxy).
- API Key nhập một lần, không nhúng bí mật vào source; Settings và nút Test Connection.
- Không chèn toolbar vào webpage; popup có nút tắt riêng domain/hiện bản gốc và độ trễ batch gần nhất.
- Batch, prefetch viewport, MutationObserver, IntersectionObserver, khôi phục DOM, cache IndexedDB, coalescing các request trùng.
- Sửa giới hạn worker: config 4–8 không còn bị hard-cap ở 3 trong content script.
- Skip text ẩn, editable, code, input, SVG, media, script; tránh thay HTML container.
- Bổ sung test DOM, mock API và UI; hiện chưa có thử nghiệm Brave end-to-end với CLIProxyAPI thật.

## 1.2.1 – Popup & iframe support
- Inject into all permitted frames; same-site login frames inherit top-site opt-in.
- Translate button text, visible placeholders, title and aria-label without accessing input values.
- Recheck attribute updates and preserve UI elements while translating.
- External third-party iframes require an explicit site allowlist entry.
