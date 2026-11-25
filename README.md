# 小智 AI 网页语音客户端（带 CF Worker 中转）

## 在线示例

**https://xiaozhi-web.smanx.xx.kg**

可以直接打开体验：支持语音对话、多 AI 角色管理、连续对话、自动打断、聊天记录本地保存，
以及 AI 配置的导入导出（换浏览器/设备迁移）。

> 首次使用：创建一个 AI → 点「查询激活码」→ 拿激活码和页面上的设备 MAC 到
> https://xiaozhi.me/ 添加设备并绑定角色 → 回来开始对话。麦克风权限需要 HTTPS。

---

## 一、为什么需要 CF Worker 中转

**不能纯前端直连**，有两个硬障碍：

1. 浏览器 `new WebSocket(url)` **不允许设置自定义请求头**，
   `Authorization` / `Device-Id` / `Client-Id` / `Protocol-Version` 一个都发不出去，
   而小智网关握手必须要这些头。
2. OTA 接口是给固件用的，**没有 CORS**，带自定义头还会触发预检 OPTIONS，
   浏览器拿不到响应。

另外浏览器没有原生 Opus 编解码 API——不过这个好解决：WebCodecs 的
`AudioEncoder`/`AudioDecoder` 支持 opus，兼容性和稳定性一般；这里用
`libopus-wasm`（单文件 ESM、WASM 内联、无需 COOP/COEP）更可靠。

所以需要一层中转：本项目的 Cloudflare Worker。
浏览器 ↔ Worker（`fetch` + 普通 WebSocket）↔ 小智网关（带全套官方请求头）。
CF Worker 的 `fetch(url, {headers:{Upgrade:'websocket', ...}})` 支持作为
WebSocket 客户端并允许自定义头，且天然处理 CORS。

---

## 二、项目结构

```
xiaozhi-web/
├── worker.js              # CF Worker：OTA 代理 + WebSocket 透明转发 + 静态托管
├── wrangler.toml
└── public/
    ├── index.html         # 页面
    ├── styles.css
    ├── js/
    │   ├── store.js       # localStorage：多 AI 配置、每个 AI 的会话记录
    │   ├── audio.js       # AudioWorklet 采集 + libopus-wasm 编解码 + 排程播放
    │   ├── xiaozhi.js     # 官方协议客户端 + 会话状态机 + MCP 应答
    │   └── ui.js          # 多 AI 管理、激活、界面
    └── worklets/
        └── capture-worklet.js
```

功能对应你的三个要求：

1. **语音对话**：`AudioWorklet` 采集 16kHz PCM → Opus 上行；下行 Opus 解码后顺序播放。
   上行音频只在「聆听中」发送，思考/播报期间停止推流，避免 TTS 回声糊住服务端 VAD。
   支持播报中打断：手动点按钮，或开启 AI 编辑里的「自动打断」开关后检测到人声自动打断
   （连续多帧超过阈值才触发，带起播保护和冷却，避免被 TTS 回声误触发）。
   打断时会把最近约 600ms 的语音作为「预滚」补发到上行，所以**打断时你说的话不会丢**，
   不需要等打断完成再重新说。
2. **创建多个 AI**：每个 AI 有独立的 `Device-Id` / `Client-Id` / Token / 模式配置；
   在小智控制台把不同 MAC 绑定到不同角色，就得到多个不同人格的 AI。列表可增删改。
3. **长语音对话**：默认开启“连续对话”；播报完自动重新聆听。网页**没有前端静默超时**：
   会话只在你点“结束”、服务端主动关闭（goodbye / WS 1000、1001）或网络异常断开时结束。
   每个 AI 的对话记录独立保存在 localStorage。

---

## 三、部署

### 方式 A：一个 Worker 全搞定（推荐）

```bash
cd xiaozhi-web
npm install -g wrangler
wrangler login
wrangler deploy
```

`wrangler.toml` 已经把 `public/` 配成静态资源，`run_worker_first` 只接管
`/api/*` 和 `/ws`，所以页面和接口在同一个域名，浏览器设置里 Worker 地址留空即可。

本地调试：

```bash
wrangler dev
# 打开 http://localhost:8787
```

### 方式 B：页面与 Worker 分开

把 `public/` 丢到任意静态托管（Cloudflare Pages / Vercel / Nginx 等），
Worker 单独部署，然后在网页左下角「设置」里填 Worker 地址
（例如 `https://xiaozhi-web-relay.xxx.workers.dev`）。注意 Worker 已经开了 CORS。

---

## 四、使用

1. 点左侧 **＋** 创建 AI，填名字/头像。
2. 保持 Token 为空，点 **查询激活码**。未绑定设备的 OTA 响应会**同时**返回
   `websocket`（token 通常是 `test-token`）和 `activation` 激活码；页面优先识别
   `activation` 并显示「设备尚未绑定」。把这个 6 位码和页面上的 MAC 填到
   <https://xiaozhi.me/> 的「添加设备」里，在后台手动绑定角色/提示词。
   绑定完成后回来点「验证是否已绑定」（或直接开始对话，会自动等待绑定），
   此时 OTA 响应里的 `activation` 段消失，页面即显示已绑定并建立连接。
   **判断绑定与否的唯一依据是 `activation` 段是否存在**：`test-token` 是官方服务端
   长期使用的占位 token，官方固件也是直接拿它连接，不要误判为未绑定。
   （如果已有可用 token，也可以直接填到 Token 一栏，跳过 OTA。）
3. 保存后回到对话页，点 **开始对话**，允许麦克风权限，然后说话。
4. 通话中点一下主按钮 = 打断；点 **结束** = 收场。网页不会因为你沉默而自动掐断会话。
5. 重复 1–3 创建更多 AI，各自绑定不同角色，点左侧即可切换。
   对话记录按 AI 分开保存。右上角 ✎ 是编辑 AI，🧹 是清空当前 AI 的聊天记录
   （会弹确认框，删除 AI 仍在编辑弹窗里）。
6. **迁移 / 备份**：左下角「导出」会把所有 AI（含 Token、设备 MAC、Client-Id）和各自
   对话记录打包成一个 JSON 文件下载；在另一个浏览器/设备打开页面后点「导入」选择该文件
   即可恢复。导入按 AI 的 `id` 和设备 MAC 去重，已存在的会跳过，不会覆盖现有数据。
   设置弹窗里也有同样的入口。备份文件含 Token，请妥善保管。

> 注意：角色/人设是在小智控制台配置的，协议本身不传输 system prompt；
> 网页只是把“设备身份”和会话通道搬到浏览器里。

---

## 五、限制与说明

- 需要现代浏览器（Chrome / Edge / Safari 16.4+ 等）支持 AudioWorklet、
  ES modules 和 Web Audio；`libopus-wasm` 从 jsDelivr CDN 加载。
- 麦克风权限要求 HTTPS（localhost 除外），CF Worker 默认就是 HTTPS。
- **关于历史记录**：小智协议本身不上传历史文本，LLM 上下文只由服务端按 `session_id`
  在单次会话内维护；结束会话/刷新页面后换新的 `session_id`，服务端就是全新上下文。
  网页保存的聊天记录只是本地展示日志。为了弥补这一点，网页通过设备侧 MCP 暴露了一个
  `self.get_chat_history` 工具（取最近 30 条本地记录），当用户问「之前说过什么」「还记得吗」
  时模型可主动调用它。**这是尽力而为的方案**：模型是否调用取决于服务端/模型，不是每次必触发；
  需要更强的长期记忆请在小智控制台配置 bot 的记忆能力。
- 网页客户端没有实现播放器/摄像头等设备控制工具；AI 调用这类工具会收到“不支持”的提示。
- CF Worker 免费版足够个人使用；WebSocket 走 Cloudflare 全球网络，延迟通常不错。
- 本项目仅供学习/个人使用，请遵守小智官方服务条款，勿滥用。
