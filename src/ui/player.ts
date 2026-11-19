// Full-screen player page: #/play/:id
import './player.css';
import { DEFAULT_SETTINGS, type PlayerState, type PocketStatus, type Settings } from '../types';
import { getSettings, onChange } from '../db';
import { controller } from '../player/controller';
import { coverSource, typographicCover, type CoverSource } from '../player/cover';
import { pocket } from '../pocket';
import { CHARS_PER_SEC, charsBefore, fmtTime } from '../text';
import { go, h, sheet, toast } from './dom';
import { icons } from './icons';
import { createReader } from './reader';

const TEXT_PREF = 'listenshelf.textView';
const externalIcon = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h6v6"/><path d="M20 4 10 14"/><path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/></svg>';

const skipIcon = (fwd: boolean, n: number) =>
  `<svg viewBox="0 0 24 24" width="30" height="30" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">` +
  (fwd ? '<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>' : '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>') +
  `<text x="12" y="15.5" font-size="7.5" text-anchor="middle" fill="currentColor" stroke="none" font-family="system-ui" font-weight="700">${n}</text></svg>`;

const RATES = [0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3];
const SLEEPS: [string, number | 'section' | null][] = [['Off', null], ['5 minutes', 5], ['15 minutes', 15], ['30 minutes', 30], ['45 minutes', 45], ['60 minutes', 60], ['End of section', 'section']];

export function mount(root: HTMLElement, params: Record<string, string>) {
  let id = params.id;
  let settings: Settings = DEFAULT_SETTINGS;
  let st: PlayerState = controller.getState();
  let pst: PocketStatus = pocket.getStatus();
  let textView = localStorage.getItem(TEXT_PREF) === '1';
  let dragging = false;
  let cover: CoverSource | null = null;
  let coverKey = '';
  let sleepTick: ReturnType<typeof setInterval> | null = null;
  let closeSheets: (() => void)[] = [];

  // ─── skeleton ───
  const backBtn = h('button', { class: 'icon-btn', 'aria-label': 'Back', html: icons.back, onclick: goBack });
  const kind = h('span', { class: 'pl-kind' });
  const badge = h('span', { class: 'pl-badge' });
  const moreBtn = h('button', { class: 'icon-btn', 'aria-label': 'More', html: icons.more, onclick: openMenu });
  const wikiBtn = h('a', { class: 'icon-btn', 'aria-label': 'Open on Wikipedia', title: 'Open on Wikipedia', target: '_blank', rel: 'noopener', html: externalIcon, hidden: true });
  const top = h('div', { class: 'pl-top' }, backBtn, h('div', { class: 'grow pl-topmid' }, kind, badge), wikiBtn, moreBtn);

  const coverBox = h('div', { class: 'pl-cover' });
  const reader = createReader((section, sentence, char) => {
    controller.goTo(section, sentence, char);
    if (!controller.getState().playing) controller.play();
  });
  const textPane = h('div', { class: 'pl-text', hidden: true }, reader.el);
  const titleEl = h('h1', { class: 'pl-title' });
  const secBtn = h('button', { class: 'pl-section', onclick: openChapters });
  const statusBox = h('div', { class: 'pl-status card', hidden: true });
  const prepBox = h('div', { class: 'pl-prep', hidden: true });

  const seek = h('input', { type: 'range', min: '0', max: '0', step: '1', value: '0', 'aria-label': 'Position in section' }) as HTMLInputElement;
  seek.addEventListener('input', () => { dragging = true; seekLabel.textContent = `Sentence ${Number(seek.value) + 1} of ${Number(seek.max) + 1}`; });
  seek.addEventListener('change', () => { dragging = false; controller.goTo(st.section, Number(seek.value)); });
  const seekLabel = h('span');
  const remainLabel = h('span');
  const overall = h('div', { class: 'progress pl-overall' }, h('i'));

  const bPrevSec = h('button', { class: 'icon-btn', 'aria-label': 'Previous section', html: icons.prevSection, onclick: () => controller.prevSection() });
  const bBack = h('button', { class: 'icon-btn', onclick: () => controller.skipSeconds(-settings.skipSeconds) });
  const bPlay = h('button', { class: 'icon-btn big', onclick: () => controller.toggle() });
  const bFwd = h('button', { class: 'icon-btn', onclick: () => controller.skipSeconds(settings.skipSeconds) });
  const bNextSec = h('button', { class: 'icon-btn', 'aria-label': 'Next section', html: icons.nextSection, onclick: () => controller.nextSection() });
  const transport = h('div', { class: 'pl-transport' }, bPrevSec, bBack, bPlay, bFwd, bNextSec);

  const bPrevSent = h('button', { class: 'icon-btn', 'aria-label': 'Previous sentence', html: icons.prevSentence, onclick: () => controller.prevSentence() });
  const bNextSent = h('button', { class: 'icon-btn', 'aria-label': 'Next sentence', html: icons.nextSentence, onclick: () => controller.nextSentence() });
  const bSpeed = h('button', { class: 'pl-pill', 'aria-label': 'Speed', onclick: openSpeed });
  const sleepLabel = h('span');
  const bSleep = h('button', { class: 'pl-pill', 'aria-label': 'Sleep timer', onclick: openSleep }, h('span', { html: icons.moon }), sleepLabel);
  const bChapters = h('button', { class: 'icon-btn', 'aria-label': 'Chapters', html: icons.list, onclick: openChapters });
  const bText = h('button', { class: 'icon-btn', 'aria-label': 'Text view', html: icons.text, onclick: toggleText });
  const tools = h('div', { class: 'pl-tools' }, bPrevSent, bNextSent, bSpeed, bSleep, bChapters, bText);

  const bPrepare = h('button', { class: 'btn pl-prepare', onclick: openPrepare, hidden: true }, h('span', { html: icons.download }), 'Prepare for offline / locked-screen listening');

  const controls = h('div', { class: 'pl-controls' },
    h('div', { class: 'pl-seek' }, seek, h('div', { class: 'row between small muted' }, seekLabel, remainLabel), overall),
    transport, tools, bPrepare);
  const page = h('div', { class: 'pl' }, top, coverBox, textPane, titleEl, secBtn, statusBox, prepBox, controls);
  root.replaceChildren(page);

  // swipe down on cover returns
  let sy = 0, sx = 0;
  coverBox.addEventListener('touchstart', (e) => { sy = e.touches[0].clientY; sx = e.touches[0].clientX; }, { passive: true });
  coverBox.addEventListener('touchend', (e) => {
    const t = e.changedTouches[0];
    if (t.clientY - sy > 90 && Math.abs(t.clientX - sx) < 60) goBack();
  }, { passive: true });

  function toggleText() {
    textView = !textView;
    localStorage.setItem(TEXT_PREF, textView ? '1' : '0');
    renderAll();
    if (textView) reader.shown();
  }

  function goBack() {
    if (history.length > 1) history.back();
    else go(st.item?.kind === 'article' ? '#/queue' : '#/library');
  }

  // ─── rendering ───
  const sec = () => st.content?.sections[st.section];

  function renderAll() {
    const item = st.item;
    kind.textContent = item ? (item.kind === 'book' ? 'Book' : 'Wikipedia') : '';
    badge.textContent = st.engine === 'pocket' ? 'Pocket voice' : st.engine === 'live' ? 'Live voice' : '';
    badge.hidden = !st.engine;
    badge.className = 'pl-badge ' + (st.engine ?? '');
    titleEl.textContent = item?.title ?? (st.loading ? 'Loading…' : '');
    wikiBtn.hidden = !item?.sourceUrl;
    if (item?.sourceUrl && wikiBtn.getAttribute('href') !== item.sourceUrl) wikiBtn.setAttribute('href', item.sourceUrl);
    const s = sec();
    secBtn.replaceChildren(h('span', { class: 'ellipsis' }, s?.title || ''));
    if (s) secBtn.append(h('span', { html: icons.list, class: 'pl-section-ic' }));
    secBtn.disabled = !s;

    bBack.innerHTML = skipIcon(false, settings.skipSeconds); bBack.setAttribute('aria-label', `Back ${settings.skipSeconds} seconds`);
    bFwd.innerHTML = skipIcon(true, settings.skipSeconds); bFwd.setAttribute('aria-label', `Forward ${settings.skipSeconds} seconds`);
    bPlay.innerHTML = st.playing && st.loading ? '<span class="spinner"></span>' : st.playing ? icons.pause : icons.play;
    bPlay.setAttribute('aria-label', st.playing ? 'Pause' : 'Play');
    bSpeed.textContent = `${+settings.rate.toFixed(2)}×`;
    bText.classList.toggle('on', textView);
    coverBox.hidden = textView; textPane.hidden = !textView;
    page.classList.toggle('textmode', textView);

    // status / errors
    const ready = !!st.content;
    let msg: Node | null = null;
    if (item && item.status === 'processing') {
      const p = Math.round((item.processingProgress ?? 0) * 100);
      msg = h('div', null, h('div', { class: 'row gap' }, h('div', { class: 'spinner' }), h('b', null, 'Still importing…')),
        h('p', { class: 'muted small' }, 'This will be ready to play shortly.'),
        h('div', { class: 'progress' }, h('i', { style: `width:${p}%` })));
    } else if (item && item.status === 'no-text') {
      msg = h('div', null, h('b', null, 'No readable text'), h('p', { class: 'muted small' }, 'This PDF seems to be scanned pages (images), and scanned PDFs are not supported yet. Try a PDF with selectable text.'));
    } else if (st.error) {
      msg = h('div', null, h('b', null, 'Something went wrong'), h('p', { class: 'muted small' }, st.error));
    }
    statusBox.hidden = !msg;
    if (msg) statusBox.replaceChildren(msg);
    controls.classList.toggle('disabled', !ready);
    for (const b of [bPrevSec, bBack, bPlay, bFwd, bNextSec, bPrevSent, bNextSent, bChapters, bText]) (b as HTMLButtonElement).disabled = !ready;

    renderCover();
    renderProgress();
    renderSleep();
    renderText();
    renderPrep();
    bPrepare.hidden = !(ready && settings.mode === 'pocket' && pocket.isSupported());
  }

  function renderProgress() {
    const s = sec();
    if (!st.content || !s) { seek.max = '0'; seek.value = '0'; seekLabel.textContent = ''; remainLabel.textContent = ''; (overall.firstChild as HTMLElement).style.width = '0'; return; }
    const n = s.sentences.length;
    if (!dragging) {
      seek.max = String(Math.max(0, n - 1)); seek.value = String(st.sentence);
      seekLabel.textContent = `Sentence ${st.sentence + 1} of ${n}`;
    }
    const total = st.content.sections.reduce((a, x) => a + x.charCount, 0) || st.item?.totalChars || 1;
    const done = charsBefore(st.content.sections, st.section, st.sentence);
    const left = Math.max(0, total - done) / (CHARS_PER_SEC * settings.rate);
    remainLabel.textContent = `${Math.round((done / total) * 100)}% · ${fmtTime(left)} left`;
    (overall.firstChild as HTMLElement).style.width = `${(done / total) * 100}%`;
    seek.style.setProperty('--fill', n > 1 ? `${(st.sentence / (n - 1)) * 100}%` : '0%');
  }

  async function renderCover() {
    const item = st.item;
    const key = item ? item.id + (item.hasCover ? 'c' : '') : '';
    if (key === coverKey) return;
    coverKey = key;
    cover?.revoke(); cover = null;
    if (!item) { coverBox.replaceChildren(); return; }
    const fallback = () => coverBox.replaceChildren(typographicCover(item));
    fallback();
    const c = await coverSource(item).catch(() => null);
    if (!c) return;
    if (coverKey !== key) { c.revoke(); return; }
    cover = c;
    const img = h('img', { src: c.url, alt: '' });
    img.onerror = fallback;
    coverBox.replaceChildren(img);
  }

  function renderSleep() {
    const sl = st.sleepAt;
    if (sleepTick) { clearInterval(sleepTick); sleepTick = null; }
    const upd = () => {
      if (typeof sl === 'number') sleepLabel.textContent = fmtTime(Math.max(0, (sl - Date.now()) / 1000));
      else sleepLabel.textContent = sl === 'section' ? 'End' : '';
    };
    upd();
    bSleep.classList.toggle('on', sl != null);
    if (typeof sl === 'number') sleepTick = setInterval(upd, 1000);
  }

  let readerShownFor = '';
  function renderText() {
    if (!textView || !st.content || !st.itemId) return;
    reader.setContent(st.itemId, st.content);
    if (readerShownFor !== st.itemId) { readerShownFor = st.itemId; reader.shown(); }
    reader.setPosition(st.section, st.sentence);
  }

  function renderPrep() {
    const jobs = pst.jobs.filter((j) => j.itemId === id && j.voice === settings.pocketVoice);
    const open = jobs.filter((j) => j.state === 'queued' || j.state === 'rendering');
    const downloading = pst.modelState === 'downloading';
    if (settings.mode !== 'pocket' || (!open.length && !downloading)) { prepBox.hidden = true; return; }
    prepBox.hidden = false;
    const done = jobs.filter((j) => j.state === 'done').length;
    const cur = open.find((j) => j.state === 'rendering');
    const frac = downloading ? pst.modelProgress : jobs.length ? (done + (cur?.progress ?? 0)) / jobs.length : 0;
    prepBox.replaceChildren(
      h('div', { class: 'row between small' },
        h('span', null, downloading ? `Downloading voice model… ${Math.round(pst.modelProgress * 100)}%` : `Preparing audio… ${done} of ${jobs.length} sections`),
        h('button', { class: 'btn ghost small', onclick: () => pocket.cancel(id) }, 'Cancel')),
      h('div', { class: 'progress' }, h('i', { style: `width:${Math.round(frac * 100)}%` })));
  }

  // ─── sheets ───
  function openSheet(title: string, body: Node) {
    const close = sheet(title, body, { onClose: () => { closeSheets = closeSheets.filter((c) => c !== close); } });
    closeSheets.push(close);
    return close;
  }

  function openSpeed() {
    const chips = h('div', { class: 'chips' });
    const val = h('div', { class: 'pl-speedval' });
    const slider = h('input', { type: 'range', min: '0.5', max: '3', step: '0.05', value: settings.rate, 'aria-label': 'Speed' }) as HTMLInputElement;
    const refresh = () => {
      val.textContent = `${+settings.rate.toFixed(2)}×`;
      slider.value = String(settings.rate);
      chips.replaceChildren(...RATES.map((r) => h('button', { class: 'chip' + (Math.abs(r - settings.rate) < 0.001 ? ' active' : ''), onclick: () => apply(r) }, `${r}×`)));
    };
    const apply = (r: number) => { settings = { ...settings, rate: r }; controller.setRate(r); refresh(); };
    slider.addEventListener('input', () => { val.textContent = `${(+slider.value).toFixed(2)}×`; });
    slider.addEventListener('change', () => apply(+slider.value));
    refresh();
    openSheet('Speed', h('div', null, val, chips, h('div', { style: 'margin-top:16px' }, slider)));
  }

  function openSleep() {
    let close: () => void = () => {};
    const list = h('div', { class: 'pl-list' }, SLEEPS.map(([label, v]) => {
      const active = v === null ? st.sleepAt == null : v === 'section' ? st.sleepAt === 'section' : false;
      return h('button', { class: 'pl-row' + (active ? ' active' : ''), onclick: () => { controller.setSleepTimer(v); close(); if (v != null) toast(typeof v === 'number' ? `Sleep in ${v} min` : 'Stops at end of section'); } }, label);
    }));
    if (typeof st.sleepAt === 'number') list.prepend(h('div', { class: 'muted small', style: 'padding:4px 4px 8px' }, `Stops in ${fmtTime((st.sleepAt - Date.now()) / 1000)}`));
    close = openSheet('Sleep timer', list);
  }

  function openChapters() {
    if (!st.content) return;
    const content = st.content;
    let close: () => void = () => {};
    const list = h('div', { class: 'pl-list' });
    const rendered = new Set<number>();
    const build = () => {
      list.replaceChildren(...content.sections.map((s, i) =>
        h('button', {
          class: 'pl-row' + (i === st.section ? ' active' : ''), 'data-i': i, style: `padding-left:${12 + Math.max(0, s.level - 1) * 16}px`,
          onclick: () => { controller.goTo(i, 0); controller.play(); close(); },
        }, h('span', { class: 'grow ellipsis' }, s.title || `Section ${i + 1}`),
          rendered.has(i) ? h('span', { class: 'pl-dot', title: 'Ready for locked-screen listening', html: icons.check }) : null)));
    };
    build();
    close = openSheet('Chapters', list);
    setTimeout(() => (list.querySelector('.active') as HTMLElement | null)?.scrollIntoView({ block: 'center' }), 300);
    if (settings.mode === 'pocket' && pocket.isSupported() && id) {
      void pocket.renderedSections(id, settings.pocketVoice).then((r) => { r.forEach((x) => rendered.add(x)); build(); }).catch(() => {});
    }
  }

  function openPrepare() {
    if (!st.content || !st.itemId) return;
    const itemId = st.itemId, voice = settings.pocketVoice, n = st.content.sections.length, cur = st.section;
    let close: () => void = () => {};
    const go3 = () => { const secs = [cur, cur + 1, cur + 2].filter((i) => i < n); pocket.enqueue(itemId, secs, voice); toast(`Preparing ${secs.length} section${secs.length > 1 ? 's' : ''}…`); close(); };
    const all = () => { pocket.enqueue(itemId, Array.from({ length: n }, (_, i) => i), voice); toast('Preparing the whole book…'); close(); };
    const needsModel = pocket.getStatus().modelState === 'absent';
    close = openSheet('Prepare for offline listening', h('div', null,
      h('p', { class: 'muted' }, 'Pocket mode records the text with a natural voice on your phone, so it keeps playing with the screen locked and works offline. Recording takes a while; leave the app open.'),
      needsModel ? h('p', { class: 'small faint' }, 'The voice model (~90 MB) will be downloaded first.') : null,
      h('div', { class: 'pl-list' },
        h('button', { class: 'pl-row', onclick: go3 }, 'Next 3 chapters'),
        h('button', { class: 'pl-row', onclick: all }, `Whole book (${n} sections)`))));
  }

  function openMenu() {
    let close: () => void = () => {};
    const item = st.item;
    const rows: Node[] = [
      h('button', { class: 'pl-row', onclick: () => { close(); openChapters(); } }, 'Chapters'),
      h('button', { class: 'pl-row', onclick: () => { close(); toggleText(); } }, textView ? 'Show cover' : 'Show text'),
    ];
    if (settings.mode === 'pocket' && pocket.isSupported()) rows.push(h('button', { class: 'pl-row', onclick: () => { close(); openPrepare(); } }, 'Prepare for offline listening'));
    if (item?.sourceUrl) rows.push(h('a', { class: 'pl-row', href: item.sourceUrl, target: '_blank', rel: 'noopener' }, 'Open on Wikipedia'));
    rows.push(h('button', { class: 'pl-row', onclick: () => { close(); go('#/settings'); } }, 'Settings'));
    close = openSheet(item?.title ?? 'Options', h('div', { class: 'pl-list' }, rows));
  }

  // ─── wiring ───
  const unsubState = controller.subscribe((s) => {
    const prevId = st.itemId;
    st = s;
    if (s.itemId && s.itemId !== id && s.itemId !== prevId) {
      id = s.itemId; // auto-advance moved to another item: keep the URL in sync without a navigation
      history.replaceState(history.state, '', '#/play/' + encodeURIComponent(id));
    }
    renderAll();
  });
  const unsubPocket = pocket.subscribe((s) => { pst = s; renderPrep(); });
  const loadSettings = () => getSettings().then((s) => { settings = s; renderAll(); });
  const unsubSettings = onChange('settings', () => { void loadSettings(); });
  void loadSettings();
  if (st.itemId !== id || !st.content) void controller.open(id);

  return () => {
    unsubState(); unsubPocket(); unsubSettings();
    if (sleepTick) clearInterval(sleepTick);
    cover?.revoke();
    closeSheets.slice().forEach((c) => c());
    reader.destroy();
  };
}
