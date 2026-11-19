// Settings page: #/settings
import './settings.css';
import type { Settings } from '../types';
import { exportBackup, getSettings, saveSettings } from '../db';
import { controller } from '../player/controller';
import { pocket } from '../pocket';
import { mountPocketSettings } from '../pocket/ui';
import { h, toast } from './dom';

const REPO_URL = 'https://github.com/James-baunach/listenshelf';
const VERSION = '1.0';

export function mount(root: HTMLElement) {
  const cleanups: (() => void)[] = [];
  const page = h('div', { class: 'st' }, h('div', { class: 'page-head' }, h('h1', null, 'Settings')));
  root.replaceChildren(page);
  let s: Settings;

  /** Save a patch; tell the controller when it affects playback. */
  async function change(patch: Partial<Settings>, playback = true) {
    s = await saveSettings(patch);
    if (playback) await controller.refreshSettings();
  }

  const section = (title: string, ...kids: Node[]) => {
    const el = h('section', { class: 'st-sec' }, h('h2', null, title), h('div', { class: 'card st-card' }, kids));
    page.append(el);
    return el;
  };
  const rowOf = (label: string, ctl: Node, hint?: string) =>
    h('div', { class: 'st-row' }, h('div', { class: 'grow' }, h('div', { class: 'st-label' }, label), hint ? h('div', { class: 'small faint' }, hint) : null), ctl);
  const toggle = (checked: boolean, onch: (v: boolean) => void) => {
    const i = h('input', { type: 'checkbox', checked, class: 'st-switch-in' }) as HTMLInputElement;
    i.addEventListener('change', () => onch(i.checked));
    return h('label', { class: 'st-switch' }, i, h('span'));
  };
  const slider = (min: number, max: number, step: number, val: number, fmt: (v: number) => string, commit: (v: number) => void) => {
    const out = h('span', { class: 'st-val' }, fmt(val));
    const i = h('input', { type: 'range', min, max, step, value: val }) as HTMLInputElement;
    i.addEventListener('input', () => { out.textContent = fmt(+i.value); });
    i.addEventListener('change', () => commit(+i.value));
    return h('div', { class: 'st-slider' }, i, out);
  };

  void (async () => {
    s = await getSettings();

    // ─── Playback ───
    const pocketOk = pocket.isSupported();
    const modeCards = h('div', { class: 'st-modes' });
    const drawModes = () => modeCards.replaceChildren(
      modeCard('live', 'Live', 'Instant, uses your phone\'s own voices. May pause when the screen locks.'),
      modeCard('pocket', 'Pocket', 'Natural neural voice, pre-recorded on your phone. Keeps playing with the screen locked. Needs a one-time ~90 MB download.', !pocketOk));
    function modeCard(m: 'live' | 'pocket', name: string, text: string, disabled = false) {
      return h('button', {
        class: 'st-mode' + (s.mode === m ? ' active' : ''), disabled, role: 'radio', 'aria-checked': s.mode === m,
        onclick: async () => { await change({ mode: m }); drawModes(); },
      }, h('b', null, name), h('span', { class: 'small muted' }, disabled ? 'Not supported on this device/browser.' : text));
    }
    drawModes();

    const skipChips = h('div', { class: 'chips' });
    const drawSkip = () => skipChips.replaceChildren(...[10, 15, 30, 60].map((n) =>
      h('button', { class: 'chip' + (s.skipSeconds === n ? ' active' : ''), onclick: async () => { await change({ skipSeconds: n }, false); drawSkip(); } }, `${n}s`)));
    drawSkip();

    section('Playback',
      modeCards,
      rowOf('Default speed', slider(0.5, 3, 0.05, s.rate, (v) => `${v.toFixed(2)}×`, (v) => change({ rate: v }))),
      rowOf('Pitch', slider(0.5, 2, 0.05, s.pitch, (v) => v.toFixed(2), (v) => change({ pitch: v })), 'Live voices only'),
      rowOf('Skip buttons', skipChips),
      rowOf('Skip text in parentheses', toggle(s.skipParentheticals, (v) => { void change({ skipParentheticals: v }); }), 'Live voices only'),
      rowOf('Auto-play next article', toggle(s.autoAdvanceQueue, (v) => { void change({ autoAdvanceQueue: v }, false); }), 'Continue down the Wikipedia queue'));

    // ─── Live voice ───
    const voiceSel = h('select', { class: 'input', 'aria-label': 'Live voice' }) as HTMLSelectElement;
    const fillVoices = () => {
      const voices = 'speechSynthesis' in window ? speechSynthesis.getVoices() : [];
      voiceSel.replaceChildren(h('option', { value: '' }, 'System default'));
      const dev = (navigator.language || 'en').split('-')[0].toLowerCase();
      let names: Intl.DisplayNames | null = null;
      try { names = new Intl.DisplayNames([navigator.language || 'en'], { type: 'language' }); } catch { /* ignore */ }
      const groups = new Map<string, SpeechSynthesisVoice[]>();
      for (const v of voices) {
        const k = v.lang.split(/[-_]/)[0].toLowerCase();
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k)!.push(v);
      }
      const keys = [...groups.keys()].sort((a, b) => (a === dev ? -1 : b === dev ? 1 : (names?.of(a) ?? a).localeCompare(names?.of(b) ?? b)));
      for (const k of keys) {
        const g = h('optgroup', { label: (names?.of(k) ?? k) + (k === dev ? ' (your language)' : '') });
        for (const v of groups.get(k)!.sort((a, b) => a.name.localeCompare(b.name))) g.append(h('option', { value: v.voiceURI }, `${v.name} (${v.lang})${v.localService ? '' : ' · online'}`));
        voiceSel.append(g);
      }
      voiceSel.value = s.liveVoiceURI ?? '';
      if (voiceSel.value !== (s.liveVoiceURI ?? '')) voiceSel.value = '';
    };
    fillVoices();
    if ('speechSynthesis' in window) {
      speechSynthesis.addEventListener('voiceschanged', fillVoices);
      cleanups.push(() => speechSynthesis.removeEventListener('voiceschanged', fillVoices));
    }
    voiceSel.addEventListener('change', () => { void change({ liveVoiceURI: voiceSel.value || undefined }); });
    const test = h('button', { class: 'btn', onclick: () => {
      if (!('speechSynthesis' in window)) { toast('Speech is not available here'); return; }
      if (controller.getState().playing) controller.pause();
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance('This is how your book will sound when I read it aloud.');
      const v = speechSynthesis.getVoices().find((x) => x.voiceURI === voiceSel.value);
      if (v) { u.voice = v; u.lang = v.lang; }
      u.rate = s.rate; u.pitch = s.pitch;
      speechSynthesis.speak(u);
    } }, 'Test voice');
    section('Live voice', voiceSel, h('div', { class: 'row end', style: 'margin-top:10px' }, test),
      h('p', { class: 'small faint' }, 'More voices can be installed in Android Settings, System, Languages, Text-to-speech output.'));

    // ─── Pocket ───
    const pocketBox = h('div');
    section('Pocket mode', pocketBox);
    const pc = mountPocketSettings(pocketBox);
    if (typeof pc === 'function') cleanups.push(pc);

    // ─── Wikipedia ───
    const lang = h('input', { class: 'input', value: s.wikiLang, maxlength: 12, autocapitalize: 'none', 'aria-label': 'Wikipedia language code' }) as HTMLInputElement;
    lang.addEventListener('change', () => {
      const v = lang.value.trim().toLowerCase().replace(/[^a-z-]/g, '');
      if (v) void change({ wikiLang: v }, false); else lang.value = s.wikiLang;
    });
    const chipBox = h('div', { class: 'chips' });
    const drawChips = () => chipBox.replaceChildren(...s.wikiSkipSections.map((t) =>
      h('span', { class: 'chip st-tag' }, t, h('button', { 'aria-label': `Remove ${t}`, onclick: async () => { await change({ wikiSkipSections: s.wikiSkipSections.filter((x) => x !== t) }, false); drawChips(); } }, '×'))));
    drawChips();
    const addIn = h('input', { class: 'input', placeholder: 'Add a section title to skip' }) as HTMLInputElement;
    const add = async () => {
      const v = addIn.value.trim();
      if (!v || s.wikiSkipSections.some((x) => x.toLowerCase() === v.toLowerCase())) { addIn.value = ''; return; }
      addIn.value = '';
      await change({ wikiSkipSections: [...s.wikiSkipSections, v] }, false);
      drawChips();
    };
    addIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); void add(); } });
    section('Wikipedia',
      rowOf('Language code', h('div', { style: 'width:90px' }, lang), 'e.g. en, de, fr'),
      h('div', { class: 'st-label', style: 'margin:12px 0 8px' }, 'Sections skipped on import'),
      chipBox,
      h('div', { class: 'row gap', style: 'margin-top:10px' }, addIn, h('button', { class: 'btn', onclick: () => void add() }, 'Add')),
      h('p', { class: 'small faint' }, 'Applies to articles imported from now on.'));

    // ─── Appearance ───
    const themeBox = h('div', { class: 'chips' });
    const drawTheme = () => themeBox.replaceChildren(...(['dark', 'light', 'system'] as const).map((t) =>
      h('button', { class: 'chip' + (s.theme === t ? ' active' : ''), onclick: async () => { await change({ theme: t }, false); drawTheme(); } }, t[0].toUpperCase() + t.slice(1))));
    drawTheme();
    section('Appearance', themeBox);

    // ─── Data ───
    const usage = h('div', { class: 'muted' }, 'Calculating…');
    const persist = h('div', { class: 'small faint' });
    const fmtMB = (n: number) => n > 1e9 ? `${(n / 1e9).toFixed(2)} GB` : `${(n / 1e6).toFixed(1)} MB`;
    const refreshStorage = async () => {
      try {
        const e = await navigator.storage.estimate();
        usage.textContent = `Using ${fmtMB(e.usage ?? 0)}${e.quota ? ` of ${fmtMB(e.quota)} available` : ''}`;
        const p = await navigator.storage.persisted?.();
        persist.replaceChildren(p ? 'Persistent storage: on (your library will not be cleared automatically).' : h('span', null, 'Persistent storage: off. ',
          h('a', { href: '#', onclick: async (ev: Event) => { ev.preventDefault(); const ok = await navigator.storage.persist?.(); toast(ok ? 'Persistent storage enabled' : 'The browser declined'); void refreshStorage(); } }, 'Request it')));
      } catch { usage.textContent = 'Storage information is not available.'; }
    };
    void refreshStorage();
    section('Data', usage, persist,
      h('div', { class: 'row gap', style: 'margin-top:12px' }, h('button', { class: 'btn', onclick: async () => {
        const data = await exportBackup();
        const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
        const a = h('a', { href: url, download: `listenshelf-backup-${new Date().toISOString().slice(0, 10)}.json` });
        document.body.append(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
        toast('Backup saved (library info and positions, not PDFs or audio)');
      } }, 'Export backup')));

    // ─── About ───
    section('About', h('div', null, `ListenShelf ${VERSION}`),
      h('p', { class: 'small muted' }, 'Reads your PDF books and Wikipedia articles aloud. Everything stays on your device.'),
      h('a', { href: REPO_URL, target: '_blank', rel: 'noopener' }, 'Project on GitHub'));
  })();

  return () => cleanups.forEach((c) => c());
}
