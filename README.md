# VietWeb AI Translator — CLIProxyAPI

Bản extension **Manifest V3 độc lập**, thiết kế để dịch website từ ngôn ngữ tự nhận diện sang tiếng Việt qua endpoint OpenAI-compatible (mặc định EasyCLIProxyAPI). Không cần npm, build script hay extension phụ.

## Cài Brave / Chrome

1. Giải nén `VietWeb-AI-Translator-v1.6.0.zip` vào một thư mục **cố định**.
2. Mở `brave://extensions` (hoặc `chrome://extensions`), bật **Developer mode**.
3. Chọn **Load unpacked / Tải tiện ích đã giải nén**, trỏ tới thư mục `VietWeb-AI-Translator` **chứa file `manifest.json`**.
4. **Tắt extension dịch cũ** để không dịch trùng và gây đè DOM.
5. Mở **Options / Cài đặt** của VietWeb AI. CLIProxyAPI mặc định: `http://127.0.0.1:8317/v1`.
6. Model mặc định: `gemini-3-flash` (không thinking, nhanh nhất và đủ chất lượng — xem [docs/BENCHMARK.md](docs/BENCHMARK.md)), dự phòng `gemini-3.5-flash-lite`. Tên model phải có trong `/v1/models` của CLIProxyAPI (nút **Tải danh sách model**). Mức *effort* là hậu tố trong ngoặc gắn vào một model id có sẵn: `gemini-3-flash(low)`, `gemini-3.8-flash-high(medium)`… (`none/minimal/low/medium/high/xhigh/auto` hoặc số token). `gemini-3.8-flash(low)` **không** hợp lệ vì `gemini-3.8-flash` không được đăng ký. Dùng preset **Gemini**.
7. Nhập **API Key client của CLIProxyAPI** một lần (để trống nếu proxy cho phép không xác thực). Chọn **Lưu & kiểm tra kết nối**.
8. Tải lại website cần dịch. Trang mới được dịch tự động sang tiếng Việt, ưu tiên vùng nhìn thấy.

## Quản lý tự động dịch theo website (v1.2.0)

Trong **Options → Tự động dịch** có 3 chế độ, tự lưu khi thay đổi:

- **Tất cả website** (mặc định khi cài mới): mọi trang web hợp lệ đều được dịch, ngoại trừ các trang đã loại trừ hoặc đã tắt riêng.
- **Chỉ website đã chọn**: chỉ dịch những domain bạn bật trong popup hoặc thêm trong **Website đã chọn**. Các lựa chọn được lưu vào `chrome.storage.local.siteModes` và hoạt động khi mở lại trình duyệt.
- **Tắt toàn bộ**: dừng tất cả dịch tự động, nhưng **không xóa danh sách domain**. Bật riêng một trang trong popup sẽ tự chuyển sang chế độ "Chỉ website đã chọn".

Khi nâng cấp từ bản cũ, nếu công tắc "Tự dịch website" đã tắt, tiện ích chuyển tương đương sang "Chỉ website đã chọn" để các domain đã bật riêng vẫn hoạt động. `siteModes` được giữ nguyên. Phần **Website đã chọn** cho phép thêm/xóa và xem các domain được phép tự dịch. Domain bị tắt riêng trong chế độ "Tất cả" vẫn được giữ như một ngoại lệ trong `siteModes` dù không xuất hiện trong danh sách cho phép.

**Lưu tự động:** chọn preset Hiệu năng sẽ lưu ngay. Model, API Key, prompt và domain loại trừ lưu sau khi bạn ngừng gõ. Trạng thái lưu được hiển thị ở đầu Settings và trong từng mục liên quan.

**Cập nhật bản mới:** giữ nguyên thư mục đã cài, ghi đè các tệp, vào `brave://extensions` → **Reload**. Cấu hình lưu trong `chrome.storage.local` gắn với ID extension của bản cài. Nếu đổi thư mục/ID hoặc cài như tiện ích mới, có thể phải nhập lại API Key.

## Tính năng

- Mặc định **Auto Detect → Vietnamese**, chế độ Auto.
- Không gắn thanh công cụ vào nội dung trang; bật/tắt riêng từng domain từ popup.
- Dịch theo vùng nhìn thấy và prefetch; nhận diện đoạn mới bằng MutationObserver/IntersectionObserver.
- Batch nhiều đoạn, số API request đồng thời có thể chỉnh bằng các preset Fast/Balanced/Quality.
- Prompt chuyên dụng giữ nguyên tên model, code, thông số, dấu phủ định; xem nội dung website là dữ liệu không đáng tin.
- Giữ liên kết, thẻ HTML và các ô nhập; không sử dụng `innerHTML` để thay thế nội dung website.
- Cache dịch IndexedDB (LRU, mặc định 20.000 mục, tối đa 200.000) để không trả token cho nội dung đã dịch. Khóa gồm model, prompt và văn bản đã chuẩn hoá (bỏ khác biệt khoảng trắng/Unicode, không phụ thuộc endpoint hay ngữ cảnh xung quanh). Đoạn dài ≥100 ký tự dùng chung cho mọi website; đoạn ngắn (nút, nhãn UI) được tách theo website vì nghĩa phụ thuộc ngữ cảnh. Bản "chưa dịch" (model bỏ sót) không bị lưu vào cache. Options → Thống kê hiện số mục cache và ước tính token đã tiết kiệm.
- Có thể hiện bản gốc ngay lập tức mà không gọi lại AI.
- Mọi cấu hình và API Key được lưu **cục bộ** (`chrome.storage.local`), không nhúng vào mã nguồn và không sử dụng analytics.

## Phụ đề YouTube và dịch ảnh (v1.5.0 – v1.6.0)

Cả hai tùy chỉnh đầy đủ trong **Options → Phụ đề YouTube / Dịch chữ trong ảnh**, tự lưu và áp dụng ngay.

- **Phụ đề YouTube**: chế độ *song ngữ / chỉ tiếng Việt / tắt*, cỡ chữ, khoảng dịch trước (60–600 giây), tự bật CC. Chỉ dịch phần sắp xem (cửa sổ trượt) nên tốn rất ít token; xem lại video cũ không tốn token (cache). Video không có phụ đề **không** được hỗ trợ.
- **Dịch ảnh**: *Khi rê chuột* (nút "Dịch ảnh" hiện trên ảnh), *Tự động* (dịch ảnh khi cuộn tới, giới hạn số ảnh/trang), hoặc *Tắt*; thêm menu chuột phải "Dịch ảnh này sang tiếng Việt". Một lời gọi model đa phương thức trả về chữ gốc, vị trí và bản dịch; bản dịch được vẽ đè lên ảnh với màu nền/chữ lấy từ ảnh. Cache theo nội dung ảnh nên cùng một ảnh ở bất kỳ trang nào chỉ tốn token một lần. Có thể đặt model riêng cho ảnh (để trống = dùng danh sách model chung).
- **Riêng tư**: ảnh được gửi (dạng JPEG base64) tới CLIProxyAPI/model upstream khi bạn dịch. Chế độ Tự động gửi nhiều ảnh trên trang bạn đang xem — hãy đặt giới hạn thấp hoặc dùng *Khi rê chuột* trên trang nhạy cảm. Quyền mới: `contextMenus`.
- Chưa kiểm chứng trên YouTube/Brave thật (chỉ trang giả lập bằng Chromium): vị trí overlay so với thanh điều khiển, ASR đặc thù, ảnh có hotlink protection.

## Riêng tư / bảo mật

**Auto trên mọi website** có thể gửi văn bản trang bạn đọc tới CLIProxyAPI và model upstream. Hệ thống đã mặc định loại trừ `mail.google.com`, `accounts.google.com`, `outlook.live.com`, `outlook.office.com` và `localhost`, nhưng đây không phải bộ lọc hoàn chỉnh cho mọi trang nhạy cảm. Thêm ngân hàng, email, nội bộ công ty, ứng dụng riêng tư... vào danh sách loại trừ trong Options. Bạn có thể chủ động bật lại một domain từ popup.

API Key được lưu cục bộ trong vùng lưu trữ extension của trình duyệt; không mã hóa riêng ở cấp ứng dụng. Không chia sẻ profile Brave hay bản sao dữ liệu extension. HTTP chỉ được chấp nhận cho localhost/127.0.0.1; endpoint khác phải dùng HTTPS. Không nhập API Key của dịch vụ trực tiếp vào tiện ích nếu bạn chỉ định dùng key của CLIProxyAPI.

## Giới hạn

- Một vài website có Shadow DOM đóng, canvas, PDF nhúng hoặc giao diện render bằng canvas sẽ không dịch được.
- Bản dịch phụ thuộc model và giới hạn quota của tài khoản nguồn trong CLIProxyAPI.
- Không bảo đảm tốc độ tối đa với mọi model hoặc website. Kiểm tra thống kê trong popup và EasyCLIProxyAPI để đo thực tế.
- Tiện ích độc lập này được viết mới theo các ý tưởng thiết kế chung của extension dịch web; **không phải bản fork đóng gói của LLM Page Translator/DualRead/FluentRead**.
- Đã chạy unit smoke, Chromium DOM/UI smoke (API giả lập) và benchmark end-to-end với CLIProxyAPI thật (xem `docs/BENCHMARK.md`). Chưa xác nhận cài extension thật trên Brave và các trang Goofish/NodeSeek/X.

## Kiểm tra dành cho developer

- `node --check background.js` (và các tệp `.js` khác)
- `node tests/background_smoke.js`
- `python tests/dom_smoke.py`, `stream_smoke.py`, `ui_smoke.py`, … (cần Playwright; trên Windows đặt `CHROMIUM_PATH` tới chrome.exe)
- Benchmark thật: tạo `.env.local` từ `.env.example` (file này bị git bỏ qua) rồi `node tests/live_e2e.js gemini-3-flash gemini-3.5-flash-lite` (chạy `background.js` thật qua proxy thật) và `node tests/effort_probe.js` (kiểm tra effort). Tuỳ chọn: `VIWEB_ROUNDS`, `VIWEB_PARALLEL`, `VIWEB_STREAM=0`, `VIWEB_DUMP=1`.

## v1.4.0

Hiển thị bản dịch theo luồng (streaming), ưu tiên vùng nhìn thấy, giao diện kiểu Apple sáng/tối, mặc định `gemini-3-flash` theo số đo thật. Chi tiết trong CHANGELOG.

## v1.3.0: tối ưu cho Gemini qua CLIProxyAPI

Giao thức JSON gọn, trả kết quả từng phần, tự giảm/tăng song song theo 429, model dự phòng, hủy request khi đổi trang, thống kê p50/p95 (Options/popup). Nâng cấp: ghi đè cùng thư mục rồi **Reload**; cấu hình được giữ, cache dịch bị làm mới. Đã kiểm thử bằng API giả lập; **chưa đo** chất lượng/tốc độ trên CLIProxyAPI thật — hãy chạy `tests/bench.js`.

Gói không gồm dependency runtime từ bên ngoài.


## v1.2.1: Dịch popup và iframe đăng nhập

- Cho phép content script chạy trong iframe (`all_frames` và `match_about_blank`).
- Với iframe cùng website (ví dụ: passport.goofish.com bên trong goofish.com), lấy quyền dịch từ website gốc. Iframe bên thứ ba không liên quan cần được bật riêng để tránh gửi nội dung nhạy cảm.
- Dịch cả nhãn chữ trên nút bấm và một số thuộc tính giao diện (`placeholder`, `title`, `aria-label`), nhưng **không đọc giá trị người dùng nhập vào biểu mẫu**.
- Popup được sinh động bởi React/Vue sẽ được quét nhờ MutationObserver. Không thể dịch nội dung nằm trong ảnh, canvas, browser-native prompts hoặc shadow DOM đóng.
- Để cập nhật mà giữ cấu hình, chép đè nội dung ZIP vào **cùng thư mục** extension trước đó và nhấn Reload tại `brave://extensions`.

- Kiểm thử hồi quy Chromium: modal tạo động, nút bấm, placeholder, title, aria-label, giữ nguyên nội dung nhập liệu và khôi phục bản gốc.
- Cơ chế iframe hạn chế ở iframe cùng website; iframe thuộc domain xác thực bên thứ ba cần được bật riêng. Trang có Shadow DOM đóng hoặc ảnh chứa chữ không thể dịch bằng DOM scanner.
