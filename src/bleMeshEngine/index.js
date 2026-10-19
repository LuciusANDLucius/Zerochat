/**
 * ============================================================================
 * BLE MESH ENGINE (FACADE MODULE)
 * Module: src/bleMeshEngine/index.js
 * ============================================================================
 * 
 * Kiến trúc phân tầng (Clean Modular Architecture) cho hệ thống mạng Mesh
 * ngoại tuyến dựa trên Bluetooth 5.0+ Extended Advertising PDU (254 Bytes).
 * 
 * BẢN ĐỒ CÁC MODULE CON (SITEMAP):
 * ├── config.js     : Toàn bộ hằng số hệ thống, giới hạn payload, chu kỳ 120ms, UUID.
 * ├── codec.js      : Đóng gói / Giải mã 240B, CRC-16-CCITT, phân tách UTF-8 an toàn.
 * └── cacheStore.js : RAM Cache FIFO 200, Deduplication, bộ lập lịch phát Round-Robin.
 * 
 * NGUYÊN LÝ HOẠT ĐỘNG TRONG 30 GIÂY:
 * 1. PHÁT TIN (TX):
 *    Văn bản ➔ chunkUtf8Text() ➔ encodePacket() (12B Header + Payload + CRC-16)
 *    ➔ Đưa vào MeshCacheStore.relayQueue ➔ Phát 20 nhịp xoay vòng mỗi 120ms.
 * 2. THU TIN & CHUYỂN TIẾP (RX & STORE-AND-FORWARD):
 *    Sóng BLE ➔ decodePacket() (Kiểm tra CRC-16 & loại bỏ 0x00)
 *    ➔ MeshCacheStore.has(msgId)? (Deduplication)
 *    ➔ Nếu mới: Lưu vào RAM FIFO 200 + Hiển thị Chat
 *    ➔ Nếu TTL > 1: Giảm TTL = TTL - 1, đóng gói lại và đẩy vào relayQueue để tiếp sóng!
 * 
 * @module BLEMeshEngine
 */

// 1. Cấu hình hệ thống (Configuration)
export { BLE_MESH_CONFIG } from './config.js';

// 2. Bộ xử lý nhị phân & Kiểm tra toàn vẹn (Binary Codec & CRC-16)
export {
  calculateChecksumCRC16,
  encodePacket,
  decodePacket,
  chunkUtf8Text,
} from './codec.js';

// 3. Quản lý trạng thái bộ nhớ đệm (State & Cache Store)
export { MeshCacheStore } from './cacheStore.js';
