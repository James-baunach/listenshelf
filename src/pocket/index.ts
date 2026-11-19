// STUB — replaced by the pocket agent. Public API of Pocket mode (neural TTS rendered to audio).
import type { PlaybackEngine, PocketStatus, PocketVoice } from '../types';

export interface PocketAPI {
  /** False if the browser can't run the model (no WebAssembly / too little memory). */
  isSupported(): boolean;
  getStatus(): PocketStatus;
  /** Called immediately and on every status change. Returns unsubscribe. */
  subscribe(fn: (s: PocketStatus) => void): () => void;
  listVoices(): PocketVoice[];
  /** Downloads (first time, ~90 MB, cached) and initialises the model. */
  loadModel(): Promise<void>;
  /** True if audio for this section+voice exists in the `audio` store. */
  hasSection(itemId: string, section: number, voice: string): Promise<boolean>;
  /** Section indexes already rendered for this item+voice. */
  renderedSections(itemId: string, voice: string): Promise<Set<number>>;
  /** Queue sections for rendering (skips ones already rendered). Loads the model if needed. */
  enqueue(itemId: string, sections: number[], voice: string): void;
  /** Cancel queued/running jobs for an item (or all if omitted). */
  cancel(itemId?: string): void;
  /** Plays rendered audio via an <audio> element (works with the screen locked). */
  engine: PlaybackEngine;
  /** Speak a short sample with a voice (for the settings voice picker). */
  preview(voice: string, text?: string): Promise<void>;
}

const status: PocketStatus = { modelState: 'absent', modelProgress: 0, jobs: [] };
export const pocket: PocketAPI = {
  isSupported: () => false, getStatus: () => status, subscribe: (fn) => { fn(status); return () => {}; },
  listVoices: () => [], loadModel: async () => {}, hasSection: async () => false,
  renderedSections: async () => new Set(), enqueue: () => {}, cancel: () => {},
  engine: { kind: 'pocket', play: async () => 'ended' }, preview: async () => {},
};
