# voice-engine

A small, tested TypeScript reference for the turn-taking part of a real-time phone agent: knowing **what the caller actually heard** when they interrupt, and not talking over them.

> **Positioning.** This is not a new idea or a framework. Vapi, Retell, LiveKit Agents and Pipecat already ship barge-in. This is a compact, dependency-light, fully fake-able implementation of the handful of mechanisms that are easy to get subtly wrong, with tests that pin their behaviour. Read it, borrow from it, or use it as a starting point. There are no latency or quality claims here: nothing in this repo has been benchmarked, and the offline fakes answer instantly.

Working name `voice-engine` (npm `@27colab/voice-engine`). If you want it narrower, `voice-turns` would describe it better.

## What it does

| Mechanism | Where | The problem it solves |
|---|---|---|
| **Mark-confirmed playback** | [`playback.ts`](src/playback.ts) | Sending audio is not playing audio. Every chunk is followed by a Twilio `mark`; only echoed marks count as heard. Marks Twilio echoes in response to `clear` are ignored. |
| **Unspoken-text from TTS alignment** | [`alignment.ts`](src/alignment.ts) | Maps "confirmed N ms played" to a text prefix using per-character timings. Works across multi-chunk alignment, Spanish accents, NFC/NFD, emoji, and snaps to word boundaries. |
| **History rewrite on barge-in** | [`history.ts`](src/history.ts) | The model's next prompt shows `"We have openings Monday [interrupted]"`, not the full sentence it never finished saying. |
| **Backchannel vs interruption** | [`turn-policy.ts`](src/turn-policy.ts) | "uh-huh", "sí claro" don't cut the agent off; a real utterance does. Pluggable classifier. |
| **Speculative turn start** | [`call-session.ts`](src/call-session.ts) | Start the LLM on Flux `EagerEndOfTurn`; cancel on `TurnResumed` (restoring history), keep the reply if the final transcript matches, restart if it differs. |
| **Latency timeline** | [`timeline.ts`](src/timeline.ts) | Per-call events and per-turn TTFT / time-to-first-audio / EOT-to-audio with p50/p90. |
| **Twilio Media Streams transport** | [`twilio.ts`](src/twilio.ts) | `start`/`media`/`mark`/`stop` in, `media`/`mark`/`clear` out. Structural socket type, no `ws` import in core. |
| **Provider adapters** | [`providers/`](src/providers) | Deepgram Flux (STT), ElevenLabs (TTS, any voice id, per-language voice selection), Anthropic Messages (chat). Optional peer deps. |
| **Fakes** | [`testing/`](src/testing) | In-memory transport, STT, TTS (with real alignment), and scripted chat. |

## Architecture

```
        Twilio <Connect><Stream>  (wss, mulaw 8 kHz, base64)
                    │  media / mark / stop           ▲  media / mark / clear
                    ▼                                │
            ┌──────────────────  MediaTransport  ─────────────────┐
            │                                                     │
   caller audio ──► SttStream (Flux)                  PlaybackTracker (1 per utterance)
                      │ Update / EagerEOT / TurnResumed / EOT       ▲  chunk ─► mark "u3-7"
                      ▼                                              │  echo  ─► playedMs
              ┌────────────────────── CallSession ──────────────────────┐
              │  state: greeting → listening → thinking → speaking      │
              │  generation id: stale audio / chat results are dropped  │
              │                                                         │
              │  EagerEOT  → speculative ChatEngine turn                │
              │  TurnResumed → abort + restore history                  │
              │  speech over agent → classify: backchannel | interrupt │
              │  interrupt → heard = splitAtPlayedMs(text, alignment,   │
              │              playedMs); rewriteOnBargeIn(history);      │
              │              tts.abort(); transport.clear()             │
              └──────────┬──────────────────────────────┬───────────────┘
                         ▼                              ▼
                   ChatEngine (Anthropic)         TtsStream (ElevenLabs)
                   text deltas, tool calls        audio chunks + char alignment
```

Everything outside the box is behind an interface in [`interfaces.ts`](src/interfaces.ts).

## Run it

```bash
npm install
npm test            # vitest, offline
npm run typecheck
npm run example     # scripted loopback call against the fakes
```

The loopback prints the history the model sees after an interruption:

```
history sent to the model on the next turn:
  user      "Do you have any openings this week?"
  assistant "We have openings Monday morning, [interrupted]"
  user      "Actually, never mind, thanks"
```

A live Twilio example ([`examples/live-twilio.ts`](examples/live-twilio.ts)) runs only if `DEEPGRAM_API_KEY`, `ELEVENLABS_API_KEY`, `ANTHROPIC_API_KEY` and `ELEVENLABS_VOICE_EN` are set; otherwise it exits with a message. See [`.env.example`](.env.example).

## Usage

```ts
import { createCallSession, TwilioMediaTransport } from '@27colab/voice-engine';
import { createAnthropicChat, createDeepgramFluxFactory, createElevenLabsFactory } from '@27colab/voice-engine/providers';

wss.on('connection', async (ws) => {
  const transport = new TwilioMediaTransport(ws);
  const start = await transport.started;                 // streamSid, callSid, <Parameter>s

  const session = createCallSession(
    { transport, sttFactory, ttsFactory, chat },
    { callId: start.callSid, startedAt: new Date() },
    { onEnd: (record, reason) => save(record) },         // transcript, stats, events
    {
      languages: ['en', 'es'],
      languagePolicy: 'follow-caller',                   // heuristic EN/ES detection per turn
      greeting: { en: 'Hi, how can I help?', es: 'Hola, ¿en qué puedo ayudarle?' },
      system: (lang) => `Reply in ${lang === 'es' ? 'Spanish' : 'English'}.`,
      llm: { model: 'claude-haiku-4-5', maxTokens: 300 },
      voice: { provider: 'elevenlabs', voices: { en: '<voice id>', es: '<voice id>' },
               defaultVoiceId: '<voice id>', model: 'eleven_flash_v2_5', outputFormat: 'ulaw_8000' },
      stt: { model: 'flux-general-multi', eagerEotThreshold: 0.6 },
      tools, executeTool,                                // optional; `endCall: true` hangs up
    },
  );
  await session.start();
});
```

Tests use `@27colab/voice-engine/testing`: `FakeTransport` (with `confirmPlayedMs(ms)`, Twilio-style mark echo on `clear`), `FakeStt` (`emitEagerEndOfTurn`, `emitTurnResumed`, ...), `FakeTts` (deterministic alignment), `FakeChat` (scripted turns, optional `gate` to simulate latency).

## Design notes and limits

- **`playedMs` is a lower bound.** It advances only at echoed marks, so its resolution is the TTS chunk size. The rewrite errs toward "heard less", never more. Words the caller heard only part of are dropped (`snap: 'word'`); use `snap: 'char'` for exact cuts.
- **Alignment assumptions are unverified against the live API.** Fields are read as ElevenLabs `chars` / `charStartTimesMs` / `charDurationsMs`. Chunk timestamps may be chunk-relative or cumulative; `AlignmentAccumulator` handles both by a heuristic (a later chunk starting before the previous one ended is shifted). Verify against your account before relying on it. Providers that rewrite the text inside the alignment (number expansion) will mis-map.
- **Without alignment** the session falls back to a fixed ~15 chars/s estimate. That is crude.
- **Buffer-then-speak.** Each agent turn is synthesized as one utterance. Streaming sentence-by-sentence TTS would need the alignment/history logic to track which sentences were flushed; it is not implemented.
- **Speculation trade-off.** A speculative reply can start speaking before the final end-of-turn. If it is then cancelled, the caller may hear a clipped fragment (the transport is cleared immediately). Disable with `turnTaking.speculative: false`.
- **Heuristics, not models.** The backchannel list (EN/ES) and `detectLang` are small word lists. Replace `classify` for anything serious.
- **Providers are not tested in CI.** The Deepgram, ElevenLabs and Anthropic adapters need real keys; CI covers the engine against fakes only. Message shapes follow those vendors' docs at the time of writing and can drift.
- **No tenancy, persistence, metering, prompt assembly, or telephony provisioning.** `onEnd` hands you a `CallRecord`; what you do with it is yours.
- **Single process, in-memory.** No reconnect, no resumption.

## Layout

```
src/            engine, transport, adapters, fakes
test/           vitest (alignment, playback, policy/history/timeline, twilio, session)
examples/       loopback.ts (offline), live-twilio.ts (env-gated)
```

## License

MIT, see [LICENSE](LICENSE).
