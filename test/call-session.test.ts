import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createCallSession,
  type CallEndReason,
  type CallRecord,
  type CallSessionApi,
  type CallSessionConfig,
} from '../src/index.js';
import { FakeChat, FakeStt, FakeTransport, FakeTts, type FakeTransportOptions } from '../src/testing/index.js';

const GREETING = 'Thanks for calling Acme. This call is recorded and handled by an AI assistant.';

function baseConfig(over: Partial<CallSessionConfig> = {}): CallSessionConfig {
  return {
    languages: ['en'],
    greeting: GREETING,
    system: 'You are a friendly front-desk assistant for Acme.',
    llm: { model: 'test-model', maxTokens: 256 },
    tools: [{ name: 'lookup', description: 'Look something up', input_schema: { type: 'object' } }],
    executeTool: async (name) =>
      name === 'end_call' ? { content: 'ok', endCall: true } : { content: 'Found three matching openings.' },
    voice: {
      provider: 'fake',
      voices: { es: 'voice_es' },
      defaultVoiceId: 'voice_en',
      model: 'fake-model',
      outputFormat: 'ulaw_8000',
    },
    stt: { model: 'fake-stt' },
    ...over,
  };
}

interface Harness {
  session: CallSessionApi;
  transport: FakeTransport;
  stt: FakeStt;
  tts: FakeTts;
  chat: FakeChat;
  ended: Array<{ record: CallRecord; reason: CallEndReason }>;
  errors: unknown[];
}

function harness(
  opts: { transport?: FakeTransportOptions; config?: Partial<CallSessionConfig>; chat?: (c: FakeChat) => void } = {},
): Harness {
  const transport = new FakeTransport(opts.transport);
  const stt = new FakeStt();
  const tts = new FakeTts();
  const chat = new FakeChat();
  opts.chat?.(chat);
  const ended: Harness['ended'] = [];
  const errors: unknown[] = [];
  const session = createCallSession(
    { transport, sttFactory: stt, ttsFactory: tts, chat },
    { callId: 'call_1', startedAt: new Date('2026-01-01T12:00:00Z') },
    { onEnd: (record, reason) => ended.push({ record, reason }), onError: (e) => errors.push(e) },
    baseConfig(opts.config),
  );
  return { session, transport, stt, tts, chat, ended, errors };
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));
async function settle(n = 5) {
  for (let i = 0; i < n; i++) await tick();
}
async function waitFor(pred: () => boolean, tries = 300) {
  for (let i = 0; i < tries; i++) {
    if (pred()) return;
    await tick();
  }
  throw new Error('waitFor: condition not met');
}

/** Start the call and let the greeting finish playing. */
async function startAndFinishGreeting(h: Harness) {
  await h.session.start();
  await waitFor(() => h.tts.streams.length > 0 && h.transport.sentMarks.length > 0);
  h.transport.confirmAllMarks();
  await settle();
}

afterEach(() => vi.useRealTimers());

describe('greeting', () => {
  it('is synthesized on start with the configured text and default voice', async () => {
    const h = harness({ transport: { autoConfirmMarks: true } });
    await h.session.start();
    await waitFor(() => h.tts.streams.length > 0);
    expect(h.tts.submittedText()).toBe(GREETING);
    expect(h.tts.last.voice.voiceId).toBe('voice_en');
    expect(h.stt.streams).toHaveLength(1);
    await h.session.end('agent_end_call');
  });

  it('buffers caller audio that arrives before STT is open', async () => {
    const h = harness({ transport: { autoConfirmMarks: true } });
    const started = h.session.start();
    h.transport.emitMedia('frame-1');
    await started;
    h.transport.emitMedia('frame-2');
    expect(h.stt.last.sentAudio).toEqual(['frame-1', 'frame-2']);
    await h.session.end('agent_end_call');
  });
});

describe('mark-confirmed playback', () => {
  it('sends a mark per audio chunk and only moves on once the marks are echoed', async () => {
    const h = harness({ chat: (c) => c.pushText('Sure, we open at nine in the morning.') });
    await startAndFinishGreeting(h);

    h.stt.last.emitEndOfTurn('What time do you open?');
    await waitFor(() => h.tts.streams.length === 2);
    await waitFor(() => h.transport.sentMarks.length > 0 && h.tts.last.ended);

    // multiple chunks => multiple marks, none echoed yet
    const replyMarks = h.transport.sentMarks.filter((m) => m.name.startsWith('u2-'));
    expect(replyMarks.length).toBeGreaterThan(2);
    expect(h.ended).toHaveLength(0);

    // while unconfirmed, a second caller turn is not started (agent still "speaking")
    h.stt.last.emitEndOfTurn('Thanks');
    await settle();
    expect(h.chat.turnsRun).toBe(1);

    h.transport.confirmAllMarks();
    await settle();
    // now listening again: the next turn runs
    h.chat.pushText('You are welcome.');
    h.stt.last.emitEndOfTurn('Thank you so much for that');
    await waitFor(() => h.chat.turnsRun === 2);
    await h.session.end('agent_end_call');
  });

  it('falls back to a timeout when Twilio never echoes the mark', async () => {
    vi.useFakeTimers();
    const h = harness({ config: { turnTaking: { playbackPaddingMs: 500 } } });
    await h.session.start();
    await vi.advanceTimersByTimeAsync(1);
    const greetingMs = h.transport.totalQueuedMs;
    expect(greetingMs).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(greetingMs + 600);
    await h.session.end('agent_end_call');
    expect(h.ended[0]!.record.stats.playbackTimeouts).toBe(1);
  });
});

describe('barge-in', () => {
  const longReply = 'We have several openings this week including Monday morning and Wednesday evening.';

  it('rewrites history to the words actually confirmed as played, then clears the transport', async () => {
    const h = harness({ chat: (c) => c.pushText(longReply).pushText('No problem.') });
    await startAndFinishGreeting(h);

    h.stt.last.emitEndOfTurn('What openings do you have?');
    await waitFor(() => h.tts.streams.length === 2 && h.tts.last.ended);
    await waitFor(() => h.transport.sentMarks.some((m) => m.name.startsWith('u2-')));

    // The caller has heard 4 chunks of 8 chars @60ms = 1920ms of the reply.
    const base = h.transport.totalQueuedMs - h.tts.last.totalMs;
    h.transport.confirmPlayedMs(base + 1920);
    await settle();

    const replyStream = h.tts.last;
    const clears = h.transport.clearCount;
    h.stt.last.emitEndOfTurn('Actually never mind, thanks.');
    await waitFor(() => h.chat.turnsRun === 2);

    expect(replyStream.aborted).toBe(true);
    expect(h.transport.clearCount).toBe(clears + 1);

    // chars started before 1920ms: "We have several openings this we" -> snaps to "...this"
    const assistant = h.chat.requests[1]!.messages.find((m) => m.role === 'assistant')!;
    expect(assistant.content).toBe('We have several openings this [interrupted]');
    expect(JSON.stringify(h.chat.requests[1]!.messages)).not.toContain('Wednesday');
    await h.session.end('agent_end_call');
  });

  it('does not treat the mark echoes Twilio sends on clear as played audio', async () => {
    const h = harness({ chat: (c) => c.pushText(longReply).pushText('Okay.') });
    await startAndFinishGreeting(h);

    h.stt.last.emitEndOfTurn('Tell me about openings');
    await waitFor(() => h.tts.streams.length === 2 && h.tts.last.ended);
    await waitFor(() => h.transport.sentMarks.some((m) => m.name.startsWith('u2-')));

    // nothing confirmed at all; interrupt immediately
    h.stt.last.emitEndOfTurn('wait I need a different day please');
    await waitFor(() => h.chat.turnsRun === 2);
    await settle(); // Twilio-style mark echoes land after clear()

    const msgs = h.chat.requests[1]!.messages;
    expect(msgs.find((m) => m.role === 'assistant')!.content).toBe('[interrupted]');
    await h.session.end('agent_end_call');
  });

  it('triggers early on interim transcripts over the agent', async () => {
    const h = harness({ chat: (c) => c.pushText(longReply) });
    await startAndFinishGreeting(h);
    h.stt.last.emitEndOfTurn('Openings?');
    await waitFor(() => h.tts.streams.length === 2 && h.tts.last.ended);

    h.stt.last.emitUpdate('actually I would rather come in on');
    expect(h.tts.last.aborted).toBe(true);
    await h.session.end('agent_end_call');
  });

  it('can interrupt the greeting', async () => {
    const h = harness({ chat: (c) => c.pushText('Sure.') });
    await h.session.start();
    await waitFor(() => h.tts.streams.length > 0);
    h.stt.last.emitEndOfTurn('I need to book an appointment please');
    await waitFor(() => h.chat.turnsRun === 1);
    expect(h.tts.streams[0]!.aborted).toBe(true);
    await h.session.end('agent_end_call');
  });
});

describe('backchannel vs interruption', () => {
  it.each(['uh-huh', 'okay', 'sí claro', 'yeah yeah okay sure', 'no wait'])(
    'does not cut the agent off for "%s"',
    async (utterance) => {
      const h = harness({ chat: (c) => c.pushText('Our hours are nine to five, Monday through Friday.') });
      await startAndFinishGreeting(h);
      h.stt.last.emitEndOfTurn('When are you open?');
      await waitFor(() => h.tts.streams.length === 2 && h.tts.last.ended);

      const clears = h.transport.clearCount;
      h.stt.last.emitUpdate(utterance);
      h.stt.last.emitEagerEndOfTurn(utterance);
      h.stt.last.emitEndOfTurn(utterance);
      await settle();

      expect(h.tts.last.aborted).toBe(false);
      expect(h.transport.clearCount).toBe(clears);
      expect(h.chat.turnsRun).toBe(1);
      expect(h.ended).toHaveLength(0);
      await h.session.end('agent_end_call');
    },
  );

  it('records backchannels in the timeline', async () => {
    const h = harness({ chat: (c) => c.pushText('Our hours are nine to five, Monday through Friday.') });
    await startAndFinishGreeting(h);
    h.stt.last.emitEndOfTurn('When are you open?');
    await waitFor(() => h.tts.streams.length === 2 && h.tts.last.ended);
    h.stt.last.emitEndOfTurn('mm-hmm');
    await h.session.end('agent_end_call');
    expect(h.ended[0]!.record.stats.backchannels).toBe(1);
    expect(h.ended[0]!.record.stats.bargeIns).toBe(0);
  });

  it('a custom classifier can replace the default', async () => {
    const h = harness({
      config: { turnTaking: { classify: () => 'interruption' } },
      chat: (c) => c.pushText('Our hours are nine to five.').pushText('Okay.'),
    });
    await startAndFinishGreeting(h);
    h.stt.last.emitEndOfTurn('When are you open?');
    await waitFor(() => h.tts.streams.length === 2 && h.tts.last.ended);
    h.stt.last.emitEndOfTurn('uh-huh');
    await waitFor(() => h.chat.turnsRun === 2);
    await h.session.end('agent_end_call');
  });
});

describe('speculative turn start', () => {
  it('starts the model on EagerEndOfTurn and keeps that reply when the final transcript matches', async () => {
    const h = harness({ chat: (c) => c.pushText('We open at nine.') });
    await startAndFinishGreeting(h);

    h.stt.last.emitEagerEndOfTurn('What time do you open?');
    await waitFor(() => h.chat.turnsRun === 1);
    h.stt.last.emitEndOfTurn('What time do you open?');
    await waitFor(() => h.tts.streams.length === 2);
    await settle();

    expect(h.chat.turnsRun).toBe(1); // no second call for the confirmed turn
    expect(h.tts.last.aborted).toBe(false); // the confirming EOT did not "barge in" on the reply
    expect(h.tts.submittedText()).toContain('We open at nine.');
    h.transport.confirmAllMarks();
    await h.session.end('agent_end_call');
    expect(h.ended[0]!.record.stats.speculativeStarts).toBe(1);
    expect(h.ended[0]!.record.stats.speculativeCancels).toBe(0);
  });

  it('cancels on TurnResumed before audio and leaves no trace in history', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const h = harness({
      chat: (c) => c.push({ text: 'We open at nine.', gate }).pushText('Tomorrow we open at ten.'),
    });
    await startAndFinishGreeting(h);

    h.stt.last.emitEagerEndOfTurn('What time do you open');
    await waitFor(() => h.chat.turnsRun === 1);
    h.stt.last.emitTurnResumed();
    release();
    await settle();

    expect(h.chat.abortedTurns).toBe(1);
    expect(h.tts.streams).toHaveLength(1); // greeting only: stale reply never spoke

    h.stt.last.emitEndOfTurn('What time do you open tomorrow?');
    await waitFor(() => h.chat.turnsRun === 2);
    const second = JSON.parse(h.chat.seenMessages[1]!);
    expect(second).toEqual([{ role: 'user', content: 'What time do you open tomorrow?' }]);
    await waitFor(() => h.tts.submittedText().includes('Tomorrow we open at ten.'));
    expect(h.tts.submittedText()).not.toContain('We open at nine.');
    await h.session.end('agent_end_call');
    expect(h.ended[0]!.record.stats.speculativeCancels).toBe(1);
  });

  it('cancels a speculative reply that already started speaking, and clears the audio', async () => {
    const h = harness({ chat: (c) => c.pushText('We open at nine.').pushText('Sorry, go ahead.') });
    await startAndFinishGreeting(h);

    h.stt.last.emitEagerEndOfTurn('What time do you open');
    await waitFor(() => h.tts.streams.length === 2 && h.tts.last.ended);
    const clears = h.transport.clearCount;
    h.stt.last.emitTurnResumed();

    expect(h.tts.last.aborted).toBe(true);
    expect(h.transport.clearCount).toBe(clears + 1);
    await h.session.end('agent_end_call');
  });

  it('restarts when the final transcript differs from the eager guess', async () => {
    const h = harness({ chat: (c) => c.pushText('We open at nine.').pushText('Saturdays we open at ten.') });
    await startAndFinishGreeting(h);

    h.stt.last.emitEagerEndOfTurn('What time do you open');
    await waitFor(() => h.chat.turnsRun === 1);
    h.stt.last.emitEndOfTurn('What time do you open on Saturdays');
    await waitFor(() => h.chat.turnsRun === 2);

    const second = JSON.parse(h.chat.seenMessages[1]!);
    expect(second).toEqual([{ role: 'user', content: 'What time do you open on Saturdays' }]);
    await h.session.end('agent_end_call');
  });

  it('can be disabled', async () => {
    const h = harness({ config: { turnTaking: { speculative: false } }, chat: (c) => c.pushText('Nine.') });
    await startAndFinishGreeting(h);
    h.stt.last.emitEagerEndOfTurn('What time do you open?');
    await settle();
    expect(h.chat.turnsRun).toBe(0);
    h.stt.last.emitEndOfTurn('What time do you open?');
    await waitFor(() => h.chat.turnsRun === 1);
    await h.session.end('agent_end_call');
  });
});

describe('tools', () => {
  it('runs the tool, feeds the result back, and speaks the final reply', async () => {
    const h = harness({
      transport: { autoConfirmMarks: true },
      chat: (c) => c.pushToolCall('lookup', { q: 'openings' }).pushText('I found three openings for you.'),
    });
    await h.session.start();
    await waitFor(() => h.tts.streams.length > 0);
    await settle();

    h.stt.last.emitEndOfTurn('Do you have any openings?');
    await waitFor(() => h.chat.turnsRun === 2);
    await waitFor(() => h.tts.submittedText().includes('I found three openings'));
    const followup = JSON.stringify(h.chat.requests[1]!.messages);
    expect(followup).toContain('Found three matching openings.');
    expect(followup).toContain('tool_use_id');
    await h.session.end('agent_end_call');
  });

  it('barge-in during a tool preamble never leaves a tool_use without its tool_result', async () => {
    const h = harness({
      chat: (c) =>
        c
          .push({ text: 'Let me check the calendar for you right now.', toolCall: { name: 'lookup' } })
          .pushText('Of course.'),
    });
    await startAndFinishGreeting(h);

    h.stt.last.emitEndOfTurn('Any openings on Monday?');
    await waitFor(() => h.tts.streams.length === 2 && h.tts.last.ended);

    h.stt.last.emitEndOfTurn('actually forget it, thanks anyway');
    await waitFor(() => h.chat.turnsRun === 2);
    const msgs = JSON.stringify(h.chat.requests[1]!.messages);
    expect(msgs).not.toContain('tool_use');
    await h.session.end('agent_end_call');
  });

  it('end_call tool with a farewell speaks it, then hangs up with agent_end_call', async () => {
    const h = harness({
      transport: { autoConfirmMarks: true },
      chat: (c) => c.push({ text: 'Goodbye!', toolCall: { name: 'end_call' } }),
    });
    await h.session.start();
    await waitFor(() => h.tts.streams.length > 0);
    await settle();

    h.stt.last.emitEndOfTurn('That is all, thank you.');
    await waitFor(() => h.ended.length === 1);
    expect(h.ended[0]!.reason).toBe('agent_end_call');
    expect(h.ended[0]!.record.outcome).toBe('completed');
    expect(h.tts.submittedText()).toContain('Goodbye!');
    expect(h.transport.closed).toBe(true);
  });
});

describe('call end', () => {
  it('caller hangup fires onEnd once with a populated record', async () => {
    const h = harness({ transport: { autoConfirmMarks: true } });
    await h.session.start();
    await waitFor(() => h.tts.streams.length > 0);
    h.transport.emitStop();
    h.transport.emitStop();
    await h.session.end('agent_end_call');
    await settle();
    expect(h.ended).toHaveLength(1);
    const { record, reason } = h.ended[0]!;
    expect(reason).toBe('caller_hangup');
    expect(record.callId).toBe('call_1');
    expect(record.transcript[0]).toMatchObject({ role: 'agent', text: GREETING });
    expect(h.stt.last.closed).toBe(true);
  });

  it('ends with max_duration', async () => {
    vi.useFakeTimers();
    const h = harness({ config: { maxCallSeconds: 30 } });
    await h.session.start();
    await vi.advanceTimersByTimeAsync(31_000);
    expect(h.ended.map((e) => e.reason)).toEqual(['max_duration']);
  });

  it('ends with error when STT fails', async () => {
    const h = harness({ transport: { autoConfirmMarks: true } });
    await h.session.start();
    h.stt.last.emitError(new Error('socket died'));
    await waitFor(() => h.ended.length === 1);
    expect(h.ended[0]!.reason).toBe('error');
    expect(h.errors).toHaveLength(1);
  });

  it('a chat error keeps the line alive', async () => {
    const h = harness({ transport: { autoConfirmMarks: true } });
    await startAndFinishGreeting(h);
    h.chat.streamTurn = async () => {
      throw new Error('overloaded');
    };
    h.stt.last.emitEndOfTurn('Hello there, can you help me?');
    await waitFor(() => h.errors.length === 1);
    expect(h.ended).toHaveLength(0);
    await h.session.end('agent_end_call');
  });
});

describe('bilingual voice selection', () => {
  it('uses the Spanish voice id when the call starts in Spanish', async () => {
    const h = harness({
      transport: { autoConfirmMarks: true },
      config: { languages: ['es', 'en'], greeting: { es: 'Hola, gracias por llamar.', en: 'Hello.' } },
    });
    await h.session.start();
    await waitFor(() => h.tts.streams.length > 0);
    expect(h.tts.last.voice).toMatchObject({ voiceId: 'voice_es', languageCode: 'es' });
    expect(h.tts.submittedText()).toBe('Hola, gracias por llamar.');
    await h.session.end('agent_end_call');
  });

  it('follow-caller switches voice and system prompt language per turn', async () => {
    const systems: unknown[] = [];
    const h = harness({
      transport: { autoConfirmMarks: true },
      config: {
        languagePolicy: 'follow-caller',
        languages: ['en', 'es'],
        system: (lang) => `speak ${lang}`,
      },
      chat: (c) => c.pushText('Claro, con gusto.').pushText('Sure thing.'),
    });
    await h.session.start();
    await waitFor(() => h.tts.streams.length > 0);
    await settle();

    h.stt.last.emitEndOfTurn('Hola, necesito una cita para mañana');
    await waitFor(() => h.tts.streams.length === 2);
    expect(h.tts.last.voice.voiceId).toBe('voice_es');
    systems.push(h.chat.requests[0]!.system);
    await settle();

    h.stt.last.emitEndOfTurn('Actually, can you do it in English please');
    await waitFor(() => h.tts.streams.length === 3);
    expect(h.tts.last.voice.voiceId).toBe('voice_en');
    systems.push(h.chat.requests[1]!.system);
    expect(systems).toEqual(['speak es', 'speak en']);
    await h.session.end('agent_end_call');
  });
});
