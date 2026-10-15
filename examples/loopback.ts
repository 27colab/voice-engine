/**
 * Offline loopback: runs one scripted call against the fakes, no keys, no network.
 *
 *   npm run example
 *
 * Scenario: greeting -> caller asks (eager EOT, then confirmed) -> agent starts a
 * long answer -> caller interrupts after ~2 s of audio was confirmed played ->
 * the next model request shows the history rewritten to what was heard.
 */
import { createCallSession } from '../src/index.js';
import { FakeChat, FakeStt, FakeTransport, FakeTts } from '../src/testing/index.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const transport = new FakeTransport();
const stt = new FakeStt();
const tts = new FakeTts({ msPerChar: 60 });
const chat = new FakeChat()
  .pushText('We have openings Monday morning, Tuesday afternoon, and Wednesday evening if any of those work.')
  .pushText('No problem, what day works better for you?');

const session = createCallSession(
  { transport, sttFactory: stt, ttsFactory: tts, chat },
  { callId: 'demo-call', startedAt: new Date() },
  {
    onEnd: (record, reason) => {
      console.log(`\ncall ended (${reason}) after ${record.durationS}s`);
      const { turns, bargeIns, speculativeStarts } = record.stats;
      console.log('stats:', { turns, bargeIns, speculativeStarts });
      console.log('(latencies are ~0 here: the fakes answer instantly, so there is nothing to measure)');
    },
  },
  {
    languages: ['en'],
    greeting: 'Hi, thanks for calling Acme. How can I help?',
    system: 'You are a concise front-desk assistant.',
    llm: { model: 'scripted', maxTokens: 200 },
    voice: {
      provider: 'fake',
      voices: {},
      defaultVoiceId: 'any-voice-id',
      model: 'fake',
      outputFormat: 'ulaw_8000',
    },
    stt: { model: 'fake' },
  },
);

await session.start();
await sleep(20);
transport.confirmAllMarks(); // greeting fully played
await sleep(20);

console.log('caller (eager):  "Do you have any openings this week?"');
stt.last.emitEagerEndOfTurn('Do you have any openings this week?');
await sleep(5);
stt.last.emitEndOfTurn('Do you have any openings this week?');
await sleep(20);

const reply = tts.last;
const base = transport.totalQueuedMs - reply.totalMs;
console.log('agent starts speaking; caller hears ~2 s of it...');
transport.confirmPlayedMs(base + 2000);
await sleep(5);

console.log('caller interrupts: "Actually, never mind, thanks"');
stt.last.emitEndOfTurn('Actually, never mind, thanks');
await sleep(20);

const followup = JSON.parse(chat.seenMessages[1]!) as Array<{ role: string; content: unknown }>;
console.log('\nhistory sent to the model on the next turn:');
for (const m of followup) console.log(`  ${m.role.padEnd(9)} ${JSON.stringify(m.content)}`);

transport.confirmAllMarks();
await sleep(20);
await session.end('caller_hangup');
