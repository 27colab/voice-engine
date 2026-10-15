import { describe, expect, it } from 'vitest';
import { TwilioMediaTransport, type WebSocketLike } from '../src/index.js';

function fakeSocket() {
  const handlers: Record<string, (d?: any) => void> = {};
  const sent: any[] = [];
  const ws: WebSocketLike = {
    send: (d) => sent.push(JSON.parse(d)),
    close: () => {},
    on: ((event: string, cb: (d?: any) => void) => {
      handlers[event] = cb;
    }) as WebSocketLike['on'],
  };
  const receive = (obj: unknown) => handlers.message!({ toString: () => JSON.stringify(obj) });
  return { ws, sent, receive, close: () => handlers.close!() };
}

describe('TwilioMediaTransport', () => {
  it('parses start, forwards inbound media/marks/stop', async () => {
    const { ws, receive } = fakeSocket();
    const t = new TwilioMediaTransport(ws);
    const media: string[] = [];
    const marks: string[] = [];
    let stops = 0;
    t.onMedia((p) => media.push(p));
    t.onMark((n) => marks.push(n));
    t.onStop(() => stops++);

    receive({ event: 'connected' });
    receive({ event: 'start', start: { streamSid: 'MZ1', callSid: 'CA1', customParameters: { k: 'v' } } });
    expect(await t.started).toEqual({ streamSid: 'MZ1', callSid: 'CA1', customParameters: { k: 'v' } });

    receive({ event: 'media', media: { track: 'inbound', payload: 'AAAA' } });
    receive({ event: 'media', media: { track: 'outbound', payload: 'BBBB' } });
    receive({ event: 'mark', mark: { name: 'u1-3' } });
    receive({ event: 'stop' });
    receive({ event: 'stop' });
    expect(media).toEqual(['AAAA']);
    expect(marks).toEqual(['u1-3']);
    expect(stops).toBe(1);
  });

  it('sends media, mark and clear frames with the stream sid; drops sends before start', () => {
    const { ws, sent, receive } = fakeSocket();
    const t = new TwilioMediaTransport(ws);
    t.sendAudio('early');
    expect(sent).toHaveLength(0);

    receive({ event: 'start', start: { streamSid: 'MZ9', callSid: 'CA9' } });
    t.sendAudio('QUJD');
    t.sendMark('m1');
    t.clear();
    expect(sent).toEqual([
      { event: 'media', streamSid: 'MZ9', media: { payload: 'QUJD' } },
      { event: 'mark', streamSid: 'MZ9', mark: { name: 'm1' } },
      { event: 'clear', streamSid: 'MZ9' },
    ]);
  });

  it('treats socket close as stop and ignores malformed JSON', () => {
    const { ws, close } = fakeSocket();
    const t = new TwilioMediaTransport(ws);
    let stops = 0;
    t.onStop(() => stops++);
    ws.on('message', () => {});
    close();
    expect(stops).toBe(1);
  });
});
