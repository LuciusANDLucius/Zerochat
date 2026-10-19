# Zerochat — Offline BLE Mesh Messaging System (Store-and-Forward Cache)

Ứng dụng nhắn tin không dây qua không khí dựa trên kiến trúc **BLE Mesh Advertising kết hợp Bộ nhớ đệm trung gian (Connectionless Store-and-Forward Cache)** xây dựng bằng **React Native / Expo (Pure JavaScript ES6+)**.

---

## 1. Kiến Trúc Cốt Lõi (BLE Mesh Không Kết Nối)

- **Không Pairing / Không GATT Connection:** Không cần kết nối trực tiếp điểm-điểm. Mọi gói tin TX, RX và Relay đều được phát tán dưới dạng **BLE Advertising PDU** (Quảng bá không kết nối).
- **Trạm trung gian tự động (Zero-Interaction Auto-Relay):** 
  - Ngay khi khởi động (`useEffect`), thiết bị tự động kích hoạt **Radar Quét ngầm (`BleManager.startDeviceScan` với `allowDuplicates: true`)** và **Vòng lặp phát Carousel 120ms (`BLEAdvertiser.broadcast`)**.
  - Khi thu được gói tin trong không trung:
    1. **Deduplication:** Kiểm tra `Message_ID` trong `Set` FIFO (tối đa 500 ID gần nhất). Nếu đã tồn tại -> Bỏ qua ngay.
    2. **Delivery:** Nếu mới -> Đưa lên giao diện Chat, ghi nhận `Message_ID` vào Cache.
    3. **Store-and-Forward:** Kiểm tra `TTL`. Nếu `TTL > 1`, tự động giảm `TTL = TTL - 1`, đóng gói lại và đưa vào hàng đợi `relayCacheQueue` để phát lặp lại **25 nhịp xoay vòng (120ms/nhịp)** nhằm lan tỏa tin nhắn cho các node ở xa.

---

## 2. Cấu Trúc Khung Gói Tin Nhị Phân 24-Bytes

Toàn bộ gói tin được đóng gói và giải mã bằng `Uint8Array`, `DataView` và `Buffer` trong [src/bleMeshEngine.js](file:///h:/Zerochat/src/bleMeshEngine.js):

| Offset (Bytes) | Trường | Kiểu dữ liệu | Mô tả |
| :--- | :--- | :--- | :--- |
| **0 - 3** (4B) | `msgId` | `Uint32` Big-Endian | Mã định danh 32-bit ngẫu nhiên chống trùng lặp |
| **4** (1B) | `senderId` | `Uint8` (10 - 99) | ID trạm nguồn phát tin |
| **5** (1B) | `ttl` | `Uint8` (Mặc định = 5) | Time-To-Live (Số bước nhảy tối đa) |
| **6** (1B) | `checksum` | `Uint8` | CRC-8 Dallas/Maxim kiểm tra toàn vẹn text |
| **7 - 23** (17B) | `textPayload` | UTF-8 String | Tối đa 17 bytes (Hỗ trợ tiếng Việt có dấu) |

*Lưu ý:* Nếu văn bản dài hơn 17 bytes, engine sẽ tự động phân tách theo ranh giới ký tự UTF-8 thành nhiều gói 24-byte độc lập và đẩy lần lượt vào hàng đợi Cache.

---

## 3. Giao Diện Người Dùng (UI/UX Dark Mode)

- **Header Node:** Hiển thị `Node #ID` (có thể chạm để đổi ID), trạng thái Radar Quét (`ON/OFF`), trạng thái Vòng lặp phát Cache (`120ms/IDLE`), và số gói tin đang chờ trong hàng đợi.
- **Live Cache Monitor Panel:** Thanh ngang hiển thị các `Message_ID` (dạng Hex `0x...`) trong RAM và nhịp phát còn lại (`remainBroadcasts/25`) nhảy theo thời gian thực.
- **Nút Giả lập sóng RX (+ Giả lập sóng RX):** Tiện lợi cho việc thuyết minh đồ án khi chỉ có 1 máy thật.
- **Khung Chat Inverted FlatList:** Phân biệt rõ tin gửi và nhận, kèm badge kỹ thuật hiển thị chi tiết `ID`, `TTL`, và số lần phát tiếp qua sóng radio.
- **Thanh nhập liệu:** Đếm byte theo thời gian thực và nút **"Phát qua Không khí"**.

---

## 4. Hướng Dẫn Build Native

### Android (Xuất file APK Debug / Release):
```bash
npm run android:apk
# File APK tạo ra tại: android/app/build/outputs/apk/debug/app-debug.apk
```

Hoặc build cloud qua EAS:
```bash
eas build --platform android --profile preview
```

### iOS (Build lên Apple TestFlight):
```bash
npm run ios:testflight
```
