/**
 * ============================================================================
 * BLE MESH ENGINE (BACKWARDS COMPATIBILITY WRAPPER)
 * File: src/bleMeshEngine.js
 * ============================================================================
 * 
 * File này đóng vai trò chuyển tiếp (Proxy Re-export) tới thư mục module mới:
 * `src/bleMeshEngine/index.js`
 * 
 * Đảm bảo tương thích ngược 100% với các import cũ:
 * `import { ... } from './src/bleMeshEngine';`
 */

export * from './bleMeshEngine/index.js';
