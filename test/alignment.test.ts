import { describe, expect, it } from 'vitest';
import {
  AlignmentAccumulator,
  computeSpokenText,
  computeUnspokenText,
  estimateSpokenText,
  splitAtPlayedMs,
  type CharAlignment,
} from '../src/index.js';

/** Alignment where every code point takes `msPerChar`. */
function align(text: string, msPerChar = 100): CharAlignment {
  const chars = Array.from(text);
  return {
    chars,
    charStartTimesMs: chars.map((_, i) => i * msPerChar),
    charDurationsMs: chars.map(() => msPerChar),
  };
}

describe('computeSpokenText / computeUnspokenText', () => {
  const text = 'We have openings on Monday morning.';

  it('returns everything once playback passes the end', () => {
    expect(computeSpokenText(text, align(text), 10_000)).toBe(text);
    expect(computeUnspokenText(text, align(text), 10_000)).toBe('');
  });

  it('returns nothing before the first character starts', () => {
    expect(computeSpokenText(text, align(text), 0)).toBe('');
    expect(computeUnspokenText(text, align(text), 0)).toBe(text);
  });

  it('snaps back to a word boundary by default', () => {
    // 100ms/char: chars 0..13 started by 1400ms -> "We have openin"
    expect(computeSpokenText(text, align(text), 1400)).toBe('We have');
    expect(computeUnspokenText(text, align(text), 1400)).toBe('openings on Monday morning.');
  });

  it('can cut mid-word with snap: char', () => {
    expect(computeSpokenText(text, align(text), 1400, { snap: 'char' })).toBe('We have openin');
  });

  it('keeps a word that ended exactly at the cut', () => {
    // 7 chars started ("We have"); the next char is a space
    expect(computeSpokenText(text, align(text), 700)).toBe('We have');
  });

  it('handles Spanish accents and inverted punctuation', () => {
    const es = '¿Qué día prefieres? Tenemos mañana por la mañana.';
    const a = align(es);
    // "¿Qué día" is 8 chars: started by 800ms; the space after is char 9 (start 800)
    expect(computeSpokenText(es, a, 801, { snap: 'char' })).toBe('¿Qué día');
    expect(computeSpokenText(es, a, 1100)).toBe('¿Qué día');
    expect(computeUnspokenText(es, a, 1100)).toBe('prefieres? Tenemos mañana por la mañana.');
  });

  it('is insensitive to NFC vs NFD composition between text and alignment', () => {
    const nfc = 'mañana después';
    const nfd = nfc.normalize('NFD');
    // alignment delivered decomposed, caller text composed (and vice versa)
    const decomposed = align(nfd);
    const heardChars = Array.from(nfd.slice(0, 7)).length; // "mañana" = 6 graphemes, 7 code points in NFD
    const cutMs = heardChars * 100 + 1;
    expect(computeSpokenText(nfc, decomposed, cutMs, { snap: 'char' }).normalize('NFC')).toBe('mañana');
    expect(computeSpokenText(nfd, align(nfc), 601, { snap: 'char' }).normalize('NFC')).toBe('mañana');
  });

  it('counts emoji and ZWJ sequences as one character', () => {
    const family = '👩‍👩‍👧';
    const t = `Great ${family} news`;
    const a = align(t, 100); // alignment per code point; the emoji spans several entries
    const upToEmoji = Array.from(`Great ${family}`).length;
    expect(computeSpokenText(t, a, upToEmoji * 100 - 50, { snap: 'char' })).toBe(`Great ${family}`);
  });

  it('is robust to whitespace differences (provider collapses spaces)', () => {
    const t = 'two  spaces   here';
    const a = align('two spaces here');
    expect(computeSpokenText(t, a, 1000, { snap: 'char' })).toBe('two  spaces');
    expect(computeUnspokenText(t, a, 1000, { snap: 'char' })).toBe('here');
  });

  it('returns the full text when the alignment is longer than the text', () => {
    expect(computeSpokenText('hi', align('hi there'), 10_000)).toBe('hi');
  });

  it('property: spoken + unspoken reassemble the text and spoken never shrinks as playback advances', () => {
    let seed = 42;
    const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
    const alphabet = ['a', 'b', 'é', 'ñ', ' ', ' ', '.', '¿', '你', '😀'];
    for (let run = 0; run < 200; run++) {
      const len = 1 + Math.floor(rnd() * 40);
      const t = Array.from({ length: len }, () => alphabet[Math.floor(rnd() * alphabet.length)]).join('');
      const a = align(t, 50);
      for (const snap of ['word', 'char'] as const) {
        let prevLen = 0;
        for (let ms = 0; ms <= len * 50 + 100; ms += 37) {
          const { spoken, unspoken } = splitAtPlayedMs(t, a, ms, { snap });
          expect(t.replace(/\s+/g, '')).toBe((spoken + unspoken).replace(/\s+/g, ''));
          expect(t.startsWith(spoken)).toBe(true);
          expect(spoken.length).toBeGreaterThanOrEqual(prevLen);
          prevLen = spoken.length;
        }
      }
    }
  });
});

describe('AlignmentAccumulator', () => {
  it('shifts chunk-relative timestamps onto one timeline', () => {
    const acc = new AlignmentAccumulator();
    acc.add({ chars: ['a', 'b'], charStartTimesMs: [0, 100], charDurationsMs: [100, 100] });
    acc.add({ chars: ['c', 'd'], charStartTimesMs: [0, 100], charDurationsMs: [100, 100] });
    expect(acc.snapshot().charStartTimesMs).toEqual([0, 100, 200, 300]);
  });

  it('keeps already-cumulative timestamps unchanged', () => {
    const acc = new AlignmentAccumulator();
    acc.add({ chars: ['a', 'b'], charStartTimesMs: [0, 100], charDurationsMs: [100, 100] });
    acc.add({ chars: ['c', 'd'], charStartTimesMs: [200, 300], charDurationsMs: [100, 100] });
    expect(acc.snapshot().charStartTimesMs).toEqual([0, 100, 200, 300]);
  });

  it('ignores empty chunks', () => {
    const acc = new AlignmentAccumulator();
    acc.add(undefined);
    acc.add({ chars: [] });
    expect(acc.snapshot().chars).toEqual([]);
  });

  it('multi-chunk alignment feeds computeSpokenText correctly', () => {
    const acc = new AlignmentAccumulator();
    acc.add(align('Hola, '));
    acc.add(align('¿cómo estás?')); // chunk-relative times
    const full = 'Hola, ¿cómo estás?';
    // "Hola, ¿cómo" = 11 chars; 12th (the space) starts at 1100ms
    expect(computeSpokenText(full, acc.snapshot(), 1050)).toBe('Hola, ¿cómo');
    expect(computeSpokenText(full, acc.snapshot(), 800, { snap: 'char' })).toBe('Hola, ¿c');
  });
});

describe('estimateSpokenText', () => {
  it('estimates by speaking rate, snapped to words', () => {
    const r = estimateSpokenText('one two three four five', 1000, 8);
    expect(r.spoken).toBe('one two');
    expect(r.unspoken).toBe('three four five');
  });
});
