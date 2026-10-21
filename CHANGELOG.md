# Changelog

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
