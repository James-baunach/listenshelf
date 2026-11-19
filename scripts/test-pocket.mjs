// Node smoke test for kokoro-js: node scripts/test-pocket.mjs [out.wav]
import { KokoroTTS } from 'kokoro-js';
import { writeFileSync } from 'node:fs';

const out = process.argv[2] ?? 'pocket-test.wav';
const sentences = [
  'It was the best of times, it was the worst of times.',
  'The quick brown fox jumps over the lazy dog near the riverbank.',
  'In 1998, researchers measured 3.5 percent growth across the region.',
];
let t0 = Date.now();
const tts = await KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', { dtype: 'q8', device: 'cpu' });
console.log('load ms', Date.now() - t0);
const sr = 24000, chunks = [];
const sil = (s) => chunks.push(new Float32Array(Math.round(s * sr)));
sil(0.8);
let synthMs = 0, audioSec = 0;
for (const s of sentences) {
  t0 = Date.now();
  const a = await tts.generate(s, { voice: 'af_heart' });
  const ms = Date.now() - t0, sec = a.audio.length / a.sampling_rate;
  synthMs += ms; audioSec += sec;
  console.log(`${ms} ms -> ${sec.toFixed(2)} s audio (RTF ${(ms / 1000 / sec).toFixed(2)})`);
  chunks.push(a.audio); sil(0.25);
}
console.log(`overall realtime factor (synth time / audio time): ${(synthMs / 1000 / audioSec).toFixed(2)}`);
const n = chunks.reduce((a, c) => a + c.length, 0), pcm = new Float32Array(n);
let o = 0; for (const c of chunks) { pcm.set(c, o); o += c.length; }
const buf = Buffer.alloc(44 + n * 2);
buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVEfmt ', 8); buf.writeUInt32LE(16, 16);
buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * 2, 28);
buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, pcm[i])) * 32767), 44 + i * 2);
writeFileSync(out, buf);
console.log('wrote', out, (buf.length / 1048576).toFixed(2), 'MB,', (n / sr).toFixed(1), 's');
