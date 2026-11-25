/**
 * 小智 AI 网页客户端的 CF Worker 中转。
 *
 * 为什么需要它：
 *  1. 浏览器 WebSocket 不允许自定义请求头（Authorization / Device-Id / Client-Id /
 *     Protocol-Version），而小智网关的 wss 握手必须要这些头；
 *  2. OTA 接口不是给浏览器设计的，没有 CORS，且同样要带 Device-Id 等自定义头。
 *
 * Worker 负责把浏览器的「普通 WebSocket / fetch」翻译成官方固件那套请求。
 *
 * 路由：
 *  POST /api/ota        -> https://api.tenclass.net/xiaozhi/ota/ （可 ?ota= 自定义）
 *  POST /api/activate   -> <ota>/activate
 *  GET  /ws             -> 透明转发到小智网关 wss
 *  其他                 -> 静态页面（ASSETS binding）
 */

const DEFAULT_OTA = 'https://api.tenclass.net/xiaozhi/ota/';
const DEFAULT_VERSION = '1';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers':
    'Content-Type, X-Device-Id, X-Client-Id, X-Language, X-User-Agent, X-Activation-Version, X-Protocol-Version',
  'Access-Control-Max-Age': '86400',
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' },
  });
}

function withCors(resp) {
  const headers = new Headers(resp.headers);
  for (const [k, v] of Object.entries(CORS)) headers.set(k, v);
  return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers });
}

/** 只允许 http(s)，避免被用来打内网的非 HTTP 服务 */
function normalizeHttpUrl(raw, fallback) {
  const value = (raw || '').trim() || fallback;
  if (!/^https?:\/\/\S+$/i.test(value)) throw new Error('OTA 地址必须是 http(s) URL');
  return value;
}

function normalizeWsUrl(raw) {
  const value = (raw || '').trim();
  if (!/^wss?:\/\/\S+$/i.test(value)) throw new Error('WebSocket 地址必须是 ws(s) URL');
  return value;
}

function deviceHeaders(request) {
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'Accept-Language': request.headers.get('X-Language') || 'zh-CN',
    'Device-Id': request.headers.get('X-Device-Id') || '',
    'Client-Id': request.headers.get('X-Client-Id') || '',
    'Activation-Version': request.headers.get('X-Activation-Version') || '1',
    'User-Agent': request.headers.get('X-User-Agent') || `generic/${DEFAULT_VERSION}`,
  };
}

async function proxyOta(request, url) {
  const otaUrl = normalizeHttpUrl(url.searchParams.get('ota'), DEFAULT_OTA);
  const body = (await request.text()) || '{}';
  const upstream = await fetch(otaUrl, {
    method: 'POST',
    headers: deviceHeaders(request),
    body,
  });
  return withCors(upstream);
}

async function proxyActivate(request, url) {
  const otaUrl = normalizeHttpUrl(url.searchParams.get('ota'), DEFAULT_OTA);
  const target = otaUrl.replace(/\/+$/, '') + '/activate';
  const body = (await request.text()) || '{}';
  const upstream = await fetch(target, {
    method: 'POST',
    headers: deviceHeaders(request),
    body,
  });
  return withCors(upstream);
}

async function proxyWs(request, url) {
  const upstreamUrl = normalizeWsUrl(url.searchParams.get('url'));
  const token = url.searchParams.get('token') || '';
  const deviceId = url.searchParams.get('deviceId') || '';
  const clientId = url.searchParams.get('clientId') || '';
  const protocolVersion = url.searchParams.get('pv') || '1';

  // Workers 的 fetch 要求用 http(s) URL 发起 upgrade（等价的 WebSocket 握手），
  // 运行时会自动补 Sec-WebSocket-Key 等字段；这里只加业务头。
  const fetchUrl = upstreamUrl
    .replace(/^wss:\/\//i, 'https://')
    .replace(/^ws:\/\//i, 'http://');
  const resp = await fetch(fetchUrl, {
    headers: {
      Upgrade: 'websocket',
      Authorization: `Bearer ${token}`,
      'Protocol-Version': protocolVersion,
      'Device-Id': deviceId,
      'Client-Id': clientId,
    },
  });

  const upstream = resp.webSocket;
  if (!upstream) {
    return jsonResponse({ error: `上游拒绝 WebSocket 握手 (HTTP ${resp.status})` }, 502);
  }

  // 先接上游，再接浏览器：保证浏览器 onopen 时上游已经可用，
  // 页面可以立刻发 hello，不会丢在半路上。
  upstream.binaryType = 'arraybuffer';
  upstream.accept({ allowHalfOpen: true });

  const [client, server] = Object.values(new WebSocketPair());
  server.binaryType = 'arraybuffer';
  server.accept({ allowHalfOpen: true });

  const safeClose = (ws, code, reason) => {
    try {
      const c = Number(code);
      if (c >= 1000 && c < 5000 && ![1004, 1005, 1006, 1015].includes(c)) {
        ws.close(c, String(reason || '').slice(0, 120));
      } else {
        ws.close(1000, '');
      }
    } catch (_) {
      /* 已关闭 */
    }
  };

  const pipe = (from, to) => {
    from.addEventListener('message', (event) => {
      try {
        to.send(event.data);
      } catch (_) {
        /* 对端已关闭，忽略 */
      }
    });
    from.addEventListener('close', (event) => {
      safeClose(to, event.code, event.reason);
    });
    from.addEventListener('error', () => {
      safeClose(to, 1011, 'relay error');
    });
  };

  pipe(server, upstream);
  pipe(upstream, server);

  return new Response(null, { status: 101, webSocket: client });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    try {
      if (url.pathname === '/api/ota' && request.method === 'POST') {
        return await proxyOta(request, url);
      }
      if (url.pathname === '/api/activate' && request.method === 'POST') {
        return await proxyActivate(request, url);
      }
      if (url.pathname === '/ws' && request.method === 'GET') {
        return await proxyWs(request, url);
      }
    } catch (error) {
      return jsonResponse({ error: error?.message || String(error) }, 500);
    }

    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response('Not found', { status: 404 });
  },
};
