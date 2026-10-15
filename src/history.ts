import type { ChatMessage } from './types.js';

export const INTERRUPTED_MARKER = '[interrupted]';

export interface RewriteOptions {
  /**
   * Is the interrupted assistant turn already the last assistant message in
   * `history`? If not (e.g. it was a preamble before a tool call that never
   * ran), the heard text is appended as a new assistant message instead.
   */
  inHistory: boolean;
  marker?: string;
}

/**
 * Rewrite history after a barge-in so the model sees what the caller actually
 * heard, not what it intended to say. Mutates `history`.
 */
export function rewriteOnBargeIn(history: ChatMessage[], heardText: string, opts: RewriteOptions): void {
  const marker = opts.marker ?? INTERRUPTED_MARKER;
  const heard = heardText.trim();
  const content = heard ? `${heard} ${marker}` : marker;

  if (opts.inHistory) {
    for (let i = history.length - 1; i >= 0; i--) {
      const msg = history[i];
      if (msg?.role === 'assistant' && typeof msg.content === 'string') {
        msg.content = content;
        return;
      }
    }
  }
  if (heard) history.push({ role: 'assistant', content });
}
