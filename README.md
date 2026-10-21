# @27colab/voice-engine

Turn-taking for real-time phone agents: know what the caller actually heard when they interrupt, and rewrite the model's history to match.

[![CI](https://github.com/27colab/voice-engine/actions/workflows/ci.yml/badge.svg)](https://github.com/27colab/voice-engine/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@27colab/voice-engine)](https://www.npmjs.com/package/@27colab/voice-engine)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![types: TypeScript](https://img.shields.io/badge/types-TypeScript-3178c6.svg)](https://www.typescriptlang.org/)

## Why

- **Sent is not heard.** Only Twilio `mark` echoes count as played, so a barge-in cuts the assistant turn at what the caller actually heard (`"…Monday morning, [interrupted]"`).
- **Backchannels don't interrupt.** "uh-huh" and "sí claro" are ignored; a real utterance stops the agent. The classifier is pluggable.
- **No dead air while tools run.** A filler ("one moment") plays the instant the model starts a tool call, through the same interruptible playback path, and never lands in the model's history.
- **Cheaper turns.** The Anthropic adapter caches the system prompt and the conversation so far, and every call ends with token, cache and TTS-character totals.
- **Testable offline.** Fake transport, STT, TTS (with real character alignment) and scripted chat; the 92 tests run with no keys and no network.

## Install

```bash
npm install @27colab/voice-engine
# only for the live provider adapters:
npm install ws @anthropic-ai/sdk
```

Node 20+, ESM, TypeScript types included.

## Quickstart

Runs offline against the fakes: a caller interrupts mid-answer and the model's next prompt shows only what was heard.

```ts
import { createCallSession } from '@27colab/voice-engine';
import { FakeChat, FakeStt, FakeTransport, FakeTts } from '@27colab/voice-engine/testing';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const [transport, stt, tts] = [new FakeTransport(), new FakeStt(), new FakeTts({ msPerChar: 60 })];
const chat = new FakeChat()
  .pushText('We have openings Monday morning, Tuesday afternoon, and Wednesday evening.')
  .pushText('No problem, what day works better?');

const session = createCallSession(
  { transport, sttFactory: stt, ttsFactory: tts, chat },
  { callId: 'demo', startedAt: new Date() },
  { onEnd: (record) => console.log('barge-ins:', record.stats.bargeIns) },
  { languages: ['en'], greeting: 'Hi, how can I help?', system: 'Be concise.',
    llm: { model: 'scripted', maxTokens: 200 }, stt: { model: 'fake' },
    voice: { provider: 'fake', voices: {}, defaultVoiceId: 'v', model: 'fake', outputFormat: 'ulaw_8000' } },
);
await session.start(); await sleep(20); transport.confirmAllMarks(); await sleep(20);

stt.last.emitEagerEndOfTurn('Any openings this week?'); await sleep(5);
stt.last.emitEndOfTurn('Any openings this week?'); await sleep(20);
transport.confirmPlayedMs(transport.totalQueuedMs - tts.last.totalMs + 2000); // caller heard ~2 s
stt.last.emitEndOfTurn('Actually, never mind, thanks'); await sleep(20);      // ...and interrupts
console.log(chat.seenMessages[1]);  // assistant turn is cut to what was heard + [interrupted]
await session.end('caller_hangup');
```

Output:

```
[{"role":"user","content":"Any openings this week?"},{"role":"assistant","content":"We have openings Monday morning, [interrupted]"},{"role":"user","content":"Actually, never mind, thanks"}]
barge-ins: 1
```

For a real call, swap the fakes for `TwilioMediaTransport` and the adapters from `@27colab/voice-engine/providers`; wiring is in [`examples/live-twilio.ts`](examples/live-twilio.ts).

## Bring your own keys

The engine itself needs none. The optional adapters call third-party services with your own accounts: **Deepgram** (Flux STT), **ElevenLabs** (TTS), **Anthropic** (chat) and **Twilio** (Media Streams). See [`.env.example`](.env.example). The adapters are not exercised in CI.

## API

| Export | Purpose |
|---|---|
| `createCallSession(deps, info, hooks, config)` | The session: greeting → listening → thinking → speaking, barge-in, speculative turns, tool fillers. `hooks.onEnd` receives a `CallRecord` (transcript, stats with `usage` totals, events); `hooks.onWarning` flags configs that fail silently. |
| `config.system` | A string, or `SystemBlock[]` whose `cacheBoundary` marks the cacheable prefix, or a function of `(lang, now)` returning either. |
| `config.fillers` | `{ [toolName]: "One moment." }` or per language `{ en, es }`. |
| `TwilioMediaTransport` | Twilio Media Streams over a structural socket type (no `ws` import in core). |
| `splitAtPlayedMs`, `computeSpokenText` | Map "N ms confirmed played" to the text the caller heard, using per-character TTS timings. |
| `rewriteOnBargeIn` | Rewrite chat history to the heard prefix plus `[interrupted]`. |
| `classifyUtterance`, `detectLang` | Backchannel vs interruption; small EN/ES heuristics. |
| `/providers` | `createDeepgramFluxFactory`, `createElevenLabsFactory`, `createAnthropicChat(key, { cacheSystem, cacheHistory })` (both on by default), `buildAnthropicRequest` (optional peer deps). |
| `/testing` | `FakeTransport`, `FakeStt`, `FakeTts`, `FakeChat`. |

Full reference: **[docs.27colab.com/packages/voice-engine](https://docs.27colab.com/packages/voice-engine/)**

## Limits

- `playedMs` is a lower bound: its resolution is the TTS chunk size, so the rewrite errs toward "heard less".
- ElevenLabs alignment handling is unverified against the live API; check it on your account.
- Single process, in-memory. The backchannel list and language detection are small heuristics.
- No latency or quality numbers: nothing here has been benchmarked, and the fakes answer instantly.
- Prompt caching only applies above each model's minimum prefix (512 to 4,096 tokens depending on the model). Below it nothing is cached and `usage.llmCacheReadTokens` stays 0; history caching usually crosses it from the second turn.
- Pre-1.0: pin the exact version; 0.x minors can change APIs (see [CHANGELOG.md](CHANGELOG.md)).

## Not for you if…

- You want a complete voice-agent platform. Vapi, Retell, LiveKit Agents and Pipecat already ship barge-in; this is a compact reference for the few mechanisms that are easy to get subtly wrong.
- You need multi-tenancy, persistence, metering, prompt assembly or telephony provisioning. None of that is included.
- You need benchmarked latency or a compliance guarantee.

## Develop

```bash
npm ci && npm test && npm run typecheck
npm run example   # offline loopback call
```

MIT, see [LICENSE](LICENSE). Not affiliated with Twilio, Deepgram, ElevenLabs or Anthropic.

---

Built by [Jesus Vasquez](https://github.com/vasquezjesus2710) · [27 Colab](https://27colab.com)
