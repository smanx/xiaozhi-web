/**
 * 浏览器侧的 Opus 音频管线。
 *
 * 采集：getUserMedia -> AudioWorklet -> 16kHz 单声道 -> libopus(WASM) 60ms 帧 -> WebSocket 二进制
 * 播放：WebSocket 二进制 -> libopus 解码 24kHz -> AudioBuffer 顺序排程播放
 *
 * libopus-wasm 是单文件 ESM（WASM 内联），不需要 COOP/COEP，直接从 CDN 引入。
 */
import {
  createEncoder,
  createDecoder,
  Application,
  Signal,
} from 'https://cdn.jsdelivr.net/npm/libopus-wasm@0.4.1/+esm';

const UP_SAMPLE_RATE = 16000;
const UP_CHANNELS = 1;
const FRAME_SAMPLES = 960; // 60ms @ 16kHz，与官方协议一致
const DEFAULT_DOWN_RATE = 24000;

const WORKLET_URL = new URL('../worklets/capture-worklet.js', import.meta.url).href;

function floatToInt16(input) {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    let s = input[i];
    if (s < -1) s = -1;
    else if (s > 1) s = 1;
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

/** 仅在浏览器拿不到 16kHz AudioContext 时使用：把 ctx 采样率降到 16kHz */
function downmixTo16k(input, fromRate) {
  if (fromRate === UP_SAMPLE_RATE) return input;
  const ratio = fromRate / UP_SAMPLE_RATE;
  const outLen = Math.floor(input.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    let n = 0;
    for (let j = start; j < end; j++) {
      sum += input[j];
      n++;
    }
    out[i] = n ? sum / n : input[Math.min(start, input.length - 1)] || 0;
  }
  return out;
}

function appendFloat(acc, part) {
  if (acc.length === 0) return part;
  const merged = new Float32Array(acc.length + part.length);
  merged.set(acc);
  merged.set(part, acc.length);
  return merged;
}

export class AudioEngine {
  constructor({ onPacket, onLevel, onDrained, log } = {}) {
    this.onPacket = onPacket || (() => {});
    this.onLevel = onLevel || (() => {});
    this.onDrained = onDrained || (() => {});
    this.log = log || (() => {});

    this.encoder = null;
    this.decoder = null;
    this.decoderRate = DEFAULT_DOWN_RATE;

    this.ctx = null;
    this.stream = null;
    this.source = null;
    this.captureNode = null;
    this.silentSink = null;
    this.acc = new Float32Array(0);
    this.captureRate = UP_SAMPLE_RATE;

    this.playCtx = null;
    this.playGain = null;
    this.nextPlayTime = 0;
    this.pending = 0;
    this.turnEnded = false;
    this.generation = 0;
    this.activeSources = new Set();
    this.capturing = false;

    this.lastLevelAt = 0;
  }

  async init(decoderRate = DEFAULT_DOWN_RATE) {
    if (!this.encoder) {
      this.encoder = await createEncoder({
        sampleRate: UP_SAMPLE_RATE,
        channels: UP_CHANNELS,
        frameSize: FRAME_SAMPLES,
        application: Application.Voip,
        bitrate: 16000,
        complexity: 5,
        signal: Signal.Voice,
        vbr: true,
      });
    }
    this.setDecoderRate(decoderRate);
    if (!this.playCtx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) throw new Error('浏览器不支持 Web Audio');
      this.playCtx = new Ctx();
      this.playGain = this.playCtx.createGain();
      this.playGain.gain.value = 1;
      this.playGain.connect(this.playCtx.destination);
    }
    if (this.playCtx.state === 'suspended') await this.playCtx.resume();
  }

  setDecoderRate(rate) {
    const next = [8000, 12000, 16000, 24000, 48000].includes(rate) ? rate : DEFAULT_DOWN_RATE;
    if (this.decoder && this.decoderRate === next) return;
    try {
      this.decoder?.free();
    } catch (_) {
      /* ignore */
    }
    this.decoderRate = next;
    this.decoder = null;
    // 延迟到下一次 init/使用时创建，这里先标记
    this._decoderDirty = true;
  }

  async ensureDecoder() {
    if (!this.decoder || this._decoderDirty) {
      this.decoder = await createDecoder({
        sampleRate: this.decoderRate,
        channels: 1,
        maxFrameSize: 2880, // 120ms @ 24kHz，足够放下任何单包
      });
      this._decoderDirty = false;
    }
  }

  /** 浏览器可能在后台/省电时挂起 AudioContext，每轮开始聆听前恢复一次 */
  resumeIfNeeded() {
    if (this.ctx?.state === 'suspended') this.ctx.resume().catch(() => {});
    if (this.playCtx?.state === 'suspended') this.playCtx.resume().catch(() => {});
  }

  /** 必须发生在用户手势（点击按钮）里，否则浏览器不允许录音/播放 */
  async startCapture() {
    if (this.capturing) return;
    await this.init();
    await this.ensureDecoder();

    if (this.playCtx.state === 'suspended') await this.playCtx.resume();

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: false,
        channelCount: 1,
      },
    });

    const Ctx = window.AudioContext || window.webkitAudioContext;
    try {
      this.ctx = new Ctx({ sampleRate: UP_SAMPLE_RATE });
    } catch (_) {
      this.ctx = new Ctx();
    }
    this.captureRate = this.ctx.sampleRate || UP_SAMPLE_RATE;
    if (this.ctx.state === 'suspended') await this.ctx.resume();

    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.silentSink = this.ctx.createGain();
    this.silentSink.gain.value = 0;
    this.silentSink.connect(this.ctx.destination);
    this.acc = new Float32Array(0);

    let useWorklet = false;
    try {
      await this.ctx.audioWorklet.addModule(WORKLET_URL);
      this.captureNode = new AudioWorkletNode(this.ctx, 'pcm-capture');
      this.captureNode.port.onmessage = (e) => this._onCaptured(e.data);
      this.source.connect(this.captureNode);
      this.captureNode.connect(this.silentSink);
      useWorklet = true;
    } catch (e) {
      this.log(`AudioWorklet 不可用，回退 ScriptProcessor：${e.message}`);
    }

    if (!useWorklet) {
      const proc = this.ctx.createScriptProcessor(1024, 1, 1);
      proc.onaudioprocess = (e) => {
        const ch = e.inputBuffer.getChannelData(0);
        this._onCaptured(new Float32Array(ch));
      };
      this.captureNode = proc;
      this.source.connect(proc);
      proc.connect(this.silentSink);
    }

    this.capturing = true;
  }

  _onCaptured(block) {
    if (!this.capturing || !block || !block.length) return;
    const mono = downmixTo16k(block, this.captureRate);
    this.acc = appendFloat(this.acc, mono);

    while (this.acc.length >= FRAME_SAMPLES) {
      const frame = this.acc.subarray(0, FRAME_SAMPLES);
      this.acc = this.acc.slice(FRAME_SAMPLES);

      let sum = 0;
      for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
      const rms = Math.sqrt(sum / frame.length) * 32768;
      const now = performance.now();
      if (now - this.lastLevelAt > 40) {
        this.lastLevelAt = now;
        this.onLevel(rms);
      }

      try {
        const packet = this.encoder.encode(floatToInt16(frame));
        if (packet && packet.length) this.onPacket(packet);
      } catch (e) {
        this.log(`Opus 编码失败：${e.message}`);
      }
    }
  }

  stopCapture() {
    this.capturing = false;
    try {
      this.source?.disconnect();
      this.captureNode?.disconnect();
      this.silentSink?.disconnect();
    } catch (_) {
      /* ignore */
    }
    this.source = null;
    this.captureNode = null;
    this.silentSink = null;
    this.acc = new Float32Array(0);
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
    if (this.ctx) {
      this.ctx.close().catch(() => {});
      this.ctx = null;
    }
  }

  /** 收到下行 Opus 包：解码并排程播放 */
  async enqueuePacket(data) {
    if (!this.playCtx) await this.init();
    await this.ensureDecoder();
    let pcm;
    try {
      pcm = this.decoder.decode(new Uint8Array(data));
    } catch (e) {
      this.log(`Opus 解码失败：${e.message}`);
      return;
    }
    if (!pcm || !pcm.length) return;

    const ctx = this.playCtx;
    const buffer = ctx.createBuffer(1, pcm.length, this.decoderRate);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) channel[i] = pcm[i] / 32768;

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.playGain);

    const now = ctx.currentTime;
    if (this.nextPlayTime < now) this.nextPlayTime = now + 0.02;
    const gen = this.generation;
    source.start(this.nextPlayTime);
    this.nextPlayTime += pcm.length / this.decoderRate;
    this.pending++;
    this.activeSources.add(source);
    source.onended = () => {
      this.activeSources.delete(source);
      if (gen !== this.generation) return;
      this.pending = Math.max(0, this.pending - 1);
      this._checkDrained();
    };
  }

  /** 服务端 tts stop：这一轮数据收齐，等排队的音频播完就通知上层 */
  markTurnEnd() {
    this.turnEnded = true;
    this._checkDrained();
  }

  _checkDrained() {
    if (this.turnEnded && this.pending === 0) {
      this.turnEnded = false;
      this.onDrained();
    }
  }

  /** 新的一轮播报 / 打断：丢掉还没播完的 TTS */
  flushPlayback() {
    this.generation++;
    for (const source of this.activeSources) {
      try {
        source.onended = null;
        source.stop();
      } catch (_) {
        /* ignore */
      }
    }
    this.activeSources.clear();
    this.pending = 0;
    this.nextPlayTime = 0;
    this.turnEnded = false;
    try {
      this.decoder?.reset();
    } catch (_) {
      /* ignore */
    }
  }

  close() {
    this.stopCapture();
    this.flushPlayback();
    try {
      this.encoder?.free();
      this.decoder?.free();
    } catch (_) {
      /* ignore */
    }
    this.encoder = null;
    this.decoder = null;
    if (this.playCtx) {
      this.playCtx.close().catch(() => {});
      this.playCtx = null;
    }
  }
}
