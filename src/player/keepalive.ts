// Best-effort keep-alive for Live (speechSynthesis) playback.
//
// Chrome on Android may freeze/suspend a page that is not playing media, and
// speechSynthesis alone does NOT count as media playback. While Live playback is
// active we loop a near-silent audio clip in an <audio> element so the page counts
// as "playing media": it is kept alive with the screen locked and the Media Session
// notification / lock-screen controls appear.
//
// This is BEST-EFFORT: it depends on the browser version, battery optimisation
// settings and OEM task killers. Pocket mode (pre-rendered audio) is the reliable
// way to listen with the screen locked.

const RATE = 8000;
const SECONDS = 2;
const AMPLITUDE = 3; // of 32767 (~1e-4): inaudible, but not digital silence (which can be optimised away)

function makeNoiseWav(): Blob {
  const n = RATE * SECONDS;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, RATE, true); v.setUint32(28, RATE * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.round((Math.random() * 2 - 1) * AMPLITUDE), true);
  return new Blob([buf], { type: 'audio/wav' });
}

let audio: HTMLAudioElement | null = null;
let url: string | null = null;

export const keepalive = {
  /** Start the silent loop. Should be called from (or soon after) a user gesture. */
  start() {
    try {
      if (!audio) {
        url = URL.createObjectURL(makeNoiseWav());
        audio = new Audio(url);
        audio.loop = true;
        audio.preload = 'auto';
        audio.setAttribute('aria-hidden', 'true');
      }
      if (audio.paused) void audio.play().catch(() => { /* autoplay blocked: ignore */ });
    } catch { /* best effort */ }
  },
  stop() {
    try { audio?.pause(); } catch { /* ignore */ }
  },
  get active() { return !!audio && !audio.paused; },
};
