import Anthropic from '@anthropic-ai/sdk';
import type { ChatEngine, ChatTurnRequest, ChatTurnResult } from '../interfaces.js';
import type { ChatMessage, SystemPrompt } from '../types.js';

export interface AnthropicChatOptions {
  /**
   * Cache the system prompt (and the tool definitions in front of it). A
   * string prompt is cached whole; block prompts are cached up to each block
   * marked `cacheBoundary` (or to the last block if none is marked). Default true.
   */
  cacheSystem?: boolean;
  /**
   * Also cache the conversation so far, so each turn re-reads earlier turns
   * from the cache. A phone call resends the whole history every turn, so
   * this is usually the larger saving. Default true.
   */
  cacheHistory?: boolean;
}

/** The API allows at most this many cache breakpoints per request. */
const MAX_BREAKPOINTS = 4;
const EPHEMERAL = { type: 'ephemeral' } as const;

/** Content block types that accept `cache_control` when they end the history. */
const CACHEABLE_TAIL = new Set(['text', 'tool_result', 'tool_use', 'image', 'document']);

function systemParam(system: SystemPrompt, cache: boolean): { blocks: Anthropic.TextBlockParam[] | undefined; breakpoints: number } {
  const blocks: Array<{ text: string; cacheBoundary?: boolean }> =
    typeof system === 'string' ? [{ text: system, cacheBoundary: true }] : system;
  const nonEmpty = blocks.filter((b) => b.text.trim().length > 0);
  if (nonEmpty.length === 0) return { blocks: undefined, breakpoints: 0 };
  const anyMarked = nonEmpty.some((b) => b.cacheBoundary);
  let breakpoints = 0;
  const out = nonEmpty.map((b, i): Anthropic.TextBlockParam => {
    const mark = cache && breakpoints < MAX_BREAKPOINTS - 1 && (anyMarked ? b.cacheBoundary : i === nonEmpty.length - 1);
    if (!mark) return { type: 'text', text: b.text };
    breakpoints++;
    return { type: 'text', text: b.text, cache_control: EPHEMERAL };
  });
  return { blocks: out, breakpoints };
}

/** Copy of `messages` with a cache breakpoint on the last block. Never mutates the input. */
function withHistoryBreakpoint(messages: ChatMessage[]): ChatMessage[] {
  const last = messages[messages.length - 1];
  if (!last) return messages;
  let content: unknown;
  if (typeof last.content === 'string') {
    if (!last.content.trim()) return messages;
    content = [{ type: 'text', text: last.content, cache_control: EPHEMERAL }];
  } else if (Array.isArray(last.content) && last.content.length > 0) {
    const tail = last.content[last.content.length - 1] as { type?: string } | undefined;
    if (!tail || !CACHEABLE_TAIL.has(String(tail.type))) return messages;
    content = [...last.content.slice(0, -1), { ...tail, cache_control: EPHEMERAL }];
  } else {
    return messages;
  }
  return [...messages.slice(0, -1), { role: last.role, content }];
}

/**
 * The Messages API request this adapter sends for one turn, without the
 * network call. Exported so callers (and tests) can see exactly what goes out.
 */
export function buildAnthropicRequest(
  req: Pick<ChatTurnRequest, 'model' | 'maxTokens' | 'system' | 'messages' | 'tools'>,
  opts: AnthropicChatOptions = {},
): Anthropic.MessageCreateParamsNonStreaming {
  const sys = systemParam(req.system, opts.cacheSystem !== false);
  const messages =
    opts.cacheHistory !== false && sys.breakpoints < MAX_BREAKPOINTS ? withHistoryBreakpoint(req.messages) : req.messages;
  return {
    model: req.model,
    max_tokens: req.maxTokens,
    ...(sys.blocks ? { system: sys.blocks } : {}),
    messages: messages as Anthropic.MessageParam[],
    ...(req.tools.length > 0
      ? {
          tools: req.tools.map((t) => ({
            name: t.name,
            description: t.description,
            input_schema: t.input_schema as Anthropic.Tool.InputSchema,
          })),
        }
      : {}),
  };
}

/**
 * Anthropic Messages streaming adapter, with prompt caching on by default
 * (system prompt + conversation history). Pass any model id the API accepts.
 * Note: each model has a minimum cacheable prefix (from 512 to 4096 tokens);
 * shorter prompts are simply not cached, which `usage.cacheReadTokens` shows.
 */
export function createAnthropicChat(apiKey: string, opts: AnthropicChatOptions = {}): ChatEngine {
  const client = new Anthropic({ apiKey });

  return {
    async streamTurn(req: ChatTurnRequest): Promise<ChatTurnResult> {
      const stream = client.messages.stream(buildAnthropicRequest(req, opts), { signal: req.signal });

      stream.on('contentBlock', (block) => {
        if (block.type === 'tool_use') req.onToolUseStart?.(block.name);
      });
      if (req.onTextDelta) stream.on('text', (delta) => req.onTextDelta!(delta));

      const final = await stream.finalMessage();

      let text = '';
      const toolCalls: ChatTurnResult['toolCalls'] = [];
      for (const block of final.content) {
        if (block.type === 'text') text += block.text;
        else if (block.type === 'tool_use') toolCalls.push({ id: block.id, name: block.name, input: block.input });
      }

      return {
        text,
        toolCalls,
        assistantContent: final.content,
        stopReason: final.stop_reason ?? 'end_turn',
        usage: {
          inputTokens: final.usage.input_tokens ?? 0,
          outputTokens: final.usage.output_tokens ?? 0,
          cacheReadTokens: final.usage.cache_read_input_tokens ?? 0,
          cacheWriteTokens: final.usage.cache_creation_input_tokens ?? 0,
        },
      };
    },
  };
}
