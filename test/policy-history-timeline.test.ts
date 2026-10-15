import { describe, expect, it } from 'vitest';
import {
  CallTimeline,
  classifyUtterance,
  detectLang,
  percentile,
  rewriteOnBargeIn,
  selectVoice,
  type ChatMessage,
} from '../src/index.js';

describe('classifyUtterance', () => {
  it.each([
    ['uh-huh', 'backchannel'],
    ['mm-hmm', 'backchannel'],
    ['okay', 'backchannel'],
    ['yeah yeah okay sure', 'backchannel'], // long but all acknowledgements
    ['sí claro', 'backchannel'],
    ['ajá, vale', 'backchannel'],
    ['wait', 'backchannel'], // too short to be sure
    ['no wait', 'backchannel'],
    ['actually I need Friday instead', 'interruption'],
    ['espera, necesito otro día', 'interruption'],
    ['', 'backchannel'],
  ])('%s -> %s', (text, kind) => {
    expect(classifyUtterance(text)).toBe(kind);
  });

  it('threshold is configurable', () => {
    expect(classifyUtterance('hold on please', { minWords: 2 })).toBe('interruption');
    expect(classifyUtterance('hold on please', { minWords: 3 })).toBe('backchannel');
  });
});

describe('detectLang', () => {
  it('detects Spanish and English', () => {
    expect(detectLang('Hola, necesito una cita para mañana')).toBe('es');
    expect(detectLang('Hello, I need an appointment tomorrow')).toBe('en');
  });
  it('returns null when unclear', () => {
    expect(detectLang('ok')).toBeNull();
    expect(detectLang('')).toBeNull();
  });
});

describe('selectVoice', () => {
  const settings = {
    provider: 'elevenlabs',
    voices: { es: 'voice_es_any' },
    defaultVoiceId: 'voice_default_any',
    model: 'eleven_flash_v2_5',
    outputFormat: 'ulaw_8000',
  };
  it('uses the per-language voice id, any string, and sets the language code', () => {
    expect(selectVoice(settings, 'es')).toMatchObject({ voiceId: 'voice_es_any', languageCode: 'es' });
  });
  it('falls back to the default voice for languages without one', () => {
    expect(selectVoice(settings, 'en')).toMatchObject({ voiceId: 'voice_default_any', languageCode: 'en' });
  });
});

describe('rewriteOnBargeIn', () => {
  const base = (): ChatMessage[] => [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'We have openings Monday and Tuesday.' },
  ];

  it('replaces the last assistant message with what was heard + marker', () => {
    const h = base();
    rewriteOnBargeIn(h, 'We have openings', { inHistory: true });
    expect(h[1]).toEqual({ role: 'assistant', content: 'We have openings [interrupted]' });
  });

  it('keeps just the marker when nothing was heard', () => {
    const h = base();
    rewriteOnBargeIn(h, '', { inHistory: true });
    expect(h[1]!.content).toBe('[interrupted]');
  });

  it('appends an assistant message when the turn was not in history yet', () => {
    const h: ChatMessage[] = [{ role: 'user', content: 'hi' }];
    rewriteOnBargeIn(h, 'Let me check', { inHistory: false });
    expect(h).toHaveLength(2);
    expect(h[1]!.content).toBe('Let me check [interrupted]');
  });

  it('appends nothing when not in history and nothing was heard', () => {
    const h: ChatMessage[] = [{ role: 'user', content: 'hi' }];
    rewriteOnBargeIn(h, '', { inHistory: false });
    expect(h).toHaveLength(1);
  });
});

describe('CallTimeline', () => {
  it('percentile is nearest-rank', () => {
    expect(percentile([], 50)).toBeNull();
    expect(percentile([10, 20, 30, 40, 50], 50)).toBe(30);
    expect(percentile([10, 20, 30, 40, 50], 90)).toBe(50);
    expect(percentile([7], 90)).toBe(7);
  });

  it('computes ttft / ttfa / eot->audio with an injected clock', () => {
    let t = 1000;
    const tl = new CallTimeline({ now: () => t });
    for (const [gen, ttft, ttfa] of [[1, 100, 300], [2, 200, 500], [3, 300, 900]] as const) {
      tl.setGen(gen);
      tl.turnStarted('hello', false);
      t += ttft;
      tl.firstToken();
      t += ttfa - ttft;
      tl.firstAudio();
      t += 1000;
    }
    const s = tl.stats();
    expect(s.turns).toBe(3);
    expect(s.ttft).toMatchObject({ n: 3, p50: 200, p90: 300, min: 100, max: 300, mean: 200 });
    expect(s.ttfa).toMatchObject({ p50: 500, p90: 900 });
    expect(s.eotToAudio.p50).toBe(500);
    expect(tl.formatSummary()).toContain('ttfa p50=500ms');
  });

  it('speculation moves the final EOT after the turn start, shrinking eot->audio', () => {
    let t = 0;
    const tl = new CallTimeline({ now: () => t });
    tl.setGen(1);
    tl.turnStarted('what time do you open', true);
    t = 400;
    tl.speculativeConfirmed(); // final EOT 400ms after the eager guess
    t = 500;
    tl.firstAudio();
    const s = tl.stats();
    expect(s.ttfa.p50).toBe(500);
    expect(s.eotToAudio.p50).toBe(100);
  });

  it('out-of-order / missing events never throw and are excluded from stats', () => {
    const tl = new CallTimeline({ now: () => 5 });
    tl.setGen(7);
    tl.firstAudio(); // audio with no turn start
    tl.mark('barge_in');
    const s = tl.stats();
    expect(s.turns).toBe(0);
    expect(s.ttfa.n).toBe(0);
    expect(s.bargeIns).toBe(1);
    expect(tl.formatSummary()).toContain('n/a');
  });

  it('counts playback confirmations vs timeouts', () => {
    const tl = new CallTimeline({ now: () => 1 });
    tl.mark('playback_confirmed', { viaTimeout: false });
    tl.mark('playback_confirmed', { viaTimeout: true });
    expect(tl.stats()).toMatchObject({ playbackConfirmed: 1, playbackTimeouts: 1 });
  });
});
