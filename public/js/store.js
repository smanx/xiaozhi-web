/** 本地存储：AI 配置、每个 AI 的会话记录、全局设置。全部在浏览器本地，不上传。 */

const KEY_AIS = 'xiaozhi_web_ais_v1';
const KEY_MSG_PREFIX = 'xiaozhi_web_msgs_v1_';
const KEY_SETTINGS = 'xiaozhi_web_settings_v1';

export const DEFAULT_OTA = 'https://api.tenclass.net/xiaozhi/ota/';
export const DEFAULT_WS = 'wss://api.tenclass.net/xiaozhi/v1/';

export function uid(prefix = 'id') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function randomMac() {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  bytes[0] = (bytes[0] & 0xfc) | 0x02; // 本地管理位，单播
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(':');
}

export function randomClientId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (_) {
    return fallback;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (e) {
    console.warn('存储失败', e);
  }
}

export function loadAIs() {
  const list = read(KEY_AIS, []);
  return Array.isArray(list) ? list : [];
}

export function saveAIs(list) {
  write(KEY_AIS, list);
}

export function makeAI(name = '新的 AI') {
  return {
    id: uid('ai'),
    name,
    emoji: '🤖',
    color: '#6c8cff',
    deviceMac: randomMac(),
    clientId: randomClientId(),
    token: '',
    otaUrl: DEFAULT_OTA,
    wsUrl: DEFAULT_WS,
    mode: 'auto',
    autoContinue: true,
    // 说话打断：播报期间检测到人声就自动打断，无需手动点按钮
    talkInterrupt: false,
    createdAt: Date.now(),
  };
}

export function loadMessages(aiId) {
  const list = read(KEY_MSG_PREFIX + aiId, []);
  return Array.isArray(list) ? list : [];
}

export function saveMessages(aiId, list) {
  // 只保留最近 500 条，避免 localStorage 撑爆
  write(KEY_MSG_PREFIX + aiId, list.slice(-500));
}

export function loadSettings() {
  return {
    workerBase: '',
    ...read(KEY_SETTINGS, {}),
  };
}

export function saveSettings(s) {
  write(KEY_SETTINGS, s);
}
