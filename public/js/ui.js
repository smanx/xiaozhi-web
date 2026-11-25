/** 页面交互：多 AI 管理、会话界面、激活流程、波形。 */
import {
  loadAIs,
  saveAIs,
  loadMessages,
  saveMessages,
  loadSettings,
  saveSettings,
  makeAI,
  randomMac,
  randomClientId,
  uid,
  DEFAULT_OTA,
  DEFAULT_WS,
} from './store.js';
import { XiaozhiSession } from './xiaozhi.js';

const $ = (sel) => document.querySelector(sel);

const state = {
  ais: loadAIs(),
  settings: loadSettings(),
  activeId: null,
  messages: [],
  session: null,
  currentAssistant: null,
  activationTimer: null,
};

const dom = {
  list: $('#ai-list'),
  add: $('#add-ai'),
  exportBtn: $('#export-ais'),
  importBtn: $('#import-ais'),
  importFile: $('#import-file'),
  settingsBtn: $('#open-settings'),
  chatAvatar: $('#chat-avatar'),
  chatName: $('#chat-name'),
  chatStatus: $('#chat-status'),
  messages: $('#messages'),
  talk: $('#talk-btn'),
  talkLabel: $('#talk-label'),
  stop: $('#stop-btn'),
  wave: $('#wave'),
  waveLabel: $('#wave-label'),
  tip: $('#tip'),
  edit: $('#edit-ai'),
  clearChat: $('#clear-chat'),
  modalRoot: $('#modal-root'),
  toastRoot: $('#toast-root'),
};

function getAI(id = state.activeId) {
  return state.ais.find((a) => a.id === id) || null;
}

function getWorkerBase() {
  return (state.settings.workerBase || location.origin).replace(/\/+$/, '');
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function toast(text) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = text;
  dom.toastRoot.appendChild(el);
  setTimeout(() => el.remove(), 2600);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('已复制');
  } catch (_) {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    toast('已复制');
  }
}

// ---------------------------------------------------------------- AI 列表

function renderAIList() {
  if (!state.ais.length) {
    dom.list.innerHTML =
      '<div style="padding:18px 12px;color:#717a9f;font-size:12px;line-height:1.7">' +
      '还没有 AI。点右上角 <b>＋</b> 创建第一个。<br/>每个 AI 对应小智控制台里的一台设备 / 一个角色。' +
      '</div>';
    return;
  }
  dom.list.innerHTML = state.ais
    .map((ai) => {
      const live = state.activeId === ai.id && state.session?.isActive;
      const sub = ai.token ? '已配置 Token' : `设备 ${ai.deviceMac.slice(0, 8)}…`;
      return `
      <button class="ai-item ${state.activeId === ai.id ? 'active' : ''}" data-id="${ai.id}">
        <span class="avatar" style="background:${escapeHtml(ai.color)}22">${escapeHtml(ai.emoji || '🤖')}</span>
        <span class="ai-item-meta">
          <span class="ai-item-name">${escapeHtml(ai.name)}</span>
          <span class="ai-item-sub">${escapeHtml(sub)}</span>
        </span>
        <span class="dot ${live ? 'live' : ''}"></span>
      </button>`;
    })
    .join('');

  dom.list.querySelectorAll('.ai-item').forEach((el) => {
    el.addEventListener('click', () => selectAI(el.dataset.id));
  });
}

function selectAI(id) {
  if (state.activeId === id) return;
  state.session?.end('切换 AI');
  state.session?.close();
  state.session = null;
  state.currentAssistant = null;
  state.activeId = id;
  const ai = getAI(id);
  state.messages = loadMessages(id);

  dom.chatAvatar.textContent = ai?.emoji || '🤖';
  dom.chatAvatar.style.background = `${ai?.color || '#6c8cff'}22`;
  dom.chatName.textContent = ai?.name || '未选择';
  dom.talk.disabled = false;
  dom.stop.disabled = true;
  setStatus('未连接', '');
  renderMessages();
  renderAIList();
}

// ---------------------------------------------------------------- 消息区

function renderMessages() {
  if (!state.messages.length) {
    dom.messages.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">🎙️</div>
        <h2>开始一段语音对话</h2>
        <p>点击「开始对话」后直接说话。<br/>连续对话默认开启，说完会自动继续聆听。</p>
        <p class="dim">想在多个角色间切换？点左侧的 ＋ 创建更多 AI。</p>
      </div>`;
    return;
  }
  const ai = getAI();
  dom.messages.innerHTML = state.messages
    .map((m) => {
      const time = new Date(m.ts).toLocaleTimeString('zh-CN', {
        hour: '2-digit',
        minute: '2-digit',
      });
      if (m.role === 'system') {
        return `<div class="bubble system">${escapeHtml(m.text)}</div>`;
      }
      const isUser = m.role === 'user';
      const avatar = isUser ? '🙂' : ai?.emoji || '🤖';
      return `
        <div class="bubble-row ${isUser ? 'user' : ''}">
          <div class="bubble-avatar">${escapeHtml(avatar)}</div>
          <div>
            <div class="bubble">${escapeHtml(m.text)}</div>
            <div class="bubble-meta">${isUser ? '你' : escapeHtml(ai?.name || 'AI')} · ${time}</div>
          </div>
        </div>`;
    })
    .join('');
  requestAnimationFrame(() => {
    dom.messages.scrollTop = dom.messages.scrollHeight;
  });
}

function addMessage(role, text) {
  if (!state.activeId) return null;
  const msg = { id: uid('m'), role, text, ts: Date.now() };
  state.messages.push(msg);
  saveMessages(state.activeId, state.messages);
  renderMessages();
  return msg;
}

/** 新的一条 AI 回复：结束上一条的气泡，下一段文字会新建气泡，绝不覆盖旧消息 */
function startAssistantTurn() {
  state.currentAssistant = null;
}

/**
 * 同一条回复里可能连续来多句 sentence_start：
 * 追加到当前气泡，而不是替换它的 text。
 */
function updateAssistant(text) {
  if (!state.activeId || !text) return;
  if (!state.currentAssistant) {
    state.currentAssistant = addMessage('assistant', text);
    return;
  }
  const previous = state.currentAssistant.text || '';
  // 完全相同的重复推送直接忽略，避免刷屏
  if (previous === text) return;
  state.currentAssistant.text = previous ? `${previous}\n${text}` : text;
  saveMessages(state.activeId, state.messages);
  renderMessages();
}

// ---------------------------------------------------------------- 会话控制

function setStatus(label, cls = '') {
  dom.chatStatus.textContent = label;
  dom.chatStatus.className = `chat-sub ${cls}`;
}

function applySessionState(next, label, caption) {
  const listening = next === 'listening';
  const connecting = next === 'connecting' || next === 'handshaking';
  const busy = connecting || next === 'thinking' || next === 'speaking';

  // 连接阶段给出明确提示，并禁用按钮，避免用户以为没反应而反复点
  if (next === 'connecting') dom.talkLabel.textContent = '连接中，请稍后…';
  else if (next === 'handshaking') dom.talkLabel.textContent = '握手中，请稍后…';
  else if (listening) dom.talkLabel.textContent = '结束本轮';
  else if (busy) dom.talkLabel.textContent = '打断';
  else dom.talkLabel.textContent = '开始对话';

  dom.talk.disabled = connecting;
  dom.talk.className = `talk-btn ${listening ? 'listening' : busy ? 'busy' : ''}`;
  dom.stop.disabled = !(state.session?.isActive);
  if (caption) dom.waveLabel.textContent = caption;
  setStatus(label, next === 'error' ? 'error' : busy || listening ? 'live' : '');
  renderAIList();
}

async function startSession() {
  const ai = getAI();
  if (!ai) {
    toast('请先创建一个 AI');
    return;
  }
  state.currentAssistant = null;
  state.session = new XiaozhiSession({
    ai,
    workerBase: getWorkerBase(),
    callbacks: {
      onState: applySessionState,
      onCaption: (text) => {
        dom.waveLabel.textContent = text || '待机';
      },
      onMessage: (role, text) => {
        if (role === 'user') startAssistantTurn();
        if (text) addMessage(role, text);
      },
      onAssistantStart: startAssistantTurn,
      onAssistant: (text) => updateAssistant(text),
      // 让 AI 能通过 MCP 工具读取本机保存的历史对话
      getHistory: () => loadMessages(ai.id),
      onLevel: (rms) => pushLevel(rms),
      onActivation: (code, message) => {
        toast(`激活码 ${code}，请到 xiaozhi.me 绑定`);
      },
      onEnded: (reason) => {
        dom.talkLabel.textContent = '开始对话';
        dom.talk.className = 'talk-btn';
        dom.talk.disabled = false;
        dom.waveLabel.textContent = '待机';
        dom.stop.disabled = true;
        renderAIList();
        if (reason && reason !== '已结束') dom.tip.textContent = `上次结束：${reason}`;
      },
      log: (m) => console.log('[小智]', m),
    },
  });
  dom.stop.disabled = false;
  await state.session.start();
}

function onTalkClick() {
  const s = state.session;
  if (!s || !s.isActive) {
    startSession();
    return;
  }
  if (s.state === 'listening') s.end('已结束本轮');
  else s.interrupt();
}

// ---------------------------------------------------------------- 波形

const waveLevels = new Array(40).fill(0);
let waveTarget = 0;

function pushLevel(rms) {
  waveTarget = Math.min(1, rms / 2500);
}

(function drawWave() {
  const canvas = dom.wave;
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  waveLevels.push(waveTarget);
  waveLevels.shift();
  waveTarget *= 0.86;

  const barW = w / waveLevels.length;
  const gradient = ctx.createLinearGradient(0, 0, w, 0);
  gradient.addColorStop(0, '#6c8cff');
  gradient.addColorStop(1, '#a06bff');
  ctx.fillStyle = gradient;
  for (let i = 0; i < waveLevels.length; i++) {
    const v = waveLevels[i];
    const bh = Math.max(3, v * h * 0.9);
    ctx.globalAlpha = 0.35 + v * 0.65;
    ctx.fillRect(i * barW + 1, (h - bh) / 2, Math.max(1, barW - 2), bh);
  }
  ctx.globalAlpha = 1;
  requestAnimationFrame(drawWave);
})();

// ---------------------------------------------------------------- 弹窗

function openModal(html) {
  closeModal();
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.innerHTML = `<div class="modal">${html}</div>`;
  mask.addEventListener('click', (e) => {
    if (e.target === mask) closeModal();
  });
  dom.modalRoot.appendChild(mask);
  return mask;
}

function closeModal() {
  clearInterval(state.activationTimer);
  state.activationTimer = null;
  dom.modalRoot.innerHTML = '';
}

function aiEditorHtml(ai, isNew) {
  const e = escapeHtml;
  return `
    <h3>${isNew ? '创建 AI' : '编辑 AI'}</h3>
    <div class="row">
      <label>名称</label>
      <input type="text" id="f-name" value="${e(ai.name)}" placeholder="例如：英语陪练" />
    </div>
    <div class="grid2">
      <div class="row">
        <label>头像（一个 emoji）</label>
        <input type="text" id="f-emoji" value="${e(ai.emoji)}" placeholder="🤖" />
      </div>
      <div class="row">
        <label>主题色</label>
        <input type="text" id="f-color" value="${e(ai.color)}" placeholder="#6c8cff" />
      </div>
    </div>

    <div class="row">
      <label>设备 MAC（Device-Id，小智用它认设备）</label>
      <div class="field-with-btn">
        <input type="text" id="f-mac" value="${e(ai.deviceMac)}" />
        <button class="inline-btn" id="f-mac-rand">随机</button>
        <button class="inline-btn" id="f-mac-copy">复制</button>
      </div>
      <div class="field-help">在小智控制台添加设备时填的就是这串 MAC。每个 AI 用不同的 MAC，才能绑定不同角色。</div>
    </div>

    <div class="row">
      <label>Client-Id</label>
      <div class="field-with-btn">
        <input type="text" id="f-client" value="${e(ai.clientId)}" />
        <button class="inline-btn" id="f-client-rand">随机</button>
      </div>
    </div>

    <div class="row">
      <label>Token（可选，留空则走 OTA 自动获取 / 激活码绑定）</label>
      <input type="password" id="f-token" value="${e(ai.token)}" placeholder="自定义服务器可直接填 token" />
    </div>

    <div class="grid2">
      <div class="row">
        <label>OTA 地址</label>
        <input type="text" id="f-ota" value="${e(ai.otaUrl)}" />
      </div>
      <div class="row">
        <label>WebSocket 地址</label>
        <input type="text" id="f-ws" value="${e(ai.wsUrl)}" />
      </div>
    </div>

    <div class="row">
      <label>对话模式</label>
      <select id="f-mode">
        ${['auto', 'manual', 'realtime']
          .map(
            (m) =>
              `<option value="${m}" ${ai.mode === m ? 'selected' : ''}>${m}</option>`
          )
          .join('')}
      </select>
      <div class="field-help">会话不会因前端静默自动结束，只能由你点「结束」、服务端主动关闭或网络异常触发。</div>
    </div>

    <div class="row">
      <label class="check-row">
        <input type="checkbox" id="f-continue" ${ai.autoContinue ? 'checked' : ''} />
        连续对话（播报完自动继续聆听）
      </label>
      <label class="check-row" style="margin-top:8px">
        <input type="checkbox" id="f-interrupt" ${ai.talkInterrupt ? 'checked' : ''} />
        自动打断（播报期间检测到你说话就自动打断，不用点按钮）
      </label>
    </div>

    <div class="activation-box">
      <div><b>设备绑定 / 激活</b></div>
      <div id="activation-result">尚未查询。留空 Token 时，先点下面按钮拿激活码，再到 xiaozhi.me 添加设备。</div>
      <div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap">
        <button class="inline-btn" id="f-activate">查询激活码</button>
        <button class="inline-btn" id="f-activate-poll">验证是否已绑定</button>
        <a class="inline-btn" href="https://xiaozhi.me/" target="_blank" rel="noopener">打开 xiaozhi.me ↗</a>
      </div>
    </div>

    <div class="actions">
      ${isNew ? '' : '<button class="btn danger" id="f-delete">删除</button>'}
      <button class="btn" id="f-cancel">取消</button>
      <button class="btn primary" id="f-save">保存</button>
    </div>`;
}

function openAIEditor(aiId = null) {
  const isNew = !aiId;
  const ai = isNew ? makeAI('新的 AI') : { ...getAI(aiId) };
  if (!ai) return;
  const mask = openModal(aiEditorHtml(ai, isNew));
  const q = (id) => mask.querySelector(id);

  q('#f-mac-rand').onclick = () => (q('#f-mac').value = randomMac());
  q('#f-client-rand').onclick = () => (q('#f-client').value = randomClientId());
  q('#f-mac-copy').onclick = () => copyText(q('#f-mac').value);
  q('#f-cancel').onclick = closeModal;

  q('#f-delete')?.addEventListener('click', async () => {
    if (!confirm(`确定删除「${ai.name}」及其对话记录？`)) return;
    state.ais = state.ais.filter((a) => a.id !== ai.id);
    saveAIs(state.ais);
    if (state.activeId === ai.id) {
      state.session?.close();
      state.session = null;
      state.activeId = null;
      state.messages = [];
      renderMessages();
    }
    closeModal();
    renderAIList();
    toast('已删除');
  });

  q('#f-save').onclick = () => {
    ai.name = q('#f-name').value.trim() || '未命名 AI';
    ai.emoji = q('#f-emoji').value.trim() || '🤖';
    ai.color = q('#f-color').value.trim() || '#6c8cff';
    ai.deviceMac = q('#f-mac').value.trim() || randomMac();
    ai.clientId = q('#f-client').value.trim() || randomClientId();
    ai.token = q('#f-token').value.trim();
    ai.otaUrl = q('#f-ota').value.trim() || DEFAULT_OTA;
    ai.wsUrl = q('#f-ws').value.trim() || DEFAULT_WS;
    ai.mode = q('#f-mode').value;
    ai.autoContinue = q('#f-continue').checked;
    ai.talkInterrupt = q('#f-interrupt').checked;

    if (isNew) state.ais.push(ai);
    else {
      const idx = state.ais.findIndex((a) => a.id === ai.id);
      state.ais[idx] = ai;
    }
    saveAIs(state.ais);
    closeModal();

    if (isNew) {
      state.activeId = ai.id;
      state.messages = loadMessages(ai.id);
      dom.chatAvatar.textContent = ai.emoji;
      dom.chatAvatar.style.background = `${ai.color}22`;
      dom.chatName.textContent = ai.name;
      dom.talk.disabled = false;
      setStatus('未连接', '');
      renderMessages();
    } else if (state.activeId === ai.id) {
      dom.chatAvatar.textContent = ai.emoji;
      dom.chatAvatar.style.background = `${ai.color}22`;
      dom.chatName.textContent = ai.name;
    }
    renderAIList();
    toast('已保存');
  };

  const showActivation = (data) => {
    const box = q('#activation-result');

    // 关键：必须先判断 activation。未绑定设备的 OTA 响应里
    // websocket(token=test-token) 和 activation 会同时存在，
    // 有 activation 就说明还没绑定，绝不能显示“已绑定”。
    if (data.activation?.code) {
      const code = data.activation.code;
      box.innerHTML =
        `<div><b>⏳ 设备尚未绑定</b></div>` +
        `<div>设备码（激活码）：<span class="activation-code">${escapeHtml(code)}</span></div>` +
        `<div style="color:#9aa3c7">${escapeHtml(data.activation.message || '')}</div>` +
        `<div style="margin-top:6px;line-height:1.8">` +
        `① 打开 <a href="https://xiaozhi.me/" target="_blank" rel="noopener">xiaozhi.me</a> 并登录<br/>` +
        `② 添加设备，设备号填 <b>${escapeHtml(ai.deviceMac)}</b>，输入上面的激活码，绑定你的角色<br/>` +
        `③ 回到这里点「验证是否已绑定」，或保存后直接开始对话（会自动等待绑定）` +
        `</div>` +
        `<button class="inline-btn" id="activation-copy" style="margin-top:8px">复制激活码</button>`;
      box.querySelector('#activation-copy').onclick = () => copyText(code);
      return false;
    }

    // 没有 activation 段就是已绑定。token 由服务端决定，test-token 属正常，
    // 官方固件也是直接拿它连接，不能再自作主张判成“未绑定”。
    if (data.websocket?.url) {
      const note =
        data.websocket.token === 'test-token'
          ? '<div class="field-help">注：服务端返回 test-token 属正常，官方固件也直接用它连接。</div>'
          : '';
      box.innerHTML =
        '<span style="color:#4ade80">✅ 已绑定，可以直接对话。</span>' + note;
      return true;
    }

    box.textContent =
      data.error ||
      data.message ||
      `服务端未返回绑定信息（原始响应字段：${Object.keys(data).join(', ') || '空'}）`;
    return false;
  };

  const queryOnce = async () => {
    const target = `${getWorkerBase()}/api/ota?ota=${encodeURIComponent(
      q('#f-ota').value.trim() || DEFAULT_OTA
    )}`;
    const resp = await fetch(target, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Device-Id': q('#f-mac').value.trim(),
        'X-Client-Id': q('#f-client').value.trim(),
        'X-Language': 'zh-CN',
        'X-User-Agent': 'generic/1.0',
      },
      body: JSON.stringify({
        version: 2,
        language: 'zh-CN',
        mac_address: q('#f-mac').value.trim(),
        uuid: q('#f-client').value.trim(),
        application: { name: 'xiaozhi', version: '1.0' },
        board: {
          type: 'generic',
          name: 'WebClient',
          manufacturer: '',
          mac: q('#f-mac').value.trim(),
        },
        protocol: { features: { mcp: true, mcp_20260728: true } },
      }),
    });
    return resp.json();
  };

  q('#f-activate').onclick = async () => {
    const box = q('#activation-result');
    box.textContent = '查询中…';
    try {
      showActivation(await queryOnce());
    } catch (e) {
      box.textContent = `查询失败：${e.message}`;
    }
  };

  q('#f-activate-poll').onclick = () => {
    const box = q('#activation-result');
    clearInterval(state.activationTimer);
    let n = 0;
    box.textContent = '正在验证绑定状态…';
    state.activationTimer = setInterval(async () => {
      n++;
      try {
        const data = await queryOnce();
        if (showActivation(data)) {
          clearInterval(state.activationTimer);
          state.activationTimer = null;
          toast('设备已绑定，可以开始对话了');
          return;
        }
        let status = box.querySelector('#activation-status');
        if (!status) {
          status = document.createElement('div');
          status.id = 'activation-status';
          status.style.cssText = 'color:#717a9f;font-size:11px;margin-top:8px';
          box.appendChild(status);
        }
        status.textContent = `等待你在 xiaozhi.me 完成绑定…（第 ${n} 次检查）`;
      } catch (e) {
        box.textContent = `验证出错：${e.message}`;
      }
      if (n >= 100) {
        clearInterval(state.activationTimer);
        state.activationTimer = null;
      }
    }, 3000);
  };
}

function openSettings() {
  const s = state.settings;
  const mask = openModal(`
    <h3>设置</h3>
    <div class="row">
      <label>CF Worker 地址</label>
      <input type="text" id="s-worker" value="${escapeHtml(s.workerBase)}" placeholder="留空 = 与当前页面同源" />
      <div class="field-help">
        如果网页和 Worker 部署在同一个 Worker（推荐），留空即可。<br/>
        如果分开部署，填 Worker 地址，例如 https://xiaozhi-web-relay.xxx.workers.dev
      </div>
    </div>
    <div class="row">
      <label>备份 / 迁移</label>
      <div style="display:flex;gap:8px">
        <button class="btn" id="s-export">导出全部 AI</button>
        <button class="btn" id="s-import">导入 AI</button>
      </div>
      <div class="field-help">导出文件包含 Token 和对话记录，请妥善保管，不要发给陌生人。</div>
    </div>
    <div class="actions">
      <button class="btn" id="s-cancel">取消</button>
      <button class="btn primary" id="s-save">保存</button>
    </div>`);
  mask.querySelector('#s-export').onclick = () => {
    closeModal();
    exportAIs();
  };
  mask.querySelector('#s-import').onclick = () => {
    closeModal();
    dom.importFile.click();
  };
  mask.querySelector('#s-cancel').onclick = closeModal;
  mask.querySelector('#s-save').onclick = () => {
    state.settings.workerBase = mask.querySelector('#s-worker').value.trim().replace(/\/+$/, '');
    saveSettings(state.settings);
    closeModal();
    toast('已保存');
  };
}

// ---------------------------------------------------------------- 导入 / 导出

/** 导出全部 AI（含 Token）和各自的对话记录，便于换浏览器/换设备迁移 */
function exportAIs() {
  if (!state.ais.length) {
    toast('还没有 AI 可以导出');
    return;
  }
  const payload = {
    format: 'xiaozhi-web-backup',
    version: 1,
    exportedAt: new Date().toISOString(),
    settings: state.settings,
    ais: state.ais,
    messages: Object.fromEntries(state.ais.map((a) => [a.id, loadMessages(a.id)])),
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  a.download = `xiaozhi-ai-backup-${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  toast(`已导出 ${state.ais.length} 个 AI（含对话记录）`);
}

/** 导入备份：按 id / deviceMac 去重，重复的跳过，不覆盖已有数据 */
async function importAIs(file) {
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch (e) {
    toast('文件不是合法的 JSON');
    return;
  }
  if (!data || data.format !== 'xiaozhi-web-backup' || !Array.isArray(data.ais)) {
    toast('不是小智 AI 备份文件');
    return;
  }

  const incoming = data.ais.filter((a) => a && a.id && a.deviceMac);
  if (!incoming.length) {
    toast('备份文件里没有可用的 AI 配置');
    return;
  }

  const existingIds = new Set(state.ais.map((a) => a.id));
  const existingMacs = new Set(state.ais.map((a) => a.deviceMac));
  const toAdd = incoming.filter(
    (a) => !existingIds.has(a.id) && !existingMacs.has(a.deviceMac)
  );
  const skipped = incoming.length - toAdd.length;

  if (!toAdd.length) {
    toast(`全部 ${skipped} 个 AI 已存在，未导入`);
    return;
  }
  if (
    !confirm(
      `将导入 ${toAdd.length} 个 AI${skipped ? `，跳过 ${skipped} 个重复` : ''}，并恢复它们的对话记录。继续？`
    )
  ) {
    return;
  }

  state.ais.push(...toAdd);
  saveAIs(state.ais);

  const allMessages = data.messages || {};
  for (const ai of toAdd) {
    const list = Array.isArray(allMessages[ai.id]) ? allMessages[ai.id] : [];
    saveMessages(ai.id, list);
  }

  // Worker 地址只在当前还没配置时才从备份里继承，避免覆盖用户现有设置
  if (!state.settings.workerBase && data.settings?.workerBase) {
    state.settings.workerBase = data.settings.workerBase;
    saveSettings(state.settings);
  }

  renderAIList();
  if (!state.activeId && state.ais.length) selectAI(state.ais[0].id);
  toast(`已导入 ${toAdd.length} 个 AI${skipped ? `，跳过 ${skipped} 个重复` : ''}`);
}

// ---------------------------------------------------------------- 绑定事件

dom.add.addEventListener('click', () => openAIEditor(null));
dom.exportBtn.addEventListener('click', exportAIs);
dom.importBtn.addEventListener('click', () => dom.importFile.click());
dom.importFile.addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (file) await importAIs(file);
  e.target.value = '';
});
dom.settingsBtn.addEventListener('click', openSettings);
dom.edit.addEventListener('click', () => (getAI() ? openAIEditor(state.activeId) : toast('请先选择 AI')));
dom.clearChat.addEventListener('click', () => {
  const ai = getAI();
  if (!ai) {
    toast('请先选择 AI');
    return;
  }
  if (!state.messages.length) {
    toast('当前没有聊天记录');
    return;
  }
  if (!confirm(`确定清空「${ai.name}」的聊天记录吗？此操作不可恢复。`)) return;
  state.messages = [];
  state.currentAssistant = null;
  saveMessages(ai.id, []);
  renderMessages();
  toast('已清空聊天记录');
});
dom.talk.addEventListener('click', onTalkClick);
dom.stop.addEventListener('click', () => state.session?.end('已结束'));
window.addEventListener('beforeunload', () => state.session?.close());

// 启动：选中第一个 AI（如果有）
renderAIList();
if (state.ais.length) selectAI(state.ais[0].id);
else {
  dom.talk.disabled = true;
  renderMessages();
}
