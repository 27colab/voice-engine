/**
 * Turn "how many milliseconds of this utterance did the caller hear" into
 * "which part of the text was that", using TTS character alignment.
 */

/** Character timing as ElevenLabs reports it. Times are ms from utterance start. */
export interface CharAlignment {
  chars: string[];
  charStartTimesMs: number[];
  charDurationsMs: number[];
}

export const EMPTY_ALIGNMENT: CharAlignment = Object.freeze({
  chars: [],
  charStartTimesMs: [],
  charDurationsMs: [],
}) as CharAlignment;

/**
 * Stitches per-message alignment chunks into one utterance timeline.
 *
 * Providers differ on whether a chunk's times restart at 0 or continue from the
 * previous chunk. If a later chunk starts before the previous one ended, it is
 * treated as chunk-relative and shifted by the previous end time.
 */
export class AlignmentAccumulator {
  private readonly out: CharAlignment = { chars: [], charStartTimesMs: [], charDurationsMs: [] };
  private endMs = 0;

  add(chunk: Partial<CharAlignment> | undefined): void {
    const chars = chunk?.chars;
    if (!chars || chars.length === 0) return;
    const starts = chunk.charStartTimesMs ?? [];
    const durs = chunk.charDurationsMs ?? [];
    const first = starts[0] ?? 0;
    const offset = this.out.chars.length > 0 && first < this.endMs - 1 ? this.endMs : 0;
    for (let i = 0; i < chars.length; i++) {
      const start = (starts[i] ?? this.endMs - offset) + offset;
      const dur = durs[i] ?? 0;
      this.out.chars.push(chars[i] ?? '');
      this.out.charStartTimesMs.push(start);
      this.out.charDurationsMs.push(dur);
      this.endMs = Math.max(this.endMs, start + dur);
    }
  }

  snapshot(): CharAlignment {
    return {
      chars: [...this.out.chars],
      charStartTimesMs: [...this.out.charStartTimesMs],
      charDurationsMs: [...this.out.charDurationsMs],
    };
  }
}

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const isSpace = (g: string): boolean => /^\s+$/.test(g);

function graphemes(s: string): string[] {
  return Array.from(segmenter.segment(s), (x) => x.segment);
}

export interface SplitOptions {
  /**
   * 'word' (default): never end mid-word; a word the caller only partly heard
   * is treated as unheard. 'char': cut at the exact grapheme.
   */
  snap?: 'word' | 'char';
}

/**
 * Split `fullText` into the part the caller heard by `playedMs` and the rest.
 *
 * A character counts as heard once its start time is before `playedMs`. The
 * alignment's characters are matched to `fullText` by counting non-whitespace
 * grapheme clusters, so differences in whitespace and in Unicode composition
 * (precomposed "é" vs "e" + U+0301) between provider and caller text don't
 * matter. It does NOT handle providers that rewrite the text itself (expanding
 * "$5" to "five dollars" in the alignment): use un-normalized alignment.
 */
export function splitAtPlayedMs(
  fullText: string,
  alignment: CharAlignment,
  playedMs: number,
  opts: SplitOptions = {},
): { spoken: string; unspoken: string } {
  let heard = '';
  for (let i = 0; i < alignment.chars.length; i++) {
    const start = alignment.charStartTimesMs[i] ?? Infinity;
    if (start >= playedMs) break;
    heard += alignment.chars[i] ?? '';
  }
  const heardCount = graphemes(heard).filter((g) => !isSpace(g)).length;
  return splitAtContentCount(fullText, heardCount, opts.snap ?? 'word');
}

export function computeSpokenText(
  fullText: string,
  alignment: CharAlignment,
  playedMs: number,
  opts?: SplitOptions,
): string {
  return splitAtPlayedMs(fullText, alignment, playedMs, opts).spoken;
}

export function computeUnspokenText(
  fullText: string,
  alignment: CharAlignment,
  playedMs: number,
  opts?: SplitOptions,
): string {
  return splitAtPlayedMs(fullText, alignment, playedMs, opts).unspoken;
}

/**
 * Fallback for providers without alignment: assume a constant speaking rate.
 * Rough by construction; prefer real alignment.
 */
export function estimateSpokenText(
  fullText: string,
  playedMs: number,
  charsPerSecond = 15,
  opts: SplitOptions = {},
): { spoken: string; unspoken: string } {
  const count = Math.floor((playedMs / 1000) * charsPerSecond);
  return splitAtContentCount(fullText, count, opts.snap ?? 'word');
}

function splitAtContentCount(
  fullText: string,
  contentCount: number,
  snap: 'word' | 'char',
): { spoken: string; unspoken: string } {
  const gs = graphemes(fullText);
  let seen = 0;
  let cut = 0; // number of graphemes kept
  for (let i = 0; i < gs.length && seen < contentCount; i++) {
    if (!isSpace(gs[i] ?? '')) seen++;
    cut = i + 1;
  }
  if (seen < contentCount || cut >= gs.length) {
    // Everything (or more than everything) was heard.
    return { spoken: fullText, unspoken: '' };
  }
  if (snap === 'word' && !isSpace(gs[cut] ?? '') && !isSpace(gs[cut - 1] ?? ' ')) {
    // Mid-word: back up to the previous whitespace boundary.
    while (cut > 0 && !isSpace(gs[cut - 1] ?? '')) cut--;
  }
  return {
    spoken: gs.slice(0, cut).join('').trimEnd(),
    unspoken: gs.slice(cut).join('').trimStart(),
  };
}
