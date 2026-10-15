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

export interface TranscriptEntry {
  role: 'caller' | 'agent';
  text: string;
  ts: number;
}
