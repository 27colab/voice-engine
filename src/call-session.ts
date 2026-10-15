import { splitAtPlayedMs, estimateSpokenText } from './alignment.js';
import { rewriteOnBargeIn } from './history.js';
import type {
  CallEndReason,
  CallSessionApi,
  CallSessionDeps,
  CallSessionHooks,
  CallSessionInfo,
  SttStream,
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
import type { ChatMessage, Lang, ToolDef } from './types.js';
import { selectVoice, type VoiceSettings } from './voice.js';

export interface CallSessionConfig {
  /** First entry is the starting language. */
  languages: Lang[];
  /** 'follow-caller' re-detects EN/ES from each caller turn (heuristic). Default 'fixed'. */
  languagePolicy?: 'fixed' | 'follow-caller';
  greeting: string | Partial<Record<Lang, string>>;
  system: string | ((lang: Lang, now: Date) => string);
  llm: { model: string; maxTokens: number };
  tools?: ToolDef[];
  executeTool?: ToolExecutor;
  voice: VoiceSettings;
  stt: {
    model: string;
    keyterms?: string[];
    replacements?: Array<{ from: string; to: string }>;
    eotThreshold?: number;
    eagerEotThreshold?: number;
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

  private utterance: Utterance | null = null;
  private utteranceSeq = 0;
  private chatAbort: AbortController | null = null;
  private speculation: Speculation | null = null;
  private maxDurationTimer: ReturnType<typeof setTimeout> | null = null;

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
      },
    );
    for (const frame of this.bufferedAudio) this.stt.sendAudio(frame);
    this.bufferedAudio = [];
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
    if (u) {
      const heard = this.heardText(u);
      rewriteOnBargeIn(this.history, heard, { inHistory: u.inHistory });
    }

    this.gen++;
    this.timeline.setGen(this.gen);
    this.chatAbort?.abort();
    this.chatAbort = null;
    this.speculation = null;
    this.pendingEndCall = false;
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
      this.lang = detectLang(userText) ?? this.lang;
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

      const result = await chat.streamTurn({
        model: this.cfg.llm.model,
        maxTokens: this.cfg.llm.maxTokens,
        system:
          typeof this.cfg.system === 'function' ? this.cfg.system(this.lang, new Date()) : this.cfg.system,
        tools: this.cfg.tools ?? [],
        messages: this.history,
        signal: abort.signal,
        onTextDelta: () => {
          if (stale() || firstToken) return;
          firstToken = true;
          this.timeline.firstToken();
        },
        onToolUseStart: (name) => {
          if (!stale()) this.timeline.mark('tool_use', { toolName: name });
        },
      });
      if (this.chatAbort === abort) this.chatAbort = null;
      if (stale()) return;

      if (result.toolCalls.length > 0) {
        // Speak any preamble ("let me check that") first. The tool-bearing
        // message is added to history only together with its results, so a
        // barge-in here can't leave a tool_use without a tool_result.
        const preamble = result.text.trim();
        if (preamble) {
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

  // -- speak + mark-confirmed playback ----------------------------------------------

  private greetingText(): string {
    const g = this.cfg.greeting;
    if (typeof g === 'string') return g;
    return g[this.lang] ?? g.en ?? Object.values(g)[0] ?? '';
  }

  private async speak(
    text: string,
    opts: { gen: number; transitionTo: State | null; addToHistory: boolean },
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
    const utterance: Utterance = { text, tracker, tts: null, inHistory: opts.addToHistory };
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
