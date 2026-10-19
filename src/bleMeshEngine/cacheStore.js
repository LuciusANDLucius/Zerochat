/**
 * ============================================================================
 * MESH CACHE STORE & STORE-AND-FORWARD ROUND-ROBIN SCHEDULER
 * Module: src/bleMeshEngine/cacheStore.js
 * ============================================================================
 * 
 * Quản lý bộ nhớ đệm RAM chống lặp (Deduplication Cache),
 * cơ chế bảo vệ tràn bộ nhớ FIFO (Max 200 entries),
 * và bộ điều phối phát sóng chuyển tiếp xoay vòng Round-Robin (120ms/nhịp).
 * 
 * @module BLEMeshCacheStore
 */

import { BLE_MESH_CONFIG } from './config.js';

/**
 * @typedef {Object} RelayQueueItem
 * @property {number} msgId - Mã số 32-bit của gói tin
 * @property {string} hexId - Mã hex hiển thị (ví dụ: '0x1A2B3C4D')
 * @property {number} senderId - Node ID của thiết bị phát gốc
 * @property {number} ttl - Số bước nhảy còn lại
 * @property {number} timestamp - Unix epoch time
 * @property {number} checksum - Checksum CRC-16
 * @property {string} text - Nội dung tin nhắn
 * @property {Uint8Array} rawPacket - Mảng byte nhị phân đã đóng gói sẵn sàng phát
 * @property {number} remainBroadcasts - Số nhịp phát còn lại
 * @property {number} totalBroadcasts - Tổng số nhịp phát dự kiến
 * @property {boolean} isLocal - Cờ xác định gói tin do máy này tự tạo hay từ máy khác chuyển tiếp
 * @property {number} queuedAt - Thời điểm đưa vào hàng đợi
 */

/**
 * Lớp quản lý bộ nhớ đệm và hàng đợi phát sóng chuyển tiếp Mesh
 */
export class MeshCacheStore {
  /**
   * Khởi tạo kho lưu trữ Cache
   * @param {number} [maxEntries=BLE_MESH_CONFIG.MAX_CACHE_IDS] - Giới hạn tối đa số tin nhắn trong RAM
   */
  constructor(maxEntries = BLE_MESH_CONFIG.MAX_CACHE_IDS) {
    /** @type {number} */
    this.maxEntries = maxEntries;

    /** @type {Set<number>} */
    this.seenSet = new Set();

    /** @type {Map<number, any>} */
    this.messageMap = new Map();

    /** @type {number[]} */
    this.fifoOrder = [];

    /** @type {RelayQueueItem[]} */
    this.relayQueue = [];

    /** @type {number} */
    this.roundRobinIndex = 0;
  }

  /**
   * Kiểm tra gói tin đã từng xuất hiện hay chưa (Deduplication Check)
   * 
   * @param {number} msgId - Mã số ngẫu nhiên 32-bit của gói tin
   * @returns {boolean} true nếu gói tin đã có trong Cache, ngược lại false
   */
  has(msgId) {
    return this.seenSet.has(msgId);
  }

  /**
   * Thêm Message ID vào bộ nhớ RAM Cache
   * Tự động loại bỏ phần tử cũ nhất theo nguyên lý FIFO khi vượt quá maxEntries (200)
   * 
   * @param {number} msgId - Mã gói tin 32-bit
   * @param {Object} [metadata=null] - Thông tin bổ sung kèm theo tin nhắn
   */
  add(msgId, metadata = null) {
    if (this.seenSet.has(msgId)) return;

    this.seenSet.add(msgId);
    if (metadata) {
      this.messageMap.set(msgId, metadata);
    }
    this.fifoOrder.push(msgId);

    // Cơ chế FIFO: Nếu danh sách vượt quá 200 tin nhắn -> Đẩy tin nhắn cũ nhất ra khỏi RAM
    if (this.fifoOrder.length > this.maxEntries) {
      const evicted = this.fifoOrder.shift();
      if (evicted !== undefined) {
        this.seenSet.delete(evicted);
        this.messageMap.delete(evicted);
      }
    }
  }

  /**
   * Đưa một gói tin vào hàng đợi chuyển tiếp tự động (Store-and-Forward Relay Queue)
   * Nếu gói tin đã tồn tại trong hàng đợi, làm mới số nhịp phát còn lại.
   * 
   * @param {RelayQueueItem} item - Đối tượng gói tin cần chuyển tiếp
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
   * Lấy gói tin tiếp theo để phát sóng theo cơ chế xoay vòng Round-Robin (120ms/nhịp)
   * Tự động giảm `remainBroadcasts` đi 1 và xóa khỏi hàng đợi khi đã đủ số nhịp.
   * 
   * @returns {RelayQueueItem|null} Gói tin tiếp theo cần phát sóng, hoặc null nếu hàng đợi trống
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
   * Trả về ảnh chụp trạng thái hàng đợi phục vụ hiển thị Live Cache Monitor trên UI
   * 
   * @returns {Array<Object>} Danh sách tóm tắt các gói tin đang chờ phát
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
   * Lấy danh sách 10 Message ID gần nhất trong RAM Cache dạng Hex
   * 
   * @returns {string[]} Mảng chuỗi Hexadecimal của các ID gần nhất
   */
  getRecentIds() {
    return this.fifoOrder.slice(-10).map((id) => '0x' + id.toString(16).toUpperCase().padStart(8, '0'));
  }

  /**
   * Số lượng gói tin hiện đang nằm trong hàng đợi chuyển tiếp
   * 
   * @returns {number}
   */
  getQueueLength() {
    return this.relayQueue.length;
  }

  /**
   * Tổng số tin nhắn đã lưu trong RAM Cache chống lặp
   * 
   * @returns {number}
   */
  getCacheSize() {
    return this.seenSet.size;
  }

  /**
   * Xóa sạch toàn bộ hàng đợi phát sóng
   */
  clear() {
    this.relayQueue = [];
    this.roundRobinIndex = 0;
  }
}
