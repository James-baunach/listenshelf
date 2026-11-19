// Pocket mode: neural TTS (kokoro-js, in a worker) rendered ahead of time to audio blobs in IndexedDB.
import { audioKey, type PlaybackEngine, type PocketJob, type PocketStatus, type PocketVoice } from '../types';
import { getAudio, getContent, getSettings, listAudioKeys, putAudio } from '../db';
import { encodeWav } from './wav';
import { prepareForSpeech } from '../speech';
import { createEngine } from './engine';
import type { WorkerIn, WorkerOut } from './worker';

export interface PocketAPI {
  /** False if the browser can't run the model (no WebAssembly / too little memory). */
  isSupported(): boolean;
  getStatus(): PocketStatus;
  /** Called immediately and on every status change. Returns unsubscribe. */
  subscribe(fn: (s: PocketStatus) => void): () => void;
  listVoices(): PocketVoice[];
  /** Downloads (first time, ~90 MB, cached) and initialises the model. */
  loadModel(): Promise<void>;
  /** True if audio for this section+voice exists in the `audio` store. */
  hasSection(itemId: string, section: number, voice: string): Promise<boolean>;
  /** Section indexes already rendered for this item+voice. */
  renderedSections(itemId: string, voice: string): Promise<Set<number>>;
  /** Queue sections for rendering (skips ones already rendered). Loads the model if needed. */
  enqueue(itemId: string, sections: number[], voice: string): void;
  /** Cancel queued/running jobs for an item (or all if omitted). */
  cancel(itemId?: string): void;
  /** Plays rendered audio via an <audio> element (works with the screen locked). */
  engine: PlaybackEngine;
  /** Speak a short sample with a voice (for the settings voice picker). */
  preview(voice: string, text?: string): Promise<void>;
  // ── additions ──
  /** True if the model files are already in the browser cache (loadModel will not download). */
  isModelCached(): Promise<boolean>;
  /** 'wasm' (default, q8, ~90 MB) or 'webgpu' (fp32, ~330 MB, faster). Applies to the next loadModel(). */
  getDevicePref(): 'wasm' | 'webgpu';
  setDevicePref(d: 'wasm' | 'webgpu'): void;
  hasWebGPU(): boolean;
}

const VOICE_LIST: PocketVoice[] = [
  { id: 'af_heart', name: 'Heart — US female' },
  { id: 'af_bella', name: 'Bella — US female' },
  { id: 'af_nicole', name: 'Nicole — US female' },
  { id: 'af_sarah', name: 'Sarah — US female' },
  { id: 'af_sky', name: 'Sky — US female' },
  { id: 'af_kore', name: 'Kore — US female' },
  { id: 'af_aoede', name: 'Aoede — US female' },
  { id: 'af_alloy', name: 'Alloy — US female' },
  { id: 'af_nova', name: 'Nova — US female' },
  { id: 'af_jessica', name: 'Jessica — US female' },
  { id: 'af_river', name: 'River — US female' },
  { id: 'am_michael', name: 'Michael — US male' },
  { id: 'am_fenrir', name: 'Fenrir — US male' },
  { id: 'am_puck', name: 'Puck — US male' },
  { id: 'am_echo', name: 'Echo — US male' },
  { id: 'am_eric', name: 'Eric — US male' },
  { id: 'am_liam', name: 'Liam — US male' },
  { id: 'am_onyx', name: 'Onyx — US male' },
  { id: 'am_adam', name: 'Adam — US male' },
  { id: 'am_santa', name: 'Santa — US male' },
  { id: 'bf_emma', name: 'Emma — UK female' },
  { id: 'bf_isabella', name: 'Isabella — UK female' },
  { id: 'bf_alice', name: 'Alice — UK female' },
  { id: 'bf_lily', name: 'Lily — UK female' },
  { id: 'bm_george', name: 'George — UK male' },
  { id: 'bm_fable', name: 'Fable — UK male' },
  { id: 'bm_lewis', name: 'Lewis — UK male' },
  { id: 'bm_daniel', name: 'Daniel — UK male' },
];

const PREF_KEY = 'listenshelf.pocketDevice';

// ─── status store ───
let status: PocketStatus = { modelState: 'absent', modelProgress: 0, jobs: [] };
const subs = new Set<(s: PocketStatus) => void>();
function setStatus(patch: Partial<PocketStatus>) {
  status = { ...status, ...patch };
  subs.forEach((f) => f(status));
}
function emitJobs() { setStatus({ jobs: status.jobs.slice() }); }

const supported = (() => {
  if (typeof WebAssembly === 'undefined') return false;
  const mem = (navigator as any).deviceMemory;
  return mem === undefined || mem >= 2;
})();
if (!supported) status = { ...status, modelState: 'unsupported' };

// ─── worker plumbing ───
let worker: Worker | null = null;
let loadPromise: Promise<void> | null = null;
let loadResolve: (() => void) | null = null;
let loadReject: ((e: Error) => void) | null = null;
let nextId = 1;
const pending = new Map<number, {
  resolve: (r: { pcm: Float32Array; sampleRate: number; offsets: number[] }) => void;
  reject: (e: Error) => void;
  onProgress?: (p: number) => void;
}>();

function getWorker(): Worker {
  if (worker) return worker;
  const w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  w.onmessage = (ev: MessageEvent<WorkerOut>) => {
    const m = ev.data;
    switch (m.type) {
      case 'progress': setStatus({ modelProgress: m.value }); break;
      case 'ready': setStatus({ modelState: 'ready', modelProgress: 1, device: m.device, modelError: undefined }); loadResolve?.(); break;
      case 'loadError': setStatus({ modelState: 'error', modelError: m.message }); loadReject?.(new Error(m.message)); loadPromise = null; break;
      case 'synthProgress': pending.get(m.id)?.onProgress?.(m.done / m.total); break;
      case 'result': { const p = pending.get(m.id); pending.delete(m.id); p?.resolve(m); break; }
      case 'synthError': { const p = pending.get(m.id); pending.delete(m.id); p?.reject(new Error(m.message)); break; }
    }
  };
  w.onerror = (e) => {
    const msg = e.message || 'Worker crashed';
    setStatus({ modelState: 'error', modelError: msg });
    loadReject?.(new Error(msg));
    for (const p of pending.values()) p.reject(new Error(msg));
    pending.clear();
    worker?.terminate(); worker = null; loadPromise = null;
  };
  worker = w;
  return w;
}
const send = (m: WorkerIn) => getWorker().postMessage(m);

function getDevicePref(): 'wasm' | 'webgpu' {
  try { return localStorage.getItem(PREF_KEY) === 'webgpu' ? 'webgpu' : 'wasm'; } catch { return 'wasm'; }
}

function loadModel(): Promise<void> {
  if (!supported) return Promise.reject(new Error('Pocket mode is not supported on this device'));
  if (status.modelState === 'ready') return Promise.resolve();
  if (loadPromise) return loadPromise;
  setStatus({ modelState: 'downloading', modelProgress: 0, modelError: undefined });
  loadPromise = new Promise<void>((res, rej) => { loadResolve = res; loadReject = rej; });
  loadPromise.catch(() => {});
  send({ type: 'load', device: getDevicePref() });
  return loadPromise;
}

// Serialises access to the worker (render jobs and previews).
let lock: Promise<unknown> = Promise.resolve();
function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const run = lock.then(fn, fn);
  lock = run.catch(() => {});
  return run;
}

function synth(sentences: string[], voice: string, onProgress?: (p: number) => void, onId?: (id: number) => void) {
  return new Promise<{ pcm: Float32Array; sampleRate: number; offsets: number[] }>((resolve, reject) => {
    const id = nextId++;
    onId?.(id);
    pending.set(id, { resolve, reject, onProgress });
    send({ type: 'synth', id, sentences, voice });
  });
}

// ─── render queue ───
interface Internal { job: PocketJob; cancelled: boolean; synthId?: number; }
const queue: Internal[] = [];
let running = false;

async function runQueue() {
  if (running) return;
  running = true;
  try {
    while (true) {
      const cur = queue.find((q) => q.job.state === 'queued');
      if (!cur) break;
      await renderOne(cur);
    }
  } finally {
    running = false;
    releaseWake();
  }
}

async function renderOne(cur: Internal) {
  const { job } = cur;
  try {
    await loadModel();
    if (cur.cancelled) throw new Error('cancelled');
    const key = audioKey(job.itemId, job.section, job.voice);
    if (await getAudio(key)) { job.state = 'done'; job.progress = 1; return; }
    const content = await getContent(job.itemId);
    const raw = content?.sections[job.section]?.sentences;
    if (!raw?.length) throw new Error('Section has no text');
    // Speech cleanup + pronunciations are baked into the audio here. Changing those settings later
    // does NOT re-render audio that already exists (the settings panel shows a hint about this).
    // Sentences that clean to '' stay in the array so offsets remain 1:1 with sentences; the worker
    // turns an empty/failed sentence into short silence and still records its offset.
    const cfg = await getSettings();
    const sentences = raw.map((x) => prepareForSpeech(x, cfg));
    job.state = 'rendering'; job.progress = 0; emitJobs();
    const r = await exclusive(async () => {
      if (cur.cancelled) throw new Error('cancelled');
      return synth(sentences, job.voice, (p) => { job.progress = p; emitJobs(); }, (id) => { cur.synthId = id; });
    });
    if (cur.cancelled) throw new Error('cancelled');
    const blob = encodeWav(r.pcm, r.sampleRate);
    await putAudio({
      key, itemId: job.itemId, section: job.section, voice: job.voice,
      blob, offsets: r.offsets, duration: r.pcm.length / r.sampleRate, createdAt: Date.now(),
    });
    job.state = 'done'; job.progress = 1;
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    if (cur.cancelled || msg === 'cancelled') {
      const i = queue.indexOf(cur); if (i >= 0) queue.splice(i, 1);
    } else { job.state = 'error'; job.error = msg; }
  } finally {
    syncJobs();
  }
}

function syncJobs() {
  // keep active jobs plus the last few finished/failed ones
  const finished = queue.filter((q) => q.job.state === 'done' || q.job.state === 'error');
  for (const f of finished.slice(0, Math.max(0, finished.length - 20))) queue.splice(queue.indexOf(f), 1);
  setStatus({ jobs: queue.map((q) => q.job) });
}

// ─── wake lock ───
let wake: WakeLockSentinel | null = null;
async function acquireWake() {
  if (wake || document.visibilityState !== 'visible' || !('wakeLock' in navigator)) return;
  try {
    wake = await navigator.wakeLock.request('screen');
    wake.addEventListener('release', () => { wake = null; });
  } catch { /* denied */ }
}
function releaseWake() { void wake?.release().catch(() => {}); wake = null; }
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && running) void acquireWake();
});

// ─── public API ───
async function hasSection(itemId: string, section: number, voice: string) {
  return !!(await getAudio(audioKey(itemId, section, voice)));
}
async function renderedSections(itemId: string, voice: string) {
  const out = new Set<number>();
  const suffix = `|${voice}`;
  for (const k of await listAudioKeys(itemId)) {
    if (!k.endsWith(suffix)) continue;
    const n = Number(k.slice(itemId.length + 1, k.length - suffix.length));
    if (Number.isFinite(n)) out.add(n);
  }
  return out;
}

function enqueue(itemId: string, sections: number[], voice: string) {
  if (!supported) return;
  void (async () => {
    const done = await renderedSections(itemId, voice);
    let added = false;
    for (const s of sections) {
      if (done.has(s)) continue;
      if (queue.some((q) => q.job.itemId === itemId && q.job.section === s && q.job.voice === voice && (q.job.state === 'queued' || q.job.state === 'rendering'))) continue;
      // drop an older failed entry for the same section
      const old = queue.findIndex((q) => q.job.itemId === itemId && q.job.section === s && q.job.voice === voice);
      if (old >= 0) queue.splice(old, 1);
      queue.push({ cancelled: false, job: { itemId, section: s, voice, state: 'queued', progress: 0 } });
      added = true;
    }
    if (added) { syncJobs(); void acquireWake(); void runQueue(); }
  })();
}

function cancel(itemId?: string) {
  for (const q of queue.slice()) {
    if (itemId && q.job.itemId !== itemId) continue;
    if (q.job.state === 'queued') { queue.splice(queue.indexOf(q), 1); }
    else if (q.job.state === 'rendering') {
      q.cancelled = true;
      if (q.synthId != null) {
        send({ type: 'cancel', id: q.synthId });
        // The worker stops silently; reject locally so the queue moves on.
        const p = pending.get(q.synthId); pending.delete(q.synthId);
        p?.reject(new Error('cancelled'));
      }
    }
  }
  syncJobs();
}

async function isModelCached() {
  try {
    if (!('caches' in self)) return false;
    for (const name of await caches.keys()) {
      const c = await caches.open(name);
      for (const req of await c.keys()) if (/Kokoro-82M.*\.onnx/i.test(req.url)) return true;
    }
  } catch { /* ignore */ }
  return false;
}

let previewAudio: HTMLAudioElement | null = null;
async function preview(voice: string, text = 'Hello! This is how I sound when reading your books aloud.') {
  await loadModel();
  const r = await exclusive(() => synth([text], voice));
  const blob = encodeWav(r.pcm, r.sampleRate);
  previewAudio?.pause();
  if (previewAudio?.src) URL.revokeObjectURL(previewAudio.src);
  const a = (previewAudio = new Audio(URL.createObjectURL(blob)));
  await new Promise<void>((res) => {
    a.onended = () => res(); a.onerror = () => res(); a.onpause = () => res();
    a.play().catch(() => res());
  });
}

export const pocket: PocketAPI = {
  isSupported: () => supported,
  getStatus: () => status,
  subscribe(fn) { subs.add(fn); fn(status); return () => { subs.delete(fn); }; },
  listVoices: () => VOICE_LIST,
  loadModel, hasSection, renderedSections, enqueue, cancel,
  engine: createEngine(),
  preview,
  isModelCached,
  getDevicePref,
  setDevicePref(d) {
    try { localStorage.setItem(PREF_KEY, d); } catch { /* ignore */ }
  },
  hasWebGPU: () => !!(navigator as any).gpu,
};
