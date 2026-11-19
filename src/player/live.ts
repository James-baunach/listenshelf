// Live engine: speaks one sentence at a time with window.speechSynthesis.
// One utterance per sentence avoids Chrome's ~15 s cut-off for long utterances.
import type { EnginePlayRequest, PlaybackEngine } from '../types';
import { CHARS_PER_SEC, stripParentheticals } from '../text';

/** Incremented on every play() and abort; stale callbacks compare against it. */
let gen = 0;
/** Chrome garbage-collects utterances that are still speaking (onend never fires); keep a reference. */
let current: SpeechSynthesisUtterance | null = null;

const synth = (): SpeechSynthesis | null => ('speechSynthesis' in window ? window.speechSynthesis : null);

async function findVoice(uri?: string): Promise<SpeechSynthesisVoice | undefined> {
  const s = synth();
  if (!s || !uri) return undefined;
  let voices = s.getVoices();
  if (!voices.length) {
    // Voices load asynchronously on Chrome/Android.
    await new Promise<void>((res) => {
      const done = () => { s.removeEventListener('voiceschanged', done); res(); };
      s.addEventListener('voiceschanged', done);
      setTimeout(done, 1500);
    });
    voices = s.getVoices();
  }
  return voices.find((v) => v.voiceURI === uri);
}

type Outcome = 'done' | 'aborted' | 'failed';

function speakOne(text: string, voice: SpeechSynthesisVoice | undefined, rate: number, pitch: number,
  myGen: number, signal: AbortSignal, onStart: () => void): Promise<Outcome> {
  const s = synth()!;
  return new Promise<Outcome>((resolve) => {
    const u = new SpeechSynthesisUtterance(text);
    u.rate = Math.min(Math.max(rate, 0.1), 10);
    u.pitch = pitch;
    if (voice) { u.voice = voice; u.lang = voice.lang; }
    const t0 = Date.now();
    let started = false;
    let settled = false;
    // Watchdog: Android Chrome sometimes never fires onend. Generous: 2.5x expected + 5 s.
    const expectedMs = (text.length / (CHARS_PER_SEC * Math.max(rate, 0.1))) * 1000;
    const wd = setTimeout(() => { if (!settled) { try { s.cancel(); } catch { /* ignore */ } finish(started ? 'done' : 'failed'); } }, expectedMs * 2.5 + 5000);
    const onAbort = () => finish('aborted');
    function finish(r: Outcome) {
      if (settled) return;
      settled = true;
      clearTimeout(wd);
      signal.removeEventListener('abort', onAbort);
      resolve(r);
    }
    signal.addEventListener('abort', onAbort);
    u.onstart = () => { if (myGen !== gen || settled) return; started = true; onStart(); };
    u.onend = () => {
      if (myGen !== gen || settled) return;
      if (!started) { started = true; onStart(); }
      finish('done');
    };
    u.onerror = (e) => {
      if (myGen !== gen || settled) return;
      const err = (e as SpeechSynthesisErrorEvent).error;
      if (err === 'canceled' || err === 'interrupted') finish(signal.aborted ? 'aborted' : 'failed');
      else finish('failed');
    };
    current = u;
    try { s.speak(u); } catch { finish('failed'); }
    void t0;
  });
}

export const liveEngine: PlaybackEngine = {
  kind: 'live',
  async play(req: EnginePlayRequest): Promise<'ended' | 'aborted'> {
    const s = synth();
    if (!s) throw new Error('Speech synthesis is not available in this browser.');
    const myGen = ++gen;
    const { signal } = req;
    const onAbort = () => { if (myGen === gen) { gen++; try { s.cancel(); } catch { /* ignore */ } } };
    signal.addEventListener('abort', onAbort);
    try {
      if (signal.aborted) return 'aborted';
      const voice = await findVoice(req.settings.liveVoiceURI);
      if (signal.aborted || myGen !== gen) return 'aborted';
      // speechSynthesis.speaking can be stuck on Android: always reset first,
      // then give the engine a moment (cancel() immediately followed by speak() can be dropped).
      try { s.cancel(); } catch { /* ignore */ }
      await new Promise((r) => setTimeout(r, 60));
      if (signal.aborted || myGen !== gen) return 'aborted';

      let failures = 0;
      for (let i = req.startSentence; i < req.sentences.length; i++) {
        if (signal.aborted || myGen !== gen) return 'aborted';
        const raw = req.sentences[i];
        const text = req.settings.skipParentheticals ? stripParentheticals(raw) : raw;
        if (!/[\p{L}\p{N}]/u.test(text)) { req.onSentence(i); continue; }
        const t0 = Date.now();
        let started = false;
        const r = await speakOne(text, voice, req.rate, req.pitch, myGen, signal, () => { started = true; req.onSentence(i); });
        if (r === 'aborted' || signal.aborted || myGen !== gen) return 'aborted';
        if (!started) req.onSentence(i);
        if (r === 'failed' && Date.now() - t0 < 150) {
          if (++failures >= 5) throw new Error('The speech engine is not responding. Check your phone\'s text-to-speech settings.');
        } else failures = 0;
      }
      return 'ended';
    } finally {
      signal.removeEventListener('abort', onAbort);
      if (current && myGen === gen) current = null;
    }
  },
};
