// Module worker owning the KokoroTTS instance. Keeps heavy model code out of the main bundle.
import { KokoroTTS } from 'kokoro-js';
import { env } from '@huggingface/transformers';

export type WorkerIn =
  | { type: 'load'; device?: 'wasm' | 'webgpu' }
  | { type: 'synth'; id: number; sentences: string[]; voice: string }
  | { type: 'cancel'; id: number };

export type WorkerOut =
  | { type: 'progress'; value: number }
  | { type: 'ready'; device: 'wasm' | 'webgpu' }
  | { type: 'loadError'; message: string }
  | { type: 'synthProgress'; id: number; done: number; total: number }
  | { type: 'result'; id: number; pcm: Float32Array; sampleRate: number; offsets: number[] }
  | { type: 'synthError'; id: number; message: string };

env.allowLocalModels = false;
env.useBrowserCache = true; // model files cached in the Cache API -> works offline after first load
// Self-host the onnxruntime wasm runtime (transformers.js defaults to the jsdelivr CDN, which breaks offline use).
const ortWasm = new URL('../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.wasm', import.meta.url).href;
const ortMjs = new URL('../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.mjs', import.meta.url).href;
if (env.backends.onnx.wasm) env.backends.onnx.wasm.wasmPaths = { wasm: ortWasm, mjs: ortMjs } as any;

const MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const LEAD_SILENCE = 0.8;
const GAP_SILENCE = 0.25;

const post = (m: WorkerOut, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(m, transfer);

let tts: KokoroTTS | null = null;
let loading: Promise<void> | null = null;
let device: 'wasm' | 'webgpu' = 'wasm';
const cancelled = new Set<number>();

async function hasWebGPU() {
  try {
    const gpu = (navigator as any).gpu;
    return !!gpu && !!(await gpu.requestAdapter());
  } catch { return false; }
}

function makeProgress() {
  const files = new Map<string, { loaded: number; total: number }>();
  let last = 0;
  return (p: any) => {
    if (!p || !p.file) return;
    if (p.status === 'progress' || p.status === 'progress_total') {
      if (p.status === 'progress_total') return;
      files.set(p.file, { loaded: p.loaded ?? 0, total: p.total ?? 0 });
    } else if (p.status === 'done') {
      const f = files.get(p.file);
      if (f) f.loaded = f.total;
    } else return;
    let l = 0, t = 0;
    for (const f of files.values()) { l += f.loaded; t += f.total; }
    const v = t > 0 ? Math.min(0.99, l / t) : 0;
    if (v - last >= 0.005) { last = v; post({ type: 'progress', value: v }); }
  };
}

async function load(want?: 'wasm' | 'webgpu') {
  if (tts) { post({ type: 'ready', device }); return; }
  loading ??= (async () => {
    const tryWebgpu = want === 'webgpu' && (await hasWebGPU());
    if (tryWebgpu) {
      try {
        tts = await KokoroTTS.from_pretrained(MODEL, { dtype: 'fp32', device: 'webgpu', progress_callback: makeProgress() });
        device = 'webgpu';
        return;
      } catch (e) { console.warn('webgpu failed, falling back to wasm', e); }
    }
    tts = await KokoroTTS.from_pretrained(MODEL, { dtype: 'q8', device: 'wasm', progress_callback: makeProgress() });
    device = 'wasm';
  })();
  try {
    await loading;
    post({ type: 'ready', device });
  } catch (e) {
    loading = null;
    post({ type: 'loadError', message: String((e as Error)?.message ?? e) });
  }
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

async function synth(id: number, sentences: string[], voice: string) {
  try {
    if (!tts) throw new Error('model not loaded');
    const chunks: Float32Array[] = [];
    const offsets: number[] = [];
    let sr = 24000;
    let samples = 0;
    const silence = (sec: number) => { const n = Math.round(sec * sr); chunks.push(new Float32Array(n)); samples += n; };
    silence(LEAD_SILENCE);
    for (let i = 0; i < sentences.length; i++) {
      await tick(); // let 'cancel' messages in
      if (cancelled.has(id)) { cancelled.delete(id); return; }
      offsets.push(samples / sr);
      const text = sentences[i];
      try {
        const out = await tts.generate(text, { voice: voice as any });
        sr = out.sampling_rate;
        chunks.push(out.audio); samples += out.audio.length;
      } catch (e) {
        console.warn('sentence failed', i, e);
        silence(0.4);
      }
      if (i < sentences.length - 1) silence(GAP_SILENCE);
      post({ type: 'synthProgress', id, done: i + 1, total: sentences.length });
    }
    const pcm = new Float32Array(samples);
    let o = 0;
    for (const c of chunks) { pcm.set(c, o); o += c.length; }
    post({ type: 'result', id, pcm, sampleRate: sr, offsets }, [pcm.buffer]);
  } catch (e) {
    post({ type: 'synthError', id, message: String((e as Error)?.message ?? e) });
  } finally {
    cancelled.delete(id);
  }
}

self.addEventListener('message', (ev: MessageEvent<WorkerIn>) => {
  const m = ev.data;
  if (m.type === 'load') void load(m.device);
  else if (m.type === 'synth') void synth(m.id, m.sentences, m.voice);
  else if (m.type === 'cancel') cancelled.add(m.id);
});
