import type { MediaTransport } from './interfaces.js';

/** mulaw 8 kHz mono: 1 byte per sample, 8 samples per ms. */
export function mulawDurationMs(payloadB64: string): number {
  const pad = payloadB64.endsWith('==') ? 2 : payloadB64.endsWith('=') ? 1 : 0;
  const bytes = Math.floor((payloadB64.length * 3) / 4) - pad;
  return bytes / 8;
}

export type DrainResult = 'confirmed' | 'timeout' | 'cleared';

export interface PlaybackTrackerOptions {
  transport: Pick<MediaTransport, 'sendAudio' | 'sendMark' | 'clear'>;
  /** Mark-name prefix; make it unique per utterance so late echoes are ignored. */
  prefix: string;
}

/**
 * Tracks how much of one utterance the far end has CONFIRMED playing.
 *
 * Every audio chunk is followed by a named mark; when Twilio echoes the mark,
 * everything before it has been played. `playedMs` is therefore a lower bound
 * with chunk granularity, never an overestimate.
 *
 * Twilio also echoes all pending marks when you send `clear`. clear() here
 * freezes the ledger first, so those echoes cannot count as playback.
 */
export class PlaybackTracker {
  private readonly pending = new Map<string, number>(); // mark name -> cumulative ms
  private seq = 0;
  private queued = 0;
  private confirmed = 0;
  private cleared = false;
  private waiter: { resolve: (r: DrainResult) => void; timer: ReturnType<typeof setTimeout> } | null = null;

  constructor(private readonly opts: PlaybackTrackerOptions) {}

  /** Audio queued so far, ms. */
  get queuedMs(): number {
    return this.queued;
  }

  /** Audio the peer has confirmed playing, ms. */
  get playedMs(): number {
    return this.confirmed;
  }

  /** Queue a chunk and the mark that will confirm it. Returns the chunk length in ms. */
  sendAudio(payloadB64: string): number {
    if (this.cleared) return 0;
    const ms = mulawDurationMs(payloadB64);
    this.opts.transport.sendAudio(payloadB64);
    this.queued += ms;
    const name = `${this.opts.prefix}${++this.seq}`;
    this.pending.set(name, this.queued);
    this.opts.transport.sendMark(name);
    return ms;
  }

  /** Feed a mark echo from the transport. Unknown or post-clear names are ignored. */
  onMark(name: string): boolean {
    if (this.cleared) return false;
    const at = this.pending.get(name);
    if (at === undefined) return false;
    this.pending.delete(name);
    this.confirmed = Math.max(this.confirmed, at);
    this.maybeResolve();
    return true;
  }

  /**
   * Resolves when everything queued so far is confirmed, or after the audio that
   * is still unconfirmed has had time to play plus `paddingMs` (a lost mark
   * must not stall the call forever).
   */
  whenDrained(paddingMs: number): Promise<DrainResult> {
    if (this.cleared) return Promise.resolve('cleared');
    if (this.confirmed >= this.queued) return Promise.resolve('confirmed');
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.settle('timeout'), this.queued - this.confirmed + paddingMs);
      this.waiter = { resolve, timer };
    });
  }

  /** Barge-in: freeze the ledger, wipe the peer's queue, release waiters. */
  clear(): void {
    if (this.cleared) return;
    this.cleared = true;
    this.pending.clear();
    this.opts.transport.clear();
    this.settle('cleared');
  }

  /** Release timers without touching the transport (call ended). */
  dispose(): void {
    this.cleared = true;
    this.pending.clear();
    this.settle('cleared');
  }

  private maybeResolve(): void {
    if (this.waiter && this.confirmed >= this.queued) this.settle('confirmed');
  }

  private settle(result: DrainResult): void {
    const w = this.waiter;
    if (!w) return;
    this.waiter = null;
    clearTimeout(w.timer);
    w.resolve(result);
  }
}
