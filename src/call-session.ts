import { splitAtPlayedMs, estimateSpokenText } from './alignment.js';
import { rewriteOnBargeIn } from './history.js';
import type {
  CallEndReason,
  CallSessionApi,
  CallSessionDeps,
  CallSessionHooks,
  CallSessionInfo,
  SttStream,
  SttUpdate,
  ToolExecutor,
  TtsStream,
} from './interfaces.js';
import { PlaybackTracker } from './playback.js';
import { CallTimeline } from './timeline.js';
import {
  classifyUtterance,
  detectLang,
  normalizeTranscript,
  wordCount,
  type ClassifyOptions,
  type UtteranceKind,
} from './turn-policy.js';
import type { ChatMessage, Filler, Lang, SystemPrompt, ToolDef } from './types.js';
import { selectVoice, type VoiceSettings } from './voice.js';

export interface CallSessionConfig {
  /** First entry is the starting language. */
  languages: Lang[];
  /** 'follow-caller' re-detects EN/ES from each caller turn (heuristic). Default 'fixed'. */
  languagePolicy?: 'fixed' | 'follow-caller';
  greeting: string | Partial<Record<Lang, string>>;
  /**
   * The system prompt: a string, ordered blocks with cache boundaries, or a
   * function of the current language and time returning either. Called per
   * model turn, so volatile facts (the time) can go after the last boundary.
   */
  system: SystemPrompt | ((lang: Lang, now: Date) => SystemPrompt);
  llm: { model: string; maxTokens: number };
  tools?: ToolDef[];
  executeTool?: ToolExecutor;
  /**
   * Phrases spoken the instant the model starts a tool call ("One moment."),
   * keyed by tool name, per language or one string for all. Spoken through
   * the normal playback path: the caller can interrupt it, it is on the
   * timeline and in the transcript, and it is never added to chat history.
   * Skipped when the model already wrote its own preamble that turn.
   */
  fillers?: Record<string, Filler>;
  voice: VoiceSettings;
  stt: {
    model: string;
    keyterms?: string[];
    replacements?: Array<{ from: string; to: string }>;
    eotThreshold?: number;
    eagerEotThreshold?: number;
    /** Digits instead of words for numbers. Change it mid-call with `session.configureStt`. */
    numerals?: boolean;
    /**
     * Keep the STT language hint on the caller's current language when
     * `languagePolicy` is 'follow-caller' (needs a provider with `configure`,
     * e.g. Flux multilingual). Default true.
     */
    followLanguage?: boolean;
  };
  /** Hard cap on call length. Default 900. */
  maxCallSeconds?: number;
  turnTaking?: {
    /** Start the LLM on EagerEndOfTurn and cancel on TurnResumed. Default true. */
    speculative?: boolean;
    /** Words above which speech over the agent is an interruption. Default 3. */
    bargeInMinWords?: number;
    /** Replace the backchannel/interruption classifier. */
    classify?: (transcript: string, opts: ClassifyOptions) => UtteranceKind;
    /** Slack added to the audio-remaining time before a lost mark is given up on. Default 3000. */
    playbackPaddingMs?: number;
  };
  /** Injectable clock for the timeline. */
  now?: () => number;
}

type State = 'greeting' | 'listening' | 'thinking' | 'speaking' | 'ending';

interface Utterance {
  text: string;
  tracker: PlaybackTracker;
  tts: TtsStream | null;
  /** Is this text already the last assistant message in history? */
  inHistory: boolean;
  /** A tool filler: never rewritten into history on barge-in. */
  filler: boolean;
}

interface Speculation {
  gen: number;
  transcript: string;
  historyLen: number;
}

const SYNTH_TIMEOUT_FLOOR_MS = 8_000;
const WORDS_PER_SEC = 2.5;
const MAX_BUFFERED_FRAMES = 150;

class CallSession implements CallSessionApi {
  private readonly timeline: CallTimeline;
  private readonly cfg: CallSessionConfig;
  private lang: Lang;

  private state: State = 'greeting';
  private ended = false;
  private pendingEndCall = false;

  /** Anything tagged with a stale generation is dropped. */
  private gen = 0;
  private history: ChatMessage[] = [];

  private stt: SttStream | null = null;
  private bufferedAudio: string[] = [];
  /** Updates requested before STT opened, merged; sent right after it opens. */
  private pendingSttUpdate: SttUpdate | null = null;

  private utterance: Utterance | null = null;
  private utteranceSeq = 0;
  private chatAbort: AbortController | null = null;
  private speculation: Speculation | null = null;
  private maxDurationTimer: ReturnType<typeof setTimeout> | null = null;
  /** The filler currently playing (or synthesizing), if any. */
  private pendingFiller: Promise<void> | null = null;

  constructor(
    private readonly deps: CallSessionDeps,
    readonly info: CallSessionInfo,
    private readonly hooks: CallSessionHooks,
    cfg: CallSessionConfig,
  ) {
    this.cfg = cfg;
    this.lang = cfg.languages[0] ?? 'en';
    this.timeline = new CallTimeline({ now: cfg.now });
  }

  // -- lifecycle -------------------------------------------------------------

  async start(): Promise<void> {
    const { transport } = this.deps;
    transport.onMedia((p) => {
      if (this.stt) this.stt.sendAudio(p);
      else if (this.bufferedAudio.length < MAX_BUFFERED_FRAMES) this.bufferedAudio.push(p);
    });
    transport.onMark((name) => this.utterance?.tracker.onMark(name));
    transport.onStop(() => void this.end('caller_hangup'));

    this.checkConfig();

    const limitMs = (this.cfg.maxCallSeconds ?? 900) * 1000;
    this.maxDurationTimer = setTimeout(() => void this.end('max_duration'), limitMs);

    await this.openStt();

    // Do not await playout: the caller may barge in over the greeting.
    this.state = 'greeting';
    void this.speak(this.greetingText(), { gen: this.gen, transitionTo: 'listening', addToHistory: false }).catch(
      (err) => {
        this.hooks.onError?.(err);
        void this.end('error');
      },
    );
  }

  async end(reason: CallEndReason): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    this.state = 'ending';
    if (this.maxDurationTimer) clearTimeout(this.maxDurationTimer);
    this.maxDurationTimer = null;

    this.gen++;
    this.chatAbort?.abort();
    this.chatAbort = null;
    this.speculation = null;
    this.dropUtterance({ clearTransport: false });

    try {
      await this.stt?.close();
    } catch {
      /* ignore */
    }
    this.stt = null;
    try {
      this.deps.transport.clear();
      this.deps.transport.close();
    } catch {
      /* ignore */
    }

    this.timeline.mark('call_end', { reason });
    const record = this.timeline.toRecord({
      callId: this.info.callId,
      startedAt: this.info.startedAt,
      endedAt: new Date(this.cfg.now ? this.cfg.now() : Date.now()),
      lang: this.lang,
      outcome: reason === 'agent_end_call' ? 'completed' : reason,
      metadata: this.info.metadata,
    });
    try {
      this.hooks.onEnd(record, reason);
    } catch {
      /* host hook errors must not crash teardown */
    }
  }

  /** Warn about configurations that fail silently. */
  private checkConfig(): void {
    const model = this.cfg.stt.model;
    if (this.cfg.languages.length > 1 && model.startsWith('flux-') && !model.endsWith('-multi')) {
      this.warn(
        `stt.model "${model}" transcribes one language, but languages is [${this.cfg.languages.join(', ')}]. ` +
          'Use "flux-general-multi" so callers in the other language are understood.',
      );
    }
  }

  private warn(message: string): void {
    this.timeline.mark('warning', { message });
    this.hooks.onWarning?.(message);
  }

  // -- STT wiring --------------------------------------------------------------

  private async openStt(): Promise<void> {
    const s = this.cfg.stt;
    this.timeline.mark('stt_start', { model: s.model });
    this.stt = await this.deps.sttFactory.create(
      {
        model: s.model,
        keyterms: s.keyterms ?? [],
        replacements: s.replacements ?? [],
        eotThreshold: s.eotThreshold,
        eagerEotThreshold: s.eagerEotThreshold,
        languageHint: this.lang,
        numerals: s.numerals,
      },
      {
        onUpdate: (t) => this.onUpdate(t),
        onEagerEndOfTurn: (t) => this.onEagerEndOfTurn(t),
        onTurnResumed: () => this.onTurnResumed(),
        onEndOfTurn: (t) => this.onEndOfTurn(t),
        onError: (err) => {
          // We can no longer hear the caller.
          this.hooks.onError?.(err);
          void this.end('error');
        },
        onWarning: (message) => this.warn(message),
      },
    );
    for (const frame of this.bufferedAudio) this.stt.sendAudio(frame);
    this.bufferedAudio = [];
    if (this.pendingSttUpdate) {
      const update = this.pendingSttUpdate;
      this.pendingSttUpdate = null;
      this.configureStt(update);
    }
  }

  configureStt(update: SttUpdate): boolean {
    if (this.ended) return false;
    if (!this.stt) {
      this.pendingSttUpdate = { ...this.pendingSttUpdate, ...update };
      return true;
    }
    if (!this.stt.configure) return false;
    this.timeline.mark('stt_configure', { ...update });
    this.stt.configure(update);
    return true;
  }

  // -- turn events ---------------------------------------------------------------

  private classify(text: string): UtteranceKind {
    const opts = { minWords: this.cfg.turnTaking?.bargeInMinWords };
    return (this.cfg.turnTaking?.classify ?? classifyUtterance)(text, opts);
  }

  /** Called while the agent is audible. Returns true if the caller interrupted. */
  private interrupts(text: string): boolean {
    if (this.classify(text) === 'interruption') return true;
    this.timeline.mark('backchannel', { text });
    return false;
  }

  private onUpdate(transcript: string): void {
    // Interim text is an early barge-in trigger only; never starts a turn.
    if (this.state !== 'speaking' || wordCount(transcript) === 0) return;
    if (this.classify(transcript) === 'interruption') this.bargeIn(transcript);
  }

  private onEagerEndOfTurn(transcript: string): void {
    const text = transcript.trim();
    if (!text || this.ended) return;
    this.timeline.mark('eager_eot', { text });

    if (this.speculation) {
      if (normalizeTranscript(this.speculation.transcript) === normalizeTranscript(text)) return;
      this.cancelSpeculation('eager_changed');
    }

    if (this.state === 'speaking') {
      if (this.interrupts(text)) {
        this.bargeIn(text);
        this.beginTurn(text);
      }
      return;
    }
    if (this.state !== 'listening' || this.cfg.turnTaking?.speculative === false) return;
    this.beginTurn(text, { speculative: true });
  }

  private onTurnResumed(): void {
    this.timeline.mark('turn_resumed');
    if (this.speculation) this.cancelSpeculation('turn_resumed');
  }

  private onEndOfTurn(transcript: string): void {
    const text = transcript.trim();
    if (!text || this.ended) return;

    const spec = this.speculation;
    if (spec && spec.gen === this.gen) {
      if (normalizeTranscript(spec.transcript) === normalizeTranscript(text)) {
        // The eager guess was right: keep the reply already in flight.
        this.speculation = null;
        this.timeline.speculativeConfirmed();
        return;
      }
      this.cancelSpeculation('final_differs');
    }

    if (this.state === 'speaking') {
      if (this.interrupts(text)) {
        this.bargeIn(text);
        this.beginTurn(text);
      }
      return;
    }
    if (this.state !== 'listening') return;
    this.beginTurn(text);
  }

  // -- speculation + barge-in ----------------------------------------------------

  /** Undo a speculative turn: stop chat and audio, restore history to before it. */
  private cancelSpeculation(why: string): void {
    const spec = this.speculation;
    if (!spec) return;
    this.speculation = null;
    this.timeline.mark('speculative_cancel', { why });
    this.gen++;
    this.timeline.setGen(this.gen);
    this.chatAbort?.abort();
    this.chatAbort = null;
    this.dropUtterance({ clearTransport: true });
    this.pendingEndCall = false;
    this.history.length = Math.min(this.history.length, spec.historyLen);
    this.state = 'listening';
  }

  private bargeIn(transcript: string): void {
    this.timeline.bargeIn(transcript);

    const u = this.utterance;
    if (u && !u.filler) {
      const heard = this.heardText(u);
      rewriteOnBargeIn(this.history, heard, { inHistory: u.inHistory });
    }

    this.gen++;
    this.timeline.setGen(this.gen);
    this.chatAbort?.abort();
    this.chatAbort = null;
    this.speculation = null;
    this.pendingEndCall = false;
    this.pendingFiller = null;
    this.dropUtterance({ clearTransport: true });
    this.state = 'listening';
  }

  /** What the caller actually heard of an utterance, from confirmed playback + alignment. */
  private heardText(u: Utterance): string {
    const playedMs = u.tracker.playedMs;
    const alignment = u.tts?.alignment();
    if (alignment && alignment.chars.length > 0) {
      return splitAtPlayedMs(u.text, alignment, playedMs).spoken;
    }
    return estimateSpokenText(u.text, playedMs).spoken;
  }

  private dropUtterance(opts: { clearTransport: boolean }): void {
    const u = this.utterance;
    this.utterance = null;
    if (!u) return;
    try {
      u.tts?.abort();
    } catch {
      /* ignore */
    }
    if (opts.clearTransport) u.tracker.clear();
    else u.tracker.dispose();
  }

  // -- turn loop -------------------------------------------------------------------

  private beginTurn(userText: string, opts: { speculative?: boolean } = {}): void {
    if (this.ended) return;
    const gen = ++this.gen;
    this.timeline.setGen(gen);
    this.state = 'thinking';

    if (this.cfg.languagePolicy === 'follow-caller') {
      const previous = this.lang;
      this.lang = detectLang(userText) ?? this.lang;
      if (this.lang !== previous && this.cfg.stt.followLanguage !== false) {
        this.configureStt({ languageHint: this.lang });
      }
    }

    const historyLen = this.history.length;
    this.history.push({ role: 'user', content: userText });
    this.timeline.turnStarted(userText, !!opts.speculative);
    if (opts.speculative) {
      this.speculation = { gen, transcript: userText, historyLen };
      this.timeline.mark('speculative_start');
    }

    void this.runChatLoop(gen).catch((err) => {
      if (gen !== this.gen) return; // aborted by barge-in / cancel
      this.timeline.mark('error', { message: err instanceof Error ? err.message : String(err) });
      this.hooks.onError?.(err);
      this.state = 'listening'; // keep the line alive
    });
  }

  private async runChatLoop(gen: number): Promise<void> {
    const { chat } = this.deps;
    const stale = () => gen !== this.gen || this.ended;

    while (!stale()) {
      const abort = new AbortController();
      this.chatAbort = abort;
      let firstToken = false;
      let sawText = false;
      let fillerStarted = false;

      const result = await chat.streamTurn({
        model: this.cfg.llm.model,
        maxTokens: this.cfg.llm.maxTokens,
        system:
          typeof this.cfg.system === 'function' ? this.cfg.system(this.lang, new Date()) : this.cfg.system,
        tools: this.cfg.tools ?? [],
        messages: this.history,
        signal: abort.signal,
        onTextDelta: (delta) => {
          if (stale()) return;
          if (delta.trim()) sawText = true;
          if (firstToken) return;
          firstToken = true;
          this.timeline.firstToken();
        },
        onToolUseStart: (name) => {
          if (stale()) return;
          this.timeline.mark('tool_use', { toolName: name });
          // One filler per model turn, only when the model wrote no preamble of its own.
          if (!fillerStarted && !sawText) {
            fillerStarted = true;
            this.startFiller(gen, name);
          }
        },
      });
      if (this.chatAbort === abort) this.chatAbort = null;
      this.timeline.addUsage({
        llmInputTokens: result.usage.inputTokens,
        llmOutputTokens: result.usage.outputTokens,
        llmCacheReadTokens: result.usage.cacheReadTokens,
        llmCacheWriteTokens: result.usage.cacheWriteTokens,
      });
      if (stale()) return;

      if (result.toolCalls.length > 0) {
        // Speak any preamble ("let me check that") first. The tool-bearing
        // message is added to history only together with its results, so a
        // barge-in here can't leave a tool_use without a tool_result.
        const preamble = result.text.trim();
        if (preamble) {
          await this.finishFiller();
          await this.speak(preamble, { gen, transitionTo: null, addToHistory: false });
          if (stale()) return;
        }

        const results: unknown[] = [];
        let endCall = false;
        for (const call of result.toolCalls) {
          const res = this.cfg.executeTool
            ? await this.cfg.executeTool(call.name, call.input, { callId: this.info.callId, lang: this.lang })
            : { content: `Unknown tool: ${call.name}`, isError: true };
          if ('endCall' in res && res.endCall) endCall = true;
          results.push({
            type: 'tool_result',
            tool_use_id: call.id,
            content: res.content,
            is_error: res.isError ?? false,
          });
        }
        if (stale()) return;
        this.history.push({ role: 'assistant', content: result.assistantContent });
        this.history.push({ role: 'user', content: results });

        if (endCall) {
          this.pendingEndCall = true;
          if (preamble) {
            await this.gracefulEnd(gen); // the farewell was the preamble
            return;
          }
        }
        continue;
      }

      const text = result.text.trim();
      await this.finishFiller();
      if (stale()) return;
      if (!text) {
        if (this.pendingEndCall) await this.gracefulEnd(gen);
        else this.state = 'listening';
        return;
      }

      await this.speak(text, {
        gen,
        transitionTo: this.pendingEndCall ? null : 'listening',
        addToHistory: true,
      });
      if (!stale() && this.pendingEndCall) await this.gracefulEnd(gen);
      return;
    }
  }

  private async gracefulEnd(gen: number): Promise<void> {
    if (gen !== this.gen) return;
    await this.end('agent_end_call');
  }

  // -- fillers ---------------------------------------------------------------------

  private fillerText(toolName: string): string | null {
    const f = this.cfg.fillers?.[toolName];
    if (!f) return null;
    if (typeof f === 'string') return f.trim() || null;
    return (f[this.lang] ?? f.en ?? Object.values(f)[0] ?? '').trim() || null;
  }

  /** Speak the tool's filler now; the tool runs while it plays. */
  private startFiller(gen: number, toolName: string): void {
    if (this.pendingFiller) return; // one is still playing; never overlap two
    const text = this.fillerText(toolName);
    if (!text) return;
    this.timeline.mark('filler', { toolName, text });
    // Back to 'thinking' afterwards: caller speech while the tool runs is not an interruption.
    const p: Promise<void> = this.speak(text, { gen, transitionTo: 'thinking', addToHistory: false, filler: true })
      .catch((err) => this.hooks.onError?.(err))
      .finally(() => {
        if (this.pendingFiller === p) this.pendingFiller = null;
      });
    this.pendingFiller = p;
  }

  /** Let a filler finish playing before the next utterance starts. */
  private async finishFiller(): Promise<void> {
    const p = this.pendingFiller;
    this.pendingFiller = null;
    if (p) await p;
  }

  // -- speak + mark-confirmed playback ----------------------------------------------

  private greetingText(): string {
    const g = this.cfg.greeting;
    if (typeof g === 'string') return g;
    return g[this.lang] ?? g.en ?? Object.values(g)[0] ?? '';
  }

  private async speak(
    text: string,
    opts: { gen: number; transitionTo: State | null; addToHistory: boolean; filler?: boolean },
  ): Promise<void> {
    const { gen } = opts;
    const stale = () => gen !== this.gen || this.ended;
    if (stale()) return;

    this.state = 'speaking';
    if (opts.addToHistory) this.history.push({ role: 'assistant', content: text });
    this.timeline.agentSaid(text);

    const tracker = new PlaybackTracker({
      transport: this.deps.transport,
      prefix: `u${++this.utteranceSeq}-`,
    });
    const utterance: Utterance = { text, tracker, tts: null, inHistory: opts.addToHistory, filler: opts.filler ?? false };
    this.utterance = utterance;

    let firstAudio = false;
    let synthDone!: () => void;
    const synthesized = new Promise<void>((r) => (synthDone = r));

    const tts = await this.deps.ttsFactory.create(selectVoice(this.cfg.voice, this.lang), {
      onAudio: (payload) => {
        if (stale() || this.utterance !== utterance) return;
        if (!firstAudio) {
          firstAudio = true;
          this.timeline.firstAudio();
        }
        tracker.sendAudio(payload);
      },
      onComplete: () => synthDone(),
      onError: (err) => {
        this.timeline.mark('error', { source: 'tts', message: err.message });
        synthDone();
      },
    });

    if (stale() || this.utterance !== utterance) {
      try {
        tts.abort();
      } catch {
        /* ignore */
      }
      return;
    }
    utterance.tts = tts;
    tts.speak(text);
    tts.end();
    this.timeline.addUsage({ ttsCharacters: text.length });

    // Wait for all audio to be handed to the transport, so the last mark rides
    // behind it; then wait for the marks to come back.
    const synthTimeoutMs = Math.max(SYNTH_TIMEOUT_FLOOR_MS, (wordCount(text) / WORDS_PER_SEC) * 1000);
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      synthesized,
      new Promise<void>((r) => {
        timer = setTimeout(r, synthTimeoutMs);
      }),
    ]);
    clearTimeout(timer);
    if (stale() || this.utterance !== utterance) return;

    const result = await tracker.whenDrained(this.cfg.turnTaking?.playbackPaddingMs ?? 3_000);
    if (stale() || this.utterance !== utterance || result === 'cleared') return;
    this.timeline.mark('playback_confirmed', { viaTimeout: result === 'timeout', playedMs: tracker.playedMs });

    this.utterance = null;
    tracker.dispose();
    if (opts.transitionTo) this.state = opts.transitionTo;
  }
}

export const createCallSession = (
  deps: CallSessionDeps,
  info: CallSessionInfo,
  hooks: CallSessionHooks,
  config: CallSessionConfig,
): CallSessionApi => new CallSession(deps, info, hooks, config);
