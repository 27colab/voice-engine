import { describe, expect, it } from 'vitest';
import {
  createCallSession,
  type CallEndReason,
  type CallRecord,
  type CallSessionConfig,
} from '../src/index.js';
import { buildAnthropicRequest } from '../src/providers/anthropic-chat.js';
import { FakeChat, FakeStt, FakeTransport, FakeTts } from '../src/testing/index.js';

const tick = () => new Promise<void>((r) => setTimeout(r, 0));
async function settle(n = 8) {
  for (let i = 0; i < n; i++) await tick();
}
async function waitFor(pred: () => boolean, tries = 400) {
  for (let i = 0; i < tries; i++) {
    if (pred()) return;
    await tick();
  }
  throw new Error('waitFor: condition not met');
}

const lookup = { name: 'lookup', description: 'Look up openings', input_schema: { type: 'object' } };

function config(over: Partial<CallSessionConfig> = {}): CallSessionConfig {
  return {
    languages: ['en'],
    greeting: 'Recorded AI call. Hi!',
    system: 'Be brief.',
    llm: { model: 'test', maxTokens: 200 },
    tools: [lookup],
    executeTool: async () => ({ content: 'Tuesday at 2.' }),
    voice: { provider: 'fake', voices: {}, defaultVoiceId: 'v', model: 'fake', outputFormat: 'ulaw_8000' },
    stt: { model: 'fake-stt' },
    ...over,
  };
}

function harness(cfg: Partial<CallSessionConfig> = {}, script?: (c: FakeChat) => void, autoConfirmMarks = true) {
  const transport = new FakeTransport({ autoConfirmMarks });
  const stt = new FakeStt();
  const tts = new FakeTts();
  const chat = new FakeChat();
  script?.(chat);
  const ended: Array<{ record: CallRecord; reason: CallEndReason }> = [];
  const warnings: string[] = [];
  const session = createCallSession(
    { transport, sttFactory: stt, ttsFactory: tts, chat },
    { callId: 'c1', startedAt: new Date() },
    { onEnd: (record, reason) => ended.push({ record, reason }), onWarning: (m) => warnings.push(m) },
    config(cfg),
  );
  return { session, transport, stt, tts, chat, ended, warnings };
}

async function started(h: ReturnType<typeof harness>) {
  await h.session.start();
  await waitFor(() => h.tts.streams.length > 0);
  await settle();
}

// ---------------------------------------------------------------------------

describe('buildAnthropicRequest: prompt caching', () => {
  const base = { model: 'm', maxTokens: 100, tools: [lookup] };

  it('caches a string system prompt whole, and the end of the history', () => {
    const r = buildAnthropicRequest({ ...base, system: 'You are Andii.', messages: [{ role: 'user', content: 'hi' }] });
    expect(r.system).toEqual([{ type: 'text', text: 'You are Andii.', cache_control: { type: 'ephemeral' } }]);
    expect(r.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral' } }] }]);
  });

  it('marks only the blocks flagged cacheBoundary, so volatile facts after it stay uncached', () => {
    const r = buildAnthropicRequest({
      ...base,
      system: [{ text: 'stable rules' }, { text: 'persona', cacheBoundary: true }, { text: 'It is 3pm.' }],
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(r.system).toEqual([
      { type: 'text', text: 'stable rules' },
      { type: 'text', text: 'persona', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'It is 3pm.' },
    ]);
  });

  it('marks the last block when blocks carry no boundary, and drops empty blocks', () => {
    const r = buildAnthropicRequest({ ...base, system: [{ text: 'a' }, { text: '  ' }, { text: 'b' }], messages: [] });
    expect(r.system).toEqual([{ type: 'text', text: 'a' }, { type: 'text', text: 'b', cache_control: { type: 'ephemeral' } }]);
    expect(buildAnthropicRequest({ ...base, system: '', messages: [] }).system).toBeUndefined();
  });

  it('puts the history breakpoint on a trailing tool_result block without mutating the caller history', () => {
    const history = [
      { role: 'user' as const, content: 'book me' },
      { role: 'assistant' as const, content: [{ type: 'tool_use', id: 't1', name: 'lookup', input: {} }] },
      { role: 'user' as const, content: [{ type: 'tool_result', tool_use_id: 't1', content: 'Tuesday' }] },
    ];
    const snapshot = JSON.stringify(history);
    const r = buildAnthropicRequest({ ...base, system: 's', messages: history });
    const last = r.messages[2]!.content as unknown as Array<Record<string, unknown>>;
    expect(last[0]).toMatchObject({ type: 'tool_result', cache_control: { type: 'ephemeral' } });
    expect(JSON.stringify(history)).toBe(snapshot);
  });

  it('never exceeds four breakpoints, and both caches can be turned off', () => {
    const many = Array.from({ length: 6 }, (_, i) => ({ text: `b${i}`, cacheBoundary: true }));
    const r = buildAnthropicRequest({ ...base, system: many, messages: [{ role: 'user', content: 'hi' }] });
    const count =
      (r.system as Array<{ cache_control?: unknown }>).filter((b) => b.cache_control).length +
      JSON.stringify(r.messages).split('cache_control').length - 1;
    expect(count).toBeLessThanOrEqual(4);

    const off = buildAnthropicRequest({ ...base, system: 's', messages: [{ role: 'user', content: 'hi' }] }, { cacheSystem: false, cacheHistory: false });
    expect(JSON.stringify(off)).not.toContain('cache_control');
  });
});

describe('system prompt blocks reach the chat engine', () => {
  it('a function returning blocks is called per turn with the language and passed through as-is', async () => {
    const h = harness({ system: (lang) => [{ text: `rules ${lang}`, cacheBoundary: true }, { text: 'now' }] }, (c) => c.pushText('Hi there.'));
    await started(h);
    h.stt.last.emitEndOfTurn('What time do you open today?');
    await waitFor(() => h.chat.requests.length === 1);
    expect(h.chat.requests[0]!.system).toEqual([{ text: 'rules en', cacheBoundary: true }, { text: 'now' }]);
    await h.session.end('caller_hangup');
  });
});

describe('fillers', () => {
  it('speaks the tool filler while the tool runs, then the reply; the filler stays out of history', async () => {
    const h = harness({ fillers: { lookup: { en: 'One moment.', es: 'Un momento.' } } }, (c) =>
      c.pushToolCall('lookup', {}).pushText('Tuesday at two works.'),
    );
    await started(h);
    h.stt.last.emitEndOfTurn('Do you have anything this week?');
    await waitFor(() => h.tts.submittedText().includes('Tuesday at two works.'));
    await settle();
    const spoken = h.tts.streams.map((s) => s.spoken.join(''));
    expect(spoken.slice(1)).toEqual(['One moment.', 'Tuesday at two works.']);
    expect(h.chat.seenMessages[1]).not.toContain('One moment');
    await h.session.end('caller_hangup');
    const rec = h.ended[0]!.record;
    expect(rec.stats.fillers).toBe(1);
    expect(rec.transcript.map((t) => t.text)).toContain('One moment.');
  });

  it('is skipped when the model wrote its own preamble with the tool call', async () => {
    const h = harness({ fillers: { lookup: 'One moment.' } }, (c) =>
      c.pushToolCall('lookup', {}, 'Let me check the calendar.').pushText('Tuesday works.'),
    );
    await started(h);
    h.stt.last.emitEndOfTurn('Anything open this week for me?');
    await waitFor(() => h.tts.submittedText().includes('Tuesday works.'));
    expect(h.tts.submittedText()).not.toContain('One moment.');
    await h.session.end('caller_hangup');
  });

  it('can be interrupted like any utterance, without writing the filler into history', async () => {
    let releaseTool!: () => void;
    const toolGate = new Promise<void>((r) => (releaseTool = r));
    const h = harness(
      {
        fillers: { lookup: 'One moment while I check the whole calendar for you.' },
        executeTool: async () => {
          await toolGate;
          return { content: 'Tuesday.' };
        },
      },
      (c) => c.pushToolCall('lookup', {}).pushText('Tuesday.').pushText('Sure, what else?'),
      false,
    );
    await h.session.start();
    await waitFor(() => h.transport.sentMarks.length > 0);
    h.transport.confirmAllMarks();
    await settle();
    h.stt.last.emitEndOfTurn('Do you have anything this week?');
    await waitFor(() => h.tts.submittedText().includes('One moment'));
    await settle();
    h.transport.confirmPlayedMs(h.transport.totalQueuedMs - h.tts.last.totalMs + 500);
    h.stt.last.emitEndOfTurn('Actually wait, I have another question first');
    releaseTool();
    await waitFor(() => h.chat.turnsRun === 2);
    expect(h.chat.seenMessages[1]).not.toContain('One moment');
    expect(h.chat.seenMessages[1]).toContain('Actually wait');
    await h.session.end('caller_hangup');
  });
});

describe('usage totals', () => {
  it('sums model tokens (cache reads and writes included) and TTS characters into stats.usage', async () => {
    const h = harness({}, (c) =>
      c.push({ text: 'We open at nine.', usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 80, cacheWriteTokens: 5 } }),
    );
    await started(h);
    h.stt.last.emitEndOfTurn('What time do you open in the morning?');
    await waitFor(() => h.tts.submittedText().includes('We open at nine.'));
    await settle();
    await h.session.end('caller_hangup');
    expect(h.ended[0]!.record.stats.usage).toEqual({
      llmInputTokens: 100,
      llmOutputTokens: 10,
      llmCacheReadTokens: 80,
      llmCacheWriteTokens: 5,
      ttsCharacters: 'Recorded AI call. Hi!'.length + 'We open at nine.'.length,
    });
  });
});

describe('configuration warnings', () => {
  it('warns when a bilingual line uses an English-only Flux model', async () => {
    const h = harness({ languages: ['en', 'es'], stt: { model: 'flux-general-en' } });
    await started(h);
    expect(h.warnings).toHaveLength(1);
    expect(h.warnings[0]).toContain('flux-general-multi');
    await h.session.end('caller_hangup');
  });

  it('stays quiet for the multilingual model or a single language', async () => {
    const a = harness({ languages: ['en', 'es'], stt: { model: 'flux-general-multi' } });
    const b = harness({ languages: ['en'], stt: { model: 'flux-general-en' } });
    await started(a);
    await started(b);
    expect([...a.warnings, ...b.warnings]).toEqual([]);
    await a.session.end('caller_hangup');
    await b.session.end('caller_hangup');
  });
});
