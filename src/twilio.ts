import type { MediaTransport } from './interfaces.js';

/** The slice of a `ws` WebSocket the transport needs (so core has no ws dependency). */
export interface WebSocketLike {
  send(data: string): void;
  close(): void;
  on(event: 'message', cb: (data: { toString(): string }) => void): unknown;
  on(event: 'close', cb: () => void): unknown;
}

export interface TwilioStartInfo {
  streamSid: string;
  callSid: string;
  customParameters: Record<string, string>;
}

/**
 * Twilio Media Streams (<Connect><Stream>) as a MediaTransport.
 *
 * Inbound events: connected, start, media, mark, stop.
 * Outbound: media {payload}, mark {name}, clear. All outbound frames carry the
 * streamSid from the `start` event; audio sent before it arrives is dropped.
 *
 * Wire up: on each new WebSocket from your server, `new TwilioMediaTransport(ws)`,
 * `await transport.started`, then build the call session.
 */
export class TwilioMediaTransport implements MediaTransport {
  readonly started: Promise<TwilioStartInfo>;
  private streamSid: string | null = null;
  private mediaCb?: (p: string) => void;
  private markCb?: (name: string) => void;
  private stopCb?: () => void;
  private stopped = false;

  constructor(private readonly ws: WebSocketLike) {
    let resolveStart!: (i: TwilioStartInfo) => void;
    this.started = new Promise((r) => (resolveStart = r));

    ws.on('message', (data) => {
      let msg: Record<string, any>;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      switch (msg.event) {
        case 'start': {
          const s = msg.start ?? {};
          this.streamSid = String(s.streamSid ?? msg.streamSid ?? '');
          resolveStart({
            streamSid: this.streamSid,
            callSid: String(s.callSid ?? ''),
            customParameters: (s.customParameters ?? {}) as Record<string, string>,
          });
          break;
        }
        case 'media':
          // Only inbound (caller) audio is forwarded.
          if (msg.media?.track === undefined || msg.media.track === 'inbound') {
            this.mediaCb?.(String(msg.media?.payload ?? ''));
          }
          break;
        case 'mark':
          if (msg.mark?.name) this.markCb?.(String(msg.mark.name));
          break;
        case 'stop':
          this.fireStop();
          break;
      }
    });
    ws.on('close', () => this.fireStop());
  }

  private fireStop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.stopCb?.();
  }

  private sendJson(obj: unknown): void {
    if (!this.streamSid) return;
    try {
      this.ws.send(JSON.stringify(obj));
    } catch {
      /* socket closed */
    }
  }

  sendAudio(payloadB64: string): void {
    this.sendJson({ event: 'media', streamSid: this.streamSid, media: { payload: payloadB64 } });
  }

  sendMark(name: string): void {
    this.sendJson({ event: 'mark', streamSid: this.streamSid, mark: { name } });
  }

  clear(): void {
    this.sendJson({ event: 'clear', streamSid: this.streamSid });
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }

  onMedia(cb: (p: string) => void): void {
    this.mediaCb = cb;
  }
  onMark(cb: (name: string) => void): void {
    this.markCb = cb;
  }
  onStop(cb: () => void): void {
    this.stopCb = cb;
  }
}
