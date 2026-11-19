# ListenShelf

Listen to your PDF books and Wikipedia articles like audiobooks and podcasts. ListenShelf is a Progressive Web App (PWA): it's built for Android Chrome, works offline, and is hosted for free on GitHub Pages. There's no server and no account. Everything stays on your phone.

## Features

**Books (PDFs)**
- Add PDFs from your phone. They show up on a bookshelf with covers taken from the first page.
- Chapters come from the PDF's table of contents. If it has none, ListenShelf detects headings, and as a last resort it splits the book into page ranges.
- Running headers, page numbers and words split across lines are cleaned up before reading.
- Every book remembers where you stopped and resumes there.

**Wikipedia**
- Search Wikipedia or paste a link, then build a queue that plays one article after another, like a podcast.
- Reference markers, infoboxes, tables and sections like "References" and "See also" are skipped. You can edit that list in Settings.
- Articles download when you add them, so they work offline.

**Player**
- Play and pause.
- Skip back or forward 30 seconds; the amount is adjustable in Settings.
- Previous or next chapter, previous or next sentence.
- Speed from 0.5× to 3×, and a sleep timer.
- A chapter list, and a text view that highlights the sentence being read; tap any sentence to jump to it.
- Lock-screen and Bluetooth controls through the Media Session API.

**Two voice modes**

| | Live | Pocket |
|---|---|---|
| Voice | Your phone's built-in text-to-speech voices | Neural voice (Kokoro-82M) that runs on your phone |
| Start | Instant | Chapters must be prepared ahead of time |
| Screen locked | Best effort: can pause, depending on Chrome and battery settings | Plays reliably, because it's an ordinary audio file |
| Download | None | About 90 MB once, plus about 3 MB per minute of audio |

Pocket mode is slower than real time on most phones. Prepare chapters ahead of time, for example overnight while charging with the app open. If a chapter hasn't been prepared, ListenShelf falls back to Live mode for it.

## Install on Android

1. Open the GitHub Pages URL in Chrome.
2. Open the ⋮ menu and choose **Add to Home screen** (or **Install app**).
3. Open ListenShelf from your home screen. It runs full screen and works offline.

If Live mode pauses when the screen locks:
1. Go to Android **Settings → Apps → Chrome → Battery** and choose **Unrestricted**.
2. Or switch to Pocket mode.

## Development

```bash
npm install
npm run dev        # http://localhost:5173 (or the port you pass)
npm run typecheck
npm run build      # outputs dist/
npm run preview    # serves dist/ the way GitHub Pages would (no special headers)
```

Pushing to `main` deploys to GitHub Pages automatically (`.github/workflows/deploy.yml`). To turn it on, go to the repo's **Settings → Pages → Source** and choose **GitHub Actions**.

Add `?debug` to the URL to expose internals on `window.__ls` for troubleshooting on a device.

### Test scripts

```bash
node scripts/make-sample-pdf.mjs && node scripts/test-pdf.mjs   # PDF extraction
node --experimental-strip-types scripts/test-wiki.mjs           # Wikipedia parsing (uses the live API)
node scripts/test-pocket.mjs out.wav                            # Kokoro synthesis in Node
node scripts/make-icons.mjs                                     # regenerate PNG icons from public/icon.svg
```

## How it fits together

```
src/
  types.ts      shared contracts (Item, Section, PlaybackEngine, PlayerController, Pocket API)
  db.ts         IndexedDB storage (items, content, PDFs, covers, rendered audio, settings, queue)
  text.ts       sentence splitting and cleanup shared by both importers
  main.ts       hash router, tab bar, mini player, service worker registration
  sw.ts         service worker: offline precache + cross-origin isolation headers
  pdf/          pdf.js text extraction, chapter detection, cover rendering
  wiki/         Wikipedia search, fetch and HTML-to-sections cleanup
  player/       controller, Live engine (speechSynthesis), keep-alive audio, Media Session
  pocket/       Kokoro worker, render queue, WAV encoding, audio-element engine, settings panel
  ui/           pages: library, queue, player, settings, mini player
```

The service worker adds `Cross-Origin-Opener-Policy` and `Cross-Origin-Embedder-Policy: credentialless` to every response, because GitHub Pages can't set headers itself. That makes the page cross-origin isolated, which allows multi-threaded WebAssembly for the Pocket voice model.
