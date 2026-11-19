// Settings panel for Pocket mode; mounted inside the Settings page.
import './pocket.css';
import { h, confirmSheet, toast } from '../ui/dom';
import { icons } from '../ui/icons';
import { db, deleteAudioForItem, getItem, getSettings, onChange, saveSettings } from '../db';
import { pocket } from './index';
import type { PocketStatus } from '../types';

const mb = (n: number) => (n / 1048576 >= 10 ? Math.round(n / 1048576) : (n / 1048576).toFixed(1)) + ' MB';

interface Usage { itemId: string; title: string; bytes: number; sections: number; }

async function readUsage(): Promise<Usage[]> {
  const d = await db();
  const map = new Map<string, Usage>();
  let cur = await d.transaction('audio').store.openCursor();
  while (cur) {
    const v = cur.value;
    const u = map.get(v.itemId) ?? { itemId: v.itemId, title: v.itemId, bytes: 0, sections: 0 };
    u.bytes += v.blob.size; u.sections++;
    map.set(v.itemId, u);
    cur = await cur.continue();
  }
  const list = [...map.values()];
  await Promise.all(list.map(async (u) => { u.title = (await getItem(u.itemId))?.title ?? '(deleted item)'; }));
  return list.sort((a, b) => b.bytes - a.bytes);
}

export function mountPocketSettings(root: HTMLElement): () => void {
  root.textContent = '';
  const wrap = h('div', { class: 'pk' });
  root.appendChild(wrap);

  let status: PocketStatus = pocket.getStatus();
  let voice = 'af_heart';
  let usage: Usage[] = [];
  let cached = false;
  let previewing: string | null = null;
  let disposed = false;

  const modelBox = h('div', { class: 'pk-model' });
  const voiceBox = h('div');
  const storageBox = h('div');
  const jobsBox = h('div');
  wrap.append(
    h('div', { class: 'pk-note' }, 'Pocket mode turns text into real audio on your phone with a neural voice, so it keeps playing with the screen locked. Rendering happens while the app is open; keep the screen on. A chapter of ~20 minutes may take several minutes on a phone.'),
    modelBox, voiceBox, jobsBox, storageBox);

  function renderModel() {
    modelBox.textContent = '';
    modelBox.append(h('h3', null, 'Voice model'));
    if (!pocket.isSupported()) {
      modelBox.append(h('div', { class: 'pk-err' }, 'This device or browser cannot run the voice model.'));
      return;
    }
    const s = status;
    let text = 'Not downloaded';
    if (s.modelState === 'downloading') text = cached ? 'Loading…' : `Downloading… ${Math.round(s.modelProgress * 100)}%`;
    else if (s.modelState === 'ready') text = `Ready (${s.device === 'webgpu' ? 'WebGPU' : 'WASM'})`;
    else if (s.modelState === 'error') text = 'Error';
    else if (cached) text = 'Downloaded — not loaded yet';
    modelBox.append(h('div', null, text));
    if (s.modelState === 'downloading') modelBox.append(h('div', { class: 'pk-bar' }, h('i', { style: `width:${Math.round(s.modelProgress * 100)}%` })));
    if (s.modelState === 'error') modelBox.append(h('div', { class: 'pk-err' }, s.modelError ?? 'Unknown error'));
    if (s.modelState === 'absent' || s.modelState === 'error') {
      if (pocket.hasWebGPU() && !cached) {
        const sel = h('select', { class: 'input', onchange: (e: Event) => pocket.setDevicePref((e.target as HTMLSelectElement).value as 'wasm' | 'webgpu') },
          h('option', { value: 'wasm' }, 'Compact — works everywhere (~90 MB)'),
          h('option', { value: 'webgpu' }, 'Fast — uses GPU if available (~330 MB)'));
        sel.value = pocket.getDevicePref();
        modelBox.append(sel);
      }
      modelBox.append(h('button', {
        class: 'btn primary',
        onclick: () => pocket.loadModel().catch((e) => toast(String(e?.message ?? e))),
      }, cached ? 'Load voice model' : 'Download voice model (~90 MB)'));
    }
  }

  function renderVoices() {
    voiceBox.textContent = '';
    voiceBox.append(h('h3', null, 'Voice'));
    const list = h('div', { class: 'pk-voices' });
    for (const v of pocket.listVoices()) {
      const busy = previewing === v.id;
      list.append(h('div', {
        class: `pk-voice${v.id === voice ? ' sel' : ''}`,
        onclick: async () => { voice = v.id; await saveSettings({ pocketVoice: v.id }); renderVoices(); },
      },
        h('span', { class: 'pk-name' }, (v.id === voice ? '✓ ' : '') + v.name),
        h('button', {
          class: 'pk-play', 'aria-label': `Preview ${v.name}`, disabled: previewing !== null, html: busy ? '…' : icons.play,
          onclick: async (e: Event) => {
            e.stopPropagation();
            previewing = v.id; renderVoices();
            try { await pocket.preview(v.id); } catch (err) { toast(String((err as Error)?.message ?? err)); }
            previewing = null; if (!disposed) renderVoices();
          },
        })));
    }
    voiceBox.append(list);
  }

  function renderJobs() {
    jobsBox.textContent = '';
    const jobs = status.jobs;
    if (!jobs.length) return;
    jobsBox.append(h('div', { class: 'row between' }, h('h3', null, 'Rendering'),
      h('button', { class: 'btn ghost', onclick: () => pocket.cancel() }, 'Cancel all')));
    for (const j of jobs) {
      const pct = Math.round(j.progress * 100);
      const label = j.state === 'queued' ? 'Queued' : j.state === 'rendering' ? `Rendering ${pct}%` : j.state === 'done' ? 'Done' : `Failed: ${j.error ?? ''}`;
      jobsBox.append(h('div', { class: 'pk-job' },
        h('div', { class: 'pk-grow' },
          h('div', { class: 't' }, `${titleCache.get(j.itemId) ?? j.itemId} — section ${j.section + 1}`),
          h('div', { class: 's' }, label),
          j.state === 'rendering' ? h('div', { class: 'pk-bar' }, h('i', { style: `width:${pct}%` })) : null),
        j.state === 'queued' || j.state === 'rendering'
          ? h('button', { class: 'btn ghost', onclick: () => pocket.cancel(j.itemId) }, 'Cancel') : null));
    }
  }
  const titleCache = new Map<string, string>();
  async function fillTitles() {
    let changed = false;
    for (const j of status.jobs) {
      if (!titleCache.has(j.itemId)) { titleCache.set(j.itemId, (await getItem(j.itemId))?.title ?? j.itemId); changed = true; }
    }
    if (changed && !disposed) renderJobs();
  }

  function renderStorage() {
    storageBox.textContent = '';
    const total = usage.reduce((a, u) => a + u.bytes, 0);
    storageBox.append(h('div', { class: 'row between' }, h('h3', null, `Rendered audio: ${mb(total)}`),
      usage.length ? h('button', {
        class: 'btn ghost',
        onclick: async () => {
          if (await confirmSheet('Delete all rendered audio?', 'You can render it again later.', 'Delete', true)) {
            for (const u of usage) await deleteAudioForItem(u.itemId);
          }
        },
      }, 'Delete all') : null));
    if (!usage.length) storageBox.append(h('div', { class: 'pk-note' }, 'Nothing rendered yet.'));
    for (const u of usage) {
      storageBox.append(h('div', { class: 'pk-item' },
        h('div', { class: 'pk-grow' }, h('div', { class: 't' }, u.title), h('div', { class: 's' }, `${u.sections} section${u.sections === 1 ? '' : 's'} · ${mb(u.bytes)}`)),
        h('button', {
          class: 'btn ghost',
          onclick: async () => { if (await confirmSheet('Delete rendered audio?', u.title, 'Delete', true)) await deleteAudioForItem(u.itemId); },
        }, 'Delete')));
    }
  }

  const refreshUsage = async () => { usage = await readUsage(); if (!disposed) renderStorage(); };

  renderModel(); renderVoices(); renderJobs(); renderStorage();
  void getSettings().then((s) => { voice = s.pocketVoice; if (!disposed) renderVoices(); });
  void pocket.isModelCached().then((c) => { cached = c; if (!disposed) renderModel(); });
  void refreshUsage();

  const unsub = pocket.subscribe((s) => {
    const modelChanged = s.modelState !== status.modelState || s.modelProgress !== status.modelProgress || s.device !== status.device;
    status = s;
    if (modelChanged) renderModel();
    renderJobs(); void fillTitles();
  });
  const unAudio = onChange('audio', () => void refreshUsage());
  return () => { disposed = true; unsub(); unAudio(); };
}
