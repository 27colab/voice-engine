import type { Lang, TranscriptEntry } from './types.js';

/**
 * Event timeline + per-turn latency stats for one call. No I/O; the clock is
 * injectable so tests are deterministic.
 */

export type TimelineEventName =
  | 'call_start'
  | 'stt_start'
  | 'transcript'
  | 'eager_eot'
  | 'turn_resumed'
  | 'speculative_start'
  | 'speculative_confirmed'
  | 'speculative_cancel'
  | 'llm_first_token'
  | 'tool_use'
  | 'tts_first_audio'
  | 'barge_in'
  | 'backchannel'
  | 'playback_confirmed'
  | 'error'
  | 'call_end';

export interface TimelineEvent {
  ts: number;
  gen: number;
  name: TimelineEventName;
  data?: Record<string, unknown>;
}

interface TurnTiming {
  turnStartedAt?: number;
  /** When the final end-of-turn arrived (differs from turnStartedAt when speculative). */
  finalEotAt?: number;
  firstTokenAt?: number;
  firstAudioAt?: number;
  bargedIn?: boolean;
  speculative?: boolean;
}

export interface Distribution {
  n: number;
  min: number | null;
  p50: number | null;
  p90: number | null;
  max: number | null;
  mean: number | null;
}

export interface CallStats {
  turns: number;
  bargeIns: number;
  backchannels: number;
  speculativeStarts: number;
  speculativeCancels: number;
  toolCalls: number;
  playbackConfirmed: number;
  playbackTimeouts: number;
  /** Turn start -> first LLM token, ms. */
  ttft: Distribution;
  /** Turn start -> first TTS audio chunk, ms. */
  ttfa: Distribution;
  /** Final end-of-turn -> first TTS audio, ms (<= ttfa when speculation helped). Floored at 0. */
  eotToAudio: Distribution;
}

export interface CallRecord {
  callId: string;
  startedAt: Date;
  endedAt: Date;
  durationS: number;
  lang: Lang;
  outcome: string;
  transcript: TranscriptEntry[];
  stats: CallStats;
  events: TimelineEvent[];
  metadata?: Record<string, unknown>;
}

/** Nearest-rank percentile of a sorted array. */
export function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1] ?? null;
}

export function distribution(values: number[]): Distribution {
  const s = [...values].sort((a, b) => a - b);
  const mean = s.length ? Math.round(s.reduce((a, b) => a + b, 0) / s.length) : null;
  return {
    n: s.length,
    min: s[0] ?? null,
    p50: percentile(s, 50),
    p90: percentile(s, 90),
    max: s[s.length - 1] ?? null,
    mean,
  };
}

export class CallTimeline {
  private readonly events: TimelineEvent[] = [];
  private readonly transcript: TranscriptEntry[] = [];
  private readonly turns = new Map<number, TurnTiming>();
  private gen = 0;
  private readonly now: () => number;

  constructor(opts: { now?: () => number } = {}) {
    this.now = opts.now ?? Date.now;
    this.mark('call_start');
  }

  setGen(gen: number): void {
    this.gen = gen;
  }

  /** Record any event at the current generation. */
  mark(name: TimelineEventName, data?: Record<string, unknown>): void {
    this.events.push({ ts: this.now(), gen: this.gen, name, data });
  }

  private turn(): TurnTiming {
    let t = this.turns.get(this.gen);
    if (!t) {
      t = {};
      this.turns.set(this.gen, t);
    }
    return t;
  }

  /** A caller transcript starts an agent turn (generation already bumped). */
  turnStarted(text: string, speculative: boolean): void {
    const t = this.turn();
    t.turnStartedAt = this.now();
    if (!speculative) t.finalEotAt = t.turnStartedAt;
    t.speculative = speculative;
    this.mark('transcript', { role: 'caller', text, speculative });
    this.transcript.push({ role: 'caller', text, ts: this.now() });
  }

  /** The final end-of-turn confirmed a speculative turn. */
  speculativeConfirmed(): void {
    this.turn().finalEotAt = this.now();
    this.mark('speculative_confirmed');
  }

  firstToken(): void {
    const t = this.turn();
    if (t.firstTokenAt == null) t.firstTokenAt = this.now();
    this.mark('llm_first_token');
  }

  firstAudio(): void {
    const t = this.turn();
    if (t.firstAudioAt == null) t.firstAudioAt = this.now();
    this.mark('tts_first_audio');
  }

  bargeIn(text: string): void {
    this.turn().bargedIn = true;
    this.mark('barge_in', { text });
  }

  agentSaid(text: string): void {
    if (text.trim()) this.transcript.push({ role: 'agent', text, ts: this.now() });
  }

  getEvents(): readonly TimelineEvent[] {
    return this.events;
  }

  count(name: TimelineEventName, extra?: (e: TimelineEvent) => boolean): number {
    return this.events.filter((e) => e.name === name && (extra ? extra(e) : true)).length;
  }

  stats(): CallStats {
    const ttft: number[] = [];
    const ttfa: number[] = [];
    const eotToAudio: number[] = [];
    let turns = 0;
    for (const t of this.turns.values()) {
      if (t.turnStartedAt == null) continue;
      turns++;
      if (t.firstTokenAt != null) ttft.push(t.firstTokenAt - t.turnStartedAt);
      if (t.firstAudioAt != null) {
        ttfa.push(t.firstAudioAt - t.turnStartedAt);
        if (t.finalEotAt != null) eotToAudio.push(Math.max(0, t.firstAudioAt - t.finalEotAt));
      }
    }
    return {
      turns,
      bargeIns: this.count('barge_in'),
      backchannels: this.count('backchannel'),
      speculativeStarts: this.count('speculative_start'),
      speculativeCancels: this.count('speculative_cancel'),
      toolCalls: this.count('tool_use'),
      playbackConfirmed: this.count('playback_confirmed', (e) => e.data?.viaTimeout === false),
      playbackTimeouts: this.count('playback_confirmed', (e) => e.data?.viaTimeout === true),
      ttft: distribution(ttft),
      ttfa: distribution(ttfa),
      eotToAudio: distribution(eotToAudio),
    };
  }

  /** One-line human summary, e.g. for logs. */
  formatSummary(): string {
    const s = this.stats();
    const d = (x: Distribution) => (x.n ? `p50=${x.p50}ms p90=${x.p90}ms (n=${x.n})` : 'n/a');
    return [
      `turns=${s.turns} barge_ins=${s.bargeIns} backchannels=${s.backchannels}`,
      `spec=${s.speculativeStarts}/cancel=${s.speculativeCancels}`,
      `ttft ${d(s.ttft)}`,
      `ttfa ${d(s.ttfa)}`,
      `eot->audio ${d(s.eotToAudio)}`,
    ].join(' | ');
  }

  toRecord(info: {
    callId: string;
    startedAt: Date;
    endedAt: Date;
    lang: Lang;
    outcome: string;
    metadata?: Record<string, unknown>;
  }): CallRecord {
    return {
      callId: info.callId,
      startedAt: info.startedAt,
      endedAt: info.endedAt,
      durationS: Math.max(0, Math.round((info.endedAt.getTime() - info.startedAt.getTime()) / 1000)),
      lang: info.lang,
      outcome: info.outcome,
      transcript: [...this.transcript],
      stats: this.stats(),
      events: [...this.events],
      metadata: info.metadata,
    };
  }
}
