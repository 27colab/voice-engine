import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { anthropicClientOptions, createAnthropicChat } from '../src/providers/anthropic-chat.js';

describe('createAnthropicChat client options', () => {
  it('passes timeoutMs and maxRetries to the SDK client', () => {
    const o = anthropicClientOptions('sk-test', { timeoutMs: 15_000, maxRetries: 1 });
    expect(o).toEqual({ apiKey: 'sk-test', timeout: 15_000, maxRetries: 1 });
    const client = new Anthropic(o);
    expect(client.timeout).toBe(15_000);
    expect(client.maxRetries).toBe(1);
  });

  it('keeps the SDK defaults when not set (non-breaking)', () => {
    expect(anthropicClientOptions('sk-test')).toEqual({ apiKey: 'sk-test' });
    expect(anthropicClientOptions('sk-test', { cacheSystem: false, maxRetries: 0 })).toEqual({ apiKey: 'sk-test', maxRetries: 0 });
  });

  it('still builds a chat engine with the new options', () => {
    const chat = createAnthropicChat('sk-test', { timeoutMs: 15_000, maxRetries: 1 });
    expect(typeof chat.streamTurn).toBe('function');
  });
});
