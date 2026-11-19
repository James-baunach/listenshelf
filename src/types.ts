// ─────────────────────────────────────────────────────────────────────────────
// Shared contracts for ListenShelf. Every module codes against these.
// Do not change shapes here without updating all modules.
// ─────────────────────────────────────────────────────────────────────────────

export type ItemKind = 'book' | 'article';
export type ItemStatus = 'processing' | 'ready' | 'error' | 'no-text';

/** Where the listener is inside an item. Sentence index is within the section. */
export interface Position {
  section: number;
  sentence: number;
  updatedAt: number; // epoch ms
}

/** A book (from PDF) or a Wikipedia article. Stored in the `items` store. */
export interface Item {
  id: string; // book: 'b_' + random; article: 'w_' + lang + '_' + normalized title
  kind: ItemKind;
  title: string;
  author?: string; // books: from PDF metadata if present
  description?: string; // articles: short Wikipedia description
  sourceUrl?: string; // articles: canonical Wikipedia URL
  thumbnailUrl?: string; // articles: remote thumbnail (may fail offline; UI must fall back)
  hasCover?: boolean; // books: a cover blob exists in the `covers` store under the same id
  status: ItemStatus;
  error?: string;
  /** 0..1 while status === 'processing' */
  processingProgress?: number;
  addedAt: number;
  lastPlayedAt?: number;
  finishedAt?: number;
  position: Position;
  /** Total characters across all sections (for progress %). 0 until processed. */
  totalChars: number;
  sectionCount: number;
  /** Books: original file format. Missing = 'pdf' (items created before EPUB support). */
  format?: 'pdf' | 'epub';
  /** Books: text came from OCR of a scanned PDF (quality may be lower). */
  ocr?: boolean;
  /** Articles: URL of a human-read Spoken Wikipedia recording, if the article has one. */
  spokenAudioUrl?: string;
}

export interface Section {
  title: string;
  /** 1 = chapter / h2, 2 = sub-section / h3 ... used for indenting the chapter list */
  level: number;
  /** Clean, speakable sentences (no citation markers, no page numbers, no hyphenation breaks). */
  sentences: string[];
  charCount: number;
  /** Books: 1-based PDF page this section starts on (optional) */
  page?: number;
  /** Sentence indexes that begin a new paragraph (always includes 0 when present). Optional. */
  paragraphs?: number[];
  /** PDFs: 1-based page number of each sentence (parallel to `sentences`). Enables page view. */
  pages?: number[];
  /** Articles: links found in the text, for "tap a link to queue it". */
  links?: SectionLink[];
}

/** A hyperlink inside a sentence: sentences[sentence].slice(start, end) is the link text. */
export interface SectionLink {
  sentence: number;
  start: number;
  end: number;
  /** Target Wikipedia article title (same language as the item). */
  title: string;
}

/** A bookmark (optionally with a note) at a sentence. Stored in the `bookmarks` store. */
export interface Bookmark {
  id: string; // 'm_' + random
  itemId: string;
  section: number;
  sentence: number;
  /** Snapshot of the sentence text, so the list reads well without loading content. */
  quote: string;
  note?: string;
  createdAt: number;
}

/** A pronunciation fix applied before speaking (Live) and before rendering audio (Pocket). */
export interface Pronunciation {
  from: string;
  to: string;
  /** Match whole words only (default true). */
  wholeWord?: boolean;
  /** Case-sensitive match (default false). */
  caseSensitive?: boolean;
}

/** Stored in the `content` store, keyed by item id. Loaded only when playing. */
export interface DocContent {
  id: string;
  sections: Section[];
}

export interface Settings {
  rate: number; // 0.5 – 3, default 1
  pitch: number; // 0.5 – 2, default 1
  /** speechSynthesis voiceURI for Live mode; undefined = system default */
  liveVoiceURI?: string;
  /** 'live' = phone's built-in voices; 'pocket' = use pre-rendered neural audio when available */
  mode: 'live' | 'pocket';
  /** kokoro voice id, e.g. 'af_heart' */
  pocketVoice: string;
  /** Articles: auto-start the next queue item when one finishes */
  autoAdvanceQueue: boolean;
  /** Skip text in parentheses when speaking (Live mode) */
  skipParentheticals: boolean;
  /** Seconds for the big skip buttons */
  skipSeconds: number; // default 30
  /** Wikipedia sections whose titles match these (case-insensitive) are dropped on import */
  wikiSkipSections: string[];
  wikiLang: string; // default 'en'
  theme: 'dark' | 'light' | 'system';
  /** Speech cleanup (applied at speak/render time, not stored in content). */
  skipUrls: boolean;
  /** Skip cross-references like "(see Figure 3)", "(Table 2)", "(p. 45)". */
  skipReferences: boolean;
  /** Skip footnote markers like "word12" / "word*" / "[3]". */
  skipFootnoteMarkers: boolean;
  pronunciations: Pronunciation[];
}

export const DEFAULT_SETTINGS: Settings = {
  rate: 1,
  pitch: 1,
  mode: 'live',
  pocketVoice: 'af_heart',
  autoAdvanceQueue: true,
  skipParentheticals: false,
  skipSeconds: 30,
  wikiSkipSections: [
    'See also', 'References', 'External links', 'Further reading', 'Notes',
    'Bibliography', 'Sources', 'Citations', 'Footnotes', 'Works cited', 'Gallery',
  ],
  wikiLang: 'en',
  theme: 'dark',
  skipUrls: true,
  skipReferences: true,
  skipFootnoteMarkers: true,
  pronunciations: [],
};

/** Pre-rendered neural audio for one section. Stored in the `audio` store. */
export interface RenderedAudio {
  key: string; // audioKey(itemId, section, voice)
  itemId: string;
  section: number;
  voice: string;
  blob: Blob; // audio/wav (or other audio/* type)
  /** Start time (seconds) of each sentence in the blob; length === sentences.length */
  offsets: number[];
  duration: number; // seconds
  createdAt: number;
}

export const audioKey = (itemId: string, section: number, voice: string) =>
  `${itemId}|${section}|${voice}`;

// ─── Playback engine contract (implemented by src/player/live.ts and src/pocket/engine.ts) ───

export interface EnginePlayRequest {
  itemId: string;
  sectionIndex: number;
  sentences: string[];
  startSentence: number;
  /** Optional: start this many characters into sentences[startSentence] (tap-a-word to start). */
  startChar?: number;
  rate: number;
  pitch: number;
  settings: Settings;
  /** Called when sentence i (index within section) starts being spoken. */
  onSentence: (i: number) => void;
  /** Aborting stops audio immediately; play() then resolves with 'aborted'. */
  signal: AbortSignal;
}

export interface PlaybackEngine {
  readonly kind: 'live' | 'pocket';
  /** Speaks sentences[startSentence..] of one section. Resolves 'ended' at end of section. */
  play(req: EnginePlayRequest): Promise<'ended' | 'aborted'>;
}

// ─── Player controller contract (singleton in src/player/controller.ts) ───

export interface PlayerState {
  itemId: string | null;
  item: Item | null;
  content: DocContent | null;
  section: number;
  sentence: number;
  playing: boolean;
  /** True while waiting for content / engine to start */
  loading: boolean;
  /** Which engine is speaking the current section */
  engine: 'live' | 'pocket' | null;
  /** Epoch ms when the sleep timer fires, or 'section' = stop at end of section */
  sleepAt: number | 'section' | null;
  error: string | null;
}

export interface PlayerController {
  getState(): PlayerState;
  /** Subscribe to state changes. Called immediately with current state. Returns unsubscribe. */
  subscribe(fn: (s: PlayerState) => void): () => void;
  /** Load an item (resuming at its saved position). Does not start playback unless autoplay. */
  open(itemId: string, opts?: { autoplay?: boolean }): Promise<void>;
  play(): void;
  pause(): void;
  toggle(): void;
  /** Stop and unload (used when deleting the current item). */
  close(): void;
  nextSentence(): void;
  prevSentence(): void;
  /** Positive or negative seconds; estimated from characters at current rate in Live mode. */
  skipSeconds(delta: number): void;
  nextSection(): void;
  /** Goes to start of current section if > 3 s in, else previous section. */
  prevSection(): void;
  /** Jump to a position. `char` starts partway into the sentence (e.g. at a tapped word). */
  goTo(section: number, sentence?: number, char?: number): void;
  setRate(rate: number): void;
  setSleepTimer(minutes: number | 'section' | null): void;
  /** Re-read settings (voice/mode changed) and restart current sentence if playing. */
  refreshSettings(): Promise<void>;
}

// ─── Pocket (neural, background-safe audio) contract (src/pocket/index.ts) ───

export interface PocketVoice {
  id: string; // e.g. 'af_heart'
  name: string; // e.g. 'Heart (US female)'
}

export interface PocketJob {
  itemId: string;
  section: number;
  voice: string;
  state: 'queued' | 'rendering' | 'done' | 'error';
  progress: number; // 0..1 within the section
  error?: string;
}

export interface PocketStatus {
  modelState: 'absent' | 'downloading' | 'ready' | 'error' | 'unsupported';
  modelProgress: number; // 0..1 while downloading
  modelError?: string;
  /** 'webgpu' | 'wasm' once the model is loaded */
  device?: string;
  jobs: PocketJob[];
}
