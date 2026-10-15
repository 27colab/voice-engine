import type { Lang } from './types.js';

export function wordCount(text: string): number {
  const t = text.trim();
  return t ? t.split(/\s+/).length : 0;
}

export type UtteranceKind = 'backchannel' | 'interruption';

/** Acknowledgements that should not cut the agent off. EN + ES. */
const BACKCHANNELS = new Set([
  'yeah', 'yes', 'yep', 'yup', 'ok', 'okay', 'right', 'sure', 'uh', 'huh', 'mm', 'mhm', 'hmm',
  'mmhmm', 'uhhuh', 'aha', 'ah', 'oh', 'got', 'it', 'i', 'see', 'alright', 'cool', 'great',
  'si', 'sí', 'claro', 'vale', 'aja', 'ajá', 'ya', 'bueno', 'bien', 'entiendo', 'perfecto',
  'mjm', 'aha', 'eh', 'ok',
]);

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/-/g, '')
    .split(/\s+/)
    .filter(Boolean);
}

export interface ClassifyOptions {
  /** More than this many words is a real interruption (default 3). */
  minWords?: number;
}

/**
 * Backchannel ("uh-huh", "sí", "okay okay") vs interruption.
 * Rule: all-backchannel tokens -> backchannel; otherwise more than `minWords`
 * words -> interruption; otherwise backchannel (too short to be sure).
 */
export function classifyUtterance(text: string, opts: ClassifyOptions = {}): UtteranceKind {
  const toks = tokens(text);
  if (toks.length === 0) return 'backchannel';
  if (toks.every((t) => BACKCHANNELS.has(t))) return 'backchannel';
  return toks.length > (opts.minWords ?? 3) ? 'interruption' : 'backchannel';
}

const ES_WORDS = new Set(['el','la','los','las','de','que','y','en','un','una','es','por','con','para','no','se','su','al','lo','como','más','pero','ya','este','porque','muy','sin','hola','gracias','quiero','necesito','puedo','cita','buenos','buenas','tengo','tiene','está','estoy','cuánto','cuándo','dónde','qué','por favor']);
const EN_WORDS = new Set(['the','and','is','to','of','in','that','it','for','you','with','this','have','are','not','but','what','can','my','me','do','hello','thanks','please','want','need','how','when','where','i','a','your','at','on','be']);

/**
 * Cheap EN/ES guess from stopwords and Spanish-only characters.
 * Returns null when it is not clear (short or mixed input).
 */
export function detectLang(text: string): Lang | null {
  const lower = text.toLowerCase();
  let es = (lower.match(/[áéíóúñ¿¡]/g) ?? []).length;
  let en = 0;
  for (const t of lower.split(/[^\p{L}]+/u)) {
    if (ES_WORDS.has(t)) es++;
    if (EN_WORDS.has(t)) en++;
  }
  if (es >= 1 && es - en >= 1) return 'es';
  if (en >= 1 && en - es >= 1) return 'en';
  return null;
}

/** Normalize for comparing an eager transcript with the final one. */
export function normalizeTranscript(text: string): string {
  return tokens(text).join(' ');
}
