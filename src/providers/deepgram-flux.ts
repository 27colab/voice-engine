import WebSocket from 'ws';
import type { SttConfig, SttEventHandlers, SttFactory, SttStream } from '../interfaces.js';
import type { Lang } from '../types.js';

const FLUX_URL = 'wss://api.deepgram.com/v2/listen';
const DEFAULT_MODEL = 'flux-general-en';

type FluxTurnEvent = 'Update' | 'StartOfTurn' | 'EagerEndOfTurn' | 'TurnResumed' | 'EndOfTurn';

const LANGUAGE_HINTS: Record<Lang, string> = { en: 'en', es: 'es' };

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

  constructor(apiKey: string, config: SttConfig, private readonly handlers: SttEventHandlers) {
    this.replacements = compileReplacements(config.replacements);

    const model = config.model || DEFAULT_MODEL;
    const params = new URLSearchParams({ model, encoding: 'mulaw', sample_rate: '8000' });
    if (config.eotThreshold != null) params.set('eot_threshold', String(config.eotThreshold));
    if (config.eagerEotThreshold != null) params.set('eager_eot_threshold', String(config.eagerEotThreshold));
    for (const k of config.keyterms) params.append('keyterm', k);
    // language_hint only applies to the multilingual model.
    if (model.endsWith('-multi') && config.languageHint) {
      params.set('language_hint', LANGUAGE_HINTS[config.languageHint]);
    }

    this.ws = new WebSocket(`${FLUX_URL}?${params.toString()}`, {
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

/** Deepgram Flux over WebSocket, mulaw 8 kHz in, turn events out. */
export function createDeepgramFluxFactory(apiKey: string): SttFactory {
  return {
    async create(config, handlers) {
      const stream = new FluxSttStream(apiKey, config, handlers);
      await stream.ready();
      return stream;
    },
  };
}
