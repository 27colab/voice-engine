import WebSocket from 'ws';
import { AlignmentAccumulator, type CharAlignment } from '../alignment.js';
import type { TtsEventHandlers, TtsFactory, TtsStream, TtsVoiceConfig } from '../interfaces.js';

const TTS_BASE = 'wss://api.elevenlabs.io/v1/text-to-speech';

interface ElevenMessage {
  audio?: string;
  alignment?: Partial<CharAlignment>;
  isFinal?: boolean;
  error?: unknown;
}

class ElevenLabsTtsStream implements TtsStream {
  private ws: WebSocket;
  private open = false;
  private aborted = false;
  private finished = false;
  private completed = false;
  /** Text queued before the socket opened. '' is the end-of-stream sentinel. */
  private readonly pending: string[] = [];
  private readonly align = new AlignmentAccumulator();
  private submitted = 0;

  constructor(apiKey: string, voice: TtsVoiceConfig, private readonly handlers: TtsEventHandlers) {
    const query = new URLSearchParams({ model_id: voice.model, output_format: voice.outputFormat });
    if (voice.languageCode) query.set('language_code', voice.languageCode);
    const url = `${TTS_BASE}/${encodeURIComponent(voice.voiceId)}/stream-input?${query.toString()}`;

    this.ws = new WebSocket(url, { headers: { 'xi-api-key': apiKey } });
    this.ws.on('open', () => {
      this.open = true;
      this.rawSend({
        text: ' ',
        voice_settings: { stability: voice.stability ?? 0.5, similarity_boost: voice.similarityBoost ?? 0.8 },
        generation_config: { chunk_length_schedule: [50] },
        sync_alignment: true,
      });
      for (const t of this.pending) this.rawSend({ text: t === '' ? '' : `${t} ` });
      this.pending.length = 0;
    });
    this.ws.on('message', (data: Buffer) => this.onMessage(data));
    this.ws.on('error', (err: Error) => {
      this.handlers.onError?.(err);
      this.complete();
    });
    this.ws.on('close', () => this.complete());
  }

  speak(text: string): void {
    if (this.aborted || this.finished || !text.trim()) return;
    this.submitted += text.length;
    if (!this.open) this.pending.push(text);
    else this.rawSend({ text: `${text} ` });
  }

  end(): void {
    if (this.aborted || this.finished) return;
    this.finished = true;
    if (!this.open) this.pending.push('');
    else this.rawSend({ text: '' });
  }

  abort(): void {
    if (this.aborted) return;
    this.aborted = true;
    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
      this.ws.terminate();
    }
  }

  alignment(): CharAlignment {
    return this.align.snapshot();
  }

  charactersSubmitted(): number {
    return this.submitted;
  }

  private rawSend(payload: unknown): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(payload));
  }

  private onMessage(data: Buffer): void {
    if (this.aborted) return;
    let msg: ElevenMessage;
    try {
      msg = JSON.parse(data.toString()) as ElevenMessage;
    } catch {
      return;
    }
    if (msg.error != null) this.handlers.onError?.(new Error(`ElevenLabs: ${JSON.stringify(msg.error)}`));
    if (msg.alignment) this.align.add(msg.alignment);
    if (msg.audio) this.handlers.onAudio(msg.audio);
    if (msg.isFinal) {
      this.complete();
      if (this.ws.readyState === WebSocket.OPEN) this.ws.close();
    }
  }

  private complete(): void {
    if (this.completed || this.aborted) return;
    this.completed = true;
    this.handlers.onComplete();
  }
}

/** ElevenLabs stream-input WebSocket. Works with any voice id you pass in TtsVoiceConfig. */
export function createElevenLabsFactory(apiKey: string): TtsFactory {
  return {
    async create(voice, handlers) {
      return new ElevenLabsTtsStream(apiKey, voice, handlers);
    },
  };
}
