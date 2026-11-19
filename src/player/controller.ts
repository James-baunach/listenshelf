// The player controller singleton: owns playback state, picks the engine per section,
// persists position, drives the Media Session and the sleep timer.
import { DEFAULT_SETTINGS, type Item, type PlayerController, type PlayerState, type PlaybackEngine, type Settings } from '../types';
import { getContent, getCover, getItem, getQueue, getSettings, onChange, savePosition, saveSettings, setQueue, updateItem } from '../db';
import { CHARS_PER_SEC } from '../text';
import { pocket } from '../pocket';
import { liveEngine } from './live';
import { keepalive } from './keepalive';
import * as ms from './mediasession';

const state: PlayerState = {
  itemId: null, item: null, content: null, section: 0, sentence: 0, playing: false,
  loading: false, engine: null, sleepAt: null, error: null,
};
let settings: Settings = DEFAULT_SETTINGS;
const refreshCached = () => getSettings().then((s) => { settings = s; });
void refreshCached();
onChange('settings', () => { void refreshCached(); });

// ─── subscriptions (batched) ───
const subs = new Set<(s: PlayerState) => void>();
let pending = false;
let metaKey = '';
function emit() {
  syncMeta();
  if (pending) return;
  pending = true;
  queueMicrotask(() => {
    pending = false;
    const snap = { ...state };
    subs.forEach((f) => { try { f(snap); } catch (e) { console.error(e); } });
  });
}

// ─── Media Session ───
let artworkUrl: string | null = null;
let artworkRevoke: (() => void) | null = null;
function syncMeta(force = false) {
  if (!state.item || !state.content) { metaKey = ''; return; }
  const key = `${state.itemId}:${state.section}:${artworkUrl}`;
  if (!force && key === metaKey) return;
  metaKey = key;
  const sec = state.content.sections[state.section];
  ms.setMetadata({
    title: state.item.title,
    artist: state.item.author || (state.item.kind === 'article' ? 'Wikipedia' : 'ListenShelf'),
    album: sec?.title ?? '',
    artwork: artworkUrl,
  });
}
async function loadArtwork(item: Item, seq: number) {
  artworkRevoke?.(); artworkRevoke = null; artworkUrl = null;
  if (item.kind === 'book' && item.hasCover) {
    const blob = await getCover(item.id).catch(() => undefined);
    if (blob && seq === openSeq) {
      const u = URL.createObjectURL(blob);
      artworkUrl = u; artworkRevoke = () => URL.revokeObjectURL(u);
    }
  } else if (item.thumbnailUrl) artworkUrl = item.thumbnailUrl;
  if (seq === openSeq) syncMeta(true);
}

// ─── playback loop ───
let ac: AbortController | null = null;
let runId = 0;
let openSeq = 0;
let opening: { id: string; p: Promise<void> } | null = null;

function stopEngine() { runId++; ac?.abort(); ac = null; }

function flush() {
  if (state.itemId && state.content) void savePosition(state.itemId, { section: state.section, sentence: state.sentence }, true);
}

function startPlayback() {
  if (!state.content || !state.itemId) return;
  stopEngine();
  const my = runId;
  const a = new AbortController();
  ac = a;
  state.playing = true; state.loading = true; state.error = null;
  ms.setPlaybackState('playing');
  emit();
  void loop(my, a);
}

function restartIfPlaying() { if (state.playing) startPlayback(); }

function halt() {
  stopEngine();
  state.playing = false; state.loading = false; state.engine = null;
  keepalive.stop();
  ms.setPlaybackState('paused');
}

async function loop(my: number, a: AbortController) {
  const alive = () => my === runId && !a.signal.aborted;
  try {
    while (alive()) {
      const content = state.content, itemId = state.itemId;
      if (!content || !itemId) return;
      const count = content.sections.length;
      const secIdx = state.section;
      const sec = content.sections[secIdx];
      if (!sec) { await finishItem(true); return; }
      settings = await getSettings();
      if (!alive()) return;

      if (sec.sentences.length) {
        const voice = settings.pocketVoice;
        let usePocket = false;
        if (settings.mode === 'pocket' && pocket.isSupported()) {
          try { usePocket = await pocket.hasSection(itemId, secIdx, voice); } catch { usePocket = false; }
          if (!alive()) return;
        }
        const engine: PlaybackEngine = usePocket ? pocket.engine : liveEngine;
        state.engine = engine.kind;
        if (usePocket) keepalive.stop(); else keepalive.start();
        // Render ahead (only when the model is already installed: never trigger the big download implicitly).
        if (settings.mode === 'pocket' && pocket.isSupported() && pocket.getStatus().modelState === 'ready') {
          const ahead = [secIdx + 1, secIdx + 2].filter((i) => i < count);
          if (ahead.length) { try { pocket.enqueue(itemId, ahead, voice); } catch { /* ignore */ } }
        }

        const start = Math.min(Math.max(state.sentence, 0), sec.sentences.length - 1);
        const sc = start === state.sentence ? startChar : 0;
        startChar = 0; // consumed: resuming after a pause restarts the sentence from its beginning
        // Live mode: announce the section title as a prefix utterance when starting a section.
        const announce = !usePocket && start === 0 && sc === 0 && !!sec.title && (count > 1 || sec.title !== state.item?.title);
        const offset = announce ? 1 : 0;
        const sentences = announce ? [sec.title, ...sec.sentences] : sec.sentences;
        emit();
        const res = await engine.play({
          itemId, sectionIndex: secIdx, sentences, startSentence: announce ? 0 : start, startChar: sc,
          rate: settings.rate, pitch: settings.pitch, settings,
          signal: a.signal,
          onSentence: (i) => {
            if (!alive()) return;
            state.loading = false;
            const idx = i - offset;
            if (idx >= 0) {
              state.sentence = idx;
              void savePosition(itemId, { section: secIdx, sentence: idx });
            }
            if (typeof state.sleepAt === 'number' && Date.now() >= state.sleepAt) queueMicrotask(() => sleepFire());
            emit();
          },
        });
        if (!alive() || res === 'aborted') return;
      }

      // Section ended.
      const last = secIdx >= count - 1;
      const stopAtSection = state.sleepAt === 'section';
      if (stopAtSection) state.sleepAt = null;
      if (last) { await finishItem(!stopAtSection); return; }
      state.section = secIdx + 1; state.sentence = 0;
      void savePosition(itemId, { section: state.section, sentence: 0 }, stopAtSection);
      if (stopAtSection) { halt(); emit(); return; }
      state.loading = true;
      emit();
    }
  } catch (e) {
    if (my === runId) {
      halt();
      state.error = e instanceof Error ? e.message : String(e);
      emit();
    }
  }
}

async function finishItem(advance: boolean) {
  const { itemId, content, item } = state;
  if (!itemId || !content) return;
  const lastSec = content.sections.length - 1;
  state.section = lastSec;
  state.sentence = Math.max(0, (content.sections[lastSec]?.sentences.length ?? 1) - 1);
  halt();
  state.sleepAt = null; clearSleepTimer();
  emit();
  await savePosition(itemId, { section: state.section, sentence: state.sentence }, true);
  await updateItem(itemId, { finishedAt: Date.now() });
  if (advance && item?.kind === 'article' && settings.autoAdvanceQueue) {
    const q = await getQueue();
    if (q.includes(itemId)) {
      const rest = q.filter((x) => x !== itemId);
      await setQueue(rest);
      if (rest[0] && state.itemId === itemId) await open(rest[0], { autoplay: true });
    }
  }
}

// ─── sleep timer ───
let sleepTimer: ReturnType<typeof setTimeout> | null = null;
function clearSleepTimer() { if (sleepTimer) clearTimeout(sleepTimer); sleepTimer = null; }
function sleepFire() {
  if (typeof state.sleepAt !== 'number') return;
  clearSleepTimer(); state.sleepAt = null;
  pause();
}

// ─── position helpers ───
function clampPos(section: number, sentence: number): [number, number] {
  const secs = state.content?.sections ?? [];
  if (!secs.length) return [0, 0];
  const s = Math.min(Math.max(section, 0), secs.length - 1);
  const n = secs[s].sentences.length;
  return [s, Math.min(Math.max(sentence, 0), Math.max(0, n - 1))];
}
/** Character offset into the current sentence for the next engine start (tap-a-word). */
let startChar = 0;
function setPos(section: number, sentence: number, char = 0) {
  const [s, i] = clampPos(section, sentence);
  state.section = s; state.sentence = i;
  startChar = s === section && i === sentence ? Math.max(0, char) : 0;
  if (state.itemId) void savePosition(state.itemId, { section: s, sentence: i });
  if (state.playing) startPlayback(); else emit();
}
/** Moves by a (possibly negative) number of characters across sentence/section boundaries. */
function moveChars(chars: number): [number, number] {
  const secs = state.content!.sections;
  let s = state.section, i = state.sentence;
  if (chars >= 0) {
    let rem = chars;
    while (rem > 0) {
      const len = secs[s].sentences[i]?.length ?? 0;
      rem -= len;
      if (rem <= 0) break;
      if (i + 1 < secs[s].sentences.length) i++;
      else if (s + 1 < secs.length) { s++; i = 0; }
      else break;
    }
    // we consumed sentence i; land on the next one if any
    if (rem <= 0 && chars > 0) {
      if (i + 1 < secs[s].sentences.length) i++;
      else if (s + 1 < secs.length) { s++; i = 0; }
    }
  } else {
    let rem = -chars;
    while (rem > 0) {
      if (i > 0) i--;
      else if (s > 0) { s--; i = Math.max(0, secs[s].sentences.length - 1); }
      else break;
      rem -= secs[s].sentences[i]?.length ?? 0;
    }
  }
  return [s, i];
}

// ─── public API ───
function play() {
  if (!state.content) return;
  startPlayback();
}
function pause() {
  if (!state.itemId) return;
  halt();
  emit();
  flush();
}
function toggle() { if (state.playing) pause(); else play(); }

function close() {
  openSeq++; opening = null;
  flush();
  halt();
  clearSleepTimer();
  Object.assign(state, { itemId: null, item: null, content: null, section: 0, sentence: 0, playing: false, loading: false, engine: null, sleepAt: null, error: null });
  artworkRevoke?.(); artworkRevoke = null; artworkUrl = null;
  ms.setPlaybackState('none'); ms.clearMetadata();
  emit();
}

function statusError(item: Item): string | null {
  if (item.status === 'error') return item.error || 'This item could not be imported.';
  if (item.status === 'no-text') return 'No readable text was found. Scanned PDFs (images of pages) are not supported yet.';
  return null;
}

async function doOpen(id: string, opts: { autoplay?: boolean }) {
  const seq = ++openSeq;
  flush();
  halt();
  clearSleepTimer();
  Object.assign(state, { itemId: id, item: null, content: null, section: 0, sentence: 0, playing: false, loading: true, engine: null, sleepAt: null, error: null });
  ms.setPlaybackState('none');
  emit();
  const item = await getItem(id);
  if (seq !== openSeq) return;
  if (!item) { state.loading = false; state.error = 'This item no longer exists.'; emit(); return; }
  state.item = item;
  if (item.status !== 'ready') { state.loading = false; state.error = statusError(item); emit(); return; }
  const content = await getContent(id);
  if (seq !== openSeq) return;
  if (!content || !content.sections.length) { state.loading = false; state.error = 'The text for this item is missing. Try importing it again.'; emit(); return; }
  const finished = item.finishedAt != null && item.position.updatedAt <= item.finishedAt;
  state.content = content;
  state.item = item;
  const [s, i] = finished ? [0, 0] : (() => { state.content = content; return clampPos(item.position?.section ?? 0, item.position?.sentence ?? 0); })();
  state.section = s; state.sentence = i; state.loading = false;
  void loadArtwork(item, seq);
  emit();
  if (opts.autoplay) play();
}

function open(id: string, opts: { autoplay?: boolean } = {}): Promise<void> {
  if (opening?.id === id) return opening.p.then(() => { if (opts.autoplay) play(); });
  if (state.itemId === id && state.content) { if (opts.autoplay && !state.playing) play(); return Promise.resolve(); }
  const p = doOpen(id, opts).finally(() => { if (opening?.p === p) opening = null; });
  opening = { id, p };
  return p;
}

export const controller: PlayerController = {
  getState: () => ({ ...state }),
  subscribe(fn) { subs.add(fn); fn({ ...state }); return () => { subs.delete(fn); }; },
  open, play, pause, toggle, close,
  nextSentence() {
    if (!state.content) return;
    const sec = state.content.sections[state.section];
    if (state.sentence + 1 < sec.sentences.length) setPos(state.section, state.sentence + 1);
    else if (state.section + 1 < state.content.sections.length) setPos(state.section + 1, 0);
  },
  prevSentence() {
    if (!state.content) return;
    if (state.sentence > 0) setPos(state.section, state.sentence - 1);
    else if (state.section > 0) setPos(state.section - 1, Number.MAX_SAFE_INTEGER);
    else setPos(0, 0);
  },
  skipSeconds(delta) {
    if (!state.content) return;
    const chars = delta * CHARS_PER_SEC * settings.rate;
    const [s, i] = moveChars(chars);
    setPos(s, i);
  },
  nextSection() {
    if (!state.content) return;
    if (state.section + 1 < state.content.sections.length) setPos(state.section + 1, 0);
  },
  prevSection() {
    if (!state.content) return;
    const sents = state.content.sections[state.section].sentences;
    let chars = 0;
    for (let j = 0; j < state.sentence; j++) chars += sents[j].length;
    const secsIn = chars / (CHARS_PER_SEC * settings.rate);
    if (secsIn > 3 || state.section === 0) setPos(state.section, 0);
    else setPos(state.section - 1, 0);
  },
  goTo(section, sentence = 0, char = 0) { if (state.content) setPos(section, sentence, char); },
  setRate(rate) {
    const r = Math.round(Math.min(Math.max(rate, 0.5), 3) * 100) / 100;
    settings = { ...settings, rate: r };
    void saveSettings({ rate: r });
    restartIfPlaying();
    emit();
  },
  setSleepTimer(minutes) {
    clearSleepTimer();
    if (minutes == null) state.sleepAt = null;
    else if (minutes === 'section') state.sleepAt = 'section';
    else {
      state.sleepAt = Date.now() + minutes * 60_000;
      sleepTimer = setTimeout(sleepFire, minutes * 60_000);
    }
    emit();
  },
  async refreshSettings() {
    settings = await getSettings();
    restartIfPlaying();
    emit();
  },
};

// ─── wiring ───
ms.bindMediaSession({
  play, pause,
  prev: () => controller.prevSection(),
  next: () => controller.nextSection(),
  seekBack: () => controller.skipSeconds(-settings.skipSeconds),
  seekForward: () => controller.skipSeconds(settings.skipSeconds),
  stop: pause,
});
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });
window.addEventListener('pagehide', flush);

onChange('items', async () => {
  const id = state.itemId;
  if (!id) return;
  const fresh = await getItem(id);
  if (id !== state.itemId) return;
  if (!fresh) { close(); return; }
  const cur = state.item;
  if (!cur) return;
  if (fresh.status !== cur.status || fresh.title !== cur.title || fresh.processingProgress !== cur.processingProgress || fresh.hasCover !== cur.hasCover) {
    const becameReady = cur.status !== 'ready' && fresh.status === 'ready' && !state.content;
    state.item = fresh;
    if (becameReady) void open(id);
    else emit();
  }
});

// Content replaced for the loaded item (OCR finished, page map rebuilt, re-import):
// swap it in place and keep the position (clamped). Restart playback only if it was playing.
onChange('content', async () => {
  const id = state.itemId;
  if (!id || !state.content) return;
  const fresh = await getContent(id);
  if (!fresh || id !== state.itemId || fresh === state.content) return;
  state.content = fresh;
  const [s, i] = clampPos(state.section, state.sentence);
  state.section = s; state.sentence = i;
  if (state.playing) startPlayback(); else emit();
});
