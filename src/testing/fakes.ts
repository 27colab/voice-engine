import { AlignmentAccumulator, type CharAlignment } from '../alignment.js';
import type {
  ChatEngine,
  ChatTurnRequest,
  ChatTurnResult,
  ChatUsage,
  MediaTransport,
  SttConfig,
  SttEventHandlers,
  SttFactory,
  SttStream,
  SttUpdate,
  TtsEventHandlers,
  TtsFactory,
  TtsStream,
  TtsVoiceConfig,
} from '../interfaces.js';
import { mulawDurationMs } from '../playback.js';

/**
 * Offline, in-memory implementations of every provider interface. Tests drive
 * inbound events with the `emit*`/`confirm*` helpers and inspect recorded calls.
 */

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

export interface FakeTransportOptions {
  /** Echo each mark on the next microtask, as if audio played instantly. Default false. */
  autoConfirmMarks?: boolean;
  /** Like Twilio, echo all still-pending marks when clear() is called. Default true. */
  echoMarksOnClear?: boolean;
}

export class FakeTransport implements MediaTransport {
  readonly sentAudio: string[] = [];
  /** Every mark sent, with the cumulative audio (ms) queued before it. */
  readonly sentMarks: Array<{ name: string; atMs: number }> = [];
  clearCount = 0;
  closed = false;

  private queuedMs = 0;

  /** Audio queued on this transport so far, ms (marks are positioned on this timeline). */
  get totalQueuedMs(): number {
    return this.queuedMs;
  }

  private unconfirmed: Array<{ name: string; atMs: number }> = [];
  private mediaCb?: (p: string) => void;
  private markCb?: (name: string) => void;
  private stopCb?: () => void;

  constructor(private readonly opts: FakeTransportOptions = {}) {}

  sendAudio(payloadB64: string): void {
    this.sentAudio.push(payloadB64);
    this.queuedMs += mulawDurationMs(payloadB64);
  }

  sendMark(name: string): void {
    const mark = { name, atMs: this.queuedMs };
    this.sentMarks.push(mark);
    this.unconfirmed.push(mark);
    if (this.opts.autoConfirmMarks) queueMicrotask(() => this.confirmMark(name));
  }

  clear(): void {
    this.clearCount++;
    const pending = this.unconfirmed;
    this.unconfirmed = [];
    if (this.opts.echoMarksOnClear !== false) {
      queueMicrotask(() => pending.forEach((m) => this.markCb?.(m.name)));
    }
  }

  close(): void {
    this.closed = true;
  }

  onMedia(cb: (p: string) => void): void {
    this.mediaCb = cb;
  }
  onMark(cb: (name: string) => void): void {
    this.markCb = cb;
  }
  onStop(cb: () => void): void {
    this.stopCb = cb;
  }

  // -- test drivers --
  emitMedia(payloadB64: string): void {
    this.mediaCb?.(payloadB64);
  }

  confirmMark(name: string): void {
    this.unconfirmed = this.unconfirmed.filter((m) => m.name !== name);
    this.markCb?.(name);
  }

  /** Simulate the caller having heard `ms` of queued audio: echo every mark at or before it. */
  confirmPlayedMs(ms: number): void {
    for (const m of [...this.unconfirmed]) if (m.atMs <= ms) this.confirmMark(m.name);
  }

  confirmAllMarks(): void {
    for (const m of [...this.unconfirmed]) this.confirmMark(m.name);
  }

  emitStop(): void {
    this.stopCb?.();
  }
}

// ---------------------------------------------------------------------------
// STT
// ---------------------------------------------------------------------------

export class FakeSttStream implements SttStream {
  readonly sentAudio: string[] = [];
  /** Every mid-call update received, in order. */
  readonly configures: SttUpdate[] = [];
  closed = false;

  constructor(
    readonly config: SttConfig,
    private readonly handlers: SttEventHandlers,
  ) {}

  sendAudio(payloadB64: string): void {
    this.sentAudio.push(payloadB64);
  }
  async close(): Promise<void> {
    this.closed = true;
  }
  configure(update: SttUpdate): void {
    this.configures.push(update);
  }

  emitStartOfTurn(): void {
    this.handlers.onStartOfTurn?.();
  }
  emitUpdate(transcript: string): void {
    this.handlers.onUpdate?.(transcript);
  }
  emitEagerEndOfTurn(transcript: string): void {
    this.handlers.onEagerEndOfTurn?.(transcript);
  }
  emitTurnResumed(): void {
    this.handlers.onTurnResumed?.();
  }
  emitEndOfTurn(transcript: string, confidence = 0.95): void {
    this.handlers.onEndOfTurn(transcript, { confidence });
  }
  emitError(err: Error): void {
    this.handlers.onError?.(err);
  }
  emitWarning(message: string): void {
    this.handlers.onWarning?.(message);
  }
}

export class FakeStt implements SttFactory {
  readonly streams: FakeSttStream[] = [];

  async create(config: SttConfig, handlers: SttEventHandlers): Promise<SttStream> {
    const stream = new FakeSttStream(config, handlers);
    this.streams.push(stream);
    return stream;
  }

  get last(): FakeSttStream {
    const s = this.streams[this.streams.length - 1];
    if (!s) throw new Error('FakeStt: no stream created yet');
    return s;
  }
}

// ---------------------------------------------------------------------------
// TTS
// ---------------------------------------------------------------------------

export interface FakeTtsOptions {
  /** Speaking speed: ms of audio per character. Default 60. */
  msPerChar?: number;
  /** Characters per emitted audio chunk (and so per mark). Default 8. */
  charsPerChunk?: number;
}

/**
 * Deterministic TTS: each character is `msPerChar` of mulaw silence with exact
 * alignment, emitted in fixed-size chunks.
 */
export class FakeTtsStream implements TtsStream {
  aborted = false;
  ended = false;
  readonly spoken: string[] = [];
  private submitted = 0;
  private readonly align = new AlignmentAccumulator();
  private clockMs = 0;

  constructor(
    readonly voice: TtsVoiceConfig,
    private readonly handlers: TtsEventHandlers,
    private readonly opts: Required<FakeTtsOptions>,
  ) {}

  speak(text: string): void {
    if (this.aborted) return;
    this.spoken.push(text);
    this.submitted += text.length;
    const chars = Array.from(text);
    for (let i = 0; i < chars.length; i += this.opts.charsPerChunk) {
      const part = chars.slice(i, i + this.opts.charsPerChunk);
      const starts = part.map((_, j) => this.clockMs + j * this.opts.msPerChar);
      const durs = part.map(() => this.opts.msPerChar);
      this.align.add({ chars: part, charStartTimesMs: starts, charDurationsMs: durs });
      this.clockMs += part.length * this.opts.msPerChar;
      const bytes = Math.round(part.length * this.opts.msPerChar * 8); // 8 bytes/ms
      this.handlers.onAudio(Buffer.alloc(bytes, 0xff).toString('base64'));
    }
  }

  end(): void {
    this.ended = true;
    this.handlers.onComplete();
  }

  abort(): void {
    this.aborted = true;
  }

  alignment(): CharAlignment {
    return this.align.snapshot();
  }

  charactersSubmitted(): number {
    return this.submitted;
  }

  get totalMs(): number {
    return this.clockMs;
  }
}

export class FakeTts implements TtsFactory {
  readonly streams: FakeTtsStream[] = [];
  private readonly opts: Required<FakeTtsOptions>;

  constructor(opts: FakeTtsOptions = {}) {
    this.opts = { msPerChar: opts.msPerChar ?? 60, charsPerChunk: opts.charsPerChunk ?? 8 };
  }

  async create(voice: TtsVoiceConfig, handlers: TtsEventHandlers): Promise<TtsStream> {
    const stream = new FakeTtsStream(voice, handlers, this.opts);
    this.streams.push(stream);
    return stream;
  }

  get last(): FakeTtsStream {
    const s = this.streams[this.streams.length - 1];
    if (!s) throw new Error('FakeTts: no stream created yet');
    return s;
  }

  /** All text submitted for synthesis, across streams. */
  submittedText(): string {
    return this.streams.flatMap((s) => s.spoken).join('');
  }

  charactersSubmitted(): number {
    return this.streams.reduce((n, s) => n + s.charactersSubmitted(), 0);
  }
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

const ZERO_USAGE: ChatUsage = { inputTokens: 0, outputTokens: 0 };

export interface ScriptedTurn {
  /** Streamed as text deltas, then returned as the turn's text. */
  text?: string;
  toolCall?: { id?: string; name: string; input?: unknown };
  stopReason?: string;
  usage?: Partial<ChatUsage>;
  /** Hold the response until this promise resolves (simulates LLM latency). */
  gate?: Promise<void>;
}

const aborted = (): ChatTurnResult => ({
  text: '',
  toolCalls: [],
  assistantContent: [],
  stopReason: 'aborted',
  usage: ZERO_USAGE,
});

export class FakeChat implements ChatEngine {
  private readonly queue: ScriptedTurn[] = [];
  readonly requests: ChatTurnRequest[] = [];
  /** Snapshot of `messages` as each request saw it (the live array is mutated later). */
  readonly seenMessages: string[] = [];
  turnsRun = 0;
  abortedTurns = 0;
  private toolSeq = 0;

  push(turn: ScriptedTurn): this {
    this.queue.push(turn);
    return this;
  }
  pushText(text: string): this {
    return this.push({ text });
  }
  pushToolCall(name: string, input?: unknown, text?: string): this {
    return this.push({ toolCall: { name, input }, text });
  }

  async streamTurn(req: ChatTurnRequest): Promise<ChatTurnResult> {
    this.requests.push(req);
    this.seenMessages.push(JSON.stringify(req.messages));
    this.turnsRun++;
    const turn = this.queue.shift() ?? { text: '' };

    if (turn.gate) await turn.gate;
    if (req.signal?.aborted) {
      this.abortedTurns++;
      return aborted();
    }

    const text = turn.text ?? '';
    for (let i = 0; i < text.length; i += 12) req.onTextDelta?.(text.slice(i, i + 12));

    const toolCalls: ChatTurnResult['toolCalls'] = [];
    const assistantContent: unknown[] = [];
    if (text) assistantContent.push({ type: 'text', text });
    if (turn.toolCall) {
      const id = turn.toolCall.id ?? `tool_${++this.toolSeq}`;
      const input = turn.toolCall.input ?? {};
      req.onToolUseStart?.(turn.toolCall.name);
      toolCalls.push({ id, name: turn.toolCall.name, input });
      assistantContent.push({ type: 'tool_use', id, name: turn.toolCall.name, input });
    }

    return {
      text,
      toolCalls,
      assistantContent,
      stopReason: turn.stopReason ?? (turn.toolCall ? 'tool_use' : 'end_turn'),
      usage: { ...ZERO_USAGE, ...turn.usage },
    };
  }
}
