# 📡 Zerochat — Hệ Thống Nhắn Tin Ngoại Tuyến BLE Mesh 5.0+

> **Ứng dụng nhắn tin không dây qua sóng Bluetooth năng lượng thấp (BLE) hoạt động độc lập 100% không cần Internet, WiFi, 4G/5G hay trạm phát sóng viễn thông.**  
> Xây dựng bằng **React Native & Expo (Pure JavaScript ES6+)** theo kiến trúc **Connectionless Store-and-Forward Cache** chuẩn **Bluetooth 5.0+ Extended Advertising (254 Bytes)**.

---

## 🌟 Tính Năng Nổi Bật

* 🚫 **Không ghép đôi / Không kết nối (No Pairing / No GATT Connection):** Toàn bộ dữ liệu được truyền phát qua các gói tin quảng bá không kết nối (**BLE Advertising PDU**), cho phép 1 thiết bị gửi tới vô số thiết bị cùng lúc với độ trễ cực thấp.
* 🔄 **Trạm chuyển tiếp tự động (Zero-Interaction Auto-Relay):** Thiết bị tự động hoạt động như một trạm lặp (Relay Station) trung gian, tiếp sóng cho các máy ở xa mà người dùng không cần thao tác bất kỳ nút nào.
* 📦 **Chuẩn Bluetooth 5.0+ Extended Advertising:** Dung lượng gói tin lên tới **240–254 Bytes**, cho phép truyền trọn vẹn văn bản tiếng Việt có dấu dài **180–200 ký tự** trong một lần phát duy nhất.
* 🛡️ **Kiểm soát toàn vẹn dữ liệu với CRC-16-CCITT:** Lọc bỏ hoàn toàn các gói tin bị biến dạng hoặc nhiễu tần số vô tuyến trên dải sóng 2.4GHz.
* 🧠 **Bộ nhớ đệm chống tràn RAM (FIFO 200 Entries):** Chống xử lý lặp lại tin nhắn (Deduplication) và lập lịch phát sóng xoay vòng **Round-Robin 120ms** tối ưu băng thông.
* 🎨 **Giao diện hiện đại & Chế độ Chuyên gia (Tech Inspector):** Thiết kế Dark Mode thanh lịch như Telegram/iMessage, tích hợp bảng giám sát RAM Cache thời gian thực và công cụ giải phẫu gói tin nhị phân phục vụ báo cáo đồ án.
* 📱 **Tương thích chéo Android & iOS (Dual-Mode):** Hỗ trợ nhận diện cả `ManufacturerData` (Android) lẫn `ServiceData` (iOS CoreBluetooth).

---

## 📐 1. Kiến Trúc Mạng BLE Mesh (Store-and-Forward)

```
[Thiết bị A (Gốc)] ────────(Sóng BLE)───────> [Thiết bị B (Trung gian)] ────────(Sóng BLE)───────> [Thiết bị C (Đích)]
TTL = 5                                         TTL = 4                                         TTL = 3
Tạo tin ➔ Đóng gói 240B                         Nhận tin ➔ Checksum CRC-16 OK                   Nhận tin ➔ Checksum OK
➔ Phát 20 nhịp xoay vòng                       ➔ Lưu RAM FIFO 200 (Chống lặp)                  ➔ Lưu RAM Cache
                                                ➔ Giảm TTL = 4 ➔ Đóng gói lại                   ➔ Hiển thị tin nhắn lên UI
                                                ➔ Đưa vào Relay Queue ➔ Phát tiếp 20 nhịp
```

### Vòng đời xử lý gói tin tự động:
1. **Radar Quét Ngầm (Scanner Loop):** Khi mở ứng dụng, máy tự kích hoạt quét ngầm với chế độ `allowDuplicates: true` để bắt kịp thời các nhịp phát xung quanh.
2. **Khử trùng lặp (Deduplication Check):** Kiểm tra `msgId` trong RAM Cache. Nếu ID đã tồn tại trong 200 tin nhắn gần nhất $\rightarrow$ Bỏ qua ngay lập tức để tiết kiệm pin và tránh lặp vô tận (Broadcast Storm).
3. **Tiếp nhận & Tiếp sóng (Auto-Relay):** 
   - Nếu là tin nhắn mới $\rightarrow$ Hiển thị lên màn hình chat và ghi nhận ID vào RAM.
   - Nếu số bước nhảy còn lại $TTL > 1$ và tin nhắn không phải do chính máy này gửi $\rightarrow$ Tự động giảm $TTL = TTL - 1$, bảo toàn định danh gốc, đóng gói lại và đẩy vào `relayCacheQueue` để phát xoay vòng **20 nhịp** (mỗi nhịp cách nhau **120ms**).

---

## 🔬 2. Đặc Tả Khung Gói Tin Nhị Phân BLE 5.0 (240 Bytes PDU)

Gói tin được nén trực tiếp vào mảng nhị phân bằng `Uint8Array`, `DataView` và `Buffer`:

| Vị trí Byte | Kích thước | Kiểu dữ liệu | Tên trường | Ý nghĩa kỹ thuật |
| :---: | :---: | :---: | :---: | :--- |
| **0 – 3** | 4 Bytes | `Uint32` Big-Endian | `msgId` | Mã số định danh 32-bit ngẫu nhiên chống trùng lặp |
| **4** | 1 Byte | `Uint8` | `senderId` | Node ID của thiết bị phát gốc (10 – 99) |
| **5** | 1 Byte | `Uint8` | `ttl` | Số bước nhảy tối đa cho phép (Mặc định = 5 Hops) |
| **6 – 9** | 4 Bytes | `Uint32` Big-Endian | `timestamp` | Unix epoch time tính bằng giây tại thời điểm tạo |
| **10 – 11** | 2 Bytes | `Uint16` Big-Endian | `checksum` | **CRC-16-CCITT** (Polynomial `0x1021`, Initial `0xFFFF`) |
| **12 trở đi**| Tối đa 220B| UTF-8 Buffer | `textPayload`| Nội dung tin nhắn tiếng Việt dài **180–200 ký tự** |

* Nếu người dùng nhập câu vượt quá 220 bytes, thuật toán `chunkUtf8Text` sẽ tự động phân tách theo ranh giới ký tự đa byte UTF-8 an toàn để truyền thành nhiều gói tin liên tiếp.

---

## 🏗️ 3. Cấu Trúc Mã Nguồn Module Hóa (`src/bleMeshEngine/`)

Toàn bộ logic hệ thống được chia tách thành các module độc lập theo nguyên lý **Clean Architecture & Facade Pattern**:

```
src/
└── bleMeshEngine/
    ├── config.js       # Hằng số cấu hình hệ thống: UUID, chu kỳ 120ms, payload 220B, burst 20
    ├── codec.js        # Đóng gói/giải mã nhị phân, thuật toán CRC-16-CCITT, chunk UTF-8 tiếng Việt
    ├── cacheStore.js   # Lớp MeshCacheStore: quản lý RAM FIFO 200, Deduplication Set, Round-Robin queue
    └── index.js        # Tệp trung tâm (Facade) re-export toàn bộ API hệ thống
App.js                  # Giao diện Dark Mode, điều phối phần cứng BLE, Live Cache Monitor, Inspector
```

---

## 📱 4. Giao Diện Người Dùng & Trải Nghiệm Thực Nghiệm

1. **Header Nhận Diện Thông Minh:**
   - Huy hiệu `BLE 5.0` kèm đèn trạng thái sống động (`● Sẵn sàng ngoại tuyến` / `● Đang phát sóng...`).
   - Avatar cá nhân `Node #ID` (chạm để đổi ID ngẫu nhiên).
2. **Ước Tính Khoảng Cách Trực Quan (Dựa trên TTL còn lại):**
   - `🟢 Gửi trực tiếp (Rất gần)` ($TTL = 5$)
   - `🔵 Qua 1 trạm trung gian (~20-50m)` ($TTL = 4$)
   - `🟡 Qua 2 trạm trung gian (~50-100m)` ($TTL = 3$)
   - `🟠 Qua nhiều trạm (Vùng xa)` ($TTL \le 2$)
   - Huy hiệu `🔄 Đã tiếp sóng BLE 5.0` khi máy của bạn đóng vai trò trung chuyển giúp thiết bị khác.
3. **Công Tắc `⚙️ Kỹ thuật` (Dành cho Giảng viên / Hội đồng Đồ án):**
   - Mở rộng thanh **Live Cache Monitor (Store-and-Forward)** theo thời gian thực.
   - Hiển thị danh sách Message ID dạng Hex (`0x...`), thanh tiến trình nhịp phát 20/20, và số lượng gói trong RAM.
4. **Giải Phẫu Gói Tin (Packet Inspector Modal):**
   - Chạm vào bất kỳ tin nhắn nào để xem chi tiết: Kích thước gói thực tế (Bytes), Timestamp, mã CRC-16 dạng Hex, và giải thích luồng xử lý gói tin.
5. **Hộp Thoại Giả Lập Đa Kịch Bản (`+ Thử nhận tin dài`):**
   - Cung cấp các mẫu tin nhắn khẩn cấp dài 140–180 ký tự tiếng Việt để kiểm chứng cơ chế BLE 5.0 và Store-and-Forward ngay trên 1 thiết bị đơn lẻ.

---

## 🚀 5. Hướng Dẫn Cài Đặt & Chạy Thử Nghiệm

### Cài đặt dependencies:
```bash
npm install
```

### Chạy chế độ Web Simulator (Thử nghiệm ngay trên máy tính):
Ứng dụng có cơ chế tự động nhận diện nền tảng Web và kích hoạt **Web Simulator**:
```bash
npx expo start
# Bấm phím 'w' trong terminal để mở trên trình duyệt (http://localhost:8081)
```
*Bạn có thể test gửi tin nhắn dài, xem Live Cache Monitor nhảy nhịp 120ms và bấm nút `+ Thử nhận tin dài` để kiểm thử toàn bộ luồng xử lý mà không cần thiết bị Bluetooth vật lý.*

---

## 🔨 6. Hướng Dẫn Build Native

Do ứng dụng can thiệp trực tiếp vào chip Bluetooth phần cứng thông qua `react-native-ble-plx` và `react-native-ble-advertiser`, **ứng dụng bắt buộc phải chạy bản Native Build (không dùng Expo Go tiêu chuẩn)**.

### Cách 1: Build Android APK qua Expo Cloud (EAS Build — Khuyên dùng)
*Không cần cài đặt JDK hay Android Studio trên máy tính cá nhân:*

1. Đăng nhập tài khoản Expo (miễn phí):
   ```bash
   npx eas-cli login
   ```
2. Chạy lệnh build file APK:
   ```bash
   npx eas-cli build --platform android --profile preview
   ```
3. Sau 3–5 phút, quét mã QR hoặc tải file `.apk` cài trực tiếp vào điện thoại Android.

---

### Cách 2: Build Android APK nội bộ trên máy tính (Local Gradle)
*Yêu cầu đã cài **JDK 17** và **Android Studio (Android SDK 34/35)**:*
```bash
npm run android:apk
# File APK hoàn thành tại: android/app/build/outputs/apk/debug/app-debug.apk
```

---

### Cách 3: Chạy trên iOS (iPhone)
* **Nếu có máy Mac:**
  ```bash
  npx expo prebuild --platform ios
  ```
  Mở thư mục `ios/Zerochat.xcworkspace` bằng Xcode, cắm cáp iPhone và bấm **Run (▶)** (dùng Apple ID cá nhân miễn phí để sign).
* **Nếu dùng Windows (Cloud TestFlight):**
  Yêu cầu tài khoản Apple Developer ($99/năm):
  ```bash
  npx eas-cli build --platform ios --profile production
  ```

---

## 📄 Bản Quyền & Giấy Phép
Dự án được phát triển phục vụ mục đích nghiên cứu, học tập và ứng dụng thực tế trong mạng thông tin cứu hộ khẩn cấp không phụ thuộc hạ tầng mạng viễn thông.
Giấy phép: **MIT License**.
