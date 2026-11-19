/// <reference lib="webworker" />
// Custom service worker:
//  1. Precaches the app shell (manifest injected by vite-plugin-pwa) so the app works offline.
//  2. Adds COOP/COEP headers to every same-origin response. GitHub Pages can't set headers,
//     and cross-origin isolation is what lets the Pocket voice model use multiple CPU threads.
//  3. Receives Web Share Target POSTs (Android share sheet) into the 'share-inbox' cache; see src/share.ts.
//  4. Runtime-caches the big Pocket-mode files (worker + onnxruntime wasm) on first use.
import { precache, matchPrecache, cleanupOutdatedCaches } from 'workbox-precaching';
import { clientsClaim } from 'workbox-core';

declare const self: ServiceWorkerGlobalScope & { __WB_MANIFEST: Array<{ url: string; revision: string | null }> };

self.skipWaiting();
clientsClaim();
cleanupOutdatedCaches();
precache(self.__WB_MANIFEST);

const RUNTIME = 'pocket-runtime-v1';
// Big on-demand assets: Pocket voice engine and the OCR engine (cached on first use).
const isPocketAsset = (p: string) => /\/assets\/(ort-wasm|worker-|tesseract-core|worker\.min-)/.test(p);

function isolate(res: Response): Response {
  if (res.type === 'opaque' || res.type === 'opaqueredirect' || res.status === 0) return res;
  const headers = new Headers(res.headers);
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  headers.set('Cross-Origin-Embedder-Policy', 'credentialless');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

async function respond(req: Request): Promise<Response> {
  const url = new URL(req.url);
  if (req.mode === 'navigate') {
    // Hash-routed SPA: every navigation is index.html. Network first so updates land, cache when offline.
    // cache: 'no-cache' revalidates with the server, so GitHub Pages' 10-minute HTML caching can't serve a stale shell.
    // (Fetch by URL: a navigate-mode Request can't be re-issued with a RequestInit.)
    try { return await fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' }); } catch { /* offline */ }
    return (await matchPrecache('index.html')) ?? new Response('Offline', { status: 503 });
  }
  const pre = await matchPrecache(url.href);
  if (pre) return pre;
  if (isPocketAsset(url.pathname)) {
    const cache = await caches.open(RUNTIME);
    const hit = await cache.match(req);
    if (hit) return hit;
    const res = await fetch(req);
    if (res.ok) await cache.put(req, res.clone());
    return res;
  }
  return fetch(req);
}

// ─── Web Share Target ───
// The manifest's share_target POSTs multipart/form-data to ./share-target. We stash the files and
// text fields in Cache Storage ('share-inbox': one JSON manifest + one Response per file), then
// redirect (303 -> GET) to the app, which reads and clears the inbox (src/share.ts).
const INBOX = 'share-inbox';
const shareUrl = () => new URL('share-target', self.registration.scope).href;
const inboxUrl = (name: string) => new URL('share-inbox/' + name, self.registration.scope).href;

async function receiveShare(req: Request): Promise<Response> {
  try {
    const form = await req.formData();
    await caches.delete(INBOX);
    const cache = await caches.open(INBOX);
    const files: { name: string; type: string; key: string }[] = [];
    let n = 0;
    for (const v of form.getAll('files')) {
      if (typeof v === 'string' || !v.size) continue;
      const key = 'file-' + n++;
      await cache.put(inboxUrl(key), new Response(v, { headers: { 'Content-Type': v.type || 'application/octet-stream' } }));
      files.push({ name: v.name, type: v.type, key });
    }
    const field = (k: string) => { const v = form.get(k); return typeof v === 'string' ? v : ''; };
    const manifest = { title: field('title'), text: field('text'), url: field('url'), files, at: Date.now() };
    await cache.put(inboxUrl('manifest'), new Response(JSON.stringify(manifest), { headers: { 'Content-Type': 'application/json' } }));
  } catch (e) {
    console.error('share-target failed', e);
  }
  return Response.redirect(new URL('?shared=1#/library', self.registration.scope).href, 303);
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method === 'POST' && req.url === shareUrl()) { event.respondWith(receiveShare(req)); return; }
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith(respond(req).then(isolate));
});
