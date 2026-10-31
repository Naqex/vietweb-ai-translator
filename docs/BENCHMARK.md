# Benchmark Gemini qua CLIProxyAPI thật

Đo bằng `tests/live_e2e.js`: chạy **`background.js` thật** (scheduler, streaming, parser) với CLIProxyAPI thật, mô phỏng một trang 60 đoạn (Trung/Anh/slang/code/giá/URL) chia batch như content script: batch đầu 6 đoạn (ưu tiên viewport) + các batch 16 đoạn. 3 vòng/model, cache xoá giữa các vòng, song song 8, streaming bật. Một máy, một thời điểm — số tuyệt đối thay đổi theo tải proxy; dùng để so sánh tương đối.

## Cách hoạt động của effort (CLIProxyAPI + Antigravity)

- `model(level)` — proxy tách hậu tố, quy ra thinking budget: `minimal`≈512, `low`≈1024, `medium`≈8192, `high`≈24576, `xhigh`≈32768, `auto`=động, `none`=0 (hoặc số token). Hậu tố chỉ áp lên **model id đã đăng ký** trong `/v1/models`. Vì vậy `gemini-3.8-flash(low)` lỗi `unknown provider`, còn `gemini-3.8-flash-high(low)` hợp lệ (`-high` là một biến thể id của Antigravity, vẫn nhận hậu tố effort).
- Gửi `reasoning_effort` trong body cho kết quả tương đương `(high)`.
- Đo thực tế (`tests/effort_probe.js`, câu đố cần suy luận):

| Model | Mặc định | none / minimal | low | high |
|---|---|---|---|---|
| gemini-3-flash | 0 token thinking, 1.5s | 0 token, 0.9–1.4s | ~240 token, 1.2s | ~450 token, 2.3s |
| gemini-3.1-flash-lite | 0, 1.5s | none=0 / minimal≈270 | ~240, 1.5s | ~470, 2.1s |
| gemini-3.5-flash-lite | 0, 1.3s | luôn ≥250 token | ~270, 1.6s | ~490, 1.9s |
| gemini-3.8-flash-high | ~110 token, 2.5s | ~75 token, 2.5s | ~75, 2.4s | ~330, 4.5s (xhigh 6.5s) |

→ Với dịch thuật, **không cần thinking**: mặc định của `gemini-3-flash` đã tắt thinking và nhanh nhất.

## Kết quả dịch (60 đoạn × 3 vòng)

| Model | Trang p50 (s) | Chữ đầu tiên (s) | items/s | Giữ code/số/URL | Bỏ sót dịch* |
|---|---|---|---|---|---|
| **gemini-3-flash** | 3.74 | **0.79** | **16.3** | 100% | 0 |
| gemini-3-flash(low) | 3.46 | 0.82 | 16.3 | 100% | 13 đoạn |
| gemini-3.1-flash-lite | 3.94 | 0.84 | 14.4 | 100% | 0 |
| gemini-3.5-flash-lite | 3.98 | 0.83 | 15.0 | 100% | 0 |
| gemini-3.8-flash-high(none) | 5.57 | 2.13 | 10.9 | 100% | 0 |
| gemini-3.8-flash-high(low) | 5.25 | 1.95 | 10.6 | 100% | 0 |
| gemini-3.8-flash-high(medium) | 14.36 | 2.16 | 4.0 | 97% | 0 |

\* số đoạn không phải tiếng Việt (còn nguyên tiếng Anh/Trung) sau khi dịch. Số "bỏ sót" được đo bằng prompt đã sửa; với prompt cũ, mọi model trừ 3.8 bỏ sót ~55%.

## Streaming & song song (gemini-3-flash)

| Cấu hình | Trang p50 | Chữ đầu tiên |
|---|---|---|
| Streaming tắt | 9.03s | 1.59s |
| **Streaming bật** | **3.74s** | **0.79s** |
| Song song 2 / 4 / 8 | 6.1s / 3.7s / 3.8s | — |

Trang thử chỉ có ~5 batch nên 4 và 8 ngang nhau; trang dài hơn hưởng lợi từ 8. AIMD tự giảm khi gặp 429.

## Ưu / nhược và lý do chọn

| Model | Ưu | Nhược |
|---|---|---|
| **gemini-3-flash** ✅ chọn | Nhanh nhất, chữ đầu 0.8s, dịch tự nhiên (slang diễn đàn tốt), giữ code/URL, không thinking nên tốn ít quota | Thỉnh thoảng giữ nguyên vài từ (vd "Warning:") |
| gemini-3-flash(low) | Tương đương tốc độ | Thêm thinking nhưng **bỏ sót nhiều hơn** → không đáng |
| gemini-3.1-flash-lite | Rẻ quota, nhanh | Chậm hơn chút; thỉnh thoảng thiếu 1–2 đoạn/batch |
| gemini-3.5-flash-lite ✅ dự phòng | Ổn định, đủ 100%, tốc độ sát 3-flash | Văn phong kém tự nhiên hơn một chút |
| gemini-3.8-flash-high(none/low) | Tuân thủ chỉ dẫn tốt nhất, văn phong tinh tế | Chậm gấp ~1.5×, chữ đầu 2s; luôn thinking |
| gemini-3.8-flash-high(medium+) | Chất lượng cao nhất | Quá chậm (14s/trang) cho dịch trang |

**Quyết định:** `gemini-3-flash` làm model chính, `gemini-3.5-flash-lite` dự phòng (429/hết quota). Muốn văn phong tốt nhất, chấp nhận chậm hơn: `gemini-3.8-flash-high(low)`.

## Dịch ảnh (thăm dò `tests/media_probe.py`)

Một ảnh 800×450 có chữ, một lời gọi trả về `box_2d` ([ymin,xmin,ymax,xmax], thang 0–1000), chữ gốc và bản dịch. Mọi model Gemini thử đều nhận `image_url` (data URL) và trả vị trí đúng.

| Model | Độ trễ | Nhận xét |
|---|---|---|
| `gemini-3-flash` | ~1,5 s | Đúng toàn bộ, dịch cả đơn vị tiền tệ — **mặc định** |
| `gemini-3.5-flash-lite` | ~1,5 s | Đúng, dự phòng |
| `gemini-3.1-flash-lite` | ~1,5 s | Nhanh nhưng để nguyên "yuan" |
| `gemini-3.8-flash-high` | ~5,8 s | Chậm hơn ~4 lần, cũng để nguyên "yuan" |

Chi phí ≈ 1.150 token đầu vào cho ảnh 800×450. Cache theo nội dung ảnh nên ảnh lặp lại tốn 0 token. YouTube `timedtext` gọi trực tiếp trả 0 byte (cần `pot`), nên extension nghe response của chính trình phát.

## Chạy lại

```
copy .env.example .env.local        # điền VIWEB_KEY
node tests/live_e2e.js gemini-3-flash gemini-3.5-flash-lite
node tests/effort_probe.js
```

Giới hạn: chất lượng dịch do người đánh giá đọc mẫu (+ kiểm tra tự động: giữ code/số/URL, còn chữ Trung, còn không phải tiếng Việt); chưa chạy trên Brave thật.
