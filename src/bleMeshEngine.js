/**
 * ============================================================================
 * BLE MESH ENGINE (Bluetooth 5.0+ Extended Advertising Architecture)
 * ============================================================================
 * 
 * CẤU TRÚC KHUNG GÓI TIN BLE 5.0 EXTENDED (TỐI ĐA 240 - 254 BYTES):
 * - Byte 0 - 3   (4 Bytes - Uint32 Big-Endian) : msgId (Mã định danh duy nhất chống lặp)
 * - Byte 4       (1 Byte  - Uint8)             : senderId (Node ID máy gửi 10 - 99)
 * - Byte 5       (1 Byte  - Uint8)             : ttl (Số bước nhảy, mặc định = 5)
 * - Byte 6 - 9   (4 Bytes - Uint32 Big-Endian) : timestamp (Unix epoch time tính bằng giây)
 * - Byte 10 - 11 (2 Bytes - Uint16 Big-Endian) : checksum (CRC-16-CCITT chống nhiễu sóng)
 * - Byte 12 - N  (Tối đa 220 Bytes - UTF-8)    : textPayload (Văn bản tiếng Việt dài 180-200 ký tự)
 */

import { Buffer } from 'buffer';

export const BLE_MESH_CONFIG = {
  HEADER_SIZE: 12,
  MAX_PAYLOAD_SIZE: 220,     // Hỗ trợ chuỗi tiếng Việt 180-200 ký tự UTF-8 trong 1 gói
  MAX_PACKET_SIZE: 240,      // 12 bytes header + 220 bytes payload <= 254 bytes BLE 5.0
  DEFAULT_TTL: 5,
  COMPANY_ID: 0xFFFF,
  SERVICE_UUID: '0000FEED-0000-1000-8000-00805F9B34FB',
  BROADCAST_BURSTS: 20,      // Số nhịp phát lặp lại cho mỗi tin nhắn
  PULSE_INTERVAL_MS: 120,    // Khoảng thời gian phát xoay vòng 120ms (tối ưu 100ms - 150ms)
  MAX_CACHE_IDS: 200,        // Lưu tối đa 200 tin nhắn gần nhất trong RAM
};

/**
 * Tính mã kiểm tra lỗi CRC-16-CCITT (Polynomial: 0x1021, Initial: 0xFFFF)
 * Khả năng phát hiện lỗi bit trên payload dài của sóng 2.4GHz vượt trội so với CRC-8 cũ.
 * @param {Uint8Array|number[]} bytes 
 * @returns {number} 16-bit checksum (0 - 65535)
 */
export function calculateChecksumCRC16(bytes) {
  if (!bytes || bytes.length === 0) return 0xFFFF;
  let crc = 0xFFFF;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= (bytes[i] << 8);
    for (let j = 0; j < 8; j++) {
      if ((crc & 0x8000) !== 0) {
        crc = ((crc << 1) ^ 0x1021) & 0xFFFF;
      } else {
        crc = (crc << 1) & 0xFFFF;
      }
    }
  }
  return crc;
}

/**
 * Đóng gói dữ liệu thành khung nhị phân chuẩn BLE 5.0 Extended Advertising
 * @param {Object} param0 
 * @param {number} param0.msgId - Mã ngẫu nhiên 32-bit duy nhất
 * @param {number} param0.senderId - Mã node gửi (10 - 99)
 * @param {number} [param0.ttl=5] - Time-To-Live
 * @param {number} [param0.timestamp] - Unix timestamp giây (mặc định lấy thời điểm hiện tại)
 * @param {string} [param0.textPayload=''] - Nội dung tin nhắn (tối đa 220 bytes UTF-8)
 * @returns {Uint8Array} Mảng byte nhị phân sẵn sàng phát qua BLE 5.0
 */
export function encodePacket({
  msgId,
  senderId,
  ttl = BLE_MESH_CONFIG.DEFAULT_TTL,
  timestamp = Math.floor(Date.now() / 1000),
  textPayload = '',
}) {
  const textBuf = Buffer.from(textPayload, 'utf8');
  const payloadLen = Math.min(textBuf.length, BLE_MESH_CONFIG.MAX_PAYLOAD_SIZE);
  const payloadBytes = new Uint8Array(payloadLen);

  for (let i = 0; i < payloadLen; i++) {
    payloadBytes[i] = textBuf[i];
  }

  // Byte 10-11: Checksum CRC-16 tính trên toàn bộ payload văn bản
  const checksum = calculateChecksumCRC16(payloadBytes);

  const totalLength = BLE_MESH_CONFIG.HEADER_SIZE + payloadLen;
  const buffer = new ArrayBuffer(totalLength);
  const view = new DataView(buffer);

  // Byte 0-3: msgId (Big-Endian Uint32)
  view.setUint32(0, msgId >>> 0, false);

  // Byte 4: senderId (Uint8)
  view.setUint8(4, senderId & 0xFF);

  // Byte 5: ttl (Uint8)
  view.setUint8(5, ttl & 0xFF);

  // Byte 6-9: timestamp (Big-Endian Uint32)
  view.setUint32(6, timestamp >>> 0, false);

  // Byte 10-11: checksum CRC-16 (Big-Endian Uint16)
  view.setUint16(10, checksum & 0xFFFF, false);

  // Byte 12 trở đi: textPayload UTF-8
  const packetUint8 = new Uint8Array(buffer);
  packetUint8.set(payloadBytes, BLE_MESH_CONFIG.HEADER_SIZE);

  return packetUint8;
}

/**
 * Giải mã khung gói tin BLE 5.0 Extended nhận được từ sóng không khí
 * Tự động cắt bỏ byte 0x00 đệm phía sau nếu radio driver tự đệm.
 * @param {Uint8Array|Buffer} rawBytes 
 * @returns {Object} Kết quả giải mã kèm cờ kiểm tra tính hợp lệ
 */
export function decodePacket(rawBytes) {
  if (!rawBytes || rawBytes.length < BLE_MESH_CONFIG.HEADER_SIZE) {
    return {
      isValid: false,
      error: `Kích thước quá nhỏ (${rawBytes ? rawBytes.length : 0}B < ${BLE_MESH_CONFIG.HEADER_SIZE}B header)`,
    };
  }

  const packet = rawBytes instanceof Uint8Array ? rawBytes : new Uint8Array(rawBytes);
  const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);

  const msgId = view.getUint32(0, false);
  const senderId = view.getUint8(4);
  const ttl = view.getUint8(5);
  const timestamp = view.getUint32(6, false);
  const checksum = view.getUint16(10, false);

  // Trích xuất payload từ byte 12 trở đi
  const rawPayload = packet.subarray(BLE_MESH_CONFIG.HEADER_SIZE);

  // Loại bỏ các byte 0x00 thừa ở cuối do phần cứng radio tự đệm (nếu có)
  let actualEnd = rawPayload.length;
  while (actualEnd > 0 && rawPayload[actualEnd - 1] === 0x00) {
    actualEnd--;
  }
  const payloadBytes = rawPayload.subarray(0, actualEnd);

  // Kiểm tra tính toàn vẹn với CRC-16 (hỗ trợ kiểm tra cả bản trimmed và bản gốc)
  const calculatedCrcTrimmed = calculateChecksumCRC16(payloadBytes);
  const calculatedCrcRaw = calculateChecksumCRC16(rawPayload);

  const isChecksumValid = (checksum === calculatedCrcTrimmed) || (checksum === calculatedCrcRaw);

  if (!isChecksumValid && payloadBytes.length > 0) {
    return {
      isValid: false,
      error: `Lỗi CRC-16 Checksum (Nhận: 0x${checksum.toString(16).toUpperCase()} != Tính: 0x${calculatedCrcTrimmed.toString(16).toUpperCase()})`,
    };
  }

  const text = Buffer.from(payloadBytes).toString('utf8');

  return {
    isValid: true,
    msgId,
    hexId: '0x' + msgId.toString(16).toUpperCase().padStart(8, '0'),
    senderId,
    ttl,
    timestamp,
    checksum,
    text,
    payloadSize: payloadBytes.length,
    packetSize: packet.length,
    rawBytes: packet,
  };
}

/**
 * Phân tách văn bản dài hơn 220 bytes thành các phần độc lập
 * An toàn với ký tự đa byte UTF-8 tiếng Việt (không bao giờ cắt gãy byte)
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
 * MESH CACHE STORE (Quản lý RAM Cache FIFO 200 tin nhắn & Hàng đợi Store-and-Forward)
 * ============================================================================
 */
export class MeshCacheStore {
  constructor(maxEntries = BLE_MESH_CONFIG.MAX_CACHE_IDS) {
    this.maxEntries = maxEntries;
    this.seenSet = new Set();
    this.messageMap = new Map();
    this.fifoOrder = [];
    this.relayQueue = [];
    this.roundRobinIndex = 0;
  }

  /**
   * Kiểm tra Message_ID đã từng xuất hiện hay chưa (Deduplication)
   * @param {number} msgId 
   * @returns {boolean}
   */
  has(msgId) {
    return this.seenSet.has(msgId);
  }

  /**
   * Thêm Message_ID và dữ liệu tin nhắn vào RAM Cache (FIFO tối đa 200 phần tử)
   * Tự động loại bỏ tin nhắn cũ nhất khi đầy để chống tràn bộ nhớ
   * @param {number} msgId 
   * @param {Object} [metadata]
   */
  add(msgId, metadata = null) {
    if (this.seenSet.has(msgId)) return;

    this.seenSet.add(msgId);
    if (metadata) {
      this.messageMap.set(msgId, metadata);
    }
    this.fifoOrder.push(msgId);

    // Cơ chế FIFO: Nếu vượt quá maxEntries (200), đẩy phần tử cũ nhất ra khỏi RAM
    if (this.fifoOrder.length > this.maxEntries) {
      const evicted = this.fifoOrder.shift();
      if (evicted !== undefined) {
        this.seenSet.delete(evicted);
        this.messageMap.delete(evicted);
      }
    }
  }

  /**
   * Đưa một gói tin vào hàng đợi chuyển tiếp (Store-and-Forward Relay Queue)
   * @param {Object} item 
   */
  addToRelayQueue(item) {
    const existing = this.relayQueue.find((q) => q.msgId === item.msgId);
    if (existing) {
      existing.remainBroadcasts = Math.max(
        existing.remainBroadcasts,
        item.remainBroadcasts || BLE_MESH_CONFIG.BROADCAST_BURSTS
      );
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
   * Lấy gói tin tiếp theo để phát sóng theo cơ chế xoay vòng Round-Robin (120ms)
   * Tự động giảm nhịp phát `remainBroadcasts = remainBroadcasts - 1`
   * và xóa khỏi hàng đợi khi đã hoàn thành đủ số nhịp
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

    if (currentItem.remainBroadcasts <= 0) {
      this.relayQueue.splice(this.roundRobinIndex, 1);
    } else {
      this.roundRobinIndex = (this.roundRobinIndex + 1) % this.relayQueue.length;
    }

    return currentItem;
  }

  /**
   * Trả về ảnh chụp hàng đợi phục vụ hiển thị Live Cache Monitor trên UI
   */
  getQueueSnapshot() {
    return this.relayQueue.map((item) => ({
      msgId: item.msgId,
      hexId: item.hexId,
      senderId: item.senderId,
      ttl: item.ttl,
      timestamp: item.timestamp,
      remainBroadcasts: item.remainBroadcasts,
      totalBroadcasts: item.totalBroadcasts,
      isLocal: !!item.isLocal,
      text: item.text,
      packetSize: item.rawPacket ? item.rawPacket.length : 0,
    }));
  }

  /**
   * Lấy danh sách 10 Message_ID gần nhất trong RAM Cache
   */
  getRecentIds() {
    return this.fifoOrder.slice(-10).map((id) => '0x' + id.toString(16).toUpperCase().padStart(8, '0'));
  }

  /**
   * Số lượng gói tin hiện đang nằm trong hàng đợi chuyển tiếp
   */
  getQueueLength() {
    return this.relayQueue.length;
  }

  /**
   * Tổng số tin nhắn đã lưu trong RAM Cache chống lặp
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
