import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  createCallSession,
  type CallEndReason,
  type CallRecord,
  type CallSessionConfig,
  type SttConfig,
  type SttEventHandlers,
  type SttFactory,
} from '../src/index.js';
import { buildFluxConfigure, createDeepgramFluxFactory, fluxListenParams } from '../src/providers/index.js';
import { FakeChat, FakeStt, FakeTransport, FakeTts } from '../src/testing/index.js';

const tick = () => new Promise<void>((r) => setTimeout(r, 0));
async function waitFor(pred: () => boolean, tries = 300) {
  for (let i = 0; i < tries; i++) {
    if (pred()) return;
    await tick();
  }
  throw new Error('waitFor: condition not met');
}

async function settle(n = 10) {
  for (let i = 0; i < n; i++) await tick();
}

/** Start the call and let the greeting play out (marks auto-confirm). */
async function startCall(h: { session: { start(): Promise<void> }; tts: FakeTts }) {
  await h.session.start();
  await waitFor(() => h.tts.streams.length > 0);
  await settle();
}

/** One caller turn, waiting until the agent's reply has played out. */
async function callerSays(h: { stt: FakeStt; tts: FakeTts }, text: string) {
  const before = h.tts.streams.length;
  h.stt.last.emitEndOfTurn(text);
  await waitFor(() => h.tts.streams.length > before);
  await settle();
}

function config(over: Partial<CallSessionConfig> = {}): CallSessionConfig {
  return {
    languages: ['en', 'es'],
    languagePolicy: 'follow-caller',
    greeting: 'Hi, how can I help?',
    system: 'Be concise.',
    llm: { model: 'scripted', maxTokens: 100 },
    voice: { provider: 'fake', voices: { es: 'voice_es' }, defaultVoiceId: 'voice_en', model: 'm', outputFormat: 'ulaw_8000' },
    stt: { model: 'flux-general-multi' },
    ...over,
  };
}

function harness(over: Partial<CallSessionConfig> = {}, sttFactory?: SttFactory) {
  const stt = new FakeStt();
  const tts = new FakeTts();
  const chat = new FakeChat();
  for (let i = 0; i < 5; i++) chat.pushText('Okay.');
  const warnings: string[] = [];
  const ended: Array<{ record: CallRecord; reason: CallEndReason }> = [];
  const session = createCallSession(
    { transport: new FakeTransport({ autoConfirmMarks: true }), sttFactory: sttFactory ?? stt, ttsFactory: tts, chat },
    { callId: 'c1', startedAt: new Date('2026-10-28T12:00:00Z') },
    { onEnd: (record, reason) => ended.push({ record, reason }), onWarning: (m) => warnings.push(m) },
    config(over),
  );
  return { session, stt, tts, chat, warnings, ended };
}

describe('language hint follows the caller', () => {
  it('opens with the starting language and updates the hint only when the language changes', async () => {
    const h = harness({ stt: { model: 'flux-general-multi', numerals: false } });
    await startCall(h);
    expect(h.stt.last.config).toMatchObject({ languageHint: 'en', numerals: false });

    await callerSays(h, 'Hello, do you have time on Friday?');
    expect(h.stt.last.configures).toEqual([]);

    await callerSays(h, 'Hola, necesito una cita para mañana');
    expect(h.stt.last.configures).toEqual([{ languageHint: 'es' }]);

    await callerSays(h, '¿Y el sábado por la tarde también?');
    expect(h.stt.last.configures).toEqual([{ languageHint: 'es' }]);

    await h.session.end('caller_hangup');
    const events = h.ended[0]!.record.events.filter((e) => e.name === 'stt_configure');
    expect(events.map((e) => e.data)).toEqual([{ languageHint: 'es' }]);
  });

  it('can be turned off, and never runs under the fixed policy', async () => {
    const off = harness({ stt: { model: 'flux-general-multi', followLanguage: false } });
    await startCall(off);
    await callerSays(off, 'Hola, necesito una cita para mañana');
    expect(off.stt.last.configures).toEqual([]);

    const fixed = harness({ languagePolicy: 'fixed' });
    await startCall(fixed);
    await callerSays(fixed, 'Hola, necesito una cita para mañana');
    expect(fixed.stt.last.configures).toEqual([]);
  });
});

describe('session.configureStt', () => {
  it('passes updates to the stream', async () => {
    const h = harness();
    await h.session.start();
    expect(h.session.configureStt({ numerals: true })).toBe(true);
    expect(h.session.configureStt({ numerals: false, keyterms: ['Andii'] })).toBe(true);
    expect(h.stt.last.configures).toEqual([{ numerals: true }, { numerals: false, keyterms: ['Andii'] }]);
  });

  it('queues updates requested before STT opens and sends them merged', async () => {
    const h = harness();
    expect(h.session.configureStt({ numerals: true })).toBe(true);
    expect(h.session.configureStt({ keyterms: ['Andii'] })).toBe(true);
    await h.session.start();
    expect(h.stt.last.configures).toEqual([{ numerals: true, keyterms: ['Andii'] }]);
  });

  it('returns false when the provider has no live updates, and after the call ends', async () => {
    const plain: SttFactory = {
      async create(_c: SttConfig, _h: SttEventHandlers) {
        return { sendAudio() {}, async close() {} };
      },
    };
    const h = harness({}, plain);
    await h.session.start();
    expect(h.session.configureStt({ numerals: true })).toBe(false);
    await h.session.end('caller_hangup');
    expect(h.session.configureStt({ numerals: true })).toBe(false);
  });

  it('reports a rejected update as a warning and keeps the call up', async () => {
    const h = harness();
    await startCall(h);
    h.stt.last.emitWarning('Deepgram Flux rejected a Configure update: X bad');
    expect(h.warnings).toContain('Deepgram Flux rejected a Configure update: X bad');
    expect(h.ended).toHaveLength(0);
    await callerSays(h, 'Still there?');
    expect(h.chat.requests).toHaveLength(1);
  });
});

describe('Flux request building', () => {
  it('opens with numerals and a language hint only on the multilingual model', () => {
    const base = { keyterms: ['Andii'], replacements: [], languageHint: 'es' as const };
    const multi = fluxListenParams({ ...base, model: 'flux-general-multi', numerals: true });
    expect(multi.get('numerals')).toBe('true');
    expect(multi.get('language_hint')).toBe('es');
    expect(multi.getAll('keyterm')).toEqual(['Andii']);
    const en = fluxListenParams({ ...base, model: 'flux-general-en' });
    expect(en.has('language_hint')).toBe(false);
    expect(en.has('numerals')).toBe(false);
  });

  it('builds Configure messages and skips empty ones', () => {
    expect(buildFluxConfigure('flux-general-multi', { languageHint: 'es' })).toEqual({ type: 'Configure', language_hints: ['es'] });
    expect(buildFluxConfigure('flux-general-en', { languageHint: 'es' })).toBeNull();
    expect(buildFluxConfigure('flux-general-en', { languageHint: 'es', numerals: true })).toEqual({ type: 'Configure', numerals: true });
    expect(buildFluxConfigure('flux-general-multi', { keyterms: [] })).toEqual({ type: 'Configure', keyterms: [] });
    const many = Array.from({ length: 120 }, (_, i) => `t${i}`);
    expect((buildFluxConfigure('flux-general-multi', { keyterms: many })!.keyterms as string[]).length).toBe(100);
    expect(buildFluxConfigure('flux-general-multi', {})).toBeNull();
  });
});

describe('Flux adapter against a local WebSocket server', () => {
  let server: WebSocketServer | undefined;
  afterEach(async () => {
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    server = undefined;
  });

  it('sends Configure, warns on ConfigureFailure without failing, keeps delivering turns', async () => {
    server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await once(server, 'listening');
    const port = (server.address() as AddressInfo).port;
    const received: unknown[] = [];
    let urlSeen = '';
    let auth = '';
    let peer: WebSocket | undefined;
    server.on('connection', (ws, req) => {
      peer = ws;
      urlSeen = req.url ?? '';
      auth = String(req.headers.authorization);
      ws.on('message', (data, isBinary) => {
        if (!isBinary) received.push(JSON.parse(data.toString()));
      });
    });

    const warnings: string[] = [];
    const errors: Error[] = [];
    const turns: string[] = [];
    const factory = createDeepgramFluxFactory('dg_test', { url: `ws://127.0.0.1:${port}/v2/listen` });
    const stream = await factory.create(
      { model: 'flux-general-multi', keyterms: [], replacements: [], languageHint: 'en', numerals: true },
      { onEndOfTurn: (t) => turns.push(t), onWarning: (m) => warnings.push(m), onError: (e) => errors.push(e) },
    );
    await waitFor(() => peer !== undefined);
    expect(urlSeen).toContain('language_hint=en');
    expect(urlSeen).toContain('numerals=true');
    expect(auth).toBe('Token dg_test');

    stream.configure!({ languageHint: 'es' });
    stream.configure!({ languageHint: 'es', numerals: false });
    await waitFor(() => received.length === 2);
    expect(received).toEqual([
      { type: 'Configure', language_hints: ['es'] },
      { type: 'Configure', language_hints: ['es'], numerals: false },
    ]);

    peer!.send(JSON.stringify({ type: 'ConfigureFailure', code: 'UNPARSABLE_CLIENT_MESSAGE', description: 'bad value' }));
    peer!.send(JSON.stringify({ type: 'ConfigureSuccess', numerals: false }));
    peer!.send(JSON.stringify({ type: 'TurnInfo', event: 'EndOfTurn', transcript: 'necesito una cita', end_of_turn_confidence: 0.9 }));
    await waitFor(() => turns.length === 1);
    expect(turns).toEqual(['necesito una cita']);
    expect(warnings).toEqual(['Deepgram Flux rejected a Configure update: UNPARSABLE_CLIENT_MESSAGE bad value']);
    expect(errors).toEqual([]);

    await stream.close();
    await waitFor(() => received.length === 3);
    expect(received[2]).toEqual({ type: 'CloseStream' });
  });
});
