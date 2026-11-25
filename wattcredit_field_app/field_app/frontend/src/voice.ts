import { toB64 } from './crypto.js';

export const MAX_MS = 30_000;       // Sarvam's REST endpoint is meant for clips under about 30 s
export interface Recording { mime: string; b64: string; ms: number }

/** Records a compressed mono voice note (Opus in WebM/Ogg where the browser supports it, ~24 kbit/s,
 *  16 kHz requested). Typically 60-90 KB for 30 s, so it is safe to keep in the local database. */
export class VoiceRecorder {
  private rec: MediaRecorder | null = null; private chunks: Blob[] = []; private t0 = 0; private timer: number | undefined;
  private stream: MediaStream | null = null; private done: ((r: Recording) => void) | null = null;
  static supported() { return typeof MediaRecorder !== 'undefined' && !!navigator.mediaDevices?.getUserMedia; }
  async start(onAutoStop: (r: Recording) => void) {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, sampleRate: 16000, noiseSuppression: true, echoCancellation: true } });
    const mime = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4'].find(m => MediaRecorder.isTypeSupported(m));
    this.rec = new MediaRecorder(this.stream, { ...(mime ? { mimeType: mime } : {}), audioBitsPerSecond: 24000 });
    this.chunks = []; this.t0 = Date.now(); this.done = onAutoStop;
    this.rec.ondataavailable = e => { if (e.data.size) this.chunks.push(e.data); };
    this.rec.onstop = async () => {
      window.clearTimeout(this.timer); this.stream?.getTracks().forEach(t => t.stop());
      const blob = new Blob(this.chunks, { type: this.rec!.mimeType });
      const r = { mime: blob.type || 'audio/webm', b64: toB64(await blob.arrayBuffer()), ms: Date.now() - this.t0 };
      const cb = this.done; this.done = null; cb?.(r);
    };
    this.rec.start(); this.timer = window.setTimeout(() => this.stop(), MAX_MS);
  }
  stop() { if (this.rec && this.rec.state !== 'inactive') this.rec.stop(); }
  get recording() { return this.rec?.state === 'recording'; }
}
