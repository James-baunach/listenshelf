// Thin wrapper around the Media Session API (lock-screen / notification controls).

export interface MediaHandlers {
  play(): void; pause(): void; prev(): void; next(): void;
  seekBack(): void; seekForward(): void; stop(): void;
}

let bound = false;
export function bindMediaSession(h: MediaHandlers) {
  if (bound || !('mediaSession' in navigator)) return;
  bound = true;
  const set = (a: MediaSessionAction, fn: () => void) => {
    try { navigator.mediaSession.setActionHandler(a, () => fn()); } catch { /* unsupported action */ }
  };
  set('play', h.play); set('pause', h.pause);
  set('previoustrack', h.prev); set('nexttrack', h.next);
  set('seekbackward', h.seekBack); set('seekforward', h.seekForward);
  set('stop', h.stop);
}

export function setMetadata(m: { title: string; artist: string; album: string; artwork?: string | null }) {
  if (!('mediaSession' in navigator)) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: m.title, artist: m.artist, album: m.album,
      artwork: m.artwork ? [{ src: m.artwork, sizes: '512x512' }] : [{ src: new URL('icon-192.png', document.baseURI).href, sizes: '192x192', type: 'image/png' }],
    });
  } catch { /* ignore */ }
}

export function clearMetadata() {
  if ('mediaSession' in navigator) { try { navigator.mediaSession.metadata = null; } catch { /* ignore */ } }
}

export function setPlaybackState(s: 'playing' | 'paused' | 'none') {
  if ('mediaSession' in navigator) { try { navigator.mediaSession.playbackState = s; } catch { /* ignore */ } }
}
