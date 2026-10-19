/**
 * ============================================================================
 * BLE MESH CONFIGURATION SPECIFICATION
 * Module: src/bleMeshEngine/config.js
 * ============================================================================
 * 
 * Định nghĩa toàn bộ hằng số kiến trúc và tham số vô tuyến (RF Parameters)
 * cho hệ thống mạng Mesh ngoại tuyến chuẩn Bluetooth 5.0+ Extended Advertising.
 * 
 * @module BLEMeshConfig
 */

/**
 * @typedef {Object} BleMeshConfig
 * @property {number} HEADER_SIZE - Kích thước header cố định (12 Bytes).
 * @property {number} MAX_PAYLOAD_SIZE - Kích thước tối đa của phần payload văn bản UTF-8 (220 Bytes).
 * @property {number} MAX_PACKET_SIZE - Kích thước tối đa của toàn bộ gói tin nhị phân (240 Bytes <= 254B chuẩn BLE 5.0).
 * @property {number} DEFAULT_TTL - Số bước nhảy tối đa mặc định qua các trạm trung gian (5 Hops).
 * @property {number} COMPANY_ID - Mã định danh nhà sản xuất BLE chuẩn (0xFFFF).
 * @property {string} SERVICE_UUID - Mã UUID 128-bit định danh mạng lưới Zerochat trên toàn cầu.
 * @property {number} BROADCAST_BURSTS - Số nhịp phát lặp lại cho mỗi gói tin để chống rớt sóng RF (20 nhịp).
 * @property {number} PULSE_INTERVAL_MS - Khoảng thời gian nghỉ giữa các nhịp xoay vòng Round-Robin (120ms).
 * @property {number} MAX_CACHE_IDS - Giới hạn số lượng tin nhắn lưu trong RAM Cache FIFO chống tràn bộ nhớ (200 entries).
 */

/**
 * Cấu hình hệ thống BLE Mesh Engine
 * @type {BleMeshConfig}
 */
export const BLE_MESH_CONFIG = {
  HEADER_SIZE: 12,
  MAX_PAYLOAD_SIZE: 220,     // Hỗ trợ chuỗi tiếng Việt 180-200 ký tự UTF-8 trong 1 gói duy nhất
  MAX_PACKET_SIZE: 240,      // 12 bytes header + 220 bytes payload <= 254 bytes BLE 5.0 PDU
  DEFAULT_TTL: 5,            // Mặc định cho phép chuyển tiếp tối đa qua 5 trạm trung gian
  COMPANY_ID: 0xFFFF,        // 16-bit Company Identifier cho Manufacturer Specific Data
  SERVICE_UUID: '0000FEED-0000-1000-8000-00805F9B34FB', // Zerochat Mesh Service UUID
  BROADCAST_BURSTS: 20,      // Phát lặp 20 lần cho mỗi gói tin trước khi xóa khỏi queue
  PULSE_INTERVAL_MS: 120,    // Chu kỳ xoay vòng 120ms (tối ưu trong dải 100ms - 150ms chống nghẽn 2.4GHz)
  MAX_CACHE_IDS: 200,        // Giới hạn RAM Cache 200 tin nhắn gần nhất theo cơ chế FIFO
};
