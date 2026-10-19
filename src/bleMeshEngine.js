/**
 * ============================================================================
 * BLE MESH ENGINE (Connectionless Store-and-Forward Cache Architecture)
 * ============================================================================
 * 
 * 24-BYTE PACKET FRAMING SPECIFICATION:
 * - Byte 0 - 3 (4 Bytes - Uint32 Big-Endian) : msgId (Unique 32-bit integer for deduplication)
 * - Byte 4     (1 Byte  - Uint8)             : senderId (Node ID 10 - 99)
 * - Byte 5     (1 Byte  - Uint8)             : ttl (Hop limit, default 5)
 * - Byte 6     (1 Byte  - Uint8)             : checksum (CRC8 of the 17-byte text payload)
 * - Byte 7 - 23(17 Bytes- UTF-8 Buffer)      : textPayload (Padded with 0x00)
 */

import { Buffer } from 'buffer';

export const BLE_MESH_CONFIG = {
  PACKET_SIZE: 24,
  MAX_PAYLOAD_SIZE: 17,
  DEFAULT_TTL: 5,
  COMPANY_ID: 0xFFFF,
  SERVICE_UUID: '0000FEED-0000-1000-8000-00805F9B34FB',
  BROADCAST_BURSTS: 25,
  PULSE_INTERVAL_MS: 120,
  MAX_CACHE_IDS: 500,
};

/**
 * Tính mã kiểm tra CRC-8 chuẩn Dallas/Maxim trên chuỗi byte payload
 * Đảm bảo lọc nhiễu sóng RF 2.4GHz và phát hiện gói tin lỗi
 * @param {Uint8Array|number[]} bytes 
 * @returns {number} 8-bit checksum (0-255)
 */
export function calculateChecksum(bytes) {
  let crc = 0x00;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i];
    for (let j = 0; j < 8; j++) {
      if ((crc & 0x80) !== 0) {
        crc = ((crc << 1) ^ 0x07) & 0xFF;
      } else {
        crc = (crc << 1) & 0xFF;
      }
    }
  }
  return crc;
}

/**
 * Đóng gói dữ liệu thành khung nhị phân 24 Bytes chính xác
 * @param {Object} param0 
 * @param {number} param0.msgId - Mã số ngẫu nhiên 32-bit
 * @param {number} param0.senderId - Mã node gửi (10-99)
 * @param {number} param0.ttl - Số bước nhảy tối đa
 * @param {string} param0.textPayload - Nội dung tin nhắn (tối đa 17 bytes UTF-8)
 * @returns {Uint8Array} Mảng 24 bytes sẵn sàng phát qua BLE Advertising
 */
export function encodePacket({ msgId, senderId, ttl = BLE_MESH_CONFIG.DEFAULT_TTL, textPayload = '' }) {
  const buffer = new ArrayBuffer(BLE_MESH_CONFIG.PACKET_SIZE);
  const view = new DataView(buffer);

  // Byte 0-3: msgId (Big-Endian Uint32)
  view.setUint32(0, msgId >>> 0, false);

  // Byte 4: senderId (Uint8)
  view.setUint8(4, senderId & 0xFF);

  // Byte 5: ttl (Uint8)
  view.setUint8(5, ttl & 0xFF);

  // Byte 7-23: textPayload (17 bytes)
  const payloadBytes = new Uint8Array(BLE_MESH_CONFIG.MAX_PAYLOAD_SIZE);
  const textBuf = Buffer.from(textPayload, 'utf8');
  const copyLen = Math.min(textBuf.length, BLE_MESH_CONFIG.MAX_PAYLOAD_SIZE);
  for (let i = 0; i < copyLen; i++) {
    payloadBytes[i] = textBuf[i];
  }

  // Byte 6: checksum tính trên toàn bộ 17 bytes payload
  const checksum = calculateChecksum(payloadBytes);
  view.setUint8(6, checksum);

  // Ghi payload vào mảng 24 bytes từ vị trí offset 7
  const packetUint8 = new Uint8Array(buffer);
  packetUint8.set(payloadBytes, 7);

  return packetUint8;
}

/**
 * Giải mã khung 24 Bytes nhận được từ sóng BLE
 * @param {Uint8Array|Buffer} rawBytes 
 * @returns {Object} Kết quả giải mã kèm cờ kiểm tra tính hợp lệ
 */
export function decodePacket(rawBytes) {
  if (!rawBytes || rawBytes.length < BLE_MESH_CONFIG.PACKET_SIZE) {
    return {
      isValid: false,
      error: `Kích thước không hợp lệ (${rawBytes ? rawBytes.length : 0}B != 24B)`,
    };
  }

  const packet = rawBytes.subarray(0, BLE_MESH_CONFIG.PACKET_SIZE);
  const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);

  const msgId = view.getUint32(0, false);
  const senderId = view.getUint8(4);
  const ttl = view.getUint8(5);
  const checksum = view.getUint8(6);

  const payloadBytes = packet.subarray(7, 24);
  const expectedChecksum = calculateChecksum(payloadBytes);

  if (checksum !== expectedChecksum) {
    return {
      isValid: false,
      error: `Sai Checksum (Nhận: 0x${checksum.toString(16)} != Tính: 0x${expectedChecksum.toString(16)})`,
    };
  }

  // Đọc chuỗi UTF-8 loại bỏ byte padding 0x00 phía sau
  let end = 0;
  while (end < payloadBytes.length && payloadBytes[end] !== 0x00) {
    end++;
  }
  const text = Buffer.from(payloadBytes.subarray(0, end)).toString('utf8');

  return {
    isValid: true,
    msgId,
    hexId: '0x' + msgId.toString(16).toUpperCase().padStart(8, '0'),
    senderId,
    ttl,
    checksum,
    text,
    rawBytes: packet,
  };
}

/**
 * Phân tách văn bản dài hơn 17 bytes thành các phần độc lập
 * An toàn với ký tự đa byte UTF-8 (Tiếng Việt có dấu)
 * @param {string} text 
 * @param {number} maxBytes 
 * @returns {string[]}
 */
export function chunkUtf8Text(text, maxBytes = BLE_MESH_CONFIG.MAX_PAYLOAD_SIZE) {
  if (!text) return [''];
  const chunks = [];
  let remaining = text;

  while (remaining.length > 0) {
    let sliceLen = remaining.length;
    let buf = Buffer.from(remaining.slice(0, sliceLen), 'utf8');

    while (buf.length > maxBytes && sliceLen > 0) {
      sliceLen--;
      buf = Buffer.from(remaining.slice(0, sliceLen), 'utf8');
    }

    if (sliceLen === 0) {
      break;
    }

    chunks.push(remaining.slice(0, sliceLen));
    remaining = remaining.slice(sliceLen);
  }

  return chunks;
}

/**
 * ============================================================================
 * MESH CACHE STORE (Quản lý Cache & Hàng đợi Store-and-Forward Round-Robin)
 * ============================================================================
 */
export class MeshCacheStore {
  constructor(maxEntries = BLE_MESH_CONFIG.MAX_CACHE_IDS) {
    this.maxEntries = maxEntries;
    this.seenSet = new Set();
    this.fifoOrder = [];
    this.relayQueue = [];
    this.roundRobinIndex = 0;
  }

  /**
   * Kiểm tra Message_ID đã từng xuất hiện hay chưa
   * @param {number} msgId 
   * @returns {boolean}
   */
  has(msgId) {
    return this.seenSet.has(msgId);
  }

  /**
   * Thêm Message_ID vào Set deduplication (FIFO tối đa 500 ID)
   * @param {number} msgId 
   */
  add(msgId) {
    if (this.seenSet.has(msgId)) return;
    this.seenSet.add(msgId);
    this.fifoOrder.push(msgId);

    if (this.fifoOrder.length > this.maxEntries) {
      const evicted = this.fifoOrder.shift();
      if (evicted !== undefined) {
        this.seenSet.delete(evicted);
      }
    }
  }

  /**
   * Đưa một gói tin vào hàng đợi chuyển tiếp (Store-and-Forward Queue)
   * @param {Object} item 
   */
  addToRelayQueue(item) {
    // Không thêm trùng vào queue phát nếu ID đó đang nằm trong queue
    const existing = this.relayQueue.find((q) => q.msgId === item.msgId);
    if (existing) {
      // Làm mới số nhịp phát còn lại nếu nhận được yêu cầu hợp lệ
      existing.remainBroadcasts = Math.max(existing.remainBroadcasts, item.remainBroadcasts || BLE_MESH_CONFIG.BROADCAST_BURSTS);
      return;
    }

    this.relayQueue.push({
      ...item,
      remainBroadcasts: item.remainBroadcasts ?? BLE_MESH_CONFIG.BROADCAST_BURSTS,
      totalBroadcasts: item.totalBroadcasts ?? BLE_MESH_CONFIG.BROADCAST_BURSTS,
      queuedAt: Date.now(),
    });
  }

  /**
   * Lấy gói tin tiếp theo để phát sóng theo cơ chế xoay vòng Round-Robin 120ms
   * Tự động giảm nhịp phát `remainBroadcasts = remainBroadcasts - 1`
   * và loại bỏ khỏi hàng đợi khi đã đủ 25 nhịp
   * @returns {Object|null}
   */
  getNextRoundRobinPacket() {
    if (this.relayQueue.length === 0) {
      this.roundRobinIndex = 0;
      return null;
    }

    if (this.roundRobinIndex >= this.relayQueue.length) {
      this.roundRobinIndex = 0;
    }

    const currentItem = this.relayQueue[this.roundRobinIndex];
    currentItem.remainBroadcasts -= 1;

    // Nếu đã phát hết số nhịp yêu cầu -> Loại khỏi hàng đợi
    if (currentItem.remainBroadcasts <= 0) {
      this.relayQueue.splice(this.roundRobinIndex, 1);
      // Không cần tăng roundRobinIndex vì phần tử tiếp theo trượt về vị trí hiện tại
    } else {
      this.roundRobinIndex = (this.roundRobinIndex + 1) % this.relayQueue.length;
    }

    return currentItem;
  }

  /**
   * Trả về ảnh chụp hàng đợi phục vụ hiển thị Live Cache Monitor Panel trên UI
   */
  getQueueSnapshot() {
    return this.relayQueue.map((item) => ({
      msgId: item.msgId,
      hexId: item.hexId,
      senderId: item.senderId,
      ttl: item.ttl,
      remainBroadcasts: item.remainBroadcasts,
      totalBroadcasts: item.totalBroadcasts,
      isLocal: !!item.isLocal,
      text: item.text,
    }));
  }

  /**
   * Lấy danh sách 10 Message_ID gần nhất trong RAM Cache
   */
  getRecentIds() {
    return this.fifoOrder.slice(-10).map((id) => '0x' + id.toString(16).toUpperCase().padStart(8, '0'));
  }

  /**
   * Số lượng gói tin hiện đang nằm trong hàng đợi
   */
  getQueueLength() {
    return this.relayQueue.length;
  }

  /**
   * Tổng số ID đã lưu trong Cache chống lặp
   */
  getCacheSize() {
    return this.seenSet.size;
  }

  /**
   * Xóa sạch hàng đợi
   */
  clear() {
    this.relayQueue = [];
    this.roundRobinIndex = 0;
  }
}
