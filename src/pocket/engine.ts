// Pocket playback engine: plays pre-rendered section audio through one persistent <audio> element
// (reuse matters for background / lock-screen playback on Android).
import { audioKey, type EnginePlayRequest, type PlaybackEngine } from '../types';
import { getAudio } from '../db';

let audio: HTMLAudioElement | null = null;
let currentUrl: string | null = null;

/** The shared element (also useful for the controller's Media Session wiring). */
export function getAudioElement(): HTMLAudioElement {
  if (!audio) {
    audio = new Audio();
    audio.preload = 'auto';
    (audio as any).preservesPitch = true;
    (audio as any).webkitPreservesPitch = true;
  }
  return audio;
}

function sentenceAt(offsets: number[], t: number): number {
  let lo = 0, hi = offsets.length - 1, ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (offsets[mid] <= t + 0.03) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

export function createEngine(): PlaybackEngine {
  return {
    kind: 'pocket',
    async play(req: EnginePlayRequest) {
      const rec = await getAudio(audioKey(req.itemId, req.sectionIndex, req.settings.pocketVoice));
      if (!rec) throw new Error('not-rendered');
      if (req.signal.aborted) return 'aborted';
      const a = getAudioElement();
      a.pause();
      if (currentUrl) URL.revokeObjectURL(currentUrl);
      currentUrl = URL.createObjectURL(rec.blob);
      a.src = currentUrl;
      a.playbackRate = req.rate;
      (a as any).preservesPitch = true;
      const start = Math.min(Math.max(req.startSentence, 0), rec.offsets.length - 1);

      return new Promise<'ended' | 'aborted'>((resolve, reject) => {
        let last = -1;
        let settled = false;
        const report = () => {
          const i = sentenceAt(rec.offsets, a.currentTime);
          if (i !== last) { last = i; req.onSentence(i); }
        };
        const cleanup = () => {
          a.removeEventListener('timeupdate', report);
          a.removeEventListener('seeked', report);
          a.removeEventListener('ended', onEnded);
          a.removeEventListener('error', onError);
          req.signal.removeEventListener('abort', onAbort);
        };
        const finish = (fn: () => void) => { if (settled) return; settled = true; cleanup(); fn(); };
        const onEnded = () => finish(() => resolve('ended'));
        const onError = () => finish(() => reject(new Error(a.error?.message || 'Audio playback error')));
        const onAbort = () => finish(() => { a.pause(); resolve('aborted'); });

        a.addEventListener('timeupdate', report);
        a.addEventListener('seeked', report);
        a.addEventListener('ended', onEnded);
        a.addEventListener('error', onError);
        req.signal.addEventListener('abort', onAbort);

        const begin = () => {
          if (settled) return;
          // Starting mid-sentence: estimate the time from the character fraction
          // (each sentence segment ends with ~0.25 s of inserted silence).
          let t = rec.offsets[start] ?? 0;
          const len = req.sentences[start]?.length ?? 0;
          if (req.startChar && len) {
            const end = (rec.offsets[start + 1] ?? rec.duration) - 0.25;
            t += Math.max(0, end - t) * Math.min(1, req.startChar / len);
          }
          try { a.currentTime = t; } catch { /* ignore */ }
          a.playbackRate = req.rate;
          last = start; req.onSentence(start);
          a.play().catch((e: Error) => finish(() =>
            reject(new Error(e?.name === 'NotAllowedError'
              ? 'Playback was blocked by the browser; tap play again.'
              : `Could not start audio: ${e?.message ?? e}`))));
        };
        if (a.readyState >= 1) begin(); else a.addEventListener('loadedmetadata', begin, { once: true });
      });
    },
  };
}
