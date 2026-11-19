// App shell: hash router, bottom nav, mini-player slot, service worker.
import './styles.css';
import { registerSW } from 'virtual:pwa-register';
import { h } from './ui/dom';
import { icons } from './ui/icons';
import { requestPersistence, getSettings, onChange } from './db';
import { mountMiniPlayer } from './ui/miniplayer';

/** Every page module exports mount(root, params) and returns a cleanup function. */
export type Mount = (root: HTMLElement, params: Record<string, string>) => (() => void) | void;

const routes: { pattern: RegExp; keys: string[]; load: () => Promise<{ mount: Mount }>; tab: string }[] = [
  { pattern: /^#\/library$/, keys: [], load: () => import('./ui/library'), tab: 'library' },
  { pattern: /^#\/queue$/, keys: [], load: () => import('./ui/queue'), tab: 'queue' },
  { pattern: /^#\/play\/([^/]+)$/, keys: ['id'], load: () => import('./ui/player'), tab: 'player' },
  { pattern: /^#\/settings$/, keys: [], load: () => import('./ui/settings'), tab: 'settings' },
];

const app = document.getElementById('app')!;
const view = h('main', { id: 'view' });
const mini = h('div', { id: 'mini' });
const tabs = [
  { id: 'library', label: 'Books', icon: icons.books, hash: '#/library' },
  { id: 'queue', label: 'Wikipedia', icon: icons.queue, hash: '#/queue' },
  { id: 'settings', label: 'Settings', icon: icons.settings, hash: '#/settings' },
];
const nav = h('nav', { id: 'tabs' }, tabs.map((t) =>
  h('a', { href: t.hash, 'data-tab': t.id }, h('span', { html: t.icon }), h('span', null, t.label))));
app.append(view, mini, nav);

let cleanup: (() => void) | void;
let seq = 0;
async function route() {
  const hash = location.hash || '#/library';
  const r = routes.find((r) => r.pattern.test(hash));
  if (!r) { location.replace('#/library'); return; }
  const m = hash.match(r.pattern)!;
  const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
  const mySeq = ++seq;
  const mod = await r.load();
  if (mySeq !== seq) return;
  try { cleanup?.(); } catch (e) { console.error(e); }
  view.replaceChildren();
  view.scrollTop = 0;
  document.body.dataset.route = r.tab;
  nav.querySelectorAll('a').forEach((a) => a.classList.toggle('active', a.dataset.tab === r.tab));
  cleanup = mod.mount(view, params);
}
window.addEventListener('hashchange', route);

async function applyTheme() {
  const { theme } = await getSettings();
  const dark = theme === 'dark' || (theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}
onChange('settings', applyTheme);

applyTheme();
mountMiniPlayer(mini);
route();
requestPersistence();
// Check for app updates on start, hourly, and whenever the app comes back to the foreground
// (an installed PWA can stay open for days).
registerSW({
  immediate: true,
  onRegisteredSW(_url, reg) {
    if (!reg) return;
    setInterval(() => reg.update().catch(() => {}), 60 * 60 * 1000);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && navigator.onLine) reg.update().catch(() => {});
    });
  },
});

// The service worker adds the cross-origin-isolation headers, but only pages it
// controls get them. After the very first install, reload once so Pocket mode
// can use multi-threaded WASM.
if ('serviceWorker' in navigator && !self.crossOriginIsolated) {
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!sessionStorage.getItem('ls-coi-reload')) { sessionStorage.setItem('ls-coi-reload', '1'); location.reload(); }
  });
}

// ?debug exposes internals on window.__ls for troubleshooting on a device.
if (new URLSearchParams(location.search).has('debug')) {
  Promise.all([import('./player/controller'), import('./pocket/index'), import('./pdf/import'), import('./db')])
    .then(([c, p, i, d]) => { (window as any).__ls = { controller: c.controller, pocket: p.pocket, importPdfs: i.importPdfs, db: d }; });
}
