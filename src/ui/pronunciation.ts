// Settings panel: speech cleanup toggles, pronunciation dictionary, live preview.
import './pronunciation.css';
import type { Pronunciation, Settings } from '../types';
import { getSettings, saveSettings } from '../db';
import { controller } from '../player/controller';
import { explainCleanup, prepareForSpeech } from '../speech';
import { h, toast } from './dom';

export const PRONUNCIATION_HINT = 'Re-prepare Pocket audio to apply to recorded chapters.';
const SAMPLE = 'The results (see Figure 3) were clear.12 Visit https://example.com, e.g. for details.';

export function mountSpeechSettings(root: HTMLElement): () => void {
  let s: Settings;
  let disposed = false;
  const cleanups: (() => void)[] = [];

  async function change(patch: Partial<Settings>) {
    s = await saveSettings(patch);
    void controller.refreshSettings();
    drawPreview();
  }

  const toggle = (checked: boolean, onch: (v: boolean) => void) => {
    const i = h('input', { type: 'checkbox', checked, class: 'st-switch-in' }) as HTMLInputElement;
    i.addEventListener('change', () => onch(i.checked));
    return h('label', { class: 'st-switch' }, i, h('span'));
  };
  const rowOf = (label: string, ctl: Node, hint?: string) =>
    h('div', { class: 'st-row' }, h('div', { class: 'grow' }, h('div', { class: 'st-label' }, label), hint ? h('div', { class: 'small faint' }, hint) : null), ctl);

  // ─── preview ───
  const input = h('textarea', { class: 'input pr-sample', rows: 3, 'aria-label': 'Sample text' }, SAMPLE) as HTMLTextAreaElement;
  const output = h('div', { class: 'pr-out', 'aria-live': 'polite' });
  function drawPreview() {
    if (!s) return;
    const out = explainCleanup(input.value, s);
    output.textContent = out || '(nothing would be spoken)';
    output.classList.toggle('faint', !out);
  }
  input.addEventListener('input', drawPreview);

  // ─── speaking ───
  function speak(text: string) {
    if (!('speechSynthesis' in window)) { toast('Speech is not available here'); return; }
    if (!text.trim()) { toast('Nothing to say'); return; }
    if (controller.getState().playing) controller.pause();
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    const v = speechSynthesis.getVoices().find((x) => x.voiceURI === s.liveVoiceURI);
    if (v) { u.voice = v; u.lang = v.lang; }
    u.rate = s.rate; u.pitch = s.pitch;
    speechSynthesis.speak(u);
  }

  // ─── dictionary ───
  const list = h('div', { class: 'pr-list' });
  const hint = h('p', { class: 'small faint pr-hint', hidden: true }, PRONUNCIATION_HINT);
  let editing = -1;

  const saveList = async (next: Pronunciation[]) => {
    await change({ pronunciations: next });
    hint.hidden = false;
    drawList();
  };

  const miniToggle = (label: string, on: boolean, onch: (v: boolean) => void) => {
    const i = h('input', { type: 'checkbox', checked: on }) as HTMLInputElement;
    i.addEventListener('change', () => onch(i.checked));
    return h('label', { class: 'pr-check' }, i, label);
  };

  function testEntry(p: Pronunciation) {
    // Speak a sentence containing 'from' through the same pipeline as playback.
    const sentence = `Today we are talking about ${p.from}.`;
    speak(prepareForSpeech(sentence, { ...s, pronunciations: [p] }) || p.to);
  }

  function drawList() {
    const items = s.pronunciations;
    if (!items.length) { list.replaceChildren(h('p', { class: 'small faint' }, 'No pronunciation fixes yet. Add a word below.')); return; }
    list.replaceChildren(...items.map((p, i) => {
      if (editing === i) return editRow(p, i);
      return h('div', { class: 'pr-item' },
        h('div', { class: 'pr-pair grow' },
          h('b', null, p.from), h('span', { class: 'faint' }, ' → '), h('span', null, p.to),
          h('div', { class: 'small faint' }, [p.wholeWord === false ? 'part of words' : 'whole word', p.caseSensitive ? 'match case' : ''].filter(Boolean).join(' · '))),
        h('button', { class: 'btn ghost', 'aria-label': `Test ${p.from}`, onclick: () => testEntry(p) }, 'Test'),
        h('button', { class: 'btn ghost', 'aria-label': `Edit ${p.from}`, onclick: () => { editing = i; drawList(); } }, 'Edit'),
        h('button', { class: 'btn ghost', 'aria-label': `Delete ${p.from}`, onclick: () => { void saveList(items.filter((_, j) => j !== i)); } }, '×'));
    }));
  }

  function editRow(p: Pronunciation, i: number) {
    const draft: Pronunciation = { ...p };
    const from = h('input', { class: 'input', value: p.from, 'aria-label': 'Written as', autocapitalize: 'none' }) as HTMLInputElement;
    const to = h('input', { class: 'input', value: p.to, 'aria-label': 'Spoken as', autocapitalize: 'none' }) as HTMLInputElement;
    return h('div', { class: 'pr-item pr-edit' },
      h('div', { class: 'pr-fields grow' }, from, to,
        h('div', { class: 'pr-checks' },
          miniToggle('Whole word', draft.wholeWord !== false, (v) => { draft.wholeWord = v; }),
          miniToggle('Match case', !!draft.caseSensitive, (v) => { draft.caseSensitive = v; }))),
      h('div', { class: 'pr-btns' },
        h('button', { class: 'btn primary', onclick: () => {
          const f = from.value.trim();
          if (!f) { toast('Enter the text to replace'); return; }
          const next = s.pronunciations.slice();
          next[i] = { ...draft, from: f, to: to.value.trim() };
          editing = -1;
          void saveList(next);
        } }, 'Save'),
        h('button', { class: 'btn ghost', onclick: () => { editing = -1; drawList(); } }, 'Cancel')));
  }

  // add form
  const newFrom = h('input', { class: 'input', placeholder: 'Written as (e.g. Louisville)', 'aria-label': 'Written as', autocapitalize: 'none' }) as HTMLInputElement;
  const newTo = h('input', { class: 'input', placeholder: 'Spoken as (e.g. Lewisville)', 'aria-label': 'Spoken as', autocapitalize: 'none' }) as HTMLInputElement;
  let newWhole = true, newCase = false;
  const addEntry = async () => {
    const f = newFrom.value.trim();
    if (!f) { toast('Enter the text to replace'); newFrom.focus(); return; }
    const entry: Pronunciation = { from: f, to: newTo.value.trim(), wholeWord: newWhole, caseSensitive: newCase };
    const rest = s.pronunciations.filter((p) => !(p.from === entry.from && !!p.caseSensitive === newCase));
    newFrom.value = ''; newTo.value = '';
    await saveList([...rest, entry]);
  };
  for (const el of [newFrom, newTo]) el.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); void addEntry(); } });

  void (async () => {
    s = await getSettings();
    if (disposed) return;

    const toggles = h('div', { class: 'pr-toggles' },
      rowOf('Skip web addresses', toggle(s.skipUrls, (v) => { void change({ skipUrls: v }); }), 'Links and email addresses'),
      rowOf('Skip figure and page references', toggle(s.skipReferences, (v) => { void change({ skipReferences: v }); }), '"(see Figure 3)", "(p. 45)", "[12]"'),
      rowOf('Skip footnote markers', toggle(s.skipFootnoteMarkers, (v) => { void change({ skipFootnoteMarkers: v }); }), 'Small numbers or symbols after words'),
      rowOf('Skip text in parentheses', toggle(s.skipParentheticals, (v) => { void change({ skipParentheticals: v }); }), 'Also on the Playback card'));

    root.replaceChildren(
      toggles,
      h('div', { class: 'st-label pr-h' }, 'Try it'),
      input, output,
      h('div', { class: 'st-label pr-h' }, 'Pronunciation fixes'),
      h('p', { class: 'small faint' }, 'Replace how a word is spoken. Applies to Live voices right away.'),
      list, hint,
      h('div', { class: 'pr-add' }, newFrom, newTo,
        h('div', { class: 'pr-checks' },
          miniToggle('Whole word', true, (v) => { newWhole = v; }),
          miniToggle('Match case', false, (v) => { newCase = v; })),
        h('div', { class: 'row gap' },
          h('button', { class: 'btn', onclick: () => speak(newTo.value.trim() || newFrom.value.trim()) }, 'Test'),
          h('button', { class: 'btn primary', onclick: () => void addEntry() }, 'Add'))));
    drawList();
    drawPreview();
  })();

  return () => { disposed = true; cleanups.forEach((c) => c()); if ('speechSynthesis' in window) speechSynthesis.cancel(); };
}
