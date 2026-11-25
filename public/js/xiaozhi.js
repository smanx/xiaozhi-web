/**
 * 小智官方 WebSocket 协议的浏览器实现。
 * 逻辑对齐 workdayAlarmClockAndroid 的 XiaozhiAssistant + XiaozhiStateMachine：
 * OTA 拿 ws/token -> wss 握手 -> hello -> listen/start -> opus 上行 ->
 * stt / llm / tts 下行 -> 播报排空后自动续听。
 */
import { AudioEngine } from './audio.js';

const PROTOCOL_VERSION = 1;
const HELLO_TIMEOUT_MS = 10000;
const MAX_RECONNECT = 5;
const MAX_LEAD_LENGTH = 8;
// 自动打断（对齐官方 App 的“说话打断”）：播报期间连续多帧高音量视为人在说话
// 浏览器经过 AEC/AGC 后音量比裸麦低，阈值按实测调低，避免开了却永远触发不了
const INTERRUPT_MIN_RMS = 150;
const INTERRUPT_HITS = 5; // 每帧 ~60ms，约 300ms
const INTERRUPT_GUARD_MS = 300; // 起播保护，避开 TTS 淡入/爆音
const INTERRUPT_COOLDOWN_MS = 1000; // 打断后冷却，避免同一句连环触发
// 预滚：播报期间缓存最近若干帧，打断后重新聆听时补发，保住打断时说的话
const PREROLL_FRAMES = 10; // 60ms/帧，约 600ms

const S = {
  IDLE: 'idle',
  CONNECTING: 'connecting',
  HANDSHAKING: 'handshaking',
  LISTENING: 'listening',
  THINKING: 'thinking',
  SPEAKING: 'speaking',
  ERROR: 'error',
};

const STATE_LABEL = {
  [S.IDLE]: '未连接',
  [S.CONNECTING]: '连接中…',
  [S.HANDSHAKING]: '握手中…',
  [S.LISTENING]: '聆听中…',
  [S.THINKING]: '思考中…',
  [S.SPEAKING]: '说话中…',
  [S.ERROR]: '出错',
};

const MCP_MODERN = '2026-07-28';
const MCP_LEGACY = '2024-11-05';
const META_PV = 'io.modelcontextprotocol/protocolVersion';
const META_SI = 'io.modelcontextprotocol/serverInfo';

export class XiaozhiSession {
  constructor({ ai, workerBase, callbacks = {} }) {
    this.ai = ai;
    this.workerBase = (workerBase || location.origin).replace(/\/+$/, '');
    this.cb = callbacks;

    this.state = S.IDLE;
    this.active = false;
    this.ws = null;
    this.wsUrl = '';
    this.token = '';
    this.sessionId = '';
    this.reconnectCount = 0;
    this.stopAfterTurn = false;
    this.turnLead = '';
    // 一条 AI 回复可能拆成多句 sentence_start 发来，这里标记当前回复是否已开过气泡
    this.assistantTurnOpened = false;
    this.helloTimer = null;
    this.reconnectTimer = null;
    this.intentionallyClosed = false;
    this.audioPackets = 0;
    // 不再用独立布尔标志：是否上行音频直接由 state 决定，避免标志与状态失步
    this.speakingSinceAt = 0;
    this.interruptHits = 0;
    this.lastAutoInterruptAt = 0;
    this.preroll = [];

    this.audio = new AudioEngine({
      onPacket: (packet) => {
        if (!this.active || this.intentionallyClosed) return;
        if (this.state !== S.LISTENING) {
          // 播报/思考期间不往上发，但把最近几帧存下来，打断时补发
          this.preroll.push(packet);
          if (this.preroll.length > PREROLL_FRAMES) this.preroll.shift();
          return;
        }
        if (this.listenPhasePackets === 0) this._log('上行音频已开始发送');
        this.listenPhasePackets++;
        this._sendBinary(packet);
      },
      onLevel: (rms) => {
        this.cb.onLevel?.(rms);
        this._detectTalkInterrupt(rms);
      },
      onDrained: () => this._onPlaybackDrained(),
      log: (m) => this._log(m),
    });
  }

  get isActive() {
    return this.active;
  }

  _log(message) {
    this.cb.log?.(message);
  }

  _setState(next, caption) {
    if (this.state === next && !caption) return;
    const previous = this.state;
    this.state = next;
    if (next === S.SPEAKING && previous !== S.SPEAKING) {
      this.speakingSinceAt = performance.now();
      this.interruptHits = 0;
      this.interruptPeak = 0;
    } else if (next !== S.SPEAKING) {
      this.speakingSinceAt = 0;
      this.interruptHits = 0;
    }
    this.cb.onState?.(next, STATE_LABEL[next] || next, caption);
  }

  /** 播报期间检测人声，满足条件自动打断（跑在采集回调里，只做几次比较） */
  _detectTalkInterrupt(rms) {
    if (!this.ai.talkInterrupt) return;
    if (this.state !== S.SPEAKING) return;
    const since = this.speakingSinceAt;
    if (!since) return;
    const now = performance.now();
    this.interruptPeak = Math.max(this.interruptPeak || 0, rms);
    if (now - (this.lastInterruptDebugAt || 0) > 1500) {
      this.lastInterruptDebugAt = now;
      this._log(
        `[自动打断] 播报中音量峰值 ${Math.round(this.interruptPeak)}（阈值 ${INTERRUPT_MIN_RMS}）`
      );
      this.interruptPeak = 0;
    }
    if (now - since < INTERRUPT_GUARD_MS) return;
    if (now - this.lastAutoInterruptAt < INTERRUPT_COOLDOWN_MS) return;

    if (rms >= INTERRUPT_MIN_RMS) {
      this.interruptHits++;
      if (this.interruptHits >= INTERRUPT_HITS) {
        this.interruptHits = 0;
        this.lastAutoInterruptAt = now;
        this._log(`自动打断：检测到人声 rms=${Math.round(rms)}`);
        this.interrupt();
      }
    } else {
      this.interruptHits = 0;
    }
  }

  // ---------------------------------------------------------------- 对外入口

  async start() {
    if (this.active) return;
    this.active = true;
    this.intentionallyClosed = false;
    this.reconnectCount = 0;
    this.turnLead = '';
    this.assistantTurnOpened = false;
    this.stopAfterTurn = false;
    this.audioPackets = 0;
    this.listenPhasePackets = 0;
    this.interruptHits = 0;
    this.lastAutoInterruptAt = 0;
    this.interruptPeak = 0;
    this.lastInterruptDebugAt = 0;
    this.preroll = [];
    this._log(this.ai.talkInterrupt ? '自动打断：已开启' : '自动打断：未开启');
    this._setState(S.CONNECTING);
    this.cb.onCaption?.('连接中…');
    try {
      await this.audio.init();
      await this._resolveEndpointAndConnect();
    } catch (e) {
      this._fail(`启动失败：${e.message}`);
    }
  }

  /** 通话中再次点击：打断并立刻重新聆听 */
  interrupt() {
    if (!this.active) return;
    if (this.state === S.CONNECTING || this.state === S.HANDSHAKING) {
      this._log('还在连接中，忽略打断');
      return;
    }
    this._log('打断，重新聆听');
    this.turnLead = '';
    this.stopAfterTurn = false;
    this.audio.flushPlayback();
    this._send({ type: 'abort', reason: 'wake_word_detected' });
    this._beginListening();
  }

  /** 主动结束整段会话 */
  end(reason = '已结束') {
    if (!this.active && this.state === S.IDLE) return;
    this._log(`结束会话：${reason}（本次共发送音频包 ${this.audioPackets} 个）`);
    this.intentionallyClosed = true;
    this._clearTimers();
    this._sendListenStop();
    this._closeWs();
    this.audio.flushPlayback();
    this.audio.stopCapture();
    this.preroll = [];
    this.active = false;
    this._setState(S.IDLE);
    this.cb.onCaption?.('');
    this.cb.onEnded?.(reason);
  }

  close() {
    this.end('关闭');
    this.audio.close();
  }

  // ---------------------------------------------------------------- OTA

  _deviceHeaders(extra = {}) {
    return {
      'Content-Type': 'application/json',
      'X-Device-Id': this.ai.deviceMac,
      'X-Client-Id': this.ai.clientId,
      'X-Language': 'zh-CN',
      'X-User-Agent': 'generic/1.0',
      'X-Activation-Version': '1',
      ...extra,
    };
  }

  _otaBody() {
    return JSON.stringify({
      version: 2,
      language: 'zh-CN',
      mac_address: this.ai.deviceMac,
      uuid: this.ai.clientId,
      application: { name: 'xiaozhi', version: '1.0' },
      board: {
        type: 'generic',
        name: 'WebClient',
        manufacturer: '',
        mac: this.ai.deviceMac,
      },
      protocol: { features: { mcp: true, mcp_20260728: true } },
    });
  }

  async _requestOta() {
    const target = `${this.workerBase}/api/ota?ota=${encodeURIComponent(this.ai.otaUrl)}`;
    const resp = await fetch(target, {
      method: 'POST',
      headers: this._deviceHeaders(),
      body: this._otaBody(),
    });
    const text = await resp.text();
    let data = {};
    try {
      data = JSON.parse(text);
    } catch (_) {
      throw new Error(`OTA 返回非 JSON (HTTP ${resp.status})：${text.slice(0, 120)}`);
    }
    if (!resp.ok && !data.websocket && !data.activation) {
      throw new Error(data.error || data.message || `OTA HTTP ${resp.status}`);
    }
    return data;
  }

  async _requestActivate() {
    const target = `${this.workerBase}/api/activate?ota=${encodeURIComponent(this.ai.otaUrl)}`;
    const resp = await fetch(target, {
      method: 'POST',
      headers: this._deviceHeaders(),
      body: '{}',
    });
    return { status: resp.status, text: await resp.text() };
  }

  async _resolveEndpointAndConnect() {
    if (this.ai.token) {
      this.connect(this.ai.wsUrl, this.ai.token);
      return;
    }
    // 未绑定：拿激活码并轮询，直到用户在 xiaozhi.me 绑定这台设备
    for (let attempt = 0; attempt < 100 && this.active && !this.intentionallyClosed; attempt++) {
      const ota = await this._requestOta();

      // 官方固件的判定顺序：先看有没有 activation 段。
      // 未绑定设备的 OTA 响应里 websocket 和 activation 会同时出现，
      // 这时候绝不能拿 websocket 去连接，必须先让用户拿设备码到
      // xiaozhi.me 手动添加设备、绑定角色。
      if (ota.activation?.code) {
        this.cb.onActivation?.(ota.activation.code, ota.activation.message || '');
        this._setState(S.CONNECTING, `激活码 ${ota.activation.code}`);
        this.cb.onCaption?.(
          `激活码 ${ota.activation.code}：请到 xiaozhi.me 添加设备并绑定，绑定后会自动继续`
        );
      } else if (ota.websocket?.url) {
        // 没有 activation 段就是已绑定。token 是服务端给什么就用什么，
        // test-token 是官方服务端长期使用的占位 token，官方固件也是直接拿它连，
        // 不能再自作主张判断“未绑定”。
        this.connect(ota.websocket.url, ota.websocket.token || '');
        return;
      }
      try {
        await this._requestActivate();
      } catch (_) {
        /* 激活轮询失败不影响下一轮 OTA */
      }
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
    this._fail('等待绑定超时，请在 xiaozhi.me 添加设备后重试');
  }

  // ---------------------------------------------------------------- WebSocket

  connect(wsUrl, token) {
    if (!this.active) return;
    this.wsUrl = wsUrl;
    this.token = token;
    this._setState(S.CONNECTING);

    const params = new URLSearchParams({
      url: wsUrl,
      token,
      deviceId: this.ai.deviceMac,
      clientId: this.ai.clientId,
      pv: String(PROTOCOL_VERSION),
    });
    const url = `${this.workerBase}/ws?${params.toString()}`;
    this._log(`连接 ${wsUrl}`);

    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    ws.onopen = () => {
      if (this.ws !== ws || !this.active) return;
      this._setState(S.HANDSHAKING);
      this._send({
        type: 'hello',
        version: PROTOCOL_VERSION,
        transport: 'websocket',
        audio_params: {
          format: 'opus',
          sample_rate: 16000,
          channels: 1,
          frame_duration: 60,
        },
        features: { mcp: true, mcp_20260728: true },
      });
      this.helloTimer = setTimeout(() => {
        if (this.state === S.HANDSHAKING) this._scheduleReconnect('握手超时');
      }, HELLO_TIMEOUT_MS);
    };

    ws.onmessage = (event) => {
      if (this.ws !== ws || !this.active) return;
      if (typeof event.data === 'string') {
        this._onText(event.data);
      } else {
        this.audio.enqueuePacket(event.data).catch((e) => this._log(e.message));
      }
    };

    ws.onclose = (event) => {
      if (this.ws !== ws || !this.active || this.intentionallyClosed) return;
      if (event.code === 1000 || event.code === 1001) {
        const detail = event.reason ? `：${event.reason}` : '';
        this._log(`服务端关闭 WebSocket（code=${event.code}${detail}）`);
        this.end(`服务端关闭连接（code=${event.code}${detail}）`);
        return;
      }
      this._scheduleReconnect(`连接断开：${event.code} ${event.reason || ''}`);
    };

    ws.onerror = () => {
      if (this.ws === ws && this.active) this._log('WebSocket 错误');
    };
  }

  _send(obj) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    try {
      this.ws.send(JSON.stringify(obj));
      return true;
    } catch (e) {
      this._log(`发送失败：${e.message}`);
      return false;
    }
  }

  _sendBinary(data) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    try {
      this.audioPackets++;
      this.ws.send(data);
    } catch (_) {
      /* ignore */
    }
  }

  _sendListenStart() {
    this._send({
      // 必须带服务端 hello 下发的 session_id，后续每轮 listen 都要用同一个
      session_id: this.sessionId || '',
      type: 'listen',
      state: 'start',
      mode: this.ai.mode || 'auto',
    });
  }

  _sendListenStop() {
    this._send({
      session_id: this.sessionId || '',
      type: 'listen',
      state: 'stop',
    });
  }

  _closeWs() {
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      try {
        ws.close(1000, 'bye');
      } catch (_) {
        /* ignore */
      }
    }
  }

  _scheduleReconnect(reason) {
    if (!this.active || this.intentionallyClosed) return;
    this._log(reason);
    this._clearTimers();
    if (this.reconnectCount >= MAX_RECONNECT) {
      this._fail(`${reason}（重试 ${MAX_RECONNECT} 次仍失败）`);
      return;
    }
    this.reconnectCount++;
    const delay = Math.min(1000 << (this.reconnectCount - 1), 16000);
    this.cb.onCaption?.(`重连中(${this.reconnectCount})…`);
    this._closeWs();
    this.reconnectTimer = setTimeout(() => {
      if (!this.active || this.intentionallyClosed) return;
      if (this.wsUrl && this.token) this.connect(this.wsUrl, this.token);
      else this._resolveEndpointAndConnect().catch((e) => this._fail(e.message));
    }, delay);
  }

  _fail(message) {
    this._log(message);
    this.end(message);
    this._setState(S.ERROR);
    this.cb.onMessage?.('system', message);
  }

  // ---------------------------------------------------------------- 下行消息

  _onText(raw) {
    let root;
    try {
      root = JSON.parse(raw);
    } catch (_) {
      this._log(`无法解析：${raw.slice(0, 100)}`);
      return;
    }

    switch (root.type) {
      case 'hello': {
        clearTimeout(this.helloTimer);
        this.helloTimer = null;
        this.sessionId = root.session_id || '';
        const rate = root.audio_params?.sample_rate || 24000;
        this.audio.setDecoderRate(rate);
        this._log(`握手完成 session=${this.sessionId} 采样率=${rate}`);
        this._beginListening();
        break;
      }
      case 'stt': {
        const text = root.text || '';
        this.turnLead = '';
        // 新一轮用户说话：下一条 AI 回复要另起一个气泡
        this.assistantTurnOpened = false;
        this._setState(S.THINKING);
        if (text) {
          this.cb.onMessage?.('user', text);
          this.cb.onCaption?.(`你：${text}`);
          this._log(`你：${text}`);
        }
        break;
      }
      case 'tts':
        this._onTts(root.state || 'sentence_start', root.text || '');
        break;
      case 'llm': {
        const lead = (root.text || '').trim();
        if (lead && lead.length <= MAX_LEAD_LENGTH && !this.turnLead) {
          this.turnLead = lead;
          this.cb.onCaption?.(lead);
        }
        break;
      }
      case 'alert':
        this.cb.onMessage?.('system', root.message || root.status || '');
        break;
      case 'goodbye':
        this._log('服务端发来 goodbye');
        this.end('服务端发来 goodbye，已退出对话');
        break;
      case 'mcp':
        this._onMcp(root);
        break;
      default:
        this._log(`忽略消息类型 ${root.type}`);
    }
  }

  /** 一条 AI 回复只开一次气泡；同一条回复里的多句由 UI 追加，不覆盖 */
  _openAssistantTurn() {
    if (this.assistantTurnOpened) return;
    this.assistantTurnOpened = true;
    this.cb.onAssistantStart?.();
  }

  _onTts(state, text) {
    switch (state) {
      case 'start':
        this.audio.flushPlayback();
        this._setState(S.SPEAKING);
        this._openAssistantTurn();
        break;
      case 'sentence_start':
        if (text) {
          this._openAssistantTurn();
          const line = this.turnLead ? this.turnLead + text : text;
          this.cb.onAssistant?.(line);
          this.cb.onCaption?.(line);
          this._log(`小智：${line}`);
        }
        this._setState(S.SPEAKING);
        break;
      case 'stop':
        this.audio.markTurnEnd();
        this.assistantTurnOpened = false;
        break;
      case 'sentence_end':
        break;
      default:
        this._log(`未知 tts 状态 ${state}`);
    }
  }

  /** 进入聆听：采集就绪 -> 通知服务端 -> 放行上行，顺序固定，杜绝状态与发送失步 */
  async _beginListening() {
    try {
      await this._startCapture();
    } catch (e) {
      return;
    }
    if (!this.active || this.intentionallyClosed) return;
    this.listenPhasePackets = 0;
    this._sendListenStart();
    this._setState(S.LISTENING);
    this._flushPreroll();
    this.cb.onCaption?.('聆听中…');
  }

  /** 把打断前缓存的语音补发到上行，顺序在实时帧之前 */
  _flushPreroll() {
    const pre = this.preroll;
    this.preroll = [];
    if (!pre.length) return;
    for (const packet of pre) {
      this.listenPhasePackets++;
      this._sendBinary(packet);
    }
    this._log(`补发打断前 ${pre.length} 帧语音（约 ${pre.length * 60}ms）`);
  }

  async _onPlaybackDrained() {
    if (!this.active || this.intentionallyClosed) return;
    if (this.stopAfterTurn) {
      this.stopAfterTurn = false;
      this.end('播放命令已执行');
      return;
    }
    await this._beginListening();
  }

  async _startCapture() {
    try {
      this.audio.resumeIfNeeded();
      await this.audio.startCapture();
    } catch (e) {
      // 用户拒绝麦克风权限等
      this._fail(`麦克风启动失败：${e.message}`);
      throw e;
    }
  }

  // 注意：没有前端静默超时。会话只在三种情况下结束：
  //   1) 用户点「结束」；
  //   2) 服务端主动发 goodbye 或以 1000/1001 关闭 WebSocket；
  //   3) 网络异常断开（非 1000/1001）触发重连，重连失败才结束。

  _clearTimers() {
    clearTimeout(this.helloTimer);
    clearTimeout(this.reconnectTimer);
    this.helloTimer = null;
    this.reconnectTimer = null;
  }

  // ---------------------------------------------------------------- 设备侧 MCP
  // 网页没有播放器/摄像头，只做最小可用实现，保证网关能完成协议握手。
  // 额外暴露一个「历史对话」工具：小智协议本身不传历史，LLM 上下文只在单次会话内有效，
  // 这个工具让模型在用户问到过去的内容时能主动读取浏览器本地保存的对话记录。

  _historyTool() {
    return {
      name: 'self.get_chat_history',
      description:
        '查询本机保存的、当前这个 AI 与用户的历史对话记录。' +
        '当用户提到「之前」「刚才」「你还记得吗」「我们聊过什么」「我说过什么」' +
        '或任何需要引用过去对话内容的问题时，必须先调用本工具读取历史，再回答。' +
        '返回的是按时间顺序排列的最近若干条对话。',
      inputSchema: { type: 'object', properties: {} },
    };
  }

  _historyText() {
    const getHistory = this.cb.getHistory;
    if (typeof getHistory !== 'function') return '网页未提供历史记录读取能力。';
    let messages = [];
    try {
      messages = getHistory() || [];
    } catch (e) {
      return `读取历史失败：${e.message}`;
    }
    const recent = messages
      .filter((m) => m && m.role !== 'system' && m.text)
      .slice(-30)
      .map((m) => {
        const who = m.role === 'user' ? '用户' : this.ai.name || '小智';
        let text = String(m.text).replace(/\s+/g, ' ');
        if (text.length > 300) text = text.slice(0, 300) + '…';
        return `${who}：${text}`;
      });
    if (!recent.length) return '本机没有保存任何历史对话。';
    return (
      `以下是本机保存的最近 ${recent.length} 条历史对话（按时间顺序）：\n` +
      recent.join('\n') +
      `\n\n注意：这是本机日志，可能不包含服务端会话内的最新上下文；回答时优先结合当前对话。`
    );
  }

  _onMcp(root) {
    const payload = root.payload || {};
    const method = payload.method || '';
    const id = payload.id;
    const params = payload.params || {};
    const sessionId = root.session_id || '';
    const modern = params?._meta?.[META_PV] === MCP_MODERN;

    if (method.startsWith('notifications/')) return;

    let result;
    switch (method) {
      case 'server/discover':
        result = {
          supportedVersions: [MCP_MODERN, MCP_LEGACY],
          capabilities: { tools: {} },
          ttlMs: 60000,
          cacheScope: 'private',
        };
        break;
      case 'initialize':
        result = {
          protocolVersion: MCP_LEGACY,
          capabilities: { tools: {} },
          serverInfo: { name: 'xiaozhi-web', version: '1.0' },
        };
        break;
      case 'tools/list': {
        const tools = params?.cursor ? [] : [this._historyTool()];
        result = { tools };
        if (modern) Object.assign(result, { ttlMs: 60000, cacheScope: 'private' });
        break;
      }
      case 'tools/call': {
        const name = params?.name || '';
        if (name === 'self.get_chat_history') {
          result = {
            content: [{ type: 'text', text: this._historyText() }],
            isError: false,
          };
        } else {
          result = {
            content: [{ type: 'text', text: '网页客户端不支持该设备控制命令' }],
            isError: true,
          };
        }
        break;
      }
      case 'ping':
        result = {};
        break;
      default:
        this._send({
          session_id: sessionId,
          type: 'mcp',
          payload: {
            jsonrpc: '2.0',
            id,
            error: { code: -32601, message: `Method not found: ${method}` },
          },
        });
        return;
    }

    if (modern) {
      result.resultType = 'complete';
      result._meta = {
        [META_SI]: { name: 'xiaozhi-web', version: '1.0' },
      };
    }
    this._send({
      session_id: sessionId,
      type: 'mcp',
      payload: { jsonrpc: '2.0', id, result },
    });
  }
}
