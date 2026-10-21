import type { CharAlignment } from './alignment.js';
import type { CallRecord } from './timeline.js';
import type { ChatMessage, Lang, SystemPrompt, ToolDef, ToolResult } from './types.js';

/**
 * Provider interfaces. Every external dependency (Twilio socket, STT, TTS, LLM)
 * sits behind one of these so the session runs offline against the fakes in
 * `@27colab/voice-engine/testing`.
 */

// ---------------------------------------------------------------------------
// Media transport (Twilio Media Streams, or a fake)
// ---------------------------------------------------------------------------

export interface MediaTransport {
  /** Queue outbound agent audio (base64 mulaw 8 kHz). */
  sendAudio(payloadB64: string): void;
  /** Insert a named mark behind the queued audio; the peer echoes it once played. */
  sendMark(name: string): void;
  /** Drop queued outbound audio immediately (barge-in). */
  clear(): void;
  close(): void;
  /** Inbound caller audio, base64 mulaw 8 kHz. */
  onMedia(cb: (payloadB64: string) => void): void;
  /** The peer confirms a named mark has played out. */
  onMark(cb: (name: string) => void): void;
  /** Caller hung up / stream stopped. */
  onStop(cb: () => void): void;
}

// ---------------------------------------------------------------------------
// STT
// ---------------------------------------------------------------------------

export interface SttConfig {
  model: string;
  keyterms: string[];
  replacements: Array<{ from: string; to: string }>;
  eotThreshold?: number;
  eagerEotThreshold?: number;
  languageHint?: Lang;
}

/** Turn events, mirroring Deepgram Flux's turn model. */
export interface SttEventHandlers {
  onStartOfTurn?(): void;
  /** Interim transcript while the caller is speaking. */
  onUpdate?(transcript: string): void;
  /** Early end-of-turn guess. Safe to start a speculative reply; may be retracted. */
  onEagerEndOfTurn?(transcript: string): void;
  /** The caller kept talking after an eager end: cancel the speculative reply. */
  onTurnResumed?(): void;
  /** Final end-of-turn transcript. */
  onEndOfTurn(transcript: string, meta: { confidence?: number }): void;
  onError?(err: Error): void;
}

export interface SttStream {
  sendAudio(payloadB64: string): void;
  close(): Promise<void>;
}

export interface SttFactory {
  create(config: SttConfig, handlers: SttEventHandlers): Promise<SttStream>;
}

// ---------------------------------------------------------------------------
// TTS
// ---------------------------------------------------------------------------

export interface TtsVoiceConfig {
  provider: string;
  voiceId: string;
  model: string;
  outputFormat: string;
  stability?: number;
  similarityBoost?: number;
  /** ISO 639-1 hint for pronunciation. */
  languageCode?: string;
}

export interface TtsEventHandlers {
  /** Outbound audio chunk (base64 mulaw 8 kHz); pipe to the transport. */
  onAudio(payloadB64: string): void;
  /** All queued text has been synthesized and delivered. */
  onComplete(): void;
  onError?(err: Error): void;
}

export interface TtsStream {
  /** Queue text. Safe to call before the socket is open. */
  speak(text: string): void;
  /** No more text is coming; flush and finish. */
  end(): void;
  /** Cancel synthesis mid-utterance (barge-in). */
  abort(): void;
  /**
   * Character-level timing for everything synthesized so far, on the same
   * timeline as the audio. Empty if the provider gives no alignment.
   */
  alignment(): CharAlignment;
  /** Total characters submitted (for whoever does their own metering). */
  charactersSubmitted(): number;
}

export interface TtsFactory {
  create(voice: TtsVoiceConfig, handlers: TtsEventHandlers): Promise<TtsStream>;
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

export interface ChatUsage {
  inputTokens: number;
  outputTokens: number;
  /** Prompt tokens read from the provider's cache, if the provider reports it. */
  cacheReadTokens?: number;
  /** Prompt tokens written to the provider's cache, if the provider reports it. */
  cacheWriteTokens?: number;
}

export interface ChatTurnRequest {
  model: string;
  maxTokens: number;
  /** A string, or ordered blocks whose `cacheBoundary` marks a cacheable prefix. */
  system: SystemPrompt;
  messages: ChatMessage[];
  tools: ToolDef[];
  signal?: AbortSignal;
  onTextDelta?(delta: string): void;
  onToolUseStart?(toolName: string): void;
}

export interface ChatTurnResult {
  /** Full assistant text of this API turn. */
  text: string;
  toolCalls: Array<{ id: string; name: string; input: unknown }>;
  /** Raw assistant content blocks to append to history verbatim. */
  assistantContent: unknown;
  stopReason: string;
  usage: ChatUsage;
}

export interface ChatEngine {
  streamTurn(req: ChatTurnRequest): Promise<ChatTurnResult>;
}

// ---------------------------------------------------------------------------
// Session wiring
// ---------------------------------------------------------------------------

export interface CallSessionDeps {
  transport: MediaTransport;
  sttFactory: SttFactory;
  ttsFactory: TtsFactory;
  chat: ChatEngine;
}

export interface CallSessionInfo {
  callId: string;
  startedAt: Date;
  /** Free-form caller/call metadata, passed through to the CallRecord. */
  metadata?: Record<string, unknown>;
}

export type CallEndReason = 'caller_hangup' | 'agent_end_call' | 'max_duration' | 'error';

export interface CallSessionHooks {
  /** Fired exactly once when the call is over. */
  onEnd(record: CallRecord, reason: CallEndReason): void;
  /** Non-fatal chat/tool errors (the call keeps listening). */
  onError?(err: unknown): void;
  /** Configuration that will probably misbehave (e.g. an English-only STT model on a bilingual line). */
  onWarning?(message: string): void;
}

export interface CallSessionApi {
  readonly info: CallSessionInfo;
  /** Open STT, speak the greeting, start the media loop. */
  start(): Promise<void>;
  /** Force-end. Idempotent. */
  end(reason: CallEndReason): Promise<void>;
}

export type ToolExecutor = (
  name: string,
  input: unknown,
  ctx: { callId: string; lang: Lang },
) => Promise<ToolResult>;
