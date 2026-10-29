import WebSocket from 'ws';
import type { SttConfig, SttEventHandlers, SttFactory, SttStream, SttUpdate } from '../interfaces.js';
import type { Lang } from '../types.js';

const FLUX_URL = 'wss://api.deepgram.com/v2/listen';
const DEFAULT_MODEL = 'flux-general-en';

type FluxTurnEvent = 'Update' | 'StartOfTurn' | 'EagerEndOfTurn' | 'TurnResumed' | 'EndOfTurn';

const LANGUAGE_HINTS: Record<Lang, string> = { en: 'en', es: 'es' };

/** Deepgram caps keyterms at 100 per list. */
const MAX_KEYTERMS = 100;

export interface DeepgramFluxOptions {
  /** Override the endpoint (tests, regional endpoints). Default `wss://api.deepgram.com/v2/listen`. */
  url?: string;
}

/** Query string for opening a Flux stream. Exported for tests. */
export function fluxListenParams(config: SttConfig): URLSearchParams {
  const model = config.model || DEFAULT_MODEL;
  const params = new URLSearchParams({ model, encoding: 'mulaw', sample_rate: '8000' });
  if (config.eotThreshold != null) params.set('eot_threshold', String(config.eotThreshold));
  if (config.eagerEotThreshold != null) params.set('eager_eot_threshold', String(config.eagerEotThreshold));
  if (config.numerals != null) params.set('numerals', String(config.numerals));
  for (const k of config.keyterms.slice(0, MAX_KEYTERMS)) params.append('keyterm', k);
  // language_hint only applies to the multilingual model.
  if (model.endsWith('-multi') && config.languageHint) {
    params.set('language_hint', LANGUAGE_HINTS[config.languageHint]);
  }
  return params;
}

/**
 * The Flux `Configure` message for a mid-call update, or null when there is
 * nothing to send (e.g. only a language hint on an English-only model).
 * Exported for tests.
 */
export function buildFluxConfigure(model: string, update: SttUpdate): Record<string, unknown> | null {
  const msg: Record<string, unknown> = { type: 'Configure' };
  if (update.languageHint && (model || DEFAULT_MODEL).endsWith('-multi')) {
    msg.language_hints = [LANGUAGE_HINTS[update.languageHint]];
  }
  if (update.numerals != null) msg.numerals = update.numerals;
  if (update.keyterms) msg.keyterms = update.keyterms.slice(0, MAX_KEYTERMS);
  return Object.keys(msg).length > 1 ? msg : null;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Whole-word, case-insensitive replacement table, compiled once. */
export function compileReplacements(
  replacements: SttConfig['replacements'],
): Array<{ pattern: RegExp; to: string }> {
  return replacements.map(({ from, to }) => ({
    pattern: new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(from)}(?![\\p{L}\\p{N}])`, 'giu'),
    to,
  }));
}

export function applyReplacements(text: string, table: Array<{ pattern: RegExp; to: string }>): string {
  let out = text;
  for (const { pattern, to } of table) {
    pattern.lastIndex = 0;
    out = out.replace(pattern, to);
  }
  return out;
}

class FluxSttStream implements SttStream {
  private ws: WebSocket;
  private closed = false;
  private readonly replacements: ReturnType<typeof compileReplacements>;
  private readonly model: string;

  constructor(
    apiKey: string,
    config: SttConfig,
    private readonly handlers: SttEventHandlers,
    url: string,
  ) {
    this.replacements = compileReplacements(config.replacements);
    this.model = config.model || DEFAULT_MODEL;
    this.ws = new WebSocket(`${url}?${fluxListenParams(config).toString()}`, {
      headers: { Authorization: `Token ${apiKey}` },
    });
    this.ws.on('message', (data: Buffer) => this.onMessage(data));
    this.ws.on('error', (err: Error) => this.handlers.onError?.(err));
    this.ws.on('close', () => {
      this.closed = true;
    });
  }

  ready(): Promise<void> {
    if (this.ws.readyState === WebSocket.OPEN) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const onOpen = () => {
        this.ws.off('error', onErr);
        resolve();
      };
      const onErr = (err: Error) => {
        this.ws.off('open', onOpen);
        reject(err);
      };
      this.ws.once('open', onOpen);
      this.ws.once('error', onErr);
    });
  }

  sendAudio(payloadB64: string): void {
    if (this.closed || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(Buffer.from(payloadB64, 'base64'));
  }

  configure(update: SttUpdate): void {
    const msg = buildFluxConfigure(this.model, update);
    if (!msg || this.closed || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(msg));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify({ type: 'CloseStream' }));
      } catch {
        /* raced to closed */
      }
      this.ws.close();
    }
  }

  private onMessage(data: Buffer): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (msg.type === 'ConfigureFailure') {
      // The update was rejected; Flux keeps the previous settings and the stream stays open.
      this.handlers.onWarning?.(
        `Deepgram Flux rejected a Configure update: ${String(msg.code ?? '')} ${String(msg.description ?? '')}`.trim(),
      );
      return;
    }
    if (msg.type === 'Error') {
      this.handlers.onError?.(
        new Error(`Deepgram Flux: ${String(msg.code ?? '')} ${String(msg.description ?? '')}`.trim()),
      );
      return;
    }
    if (msg.type !== 'TurnInfo') return;

    const transcript = applyReplacements(String(msg.transcript ?? ''), this.replacements);
    const confidence = typeof msg.end_of_turn_confidence === 'number' ? msg.end_of_turn_confidence : undefined;

    switch (msg.event as FluxTurnEvent) {
      case 'StartOfTurn':
        this.handlers.onStartOfTurn?.();
        break;
      case 'Update':
        this.handlers.onUpdate?.(transcript);
        break;
      case 'EagerEndOfTurn':
        this.handlers.onEagerEndOfTurn?.(transcript);
        break;
      case 'TurnResumed':
        this.handlers.onTurnResumed?.();
        break;
      case 'EndOfTurn':
        this.handlers.onEndOfTurn(transcript, { confidence });
        break;
    }
  }
}

/**
 * Deepgram Flux over WebSocket, mulaw 8 kHz in, turn events out. Streams
 * support `configure` (language hint, numerals, keyterms) mid-call.
 */
export function createDeepgramFluxFactory(apiKey: string, opts: DeepgramFluxOptions = {}): SttFactory {
  const url = opts.url ?? FLUX_URL;
  return {
    async create(config, handlers) {
      const stream = new FluxSttStream(apiKey, config, handlers, url);
      await stream.ready();
      return stream;
    },
  };
}
