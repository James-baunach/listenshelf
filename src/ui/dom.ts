// Tiny DOM helpers + shared UI primitives (toast, bottom sheet, confirm). No framework.

type Attrs = Record<string, unknown> & { class?: string; style?: string };
type Child = Node | string | number | null | undefined | false | Child[];

/**
 * h('button', { class: 'btn', onclick: fn, 'aria-label': 'Play' }, 'Play')
 * Keys starting with "on" become event listeners; others become attributes
 * (boolean true → empty attribute, false/null/undefined → omitted).
 * Use { html: '<svg…>' } to set innerHTML (only for trusted strings like icons).
 */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs | null = null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v == null || v === false) continue;
    if (k === 'html') el.innerHTML = String(v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener);
    else if (k === 'value' && 'value' in el) (el as HTMLInputElement).value = String(v);
    else if (k === 'checked' && 'checked' in el) (el as HTMLInputElement).checked = Boolean(v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  append(el, children);
  return el;
}
function append(el: Node, children: Child[]) {
  for (const c of children) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

/** Shows a short message at the bottom of the screen. */
export function toast(msg: string, ms = 2600) {
  const el = h('div', { class: 'toast', role: 'status' }, msg);
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 300); }, ms);
}

/**
 * Opens a bottom sheet. Returns a close() function. The sheet closes on
 * backdrop tap or the Android back button.
 */
// Sheets stack: each pushes one history entry; the Android back button (popstate)
// closes only the TOP sheet. Closing a sheet in code pops its own entry, and that
// self-inflicted popstate is swallowed so it doesn't close the sheet beneath.
const sheetStack: { dismiss: () => void }[] = [];
let swallowPops = 0;
window.addEventListener('popstate', () => {
  if (swallowPops > 0) { swallowPops--; return; }
  sheetStack[sheetStack.length - 1]?.dismiss();
});

export function sheet(title: string, body: Node, opts: { onClose?: () => void } = {}): () => void {
  const panel = h('div', { class: 'sheet', role: 'dialog', 'aria-label': title },
    h('div', { class: 'sheet-grip' }),
    h('div', { class: 'sheet-title' }, title),
    h('div', { class: 'sheet-body' }, body));
  const backdrop = h('div', { class: 'sheet-backdrop' }, panel);
  let closed = false;
  const entry = { dismiss: () => teardown() };
  /** Removes the sheet. fromCode: closed by a button/backdrop, so pop our own history entry. */
  function teardown(fromCode = false) {
    if (closed) return;
    closed = true;
    const idx = sheetStack.indexOf(entry);
    if (idx >= 0) sheetStack.splice(idx, 1);
    backdrop.classList.remove('open');
    setTimeout(() => backdrop.remove(), 250);
    if (fromCode && history.state?.sheet) { swallowPops++; history.back(); }
    opts.onClose?.();
  }
  const close = () => teardown(true);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
  history.pushState({ sheet: true }, '');
  sheetStack.push(entry);
  document.body.appendChild(backdrop);
  requestAnimationFrame(() => backdrop.classList.add('open'));
  return close;
}

/** Simple confirm dialog as a sheet. Resolves true if confirmed. */
export function confirmSheet(title: string, message: string, okLabel = 'OK', danger = false): Promise<boolean> {
  return new Promise((resolve) => {
    let result = false;
    const body = h('div', null,
      h('p', { class: 'muted' }, message),
      h('div', { class: 'row end gap' },
        h('button', { class: 'btn ghost', onclick: () => close() }, 'Cancel'),
        h('button', { class: `btn ${danger ? 'danger' : 'primary'}`, onclick: () => { result = true; close(); } }, okLabel)));
    const close = sheet(title, body, { onClose: () => resolve(result) });
  });
}

/** Prompt for text in a sheet. Resolves null if cancelled. */
export function promptSheet(title: string, initial = '', okLabel = 'Save'): Promise<string | null> {
  return new Promise((resolve) => {
    let result: string | null = null;
    const input = h('input', { class: 'input', value: initial });
    const body = h('form', { onsubmit: (e: Event) => { e.preventDefault(); result = input.value.trim(); close(); } },
      input,
      h('div', { class: 'row end gap', style: 'margin-top:12px' },
        h('button', { class: 'btn ghost', type: 'button', onclick: () => close() }, 'Cancel'),
        h('button', { class: 'btn primary', type: 'submit' }, okLabel)));
    const close = sheet(title, body, { onClose: () => resolve(result) });
    setTimeout(() => input.focus(), 50);
  });
}

/** Navigate within the app. */
export const go = (hash: string) => { location.hash = hash; };
