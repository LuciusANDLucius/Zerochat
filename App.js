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
  Modal,
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

// Bảng màu avatar theo Node ID để dễ nhận diện thiết bị
const AVATAR_COLORS = [
  '#3B82F6', '#10B981', '#F59E0B', '#EC4899', '#8B5CF6',
  '#06B6D4', '#14B8A6', '#F97316', '#6366F1', '#84CC16',
];

function getAvatarColor(id) {
  return AVATAR_COLORS[(id || 0) % AVATAR_COLORS.length];
}

// Chuyển đổi giá trị TTL thành mô tả khoảng cách trực quan cho người dùng phổ thông
function getHopDescription(ttl) {
  if (ttl >= 5) {
    return { text: 'Gửi trực tiếp (Rất gần)', color: '#10B981', icon: '🟢' };
  } else if (ttl === 4) {
    return { text: 'Qua 1 trạm trung gian (~20-50m)', color: '#38BDF8', icon: '🔵' };
  } else if (ttl === 3) {
    return { text: 'Qua 2 trạm trung gian (~50-100m)', color: '#FBBF24', icon: '🟡' };
  } else {
    return { text: 'Qua nhiều trạm (Vùng xa)', color: '#F43F5E', icon: '🟠' };
  }
}

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
  const [logInfo, setLogInfo] = useState('Đang khởi tạo trạm phát sóng BLE 5.0 Extended...');

  // Chế độ xem: Phổ thông (thân thiện) hoặc Chuyên gia (hiển thị chi tiết kỹ thuật/RAM Cache)
  const [isTechMode, setIsTechMode] = useState(false);

  // Modal xem chi tiết gói tin kỹ thuật khi bấm vào tin nhắn
  const [inspectPacket, setInspectPacket] = useState(null);

  // Modal giả lập sóng để test nhiều kịch bản
  const [isSimModalOpen, setIsSimModalOpen] = useState(false);

  // Tham chiếu giữ trạng thái logic BLE ngầm định
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
    return true; // iOS tự động xử lý qua Info.plist
  };

  /**
   * ==========================================================================
   * 2. XỬ LÝ GÓI TIN BLE 5.0 TỪ KHÔNG KHÍ (RX & STORE-AND-FORWARD AUTO RELAY)
   * ==========================================================================
   */
  const handleIncomingPacket = useCallback(
    (packet) => {
      const store = cacheStoreRef.current;
      const { msgId, hexId, senderId, ttl, timestamp, text, checksum, payloadSize, packetSize, rawBytes } = packet;

      // Bước 1: Deduplication (Chống lặp)
      // Nếu Message_ID đã nằm trong Cache 200 tin nhắn gần nhất -> Bỏ qua ngay
      if (store.has(msgId)) {
        return;
      }

      // Bước 2: Lưu Message_ID vào Cache FIFO 200
      store.add(msgId, packet);
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
        timestamp: timestamp || Math.floor(Date.now() / 1000),
        text,
        localReceivedAt: Date.now(),
        isLocal: isFromMe,
        relayed: willRelay,
        broadcastProgress: willRelay ? `${BLE_MESH_CONFIG.BROADCAST_BURSTS}/${BLE_MESH_CONFIG.BROADCAST_BURSTS}` : '0/20',
        checksum,
        payloadSize: payloadSize || Buffer.from(text, 'utf8').length,
        packetSize: packetSize || (rawBytes ? rawBytes.length : 0),
        rawBytes,
      };

      setMessages((prev) => [newMsg, ...prev]);
      setLogInfo(`Đã nhận tin BLE 5.0 (${newMsg.packetSize}B) từ Node #${senderId} | TTL ${ttl}`);

      // Bước 3: Cơ chế Trạm Cache Trung Gian Tự Động (Store-and-Forward)
      // Nếu TTL > 1, giảm TTL = TTL - 1, đóng gói lại khung BLE 5.0 và đưa vào hàng đợi phát xoay vòng
      if (willRelay) {
        const forwardedTtl = ttl - 1;
        const forwardedBytes = encodePacket({
          msgId,
          senderId,
          ttl: forwardedTtl,
          timestamp: newMsg.timestamp,
          textPayload: text,
        });

        store.addToRelayQueue({
          msgId,
          hexId,
          senderId,
          ttl: forwardedTtl,
          timestamp: newMsg.timestamp,
          checksum,
          text,
          rawPacket: forwardedBytes,
          remainBroadcasts: BLE_MESH_CONFIG.BROADCAST_BURSTS,
          totalBroadcasts: BLE_MESH_CONFIG.BROADCAST_BURSTS,
          isLocal: false,
        });

        setQueueSnapshot(store.getQueueSnapshot());
        setLogInfo(`Trạm của bạn đang tự động tiếp sóng BLE 5.0 cho Node #${senderId} (TTL mới: ${forwardedTtl})`);
      }
    },
    [nodeId]
  );

  /**
   * ==========================================================================
   * 3. KHỞI CHẠY BLE 5.0 SCANNER (Hỗ trợ Extended Advertising Frames lên tới 254B)
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
        null, // Quét toàn bộ để bắt ManufacturerData BLE 5.0
        { allowDuplicates: true },
        (error, device) => {
          if (error) {
            return;
          }

          if (!device) return;

          try {
            let packetBytes = null;

            // 1. Kiểm tra ManufacturerData (Định dạng tiêu chuẩn từ Android)
            if (device.manufacturerData) {
              const rawBuffer = Buffer.from(device.manufacturerData, 'base64');
              if (rawBuffer.length >= 14) {
                const compId = rawBuffer.readUInt16LE(0);
                if (compId === BLE_MESH_CONFIG.COMPANY_ID) {
                  packetBytes = rawBuffer.subarray(2);
                }
              } else if (rawBuffer.length >= BLE_MESH_CONFIG.HEADER_SIZE) {
                packetBytes = rawBuffer;
              }
            }

            // 2. Kiểm tra ServiceData (Định dạng CoreBluetooth của iOS khi bị hạn chế ManufacturerData)
            if (!packetBytes && device.serviceData) {
              for (const uuidKey of Object.keys(device.serviceData)) {
                if (uuidKey.toUpperCase().includes('FEED') || uuidKey.toLowerCase() === BLE_MESH_CONFIG.SERVICE_UUID.toLowerCase()) {
                  const sDataB64 = device.serviceData[uuidKey];
                  if (sDataB64) {
                    const sBuffer = Buffer.from(sDataB64, 'base64');
                    if (sBuffer.length >= BLE_MESH_CONFIG.HEADER_SIZE) {
                      packetBytes = sBuffer;
                      break;
                    }
                  }
                }
              }
            }

            if (packetBytes && packetBytes.length >= BLE_MESH_CONFIG.HEADER_SIZE) {
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
   * 4. VÒNG LẶP PHÁT BLE 5.0 EXTENDED (Carousel Cache Broadcaster - Mỗi 120ms)
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

      // Có gói tin cần phát: Cập nhật UI và bắn ra không khí qua BLE 5.0 Extended
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

      // Phát thật qua phần cứng BLE 5.0 (Low Latency, High Power)
      if (Platform.OS !== 'web') {
        try {
          if (BLEAdvertiser && typeof BLEAdvertiser.broadcast === 'function') {
            BLEAdvertiser.setCompanyId(BLE_MESH_CONFIG.COMPANY_ID);
            await BLEAdvertiser.broadcast(
              BLE_MESH_CONFIG.SERVICE_UUID,
              Array.from(item.rawPacket),
              {
                advertiseMode: 2, // ADVERTISE_MODE_LOW_LATENCY (Tối ưu độ trễ cho BLE 5.0)
                txPowerLevel: 3,  // ADVERTISE_TX_POWER_HIGH (Công suất phát tối đa)
                connectable: false,
                includeDeviceName: false,
                includeTxPowerLevel: false,
              }
            );
          }
        } catch (err) {
          // Xử lý ngoại lệ phát sóng
        }
      }
    }, BLE_MESH_CONFIG.PULSE_INTERVAL_MS);
  }, []);

  /**
   * ==========================================================================
   * 5. VÒNG ĐỜI KHỞI ĐỘNG (Tự động kích hoạt khi mở app)
   * ==========================================================================
   */
  useEffect(() => {
    let isMounted = true;

    async function initMeshNode() {
      if (Platform.OS === 'web') {
        setIsNativeBleSupported(false);
        startBleScanner();
        startCarouselBroadcaster();
        setLogInfo(`Thiết bị của bạn (#${nodeId}) - BLE 5.0 Extended (Web Simulator) sẵn sàng.`);
        return;
      }

      const hasPerm = await requestBluetoothPermissions();
      if (!isMounted) return;

      try {
        if (BLEAdvertiser && typeof BLEAdvertiser.setCompanyId === 'function') {
          BLEAdvertiser.setCompanyId(BLE_MESH_CONFIG.COMPANY_ID);
        }
      } catch (err) {
        setIsNativeBleSupported(false);
      }

      startBleScanner();
      startCarouselBroadcaster();
      setLogInfo(`Thiết bị của bạn (#${nodeId}) đang quét & phát BLE 5.0 Extended.`);
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
   * 6. GỬI TIN NHẮN BLE 5.0 (Hỗ trợ đến 220 Bytes / ~180-200 ký tự trong 1 gói)
   * ==========================================================================
   */
  const handleSendMessage = () => {
    const trimmed = inputText.trim();
    if (!trimmed) return;

    const store = cacheStoreRef.current;
    const chunks = chunkUtf8Text(trimmed, BLE_MESH_CONFIG.MAX_PAYLOAD_SIZE);
    const nowMs = Date.now();
    const epochSec = Math.floor(nowMs / 1000);

    chunks.forEach((chunk, index) => {
      const msgId = Math.floor(Math.random() * 0xffffffff) >>> 0;
      const hexId = '0x' + msgId.toString(16).toUpperCase().padStart(8, '0');

      const rawPacket = encodePacket({
        msgId,
        senderId: nodeId,
        ttl: BLE_MESH_CONFIG.DEFAULT_TTL,
        timestamp: epochSec,
        textPayload: chunk,
      });

      // Trích xuất Checksum CRC-16 đã tính
      const view = new DataView(rawPacket.buffer, rawPacket.byteOffset, rawPacket.byteLength);
      const checksum = view.getUint16(10, false);

      // Lưu vào Cache FIFO 200 để chống xử lý lại gói tin của chính mình
      store.add(msgId, { text: chunk, senderId: nodeId });
      setCachedIdsList(store.getRecentIds());

      // Đẩy vào hàng đợi phát 20 nhịp xoay vòng (120ms/nhịp)
      store.addToRelayQueue({
        msgId,
        hexId,
        senderId: nodeId,
        ttl: BLE_MESH_CONFIG.DEFAULT_TTL,
        timestamp: epochSec,
        checksum,
        text: chunk,
        rawPacket,
        remainBroadcasts: BLE_MESH_CONFIG.BROADCAST_BURSTS,
        totalBroadcasts: BLE_MESH_CONFIG.BROADCAST_BURSTS,
        isLocal: true,
      });

      const chatItem = {
        id: `${hexId}_${nowMs}_${index}`,
        msgId,
        hexId,
        senderId: nodeId,
        ttl: BLE_MESH_CONFIG.DEFAULT_TTL,
        timestamp: epochSec,
        text: chunk,
        localReceivedAt: nowMs + index,
        isLocal: true,
        relayed: false,
        broadcastProgress: `${BLE_MESH_CONFIG.BROADCAST_BURSTS}/${BLE_MESH_CONFIG.BROADCAST_BURSTS}`,
        partInfo: chunks.length > 1 ? `[${index + 1}/${chunks.length}]` : null,
        checksum,
        payloadSize: Buffer.from(chunk, 'utf8').length,
        packetSize: rawPacket.length,
        rawBytes: rawPacket,
      };

      setMessages((prev) => [chatItem, ...prev]);
    });

    setQueueSnapshot(store.getQueueSnapshot());
    setInputText('');
    setLogInfo(`Đang phát ${chunks.length} gói tin BLE 5.0 Extended ra không khí...`);
  };

  /**
   * Mô phỏng nhận gói tin nhanh (Hỗ trợ tin nhắn dài 100-200 ký tự)
   */
  const handleQuickSimulate = (customText = null, customSender = null, customTtl = 4) => {
    const remoteNodeId = customSender || Math.floor(Math.random() * 80) + 10;
    const sampleTexts = [
      '🆘 Cảnh báo khẩn cấp: Trạm cứu hộ #18 thông báo toàn bộ người dân trong khu vực di chuyển về sảnh trung tâm ngay lập tức, đem theo đèn pin và nước uống!',
      'Mất sóng 4G và Internet diện rộng, toàn bộ khu dân cư đang kích hoạt mạng Zerochat BLE 5.0 Extended để liên lạc nội bộ.',
      '📍 Tôi đang ở cửa sảnh B tầng 2, đã tập hợp được 8 người an toàn.',
      'Trạm #42 đã bắt được tín hiệu của bạn và đang tiếp sóng ra xa.',
    ];
    const textToSend = customText || sampleTexts[Math.floor(Math.random() * sampleTexts.length)];
    const simMsgId = Math.floor(Math.random() * 0xffffffff) >>> 0;
    const epochSec = Math.floor(Date.now() / 1000);

    const raw = encodePacket({
      msgId: simMsgId,
      senderId: remoteNodeId,
      ttl: customTtl,
      timestamp: epochSec,
      textPayload: textToSend,
    });

    const decoded = decodePacket(raw);
    if (decoded.isValid) {
      handleIncomingPacket(decoded);
    }
    setIsSimModalOpen(false);
  };

  /**
   * Đổi Node ID ngẫu nhiên
   */
  const handleChangeNodeId = () => {
    const newId = Math.floor(Math.random() * 90) + 10;
    setNodeId(newId);
    Alert.alert('Đổi định danh thành công', `Thiết bị của bạn hiện tại là Node #${newId}`);
  };

  // Tính số bytes UTF-8 hiện tại trong ô nhập liệu
  const currentInputBytes = Buffer.from(inputText, 'utf8').length;
  const estimatedPackets = Math.ceil(currentInputBytes / BLE_MESH_CONFIG.MAX_PAYLOAD_SIZE) || 1;

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor="#0B132B" />

      {/* ===================================================================
          1. HEADER HIỆN ĐẠI (THÔNG TIN BLE 5.0 EXTENDED ADVERTISING)
          =================================================================== */}
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <View style={styles.logoRow}>
            <View style={styles.appIconContainer}>
              <Text style={styles.appIconText}>📡</Text>
            </View>
            <View>
              <View style={styles.titleWithBadge}>
                <Text style={styles.appTitle}>Zerochat</Text>
                <View style={styles.ble5Badge}>
                  <Text style={styles.ble5BadgeText}>BLE 5.0</Text>
                </View>
              </View>
              <View style={styles.networkStatusRow}>
                <View style={[styles.pulseDot, isBroadcasting ? styles.pulseDotActive : styles.pulseDotIdle]} />
                <Text style={styles.networkStatusText}>
                  {isBroadcasting
                    ? 'Đang phát sóng BLE 5.0...'
                    : isScanning
                    ? 'Extended Adv (254B) Sẵn sàng'
                    : 'Đang khởi động'}
                </Text>
              </View>
            </View>
          </View>
        </View>

        <View style={styles.headerRight}>
          {/* Nút bật/tắt Chế độ kỹ thuật để giảng viên/chuyên gia xem RAM & Hex */}
          <TouchableOpacity
            style={[styles.techModeToggle, isTechMode && styles.techModeToggleActive]}
            onPress={() => setIsTechMode(!isTechMode)}
            activeOpacity={0.8}>
            <Text style={[styles.techModeToggleText, isTechMode && styles.techModeToggleTextActive]}>
              {isTechMode ? '🛠️ Kỹ thuật: BẬT' : '⚙️ Kỹ thuật'}
            </Text>
          </TouchableOpacity>

          {/* Badge danh tính thiết bị của bạn */}
          <TouchableOpacity
            onPress={handleChangeNodeId}
            style={[styles.userBadge, { borderColor: getAvatarColor(nodeId) }]}
            activeOpacity={0.8}>
            <View style={[styles.avatarCircleSmall, { backgroundColor: getAvatarColor(nodeId) }]}>
              <Text style={styles.avatarLetter}>#{nodeId}</Text>
            </View>
          </TouchableOpacity>
        </View>
      </View>

      {/* ===================================================================
          2. THANH TRẠNG THÁI MẠNG LƯỚI & TRẠM TRUNG GIAN
          =================================================================== */}
      <View style={styles.subHeaderBanner}>
        <View style={styles.subHeaderLeft}>
          <Text style={styles.subHeaderIcon}>📶</Text>
          <Text style={styles.subHeaderText} numberOfLines={1}>
            {queueSnapshot.length > 0
              ? `Đang chuyển tiếp ${queueSnapshot.length} gói tin BLE 5.0 (FIFO 200)`
              : logInfo}
          </Text>
        </View>

        {/* Nút mở nhanh bảng test thử */}
        <TouchableOpacity
          onPress={() => setIsSimModalOpen(true)}
          style={styles.quickSimPill}
          activeOpacity={0.8}>
          <Text style={styles.quickSimText}>+ Thử nhận tin dài</Text>
        </TouchableOpacity>
      </View>

      {/* ===================================================================
          3. BẢNG GIÁM SÁT KỸ THUẬT BLE 5.0 (Chỉ mở rộng khi bật Chế độ Kỹ thuật)
          =================================================================== */}
      {isTechMode && (
        <View style={styles.techPanel}>
          <View style={styles.techPanelHeader}>
            <View>
              <Text style={styles.techPanelTitle}>BỘ NHỚ ĐỆM BLE 5.0 (FIFO 200 ENTRIES • STORE & FORWARD)</Text>
              <Text style={styles.techPanelSub}>
                RAM Cache: {cachedIdsList.length}/200 ID • Hàng đợi phát: {queueSnapshot.length} gói (Nhịp 120ms)
              </Text>
            </View>
            <View style={styles.techSpecBadge}>
              <Text style={styles.techSpecText}>CRC-16 • 240B MAX</Text>
            </View>
          </View>

          {queueSnapshot.length === 0 ? (
            <View style={styles.techEmptyBox}>
              <Text style={styles.techEmptyText}>
                Hàng đợi chuyển tiếp rỗng. Bấm "+ Thử nhận tin dài" để kiểm chứng chuyển tiếp tự động.
              </Text>
            </View>
          ) : (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.techScroll}>
              {queueSnapshot.map((item, index) => {
                const isCurrent = currentTxItem && currentTxItem.msgId === item.msgId;
                return (
                  <View
                    key={`${item.msgId}_${index}`}
                    style={[styles.techCard, isCurrent && styles.techCardActive]}>
                    <View style={styles.techCardTop}>
                      <Text style={styles.techCardHex}>{item.hexId}</Text>
                      {isCurrent && <Text style={styles.techTxBadge}>TX EXTENDED</Text>}
                    </View>
                    <Text style={styles.techCardMeta}>
                      Node #{item.senderId} | TTL: {item.ttl} | {item.packetSize}B
                    </Text>
                    <View style={styles.techCardProgressBg}>
                      <View
                        style={[
                          styles.techCardProgressBar,
                          { width: `${(item.remainBroadcasts / item.totalBroadcasts) * 100}%` },
                        ]}
                      />
                    </View>
                    <Text style={styles.techCardCount}>
                      Nhịp còn: {item.remainBroadcasts}/{item.totalBroadcasts} (120ms)
                    </Text>
                  </View>
                );
              })}
            </ScrollView>
          )}
        </View>
      )}

      {/* ===================================================================
          4. KHUNG CHAT TIN NHẮN (GIAO DIỆN HIỆN ĐẠI, HỖ TRỢ VĂN BẢN DÀI)
          =================================================================== */}
      <View style={styles.chatArea}>
        <FlatList
          data={messages}
          keyExtractor={(item) => item.id}
          inverted
          contentContainerStyle={styles.chatListPadding}
          renderItem={({ item }) => {
            const isMe = item.isLocal;
            const hop = getHopDescription(item.ttl);
            const avatarColor = getAvatarColor(item.senderId);

            return (
              <TouchableOpacity
                activeOpacity={0.9}
                onPress={() => setInspectPacket(item)}
                style={[styles.messageRow, isMe ? styles.rowRight : styles.rowLeft]}>
                
                {/* Avatar người gửi (khi là tin nhắn của người khác) */}
                {!isMe && (
                  <View style={[styles.senderAvatar, { backgroundColor: avatarColor }]}>
                    <Text style={styles.senderAvatarText}>#{item.senderId}</Text>
                  </View>
                )}

                <View style={[styles.bubbleContainer, isMe ? styles.bubbleMeContainer : styles.bubbleOtherContainer]}>
                  {/* Tên người gửi & Khoảng cách */}
                  <View style={styles.bubbleHeaderRow}>
                    <Text style={[styles.senderName, isMe ? styles.senderNameMe : { color: avatarColor }]}>
                      {isMe ? 'Bạn' : `Thiết bị #${item.senderId}`}
                    </Text>
                    <View style={styles.metaRowRight}>
                      <Text style={styles.sizeBadge}>{item.packetSize || 0}B</Text>
                      <Text style={styles.distanceBadge}>
                        {isMe ? 'Máy gốc' : hop.text}
                      </Text>
                    </View>
                  </View>

                  {/* Nội dung tin nhắn chính (hỗ trợ văn bản dài thoải mái) */}
                  <Text style={[styles.messageBody, isMe ? styles.messageBodyMe : styles.messageBodyOther]}>
                    {item.text}
                  </Text>

                  {/* Thanh trạng thái phụ bên dưới bong bóng */}
                  <View style={styles.bubbleFooter}>
                    {item.relayed && !isMe ? (
                      <View style={styles.relayIndicator}>
                        <Text style={styles.relayIcon}>🔄</Text>
                        <Text style={styles.relayText}>Đã tiếp sóng BLE 5.0 ({item.broadcastProgress})</Text>
                      </View>
                    ) : isMe ? (
                      <Text style={styles.deliveryStatus}>
                        {item.broadcastProgress === '0/20'
                          ? '✓ Đã phát sóng xong'
                          : `📡 Đang phát sóng (${item.broadcastProgress})`}
                      </Text>
                    ) : (
                      <Text style={styles.inspectHint}>Chạm để xem chi tiết gói BLE 5.0</Text>
                    )}
                  </View>

                  {/* Hiển thị chi tiết kỹ thuật nếu đang bật Chế độ Kỹ thuật */}
                  {isTechMode && (
                    <View style={styles.techBadgeBox}>
                      <Text style={styles.techBadgeText}>
                        ID: {item.hexId} | TTL: {item.ttl} | CRC16: 0x{(item.checksum || 0).toString(16).toUpperCase()} | Size: {item.packetSize}B
                      </Text>
                    </View>
                  )}
                </View>
              </TouchableOpacity>
            );
          }}
          ListEmptyComponent={
            <View style={styles.emptyContainer}>
              <View style={styles.emptyIconBg}>
                <Text style={styles.emptyIcon}>📡</Text>
              </View>
              <Text style={styles.emptyTitle}>Chuẩn Bluetooth 5.0+ Extended Advertising</Text>
              <Text style={styles.emptyDesc}>
                Zerochat đã được nâng cấp lên chuẩn BLE 5.0, hỗ trợ gửi các đoạn tin nhắn dài tới 180-200
                ký tự tiếng Việt trong 1 gói tin duy nhất (tối đa 254 bytes) mà không cần 4G hay Internet.
              </Text>

              {/* Gợi ý tin nhắn dài nhanh */}
              <View style={styles.suggestionsContainer}>
                <Text style={styles.suggestionTitle}>Tin nhắn thử nghiệm BLE 5.0:</Text>
                <View style={styles.suggestionPills}>
                  {[
                    '🆘 Khẩn cấp! Cần nước uống và y tế tại cổng A.',
                    '📡 Kiểm tra sóng BLE 5.0 Extended không cần mạng 4G!',
                    '📍 Tôi đã đến điểm tập kết an toàn cùng 5 người.',
                  ].map((s, idx) => (
                    <TouchableOpacity
                      key={idx}
                      onPress={() => setInputText(s)}
                      style={styles.suggestionBtn}>
                      <Text style={styles.suggestionBtnText}>{s}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </View>
            </View>
          }
        />
      </View>

      {/* ===================================================================
          5. THANH NHẬP LIỆU BLE 5.0 (HỖ TRỢ 220 BYTES TRONG 1 LẦN PHÁT)
          =================================================================== */}
      <View style={styles.inputBarContainer}>
        <View style={styles.inputInnerCard}>
          <TextInput
            style={styles.textInputField}
            value={inputText}
            onChangeText={setInputText}
            placeholder="Nhập tin nhắn dài phát sóng BLE 5.0..."
            placeholderTextColor="#94A3B8"
            multiline={false}
          />

          {/* Bộ đếm dung lượng theo chuẩn gói BLE 5.0 Extended 220 Bytes Payload */}
          {inputText.length > 0 && (
            <View style={styles.byteIndicatorPill}>
              <Text
                style={[
                  styles.byteIndicatorText,
                  currentInputBytes > BLE_MESH_CONFIG.MAX_PAYLOAD_SIZE && styles.byteIndicatorWarning,
                ]}>
                {currentInputBytes > BLE_MESH_CONFIG.MAX_PAYLOAD_SIZE
                  ? `📦 Tự động chia ${estimatedPackets} gói BLE 5.0`
                  : `${currentInputBytes}/220 bytes (1 gói BLE 5.0)`}
              </Text>
            </View>
          )}
        </View>

        <TouchableOpacity
          style={[styles.sendButton, !inputText.trim() && styles.sendButtonDisabled]}
          onPress={handleSendMessage}
          disabled={!inputText.trim()}
          activeOpacity={0.8}>
          <Text style={styles.sendButtonText}>Gửi sóng</Text>
        </TouchableOpacity>
      </View>

      {/* ===================================================================
          6. MODAL XEM CHI TIẾT GÓI TIN BLE 5.0 (KHI CHẠM VÀO TIN NHẮN)
          =================================================================== */}
      <Modal
        visible={!!inspectPacket}
        transparent
        animationType="fade"
        onRequestClose={() => setInspectPacket(null)}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <View style={styles.modalHeader}>
              <View>
                <Text style={styles.modalTitle}>Giải phẫu gói tin BLE 5.0 Extended</Text>
                <Text style={styles.modalSubHeader}>Chuẩn PDU tối đa 254 Bytes không kết nối</Text>
              </View>
              <TouchableOpacity onPress={() => setInspectPacket(null)} style={styles.modalCloseBtn}>
                <Text style={styles.modalCloseText}>✕</Text>
              </TouchableOpacity>
            </View>

            {inspectPacket && (
              <ScrollView style={styles.modalBody}>
                <View style={styles.modalFieldRow}>
                  <Text style={styles.modalFieldLabel}>Nội dung văn bản ({inspectPacket.payloadSize} Bytes UTF-8):</Text>
                  <Text style={styles.modalFieldValueBold}>{inspectPacket.text}</Text>
                </View>

                <View style={styles.modalGridRow}>
                  <View style={[styles.modalFieldRow, { flex: 1, marginRight: 6 }]}>
                    <Text style={styles.modalFieldLabel}>Mã định danh (msgId):</Text>
                    <Text style={styles.modalFieldHex}>{inspectPacket.hexId}</Text>
                  </View>

                  <View style={[styles.modalFieldRow, { flex: 1, marginLeft: 6 }]}>
                    <Text style={styles.modalFieldLabel}>Thiết bị gốc (senderId):</Text>
                    <Text style={styles.modalFieldValue}>Node #{inspectPacket.senderId}</Text>
                  </View>
                </View>

                <View style={styles.modalGridRow}>
                  <View style={[styles.modalFieldRow, { flex: 1, marginRight: 6 }]}>
                    <Text style={styles.modalFieldLabel}>Số bước nhảy (TTL):</Text>
                    <Text style={styles.modalFieldValue}>{inspectPacket.ttl} / 5 bước</Text>
                  </View>

                  <View style={[styles.modalFieldRow, { flex: 1, marginLeft: 6 }]}>
                    <Text style={styles.modalFieldLabel}>Tổng kích thước gói:</Text>
                    <Text style={styles.modalFieldValueGreen}>{inspectPacket.packetSize || (12 + (inspectPacket.payloadSize || 0))} Bytes</Text>
                  </View>
                </View>

                <View style={styles.modalFieldRow}>
                  <Text style={styles.modalFieldLabel}>Thời điểm gửi (Unix Epoch Timestamp):</Text>
                  <Text style={styles.modalFieldValue}>
                    {inspectPacket.timestamp ? new Date(inspectPacket.timestamp * 1000).toLocaleString('vi-VN') : 'Vừa xong'}
                  </Text>
                </View>

                <View style={styles.modalFieldRow}>
                  <Text style={styles.modalFieldLabel}>Mã kiểm tra lỗi chống nhiễu (CRC-16-CCITT):</Text>
                  <Text style={styles.modalFieldValueGreen}>
                    0x{(inspectPacket.checksum || 0).toString(16).toUpperCase().padStart(4, '0')} (Hợp lệ ✓)
                  </Text>
                </View>

                <View style={styles.modalFieldRow}>
                  <Text style={styles.modalFieldLabel}>Cơ chế RAM Cache Store-and-Forward:</Text>
                  <Text style={styles.modalFieldValue}>
                    {inspectPacket.isLocal
                      ? 'Thiết bị này tạo và phát 20 nhịp xoay vòng (120ms/nhịp).'
                      : inspectPacket.relayed
                      ? 'Thiết bị này đã nhận, giảm TTL còn ' + inspectPacket.ttl + ' và đưa vào hàng đợi phát xoay vòng giúp trạm xung quanh.'
                      : 'Đã nhận thành công và lưu vào RAM Cache FIFO (200 ID).'}
                  </Text>
                </View>
              </ScrollView>
            )}

            <TouchableOpacity
              onPress={() => setInspectPacket(null)}
              style={styles.modalConfirmBtn}
              activeOpacity={0.8}>
              <Text style={styles.modalConfirmText}>Đóng</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* ===================================================================
          7. MODAL GIẢ LẬP NHẬN SÓNG TIN NHẮN DÀI BLE 5.0
          =================================================================== */}
      <Modal
        visible={isSimModalOpen}
        transparent
        animationType="slide"
        onRequestClose={() => setIsSimModalOpen(false)}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <View style={styles.modalHeader}>
              <View>
                <Text style={styles.modalTitle}>Mô phỏng nhận tin dài BLE 5.0</Text>
                <Text style={styles.modalSubHeader}>Kiểm chứng gói Extended Advertising trong 1 PDU</Text>
              </View>
              <TouchableOpacity onPress={() => setIsSimModalOpen(false)} style={styles.modalCloseBtn}>
                <Text style={styles.modalCloseText}>✕</Text>
              </TouchableOpacity>
            </View>

            <Text style={styles.modalSubDesc}>
              Chọn một kịch bản tin nhắn dài (100 - 180 ký tự tiếng Việt) để kiểm chứng khả năng truyền
              nguyên khối của chuẩn Bluetooth 5.0:
            </Text>

            <View style={styles.simPresetList}>
              {[
                {
                  title: '🆘 Báo nguy khẩn cấp (145 ký tự tiếng Việt)',
                  text: '🆘 Cảnh báo bão: Trạm cứu hộ #18 thông báo toàn bộ người dân trong khu vực di chuyển về sảnh trung tâm ngay lập tức, đem theo đèn pin và nước uống!',
                  sender: 18,
                  ttl: 4,
                },
                {
                  title: '📶 Báo cáo mất mạng diện rộng (108 ký tự)',
                  text: 'Mất sóng 4G và Internet diện rộng, toàn bộ khu dân cư đang kích hoạt mạng Zerochat BLE 5.0 Extended để liên lạc nội bộ.',
                  sender: 33,
                  ttl: 5,
                },
                {
                  title: '📍 Tin từ trạm xa trung chuyển (TTL = 2)',
                  text: 'Trạm #72 đang tiếp sóng từ vùng trũng, cần hỗ trợ mở rộng bán kính Mesh ra quốc lộ 1A.',
                  sender: 72,
                  ttl: 2,
                },
              ].map((item, idx) => (
                <TouchableOpacity
                  key={idx}
                  onPress={() => handleQuickSimulate(item.text, item.sender, item.ttl)}
                  style={styles.simPresetItem}
                  activeOpacity={0.8}>
                  <View style={styles.simPresetHeader}>
                    <Text style={styles.simPresetTitle}>{item.title}</Text>
                    <Text style={styles.simPresetNode}>Từ Node #{item.sender}</Text>
                  </View>
                  <Text style={styles.simPresetContent}>"{item.text}"</Text>
                </TouchableOpacity>
              ))}
            </View>

            <TouchableOpacity
              onPress={() => handleQuickSimulate()}
              style={styles.simRandomBtn}
              activeOpacity={0.8}>
              <Text style={styles.simRandomBtnText}>🎲 Tạo tin nhắn dài ngẫu nhiên</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

/**
 * ============================================================================
 * HỆ THỐNG GIAO DIỆN HIỆN ĐẠI (DARK THEME #0B132B / #1C2541)
 * ============================================================================
 */
const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0B132B',
  },

  // 1. Header
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 10,
    backgroundColor: '#1C2541',
    borderBottomWidth: 1,
    borderBottomColor: '#2A3B5C',
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  logoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  appIconContainer: {
    width: 40,
    height: 40,
    borderRadius: 10,
    backgroundColor: '#0B132B',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#38BDF8',
  },
  appIconText: {
    fontSize: 20,
  },
  titleWithBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  appTitle: {
    fontSize: 18,
    fontWeight: '800',
    color: '#F8FAFC',
    letterSpacing: 0.5,
  },
  ble5Badge: {
    backgroundColor: '#0369A1',
    borderRadius: 4,
    paddingHorizontal: 5,
    paddingVertical: 1,
  },
  ble5BadgeText: {
    fontSize: 9,
    fontWeight: '800',
    color: '#38BDF8',
    letterSpacing: 0.5,
  },
  networkStatusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 2,
  },
  pulseDot: {
    width: 7,
    height: 7,
    borderRadius: 3.5,
  },
  pulseDotActive: {
    backgroundColor: '#38BDF8',
  },
  pulseDotIdle: {
    backgroundColor: '#10B981',
  },
  networkStatusText: {
    fontSize: 11,
    color: '#94A3B8',
    fontWeight: '500',
  },
  headerRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  techModeToggle: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: '#0B132B',
    borderWidth: 1,
    borderColor: '#334155',
  },
  techModeToggleActive: {
    backgroundColor: '#1E293B',
    borderColor: '#38BDF8',
  },
  techModeToggleText: {
    fontSize: 11,
    color: '#94A3B8',
    fontWeight: '600',
  },
  techModeToggleTextActive: {
    color: '#38BDF8',
  },
  userBadge: {
    borderWidth: 1.5,
    borderRadius: 20,
    padding: 2,
  },
  avatarCircleSmall: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarLetter: {
    fontSize: 12,
    fontWeight: '800',
    color: '#FFFFFF',
  },

  // 2. Subheader Banner
  subHeaderBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 8,
    backgroundColor: '#0F172A',
    borderBottomWidth: 1,
    borderBottomColor: '#1E293B',
  },
  subHeaderLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flex: 1,
  },
  subHeaderIcon: {
    fontSize: 12,
  },
  subHeaderText: {
    fontSize: 12,
    color: '#CBD5E1',
    flex: 1,
  },
  quickSimPill: {
    backgroundColor: '#1E293B',
    borderWidth: 1,
    borderColor: '#38BDF8',
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  quickSimText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#38BDF8',
  },

  // 3. Tech Panel (Live Cache Monitor)
  techPanel: {
    backgroundColor: '#090E17',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#1E293B',
  },
  techPanelHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  techPanelTitle: {
    fontSize: 10,
    fontWeight: '800',
    color: '#38BDF8',
    letterSpacing: 0.5,
  },
  techPanelSub: {
    fontSize: 10,
    color: '#64748B',
    marginTop: 2,
  },
  techSpecBadge: {
    backgroundColor: '#0F2744',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: '#0284C7',
  },
  techSpecText: {
    fontSize: 9,
    fontWeight: '700',
    color: '#38BDF8',
  },
  techEmptyBox: {
    paddingVertical: 10,
    alignItems: 'center',
  },
  techEmptyText: {
    fontSize: 11,
    color: '#475569',
    fontStyle: 'italic',
  },
  techScroll: {
    gap: 10,
    paddingBottom: 4,
  },
  techCard: {
    backgroundColor: '#1E293B',
    borderRadius: 10,
    padding: 10,
    minWidth: 160,
    borderWidth: 1,
    borderColor: '#334155',
  },
  techCardActive: {
    borderColor: '#38BDF8',
    backgroundColor: '#0F2744',
  },
  techCardTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  techCardHex: {
    fontSize: 12,
    fontWeight: '800',
    color: '#F8FAFC',
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
  },
  techTxBadge: {
    fontSize: 9,
    fontWeight: '800',
    color: '#38BDF8',
    backgroundColor: '#0369A1',
    paddingHorizontal: 4,
    paddingVertical: 1,
    borderRadius: 4,
  },
  techCardMeta: {
    fontSize: 10,
    color: '#94A3B8',
    marginBottom: 6,
  },
  techCardProgressBg: {
    height: 4,
    backgroundColor: '#334155',
    borderRadius: 2,
    overflow: 'hidden',
    marginBottom: 4,
  },
  techCardProgressBar: {
    height: '100%',
    backgroundColor: '#38BDF8',
  },
  techCardCount: {
    fontSize: 9,
    color: '#CBD5E1',
  },

  // 4. Chat Feed
  chatArea: {
    flex: 1,
    backgroundColor: '#0B132B',
  },
  chatListPadding: {
    paddingHorizontal: 16,
    paddingVertical: 14,
    gap: 14,
  },
  messageRow: {
    flexDirection: 'row',
    marginVertical: 4,
  },
  rowLeft: {
    justifyContent: 'flex-start',
  },
  rowRight: {
    justifyContent: 'flex-end',
  },
  senderAvatar: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 8,
    marginTop: 2,
  },
  senderAvatarText: {
    color: '#FFFFFF',
    fontSize: 10,
    fontWeight: '800',
  },
  bubbleContainer: {
    maxWidth: '85%',
    borderRadius: 18,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  bubbleMeContainer: {
    backgroundColor: '#1D4ED8',
    borderBottomRightRadius: 4,
  },
  bubbleOtherContainer: {
    backgroundColor: '#1E293B',
    borderBottomLeftRadius: 4,
    borderWidth: 1,
    borderColor: '#334155',
  },
  bubbleHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    marginBottom: 4,
  },
  senderName: {
    fontSize: 12,
    fontWeight: '700',
  },
  senderNameMe: {
    color: '#93C5FD',
  },
  metaRowRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  sizeBadge: {
    fontSize: 9,
    fontWeight: '700',
    color: '#38BDF8',
    backgroundColor: 'rgba(56, 189, 248, 0.15)',
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 4,
  },
  distanceBadge: {
    fontSize: 10,
    color: '#CBD5E1',
    opacity: 0.85,
  },
  messageBody: {
    fontSize: 15,
    lineHeight: 22,
  },
  messageBodyMe: {
    color: '#FFFFFF',
    fontWeight: '500',
  },
  messageBodyOther: {
    color: '#F1F5F9',
  },
  bubbleFooter: {
    marginTop: 6,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
  },
  deliveryStatus: {
    fontSize: 10,
    color: '#BFDBFE',
  },
  relayIndicator: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  relayIcon: {
    fontSize: 10,
  },
  relayText: {
    fontSize: 10,
    color: '#38BDF8',
    fontWeight: '600',
  },
  inspectHint: {
    fontSize: 9,
    color: '#64748B',
    fontStyle: 'italic',
  },
  techBadgeBox: {
    marginTop: 6,
    paddingTop: 6,
    borderTopWidth: 1,
    borderTopColor: 'rgba(255, 255, 255, 0.1)',
  },
  techBadgeText: {
    fontSize: 9,
    color: '#94A3B8',
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
  },

  // Empty State
  emptyContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
    paddingVertical: 40,
    transform: [{ scaleY: -1 }],
  },
  emptyIconBg: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: '#1E293B',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 16,
    borderWidth: 1,
    borderColor: '#38BDF8',
  },
  emptyIcon: {
    fontSize: 30,
  },
  emptyTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#F8FAFC',
    textAlign: 'center',
    marginBottom: 8,
  },
  emptyDesc: {
    fontSize: 13,
    color: '#94A3B8',
    textAlign: 'center',
    lineHeight: 19,
    marginBottom: 20,
  },
  suggestionsContainer: {
    width: '100%',
    backgroundColor: '#1E293B',
    borderRadius: 14,
    padding: 14,
    borderWidth: 1,
    borderColor: '#334155',
  },
  suggestionTitle: {
    fontSize: 11,
    fontWeight: '700',
    color: '#38BDF8',
    marginBottom: 8,
    textTransform: 'uppercase',
  },
  suggestionPills: {
    flexDirection: 'column',
    gap: 8,
  },
  suggestionBtn: {
    backgroundColor: '#0F172A',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: '#475569',
  },
  suggestionBtnText: {
    fontSize: 12,
    color: '#E2E8F0',
    lineHeight: 18,
  },

  // 5. Input Bar
  inputBarContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: '#1C2541',
    borderTopWidth: 1,
    borderTopColor: '#2A3B5C',
    gap: 8,
  },
  inputInnerCard: {
    flex: 1,
    backgroundColor: '#0B132B',
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: '#334155',
  },
  textInputField: {
    color: '#F8FAFC',
    fontSize: 14,
    padding: 0,
    minHeight: 24,
  },
  byteIndicatorPill: {
    marginTop: 4,
    alignSelf: 'flex-end',
  },
  byteIndicatorText: {
    fontSize: 10,
    color: '#64748B',
  },
  byteIndicatorWarning: {
    color: '#F59E0B',
    fontWeight: '600',
  },
  sendButton: {
    backgroundColor: '#2563EB',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendButtonDisabled: {
    backgroundColor: '#334155',
    opacity: 0.6,
  },
  sendButtonText: {
    color: '#FFFFFF',
    fontWeight: '700',
    fontSize: 13,
  },

  // 6. Modal Styles
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.75)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  modalCard: {
    width: '100%',
    maxHeight: '88%',
    backgroundColor: '#1E293B',
    borderRadius: 18,
    padding: 18,
    borderWidth: 1,
    borderColor: '#38BDF8',
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
    paddingBottom: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#334155',
  },
  modalTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#F8FAFC',
  },
  modalSubHeader: {
    fontSize: 11,
    color: '#38BDF8',
    marginTop: 2,
  },
  modalCloseBtn: {
    padding: 4,
  },
  modalCloseText: {
    fontSize: 16,
    color: '#94A3B8',
    fontWeight: '700',
  },
  modalBody: {
    marginBottom: 14,
  },
  modalSubDesc: {
    fontSize: 12,
    color: '#94A3B8',
    lineHeight: 18,
    marginBottom: 14,
  },
  modalGridRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  modalFieldRow: {
    marginBottom: 10,
    backgroundColor: '#0F172A',
    padding: 10,
    borderRadius: 8,
  },
  modalFieldLabel: {
    fontSize: 11,
    color: '#94A3B8',
    marginBottom: 2,
  },
  modalFieldValue: {
    fontSize: 13,
    color: '#F1F5F9',
  },
  modalFieldValueBold: {
    fontSize: 14,
    fontWeight: '700',
    color: '#FFFFFF',
    lineHeight: 20,
  },
  modalFieldHex: {
    fontSize: 13,
    fontWeight: '800',
    color: '#38BDF8',
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
  },
  modalFieldValueGreen: {
    fontSize: 13,
    color: '#10B981',
    fontWeight: '700',
  },
  modalConfirmBtn: {
    backgroundColor: '#2563EB',
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: 'center',
  },
  modalConfirmText: {
    color: '#FFFFFF',
    fontWeight: '700',
    fontSize: 14,
  },
  simPresetList: {
    gap: 10,
    marginBottom: 14,
  },
  simPresetItem: {
    backgroundColor: '#0F172A',
    borderRadius: 10,
    padding: 12,
    borderWidth: 1,
    borderColor: '#334155',
  },
  simPresetHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  simPresetTitle: {
    fontSize: 12,
    fontWeight: '700',
    color: '#38BDF8',
    flex: 1,
    marginRight: 6,
  },
  simPresetNode: {
    fontSize: 11,
    color: '#94A3B8',
  },
  simPresetContent: {
    fontSize: 12,
    color: '#E2E8F0',
    fontStyle: 'italic',
    lineHeight: 17,
  },
  simRandomBtn: {
    backgroundColor: '#0F172A',
    borderWidth: 1,
    borderColor: '#475569',
    borderRadius: 10,
    paddingVertical: 10,
    alignItems: 'center',
  },
  simRandomBtnText: {
    color: '#CBD5E1',
    fontWeight: '600',
    fontSize: 12,
  },
});
