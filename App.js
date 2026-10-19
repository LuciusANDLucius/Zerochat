import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  StyleSheet,
  Text,
  View,
  TextInput,
  TouchableOpacity,
  FlatList,
  SafeAreaView,
  StatusBar,
  ScrollView,
  Platform,
  PermissionsAndroid,
  Alert,
  NativeModules,
} from 'react-native';
import { Buffer } from 'buffer';
import { BleManager } from 'react-native-ble-plx';
import BLEAdvertiser from 'react-native-ble-advertiser';

import {
  BLE_MESH_CONFIG,
  encodePacket,
  decodePacket,
  chunkUtf8Text,
  MeshCacheStore,
} from './src/bleMeshEngine';

// Khởi tạo global Buffer cho môi trường React Native
global.Buffer = Buffer;

// Tạo Node ID ngẫu nhiên cho thiết bị hiện tại (trong khoảng 10 - 99)
const INITIAL_NODE_ID = Math.floor(Math.random() * 90) + 10;

export default function App() {
  const [nodeId, setNodeId] = useState(INITIAL_NODE_ID);
  const [inputText, setInputText] = useState('');
  const [messages, setMessages] = useState([]);
  const [isScanning, setIsScanning] = useState(false);
  const [isBroadcasting, setIsBroadcasting] = useState(false);
  const [currentTxItem, setCurrentTxItem] = useState(null);
  const [queueSnapshot, setQueueSnapshot] = useState([]);
  const [cachedIdsList, setCachedIdsList] = useState([]);
  const [isNativeBleSupported, setIsNativeBleSupported] = useState(true);
  const [logInfo, setLogInfo] = useState('Khởi tạo trạm Mesh...');

  // Các tham chiếu giữ trạng thái ngầm định
  const cacheStoreRef = useRef(new MeshCacheStore(BLE_MESH_CONFIG.MAX_CACHE_IDS));
  const bleManagerRef = useRef(null);
  const carouselTimerRef = useRef(null);
  const isBroadcastingRef = useRef(false);

  /**
   * ==========================================================================
   * 1. YÊU CẦU CẤP QUYỀN BLUETOOTH (ANDROID 12+ & iOS)
   * ==========================================================================
   */
  const requestBluetoothPermissions = async () => {
    if (Platform.OS === 'android') {
      try {
        if (Platform.Version >= 31) {
          const granted = await PermissionsAndroid.requestMultiple([
            PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
            PermissionsAndroid.PERMISSIONS.BLUETOOTH_ADVERTISE,
            PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
            PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
          ]);

          const allGranted =
            granted[PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN] === PermissionsAndroid.RESULTS.GRANTED &&
            granted[PermissionsAndroid.PERMISSIONS.BLUETOOTH_ADVERTISE] === PermissionsAndroid.RESULTS.GRANTED &&
            granted[PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT] === PermissionsAndroid.RESULTS.GRANTED;

          return allGranted;
        } else {
          const granted = await PermissionsAndroid.requestMultiple([
            PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
            PermissionsAndroid.PERMISSIONS.ACCESS_COARSE_LOCATION,
          ]);
          return granted[PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION] === PermissionsAndroid.RESULTS.GRANTED;
        }
      } catch (err) {
        console.warn('Lỗi xin quyền Bluetooth Android:', err);
        return false;
      }
    }
    return true; // iOS tự động xin qua Info.plist khi khởi động
  };

  /**
   * ==========================================================================
   * 2. XỬ LÝ GÓI TIN NHẬN ĐƯỢC TỪ KHÔNG KHÍ (RX & AUTO-RELAY STORE-AND-FORWARD)
   * ==========================================================================
   */
  const handleIncomingPacket = useCallback(
    (packet) => {
      const store = cacheStoreRef.current;
      const { msgId, hexId, senderId, ttl, text } = packet;

      // Bước 1: Deduplication (Chống lặp)
      // Nếu Message_ID đã nằm trong Cache 500 ID gần nhất -> Bỏ qua ngay
      if (store.has(msgId)) {
        return;
      }

      // Bước 2: Lưu Message_ID vào Cache FIFO
      store.add(msgId);
      setCachedIdsList(store.getRecentIds());

      // Ghi nhận vào giao diện Chat
      const isFromMe = senderId === nodeId;
      const willRelay = ttl > 1 && !isFromMe;

      const newMsg = {
        id: `${hexId}_${Date.now()}_${Math.random()}`,
        msgId,
        hexId,
        senderId,
        ttl,
        text,
        timestamp: Date.now(),
        isLocal: isFromMe,
        relayed: willRelay,
        broadcastProgress: willRelay ? '25/25' : '0/25',
      };

      setMessages((prev) => [newMsg, ...prev]);
      setLogInfo(`[RX] Nhận từ Node #${senderId} | ID: ${hexId} | TTL: ${ttl}`);

      // Bước 3: Cơ chế Trạm Cache Trung Gian Tự Động (Store-and-Forward)
      // Nếu TTL > 1, giảm TTL = TTL - 1, đóng gói lại và đẩy vào hàng đợi phát 25 nhịp
      if (willRelay) {
        const forwardedTtl = ttl - 1;
        const forwardedBytes = encodePacket({
          msgId,
          senderId,
          ttl: forwardedTtl,
          textPayload: text,
        });

        store.addToRelayQueue({
          msgId,
          hexId,
          senderId,
          ttl: forwardedTtl,
          checksum: packet.checksum,
          text,
          rawPacket: forwardedBytes,
          remainBroadcasts: BLE_MESH_CONFIG.BROADCAST_BURSTS,
          totalBroadcasts: BLE_MESH_CONFIG.BROADCAST_BURSTS,
          isLocal: false,
        });

        setQueueSnapshot(store.getQueueSnapshot());
        setLogInfo(`[RELAY] Trạm trung gian chuyển tiếp ID: ${hexId} | TTL mới: ${forwardedTtl}`);
      }
    },
    [nodeId]
  );

  /**
   * ==========================================================================
   * 3. KHỞI CHẠY BLE SCANNER (startDeviceScan với allowDuplicates: true)
   * ==========================================================================
   */
  const startBleScanner = useCallback(() => {
    if (Platform.OS === 'web') {
      setIsNativeBleSupported(false);
      setIsScanning(true);
      return;
    }

    try {
      if (!bleManagerRef.current) {
        bleManagerRef.current = new BleManager();
      }

      const manager = bleManagerRef.current;
      setIsScanning(true);

      manager.startDeviceScan(
        null, // Quét toàn bộ để bắt ManufacturerData
        { allowDuplicates: true },
        (error, device) => {
          if (error) {
            // Có thể xảy ra nếu Bluetooth bị tắt hoặc đang ở Emulator
            return;
          }

          if (!device || !device.manufacturerData) return;

          try {
            const rawBuffer = Buffer.from(device.manufacturerData, 'base64');
            let packetBytes = null;

            // Xử lý tiền tố 2 bytes Company ID (0xFFFF) của gói tin BLE
            if (rawBuffer.length >= 26) {
              const compId = rawBuffer.readUInt16LE(0);
              if (compId === BLE_MESH_CONFIG.COMPANY_ID) {
                packetBytes = rawBuffer.subarray(2, 26);
              }
            } else if (rawBuffer.length === BLE_MESH_CONFIG.PACKET_SIZE) {
              packetBytes = rawBuffer.subarray(0, BLE_MESH_CONFIG.PACKET_SIZE);
            }

            if (packetBytes && packetBytes.length === BLE_MESH_CONFIG.PACKET_SIZE) {
              const decoded = decodePacket(packetBytes);
              if (decoded.isValid) {
                handleIncomingPacket(decoded);
              }
            }
          } catch (err) {
            // Bỏ qua gói tin không đúng định dạng
          }
        }
      );
    } catch (e) {
      console.warn('Lỗi bật BLE Scanner:', e.message);
      setIsNativeBleSupported(false);
      setIsScanning(false);
    }
  }, [handleIncomingPacket]);

  /**
   * ==========================================================================
   * 4. VÒNG LẶP PHÁT BỘ NHỚ ĐỆM (Carousel Cache Broadcaster - Mỗi 120ms)
   * ==========================================================================
   */
  const startCarouselBroadcaster = useCallback(() => {
    if (carouselTimerRef.current) {
      clearInterval(carouselTimerRef.current);
    }

    const store = cacheStoreRef.current;

    carouselTimerRef.current = setInterval(async () => {
      const item = store.getNextRoundRobinPacket();

      if (!item) {
        if (isBroadcastingRef.current) {
          if (Platform.OS !== 'web') {
            try {
              if (BLEAdvertiser && typeof BLEAdvertiser.stopBroadcast === 'function') {
                await BLEAdvertiser.stopBroadcast();
              }
            } catch (e) {}
          }
          isBroadcastingRef.current = false;
          setIsBroadcasting(false);
        }
        setCurrentTxItem(null);
        setQueueSnapshot(store.getQueueSnapshot());
        return;
      }

      // Có gói tin cần phát: Cập nhật UI và bắn ra không khí
      setCurrentTxItem({ ...item });
      setIsBroadcasting(true);
      isBroadcastingRef.current = true;
      setQueueSnapshot(store.getQueueSnapshot());

      // Cập nhật tiến độ phát sóng trên danh sách tin nhắn chat
      setMessages((prevList) =>
        prevList.map((m) => {
          if (m.msgId === item.msgId) {
            return {
              ...m,
              broadcastProgress: `${item.remainBroadcasts}/${item.totalBroadcasts}`,
            };
          }
          return m;
        })
      );

      // Phát thật qua phần cứng BLE
      if (Platform.OS !== 'web') {
        try {
          if (BLEAdvertiser && typeof BLEAdvertiser.broadcast === 'function') {
            BLEAdvertiser.setCompanyId(BLE_MESH_CONFIG.COMPANY_ID);
            await BLEAdvertiser.broadcast(
              BLE_MESH_CONFIG.SERVICE_UUID,
              Array.from(item.rawPacket),
              {
                advertiseMode: 2, // ADVERTISE_MODE_LOW_LATENCY
                txPowerLevel: 3,  // ADVERTISE_TX_POWER_HIGH
                connectable: false,
                includeDeviceName: false,
                includeTxPowerLevel: false,
              }
            );
          }
        } catch (err) {
          // Có thể gặp khi thiết bị chưa cấp quyền phát BLE
        }
      }
    }, BLE_MESH_CONFIG.PULSE_INTERVAL_MS);
  }, []);

  /**
   * ==========================================================================
   * 5. VÒNG ĐỜI KHỞI ĐỘNG (useEffect tự động bật không cần người dùng bấm)
   * ==========================================================================
   */
  useEffect(() => {
    let isMounted = true;

    async function initMeshNode() {
      if (Platform.OS === 'web') {
        setIsNativeBleSupported(false);
        startBleScanner();
        startCarouselBroadcaster();
        setLogInfo(`Node #${nodeId} (Web Simulator) - Radar & Store-and-Forward sẵn sàng`);
        return;
      }

      const hasPerm = await requestBluetoothPermissions();
      if (!isMounted) return;

      // Kiểm tra Native BLE Advertiser
      try {
        if (BLEAdvertiser && typeof BLEAdvertiser.setCompanyId === 'function') {
          BLEAdvertiser.setCompanyId(BLE_MESH_CONFIG.COMPANY_ID);
        }
      } catch (err) {
        setIsNativeBleSupported(false);
      }

      // Khởi động Scanner ngầm định
      startBleScanner();

      // Khởi động Vòng lặp phát Carousel 120ms ngầm định
      startCarouselBroadcaster();

      setLogInfo(`Node #${nodeId} đang chạy radar quét & phát đệm ngầm...`);
    }

    initMeshNode();

    return () => {
      isMounted = false;
      if (carouselTimerRef.current) {
        clearInterval(carouselTimerRef.current);
      }
      if (bleManagerRef.current) {
        try {
          bleManagerRef.current.stopDeviceScan();
          bleManagerRef.current.destroy();
        } catch (e) {}
      }
      if (Platform.OS !== 'web') {
        try {
          if (BLEAdvertiser && typeof BLEAdvertiser.stopBroadcast === 'function') {
            BLEAdvertiser.stopBroadcast();
          }
        } catch (e) {}
      }
    };
  }, [nodeId, startBleScanner, startCarouselBroadcaster]);

  /**
   * ==========================================================================
   * 6. GỬI TIN NHẮN TỪ THIẾT BỊ NÀY (TX CHOPPING & QUEUE INJECTION)
   * ==========================================================================
   */
  const handleSendMessage = () => {
    const trimmed = inputText.trim();
    if (!trimmed) return;

    const store = cacheStoreRef.current;
    const chunks = chunkUtf8Text(trimmed, BLE_MESH_CONFIG.MAX_PAYLOAD_SIZE);
    const now = Date.now();

    chunks.forEach((chunk, index) => {
      // Sinh msgId ngẫu nhiên 32-bit chống trùng
      const msgId = Math.floor(Math.random() * 0xffffffff) >>> 0;
      const hexId = '0x' + msgId.toString(16).toUpperCase().padStart(8, '0');

      // Đóng gói 24 bytes
      const rawPacket = encodePacket({
        msgId,
        senderId: nodeId,
        ttl: BLE_MESH_CONFIG.DEFAULT_TTL,
        textPayload: chunk,
      });

      // Lưu vào Cache để chống xử lý lại gói tin của chính mình
      store.add(msgId);
      setCachedIdsList(store.getRecentIds());

      // Đẩy vào hàng đợi phát 25 nhịp xoay vòng
      store.addToRelayQueue({
        msgId,
        hexId,
        senderId: nodeId,
        ttl: BLE_MESH_CONFIG.DEFAULT_TTL,
        checksum: rawPacket[6],
        text: chunk,
        rawPacket,
        remainBroadcasts: BLE_MESH_CONFIG.BROADCAST_BURSTS,
        totalBroadcasts: BLE_MESH_CONFIG.BROADCAST_BURSTS,
        isLocal: true,
      });

      // Đưa lên giao diện Chat
      const chatItem = {
        id: `${hexId}_${now}_${index}`,
        msgId,
        hexId,
        senderId: nodeId,
        ttl: BLE_MESH_CONFIG.DEFAULT_TTL,
        text: chunk,
        timestamp: now + index,
        isLocal: true,
        relayed: false,
        broadcastProgress: '25/25',
        partInfo: chunks.length > 1 ? `[${index + 1}/${chunks.length}]` : null,
      };

      setMessages((prev) => [chatItem, ...prev]);
    });

    setQueueSnapshot(store.getQueueSnapshot());
    setInputText('');
    setLogInfo(`[TX] Đã đẩy ${chunks.length} gói tin vào hàng đợi Cache để phát!`);
  };

  /**
   * Mô phỏng nhận một gói tin trong không khí từ Node từ xa (hữu ích khi test 1 máy)
   */
  const handleSimulateIncomingPacket = () => {
    const remoteNodeId = Math.floor(Math.random() * 80) + 10;
    const testMessages = [
      'Cứu hộ khẩn cấp!',
      'Trạm #12 online',
      'Đã nhận tín hiệu',
      'Mesh không cần 4G',
      'Store & Forward',
    ];
    const testText = testMessages[Math.floor(Math.random() * testMessages.length)];
    const simMsgId = Math.floor(Math.random() * 0xffffffff) >>> 0;

    const raw = encodePacket({
      msgId: simMsgId,
      senderId: remoteNodeId,
      ttl: 4, // Đã nhảy 1 trạm
      textPayload: testText,
    });

    const decoded = decodePacket(raw);
    if (decoded.isValid) {
      handleIncomingPacket(decoded);
    }
  };

  /**
   * Đổi Node ID ngẫu nhiên
   */
  const handleChangeNodeId = () => {
    const newId = Math.floor(Math.random() * 90) + 10;
    setNodeId(newId);
    Alert.alert('Đổi Node ID', `Thiết bị của bạn đã chuyển thành Node #${newId}`);
  };

  // Tính số bytes UTF-8 hiện tại trong ô nhập liệu
  const currentInputBytes = Buffer.from(inputText, 'utf8').length;
  const estimatedPackets = Math.ceil(currentInputBytes / BLE_MESH_CONFIG.MAX_PAYLOAD_SIZE) || 1;

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor="#0B0F19" />

      {/* ===================================================================
          1. HEADER TRẠNG THÁI NODE (Node ID & Tình trạng sóng BLE)
          =================================================================== */}
      <View style={styles.header}>
        <View style={styles.nodeIdBadgeContainer}>
          <TouchableOpacity onPress={handleChangeNodeId} style={styles.nodeIdBadge} activeOpacity={0.8}>
            <View style={styles.pulsingDotGreen} />
            <Text style={styles.nodeIdText}>NODE #{nodeId}</Text>
            <Text style={styles.nodeIdSubtext}>Chạm đổi ID</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.headerStatusRight}>
          <View style={styles.statusPill}>
            <View style={[styles.statusDot, isScanning ? styles.dotGreen : styles.dotGray]} />
            <Text style={styles.statusPillText}>RADAR QUÉT: {isScanning ? 'ON' : 'OFF'}</Text>
          </View>

          <View style={styles.statusPill}>
            <View style={[styles.statusDot, isBroadcasting ? styles.dotCyan : styles.dotGray]} />
            <Text style={styles.statusPillText}>
              PHÁT CACHE: {isBroadcasting ? '120ms' : 'IDLE'}
            </Text>
          </View>
        </View>
      </View>

      {/* Thông tin chẩn đoán trạng thái */}
      <View style={styles.statusBarSecondary}>
        <Text style={styles.logInfoText} numberOfLines={1}>
          {logInfo}
        </Text>
        <View style={styles.queueCountBadge}>
          <Text style={styles.queueCountText}>Hàng đợi: {queueSnapshot.length} gói</Text>
        </View>
      </View>

      {/* ===================================================================
          2. BẢNG GIÁM SÁT BỘ NHỚ ĐỆM (Live Cache Monitor Panel)
          =================================================================== */}
      <View style={styles.cacheMonitorContainer}>
        <View style={styles.cacheMonitorHeader}>
          <Text style={styles.cacheMonitorTitle}>LIVE CACHE MONITOR (STORE-AND-FORWARD RAM)</Text>
          <TouchableOpacity onPress={handleSimulateIncomingPacket} style={styles.simButton}>
            <Text style={styles.simButtonText}>+ Giả lập sóng RX</Text>
          </TouchableOpacity>
        </View>

        {queueSnapshot.length === 0 ? (
          <View style={styles.emptyCacheBox}>
            <Text style={styles.emptyCacheText}>
              Bộ nhớ đệm rỗng (Không có gói tin đang chờ chuyển tiếp).
            </Text>
          </View>
        ) : (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.cacheCardScroll}>
            {queueSnapshot.map((item, index) => {
              const isCurrent = currentTxItem && currentTxItem.msgId === item.msgId;
              return (
                <View
                  key={`${item.msgId}_${index}`}
                  style={[styles.cacheCard, isCurrent && styles.cacheCardActive]}>
                  <View style={styles.cacheCardTopRow}>
                    <Text style={styles.cacheCardHexId}>{item.hexId}</Text>
                    {isCurrent && <Text style={styles.currentTxBadge}>TX</Text>}
                  </View>
                  <Text style={styles.cacheCardNode}>
                    Từ Node #{item.senderId} | TTL: {item.ttl}
                  </Text>
                  <View style={styles.progressContainer}>
                    <Text style={styles.cacheCardProgress}>
                      Nhịp còn: {item.remainBroadcasts}/{item.totalBroadcasts}
                    </Text>
                  </View>
                </View>
              );
            })}
          </ScrollView>
        )}
      </View>

      {/* ===================================================================
          3. KHUNG CHAT (FlatList Đảo Ngược - Inverted)
          =================================================================== */}
      <View style={styles.chatContainer}>
        <FlatList
          data={messages}
          keyExtractor={(item) => item.id}
          inverted
          contentContainerStyle={styles.chatListContent}
          renderItem={({ item }) => {
            const isMe = item.isLocal;
            return (
              <View style={[styles.messageRow, isMe ? styles.rowRight : styles.rowLeft]}>
                <View style={[styles.bubble, isMe ? styles.bubbleMe : styles.bubbleOther]}>
                  {/* Tiêu đề người gửi */}
                  <View style={styles.bubbleHeader}>
                    <Text style={styles.senderLabel}>
                      {isMe ? `Bạn (Node #${item.senderId})` : `Trạm Node #${item.senderId}`}
                    </Text>
                    {item.partInfo && <Text style={styles.partInfoText}>{item.partInfo}</Text>}
                  </View>

                  {/* Nội dung tin nhắn */}
                  <Text style={styles.messageText}>{item.text}</Text>

                  {/* Badge kỹ thuật 24-byte packet metadata */}
                  <View style={styles.techBadgeContainer}>
                    <Text style={styles.techBadgeText}>
                      ID: {item.hexId} | TTL: {item.ttl} | Đã phát: {item.broadcastProgress} lần
                    </Text>
                  </View>
                </View>
              </View>
            );
          }}
          ListEmptyComponent={
            <View style={styles.emptyChatBox}>
              <Text style={styles.emptyChatTitle}>Sóng BLE Mesh Đang Mở</Text>
              <Text style={styles.emptyChatSub}>
                Toàn bộ tin nhắn được phát dưới dạng BLE Advertising PDU 24-byte không cần ghép đôi
                hoặc Internet.
              </Text>
            </View>
          }
        />
      </View>

      {/* ===================================================================
          4. THANH NHẬP LIỆU & NÚT PHÁT QUA KHÔNG KHÍ
          =================================================================== */}
      <View style={styles.inputContainer}>
        <View style={styles.inputWrapper}>
          <TextInput
            style={styles.textInput}
            value={inputText}
            onChangeText={setInputText}
            placeholder="Nhập tin nhắn phát sóng (BLE Mesh)..."
            placeholderTextColor="#64748B"
            multiline={false}
          />
          <Text
            style={[
              styles.byteCounter,
              currentInputBytes > BLE_MESH_CONFIG.MAX_PAYLOAD_SIZE && styles.byteCounterWarning,
            ]}>
            {currentInputBytes}B {currentInputBytes > BLE_MESH_CONFIG.MAX_PAYLOAD_SIZE ? `(${estimatedPackets} gói)` : '/17B'}
          </Text>
        </View>

        <TouchableOpacity
          style={[styles.sendButton, !inputText.trim() && styles.sendButtonDisabled]}
          onPress={handleSendMessage}
          disabled={!inputText.trim()}
          activeOpacity={0.8}>
          <Text style={styles.sendButtonText}>Phát qua{'\n'}Không khí</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

/**
 * ============================================================================
 * GIAO DIỆN DARK MODE HIỆN ĐẠI (#0F172A)
 * ============================================================================
 */
const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0F172A',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 8,
    backgroundColor: '#1E293B',
    borderBottomWidth: 1,
    borderBottomColor: '#334155',
  },
  nodeIdBadgeContainer: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  nodeIdBadge: {
    backgroundColor: '#0F172A',
    borderColor: '#38BDF8',
    borderWidth: 1.5,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 6,
    flexDirection: 'column',
    alignItems: 'flex-start',
  },
  pulsingDotGreen: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#10B981',
    position: 'absolute',
    top: 6,
    right: 8,
  },
  nodeIdText: {
    color: '#38BDF8',
    fontSize: 16,
    fontWeight: '800',
    letterSpacing: 0.8,
  },
  nodeIdSubtext: {
    color: '#94A3B8',
    fontSize: 10,
    marginTop: 1,
  },
  headerStatusRight: {
    flexDirection: 'column',
    gap: 4,
  },
  statusPill: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#0F172A',
    borderRadius: 16,
    paddingHorizontal: 10,
    paddingVertical: 3,
    borderWidth: 1,
    borderColor: '#334155',
  },
  statusDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    marginRight: 6,
  },
  dotGreen: {
    backgroundColor: '#10B981',
  },
  dotCyan: {
    backgroundColor: '#38BDF8',
  },
  dotGray: {
    backgroundColor: '#64748B',
  },
  statusPillText: {
    color: '#CBD5E1',
    fontSize: 11,
    fontWeight: '700',
  },
  statusBarSecondary: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 6,
    backgroundColor: '#172033',
    borderBottomWidth: 1,
    borderBottomColor: '#334155',
  },
  logInfoText: {
    color: '#94A3B8',
    fontSize: 12,
    flex: 1,
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
  },
  queueCountBadge: {
    backgroundColor: '#334155',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 6,
    marginLeft: 8,
  },
  queueCountText: {
    color: '#38BDF8',
    fontSize: 11,
    fontWeight: '700',
  },
  cacheMonitorContainer: {
    backgroundColor: '#1E293B',
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#334155',
  },
  cacheMonitorHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    marginBottom: 8,
  },
  cacheMonitorTitle: {
    color: '#F1F5F9',
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.6,
  },
  simButton: {
    backgroundColor: '#0284C7',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  simButtonText: {
    color: '#FFFFFF',
    fontSize: 11,
    fontWeight: '700',
  },
  emptyCacheBox: {
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  emptyCacheText: {
    color: '#64748B',
    fontSize: 12,
    fontStyle: 'italic',
  },
  cacheCardScroll: {
    paddingHorizontal: 12,
    gap: 8,
  },
  cacheCard: {
    backgroundColor: '#0F172A',
    borderColor: '#334155',
    borderWidth: 1,
    borderRadius: 8,
    padding: 8,
    minWidth: 140,
  },
  cacheCardActive: {
    borderColor: '#38BDF8',
    backgroundColor: '#1E293B',
  },
  cacheCardTopRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  cacheCardHexId: {
    color: '#F8FAFC',
    fontSize: 12,
    fontWeight: '800',
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
  },
  currentTxBadge: {
    backgroundColor: '#38BDF8',
    color: '#0F172A',
    fontSize: 9,
    fontWeight: '900',
    paddingHorizontal: 4,
    paddingVertical: 1,
    borderRadius: 4,
  },
  cacheCardNode: {
    color: '#94A3B8',
    fontSize: 10,
    marginBottom: 4,
  },
  progressContainer: {
    backgroundColor: '#334155',
    borderRadius: 4,
    paddingVertical: 2,
    paddingHorizontal: 6,
  },
  cacheCardProgress: {
    color: '#34D399',
    fontSize: 10,
    fontWeight: '700',
    textAlign: 'center',
  },
  chatContainer: {
    flex: 1,
    backgroundColor: '#0F172A',
  },
  chatListContent: {
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  messageRow: {
    marginVertical: 6,
    flexDirection: 'row',
  },
  rowRight: {
    justifyContent: 'flex-end',
  },
  rowLeft: {
    justifyContent: 'flex-start',
  },
  bubble: {
    maxWidth: '85%',
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  bubbleMe: {
    backgroundColor: '#2563EB',
    borderBottomRightRadius: 2,
  },
  bubbleOther: {
    backgroundColor: '#1E293B',
    borderColor: '#334155',
    borderWidth: 1,
    borderBottomLeftRadius: 2,
  },
  bubbleHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  senderLabel: {
    color: '#93C5FD',
    fontSize: 12,
    fontWeight: '700',
  },
  partInfoText: {
    color: '#FDE047',
    fontSize: 11,
    fontWeight: '700',
  },
  messageText: {
    color: '#FFFFFF',
    fontSize: 15,
    lineHeight: 21,
    fontWeight: '500',
  },
  techBadgeContainer: {
    marginTop: 6,
    paddingTop: 4,
    borderTopWidth: 1,
    borderTopColor: 'rgba(255,255,255,0.15)',
  },
  techBadgeText: {
    color: 'rgba(255,255,255,0.7)',
    fontSize: 10,
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
  },
  emptyChatBox: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 60,
    paddingHorizontal: 20,
  },
  emptyChatTitle: {
    color: '#38BDF8',
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 8,
  },
  emptyChatSub: {
    color: '#64748B',
    fontSize: 13,
    textAlign: 'center',
    lineHeight: 18,
  },
  inputContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: '#1E293B',
    borderTopWidth: 1,
    borderTopColor: '#334155',
    gap: 8,
  },
  inputWrapper: {
    flex: 1,
    backgroundColor: '#0F172A',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#334155',
    paddingHorizontal: 12,
    paddingVertical: 6,
    justifyContent: 'center',
  },
  textInput: {
    color: '#F8FAFC',
    fontSize: 14,
    paddingVertical: 4,
  },
  byteCounter: {
    color: '#64748B',
    fontSize: 10,
    alignSelf: 'flex-end',
    marginTop: 2,
  },
  byteCounterWarning: {
    color: '#F59E0B',
    fontWeight: '700',
  },
  sendButton: {
    backgroundColor: '#2563EB',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: '#2563EB',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.4,
    shadowRadius: 4,
    elevation: 4,
  },
  sendButtonDisabled: {
    backgroundColor: '#334155',
    shadowOpacity: 0,
    elevation: 0,
  },
  sendButtonText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '800',
    textAlign: 'center',
    lineHeight: 15,
  },
});
