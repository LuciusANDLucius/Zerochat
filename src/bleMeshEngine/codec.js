/**
 * ============================================================================
 * BLE MESH BINARY CODEC & CRC ENGINE
 * Module: src/bleMeshEngine/codec.js
 * ============================================================================
 * 
 * Chịu trách nhiệm mã hóa (serialization), giải mã (deserialization),
 * tính toán toàn vẹn dữ liệu (CRC-16-CCITT) và phân tách an toàn văn bản UTF-8
 * cho khung gói tin Bluetooth 5.0+ Extended Advertising PDU (tối đa 254 Bytes).
 * 
 * ĐẶC TẢ KHUNG GÓI TIN BLE 5.0 (12 BYTES HEADER + PAYLOAD):
 * - Byte 0 - 3   (4 Bytes - Uint32 Big-Endian) : msgId (Mã định danh duy nhất chống lặp)
 * - Byte 4       (1 Byte  - Uint8)             : senderId (Node ID máy gửi 10 - 99)
 * - Byte 5       (1 Byte  - Uint8)             : ttl (Số bước nhảy Time-To-Live)
 * - Byte 6 - 9   (4 Bytes - Uint32 Big-Endian) : timestamp (Unix epoch time giây)
 * - Byte 10 - 11 (2 Bytes - Uint16 Big-Endian) : checksum (CRC-16-CCITT chống nhiễu)
 * - Byte 12 - N  (Tối đa 220 Bytes UTF-8)      : textPayload (Nội dung văn bản)
 * 
 * @module BLEMeshCodec
 */

import { Buffer } from 'buffer';
import { BLE_MESH_CONFIG } from './config.js';

/**
 * Tính mã kiểm tra lỗi CRC-16-CCITT (Polynomial: 0x1021, Initial: 0xFFFF)
 * Chuẩn viễn thông tối ưu trên dải sóng 2.4GHz cho các gói tin nhị phân lớn.
 * 
 * @param {Uint8Array|number[]|Buffer} bytes - Mảng byte payload cần tính mã kiểm tra
 * @returns {number} Giá trị mã băm kiểm tra lỗi 16-bit (0x0000 - 0xFFFF)
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
 * Đóng gói thông tin tin nhắn thành khung nhị phân chuẩn BLE 5.0 Extended Advertising
 * 
 * @param {Object} params - Tham số đóng gói
 * @param {number} params.msgId - Mã số ngẫu nhiên 32-bit duy nhất (Deduplication ID)
 * @param {number} params.senderId - Định danh thiết bị nguồn (Node ID: 10 - 99)
 * @param {number} [params.ttl=BLE_MESH_CONFIG.DEFAULT_TTL] - Số bước nhảy tối đa cho phép
 * @param {number} [params.timestamp] - Unix timestamp giây (Mặc định: Date.now() / 1000)
 * @param {string} [params.textPayload=''] - Chuỗi văn bản tiếng Việt UTF-8 (Tối đa 220 Bytes)
 * @returns {Uint8Array} Mảng byte nhị phân sẵn sàng phát qua sóng vô tuyến BLE
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
 * @typedef {Object} DecodedPacketSuccess
 * @property {true} isValid - Cờ xác thực tính toàn vẹn gói tin thành công
 * @property {number} msgId - Mã số 32-bit của gói tin
 * @property {string} hexId - Mã số hiển thị dạng Hexadecimal (ví dụ: '0x1A2B3C4D')
 * @property {number} senderId - Node ID thiết bị gửi gốc
 * @property {number} ttl - Số bước nhảy còn lại (Time-To-Live)
 * @property {number} timestamp - Unix epoch time thời điểm tạo gói tin
 * @property {number} checksum - Mã CRC-16 nhận được trong gói tin
 * @property {string} text - Nội dung tin nhắn văn bản UTF-8 đã giải mã
 * @property {number} payloadSize - Độ dài thực tế của payload (Bytes)
 * @property {number} packetSize - Tổng kích thước toàn bộ gói tin nhận được (Bytes)
 * @property {Uint8Array} rawBytes - Dữ liệu nhị phân thô của gói tin
 */

/**
 * @typedef {Object} DecodedPacketFailure
 * @property {false} isValid - Cờ báo gói tin không hợp lệ hoặc lỗi toàn vẹn
 * @property {string} error - Mô tả nguyên nhân từ chối gói tin
 */

/**
 * Giải mã khung gói tin BLE 5.0 Extended nhận được từ sóng không khí
 * Tự động cắt bỏ các byte đệm 0x00 do phần cứng radio tự bổ sung (Trailing Zero-Padding).
 * 
 * @param {Uint8Array|Buffer|number[]} rawBytes - Dữ liệu nhị phân thô nhận được từ sóng BLE
 * @returns {DecodedPacketSuccess|DecodedPacketFailure} Kết quả giải mã gói tin
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

  // Tự động loại bỏ các byte 0x00 thừa ở cuối do driver radio tự đệm
  let actualEnd = rawPayload.length;
  while (actualEnd > 0 && rawPayload[actualEnd - 1] === 0x00) {
    actualEnd--;
  }
  const payloadBytes = rawPayload.subarray(0, actualEnd);

  // Kiểm tra tính toàn vẹn với CRC-16 (chấp nhận cả bản trimmed và bản gốc)
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
 * Phân tách chuỗi văn bản dài thành các phần nhỏ không vượt quá giới hạn byte
 * Thuật toán cắt an toàn với ký tự đa byte UTF-8 tiếng Việt (không bao giờ gây lỗi cắt gãy byte).
 * 
 * @param {string} text - Đoạn văn bản đầu vào
 * @param {number} [maxBytes=BLE_MESH_CONFIG.MAX_PAYLOAD_SIZE] - Giới hạn dung lượng byte cho mỗi phần
 * @returns {string[]} Mảng các chuỗi con đã được cắt an toàn
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
