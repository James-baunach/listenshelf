// STUB — replaced by the player agent. Exports the singleton PlayerController.
import type { PlayerController, PlayerState } from '../types';
const state: PlayerState = { itemId: null, item: null, content: null, section: 0, sentence: 0, playing: false, loading: false, engine: null, sleepAt: null, error: null };
const noop = () => {};
export const controller: PlayerController = {
  getState: () => state, subscribe: (fn) => { fn(state); return noop; },
  open: async () => {}, play: noop, pause: noop, toggle: noop, close: noop,
  nextSentence: noop, prevSentence: noop, skipSeconds: noop, nextSection: noop, prevSection: noop,
  goTo: noop, setRate: noop, setSleepTimer: noop, refreshSettings: async () => {},
};
