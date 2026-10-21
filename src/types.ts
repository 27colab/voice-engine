/** Languages the voice selection and turn policy know about. */
export type Lang = 'en' | 'es';

export interface ToolDef {
  name: string;
  description: string;
  /** JSON Schema for the tool input. */
  input_schema: Record<string, unknown>;
}

export interface ToolResult {
  content: string;
  isError?: boolean;
  /** Hang up gracefully once the current utterance has finished playing. */
  endCall?: boolean;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  /** Plain string, or provider content blocks (Anthropic shape) for tool turns. */
  content: unknown;
}

/**
 * One block of a system prompt. `cacheBoundary: true` marks the end of a
 * stable prefix the chat adapter may cache (Anthropic: `cache_control`).
 * Put volatile text (the time, per-call facts) after the last boundary.
 */
export interface SystemBlock {
  text: string;
  cacheBoundary?: boolean;
}

/** A system prompt: a plain string, or ordered blocks with cache boundaries. */
export type SystemPrompt = string | SystemBlock[];

/** A short phrase spoken the instant the model starts a tool call. */
export type Filler = string | Partial<Record<Lang, string>>;

/** Per-call usage totals, for whoever does metering or cost attribution. */
export interface CallUsage {
  llmInputTokens: number;
  llmOutputTokens: number;
  /** Prompt tokens served from the provider's cache (cheaper). */
  llmCacheReadTokens: number;
  /** Prompt tokens written to the provider's cache (slightly dearer, once). */
  llmCacheWriteTokens: number;
  /** Characters submitted to text-to-speech, fillers and greeting included. */
  ttsCharacters: number;
}

export interface TranscriptEntry {
  role: 'caller' | 'agent';
  text: string;
  ts: number;
}
