import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlaybackTracker, mulawDurationMs } from '../src/index.js';
import { FakeTransport } from '../src/testing/index.js';

const chunk = (ms: number) => Buffer.alloc(ms * 8, 0xff).toString('base64');

afterEach(() => vi.useRealTimers());

describe('mulawDurationMs', () => {
  it('is bytes / 8 at 8 kHz', () => {
    expect(mulawDurationMs(chunk(20))).toBe(20);
    expect(mulawDurationMs(chunk(1000))).toBe(1000);
    expect(mulawDurationMs('')).toBe(0);
  });
});

describe('PlaybackTracker', () => {
  it('only counts audio up to the last echoed mark', () => {
    const t = new FakeTransport();
    const p = new PlaybackTracker({ transport: t, prefix: 'u1-' });
    p.sendAudio(chunk(100));
    p.sendAudio(chunk(100));
    p.sendAudio(chunk(100));
    expect(p.queuedMs).toBe(300);
    expect(p.playedMs).toBe(0);

    p.onMark('u1-2');
    expect(p.playedMs).toBe(200);
    p.onMark('u1-1'); // late/out-of-order echo never moves it backwards
    expect(p.playedMs).toBe(200);
  });

  it('ignores marks it does not know (other utterances)', () => {
    const p = new PlaybackTracker({ transport: new FakeTransport(), prefix: 'u2-' });
    p.sendAudio(chunk(100));
    expect(p.onMark('u1-1')).toBe(false);
    expect(p.playedMs).toBe(0);
  });

  it('whenDrained resolves when the last mark is confirmed', async () => {
    const t = new FakeTransport();
    const p = new PlaybackTracker({ transport: t, prefix: 'u1-' });
    p.sendAudio(chunk(100));
    const done = p.whenDrained(1000);
    p.onMark('u1-1');
    await expect(done).resolves.toBe('confirmed');
  });

  it('whenDrained resolves immediately when nothing is queued', async () => {
    const p = new PlaybackTracker({ transport: new FakeTransport(), prefix: 'x' });
    await expect(p.whenDrained(1000)).resolves.toBe('confirmed');
  });

  it('gives up after remaining audio + padding when a mark never arrives', async () => {
    vi.useFakeTimers();
    const p = new PlaybackTracker({ transport: new FakeTransport(), prefix: 'u1-' });
    p.sendAudio(chunk(500));
    let result: string | undefined;
    void p.whenDrained(1000).then((r) => (result = r));
    await vi.advanceTimersByTimeAsync(1499);
    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(2);
    expect(result).toBe('timeout');
  });

  it('clear() freezes the ledger: the echo Twilio sends on clear does not count as playback', async () => {
    const t = new FakeTransport(); // echoMarksOnClear defaults to true
    const p = new PlaybackTracker({ transport: t, prefix: 'u1-' });
    p.sendAudio(chunk(100));
    p.sendAudio(chunk(100));
    p.onMark('u1-1');
    const done = p.whenDrained(1000);
    t.onMark((n) => p.onMark(n));
    p.clear();
    await Promise.resolve();
    await Promise.resolve();
    expect(await done).toBe('cleared');
    expect(p.playedMs).toBe(100);
    expect(t.clearCount).toBe(1);
    expect(p.sendAudio(chunk(100))).toBe(0); // no more audio after clear
  });
});
