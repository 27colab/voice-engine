# Changelog

## Unreleased (proposed 0.3.0, minor)

Uses Deepgram Flux's mid-stream `Configure` message (documented on developers.deepgram.com, numerals mid-stream since 2026-09-25).

### Added
- **The STT language hint follows the caller.** With `languagePolicy: 'follow-caller'`, a switch between English and Spanish now also updates Flux's `language_hints`, so the next caller turn is transcribed with the right hint. Before, the hint stayed on the starting language for the whole call. Opt out with `stt.followLanguage: false`.
- **`session.configureStt(update)`** changes STT settings mid-call without reconnecting: `languageHint`, `numerals`, `keyterms` (replaces the list). Typical use: `{ numerals: true }` while asking for a phone number or date. Updates requested before STT opens are merged and sent once it does. A `stt_configure` timeline event records each update.
- **`stt.numerals`** sets digit formatting when the stream opens.
- **Flux adapter:** `SttStream.configure`, `createDeepgramFluxFactory(key, { url })`, and exported `fluxListenParams` / `buildFluxConfigure`. A `ConfigureFailure` reply (Flux keeps its previous settings) is reported through the new `SttEventHandlers.onWarning` and the session's `onWarning` hook; it no longer risks being treated as a fatal error.
- **Fakes:** `FakeSttStream.configure` records updates in `configures`; `emitWarning`.

### Changed (type-level)
- `CallSessionApi` gains `configureStt`. `SttStream.configure` and `SttEventHandlers.onWarning` are optional, so custom STT providers keep compiling.

## 0.2.0 (2026-10-21)

Moved in from the first production host (a multi-tenant receptionist), where each piece had to be rebuilt outside the engine.

### Added
- **Prompt caching in the Anthropic adapter.** `createAnthropicChat(apiKey, { cacheSystem, cacheHistory })`, both on by default: the system prompt (and the tool definitions in front of it) and the conversation so far are cached. `buildAnthropicRequest` returns the exact request without sending it.
- **System prompt blocks.** `config.system` (and `ChatTurnRequest.system`) accept `SystemBlock[]`; `cacheBoundary: true` marks the end of the cacheable prefix so per-call facts after it never invalidate the cache.
- **Tool fillers.** `config.fillers` speaks a short phrase the instant the model starts a tool call, unless the model already wrote a preamble. It plays through the normal playback path: interruptible, on the timeline (`filler` event, `stats.fillers`) and in the transcript, never in chat history.
- **Usage totals.** `CallRecord.stats.usage`: input, output, cache-read and cache-write tokens, and TTS characters. `ChatUsage` gains optional `cacheReadTokens` / `cacheWriteTokens`.
- **Configuration warnings.** `hooks.onWarning` (and a `warning` timeline event) when a bilingual config uses an English-only Flux model.

### Changed (type-level)
- `ChatTurnRequest.system` is now `string | SystemBlock[]`. A custom `ChatEngine` that assumed a string must handle blocks (join their `text` if your provider has no caching).
- `CallStats` gains `fillers` and `usage`.

## 0.1.0 (2026-10-19)

First release.
