/**
 * Before/after measurement for the mid-call language hint (live, needs a key).
 *
 * Streams the same recorded bilingual call through Deepgram Flux twice:
 *   before: the hint stays on the starting language (0.2.0 behaviour)
 *   after:  the hint follows the caller, as `languagePolicy: 'follow-caller'` now does
 * and prints word error rate (WER) per language against a reference transcript.
 *
 *   DEEPGRAM_API_KEY=... npx tsx examples/flux-language-hint-ab.ts call.ulaw call.ref.txt
 *
 * call.ulaw     caller audio only, raw mu-law 8 kHz mono, e.g.
 *               ffmpeg -i call.wav -ar 8000 -ac 1 -f mulaw call.ulaw
 * call.ref.txt  what the caller actually said, one turn per line, prefixed with
 *               its language:  "en|Hi, do you have anything Friday?"
 *                              "es|Sí, a las diez está bien."
 *
 * Optional env: FLUX_MODEL (default flux-general-multi), START_LANG (default en).
 * Costs a few cents of Deepgram usage per run and takes about twice the audio length.
 */
import { readFileSync } from 'node:fs';
import { detectLang, type Lang, type SttStream } from '../src/index.js';
import { createDeepgramFluxFactory } from '../src/providers/index.js';

const FRAME_BYTES = 160; // 20 ms of mu-law 8 kHz
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const key = process.env.DEEPGRAM_API_KEY;
const [audioPath, refPath] = process.argv.slice(2);
if (!key || !audioPath || !refPath) {
  console.log('Skipping: needs DEEPGRAM_API_KEY plus <audio.ulaw> <reference.txt> arguments.');
  process.exit(0);
}

const model = process.env.FLUX_MODEL ?? 'flux-general-multi';
const startLang = (process.env.START_LANG ?? 'en') as Lang;
const audio = readFileSync(audioPath);
const reference = readFileSync(refPath, 'utf8')
  .split('\n')
  .map((l) => l.trim())
  .filter(Boolean)
  .map((l) => {
    const [lang, ...rest] = l.split('|');
    return { lang: lang as Lang, text: rest.join('|') };
  });

async function run(follow: boolean): Promise<{ turns: string[]; switches: number }> {
  const turns: string[] = [];
  let lang = startLang;
  let switches = 0;
  let stream: SttStream | undefined;
  const factory = createDeepgramFluxFactory(key!);
  stream = await factory.create(
    { model, keyterms: [], replacements: [], languageHint: startLang },
    {
      onEndOfTurn: (t) => {
        turns.push(t);
        // Same rule the session applies with languagePolicy: 'follow-caller'.
        const next = detectLang(t) ?? lang;
        if (follow && next !== lang) {
          lang = next;
          switches++;
          stream?.configure?.({ languageHint: lang });
        }
      },
      onWarning: (m) => console.warn('warning:', m),
      onError: (e) => console.error('error:', e.message),
    },
  );
  for (let i = 0; i < audio.length; i += FRAME_BYTES) {
    stream.sendAudio(audio.subarray(i, i + FRAME_BYTES).toString('base64'));
    await sleep(20); // real time, so Flux turn detection behaves as on a call
  }
  const silence = Buffer.alloc(FRAME_BYTES, 0xff).toString('base64');
  for (let i = 0; i < 100; i++) {
    stream.sendAudio(silence); // 2 s of silence closes the last turn
    await sleep(20);
  }
  await sleep(1500);
  await stream.close();
  return { turns, switches };
}

function words(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/** Word-level edit distance / reference length. */
function wer(ref: string, hyp: string): { errors: number; words: number } {
  const r = words(ref);
  const h = words(hyp);
  let prev = Array.from({ length: h.length + 1 }, (_, j) => j);
  for (let i = 1; i <= r.length; i++) {
    const cur = [i];
    for (let j = 1; j <= h.length; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (r[i - 1] === h[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return { errors: prev[h.length]!, words: r.length };
}

function score(turns: string[]) {
  const byLang: Record<string, { errors: number; words: number }> = {};
  const add = (k: string, s: { errors: number; words: number }) => {
    const t = (byLang[k] ??= { errors: 0, words: 0 });
    t.errors += s.errors;
    t.words += s.words;
  };
  if (turns.length === reference.length) {
    reference.forEach((ref, i) => add(ref.lang, wer(ref.text, turns[i]!)));
  }
  add('all', wer(reference.map((r) => r.text).join(' '), turns.join(' ')));
  return byLang;
}

const before = await run(false);
const after = await run(true);
const b = score(before.turns);
const a = score(after.turns);
const pct = (s?: { errors: number; words: number }) => (s && s.words ? `${((100 * s.errors) / s.words).toFixed(1)}%` : 'n/a');

console.log(`\nFlux ${model}, start ${startLang}, ${(audio.length / 8000).toFixed(1)} s of audio, ${reference.length} reference turns\n`);
console.log('| WER | before (fixed hint) | after (hint follows caller) |');
console.log('|---|---|---|');
for (const k of ['en', 'es', 'all']) console.log(`| ${k} | ${pct(b[k])} | ${pct(a[k])} |`);
console.log(`\nTurns detected: before ${before.turns.length}, after ${after.turns.length}. Hint switches: ${after.switches}.`);
if (before.turns.length !== reference.length || after.turns.length !== reference.length) {
  console.log('Turn counts differ from the reference, so only the overall WER is comparable.');
}
console.log('\nWER is (substitutions + insertions + deletions) / reference words; lower is better. One run is anecdotal: repeat over several calls before quoting a number.');
