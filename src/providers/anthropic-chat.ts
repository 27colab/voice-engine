import Anthropic from '@anthropic-ai/sdk';
import type { ChatEngine, ChatTurnRequest, ChatTurnResult } from '../interfaces.js';

/** Anthropic Messages streaming adapter. Pass any model id the API accepts. */
export function createAnthropicChat(apiKey: string): ChatEngine {
  const client = new Anthropic({ apiKey });

  return {
    async streamTurn(req: ChatTurnRequest): Promise<ChatTurnResult> {
      const stream = client.messages.stream(
        {
          model: req.model,
          max_tokens: req.maxTokens,
          system: req.system,
          messages: req.messages as Anthropic.MessageParam[],
          ...(req.tools.length > 0
            ? {
                tools: req.tools.map((t) => ({
                  name: t.name,
                  description: t.description,
                  input_schema: t.input_schema as Anthropic.Tool.InputSchema,
                })),
              }
            : {}),
        },
        { signal: req.signal },
      );

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
        usage: { inputTokens: final.usage.input_tokens ?? 0, outputTokens: final.usage.output_tokens ?? 0 },
      };
    },
  };
}
