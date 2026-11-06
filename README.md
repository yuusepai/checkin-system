# Hệ thống QR Check-in Sự Kiện (Cloudflare Edge + SQLite Durable Objects)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/TakiAcademy-AI/Checkin)

Hệ thống quản lý & điểm danh QR Check-in sự kiện (1 ngày & nhiều ngày) chịu tải **1.000+ khách quét QR cùng lúc** hoàn toàn trên gói **Cloudflare Workers Free (0đ)**.

## Tính năng chính
- **Tạo không giới hạn sự kiện** kèm **Logo & Banner** riêng và tự động sinh **Mã QR Vector (SVG/PNG)**.
- **Check-in 1 ngày hoặc Nhiều ngày:**
  - Mỗi số điện thoại chỉ được điểm danh **1 lần duy nhất trong ngày**.
  - Check lại lần thứ 2 trong ngày sẽ bị chặn ngay lập tức (`Số điện thoại này đã check-in hôm nay rồi!`).
  - Sự kiện nhiều ngày tự động khóa các ngày chưa tới (`Sang ngày tiếp theo mới mở`).
- **Tải lên File Excel động (`.xlsx`, `.xls`, `.csv`):**
  - Tự động giữ nguyên mọi cột trong file Excel của bạn và map toàn bộ thông tin theo **Số điện thoại**.
  - Thông tin khách mời chỉ hiển thị sau khi bấm **Điểm danh / Check-in thành công**.
- **Bảo mật trang Quản trị (`/admin`):**
  - Mật khẩu mặc định: `admin123` (đổi trực tiếp trên giao diện `/admin`).
  - Tự động khóa IP 15 phút nếu nhập sai mật khẩu quá 5 lần (chống Brute-force dò mật khẩu).

---

## 3 Cách Cài Đặt Lên Cloudflare (Tự động tạo Database 100%)

Toàn bộ cấu hình Database (`SQLite Durable Objects` + `Static Assets`) đã được khai báo tự động trong `wrangler.jsonc`, **không cần tạo DB thủ công**.

### Cách 1: Bấm nút 1-Click Deploy (Nhanh nhất)
Bấm nút bên dưới để liên kết tài khoản Cloudflare và tự động cài đặt từ GitHub:

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/TakiAcademy-AI/Checkin)

### Cách 2: Kết nối Git trực tiếp trên Cloudflare Dashboard
1. Đăng nhập [Cloudflare Dashboard](https://dash.cloudflare.com/) $\rightarrow$ **Compute (Workers & Pages)** $\rightarrow$ **Create**.
2. Chọn **Import a repository** $\rightarrow$ Chọn repo **`TakiAcademy-AI/Checkin`**.
3. Để nguyên mặc định (`Deploy command: npx wrangler deploy`) và bấm **Deploy**.

### Cách 3: Dùng Claude Code / Terminal (1 lệnh)
```bash
git clone https://github.com/TakiAcademy-AI/Checkin.git
cd Checkin
npm install
npx wrangler deploy
```

## Đường dẫn sử dụng sau khi cài
- **Trang Quản trị (Admin):** `https://<domain-cua-ban>/admin` (Mật khẩu mặc định: `admin123`)
- **Trang Khách quét QR Check-in:** `https://<domain-cua-ban>/e/<slug-su-kien>`
