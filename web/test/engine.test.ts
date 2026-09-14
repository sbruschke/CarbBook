import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/lib/api';
import { SIGNED_OUT_MESSAGE, SyncEngine, type SyncEngineOptions, type SyncPhase } from '../src/sync/engine';
import { flush } from './helpers';
import { FakeEvents, ManualTimers } from './timers';

function setup(run: () => Promise<void> = async () => {}, extra: Partial<SyncEngineOptions> = {}) {
  const timers = new ManualTimers();
  const events = new FakeEvents();
  const state = { online: true, runs: 0, authExpired: 0 };
  const engine = new SyncEngine({
    run: async () => {
      state.runs++;
      await run();
    },
    isOnline: () => state.online,
    events,
    timers,
    now: () => timers.now,
    onAuthExpired: () => state.authExpired++,
    random: () => 0.5, // neutral: no jitter offset
    ...extra,
  });
  return { engine, timers, events, state };
}

describe('SyncEngine', () => {
  it('syncs on start and every 60 s while online', async () => {
    const { engine, timers, state } = setup();
    engine.start();
    await flush();
    expect(state.runs).toBe(1);
    expect(engine.getStatus().phase).toBe('idle');
    await timers.advance(60_000);
    expect(state.runs).toBe(2);
    await timers.advance(60_000);
    expect(state.runs).toBe(3);
  });

  it('debounces local writes by 2 s', async () => {
    const { engine, timers, state } = setup();
    engine.start();
    await flush();
    engine.requestSync();
    await timers.advance(500);
    engine.requestSync();
    await timers.advance(1_999);
    expect(state.runs).toBe(1);
    await timers.advance(1);
    expect(state.runs).toBe(2);
  });

  it('waits while offline and syncs on reconnect', async () => {
    const { engine, events, state } = setup();
    state.online = false;
    engine.start();
    await flush();
    expect(state.runs).toBe(0);
    expect(engine.getStatus().phase).toBe('offline');
    state.online = true;
    events.emit('online');
    await flush();
    expect(state.runs).toBe(1);
    expect(engine.getStatus().phase).toBe('idle');
  });

  it('retries failures with exponential backoff', async () => {
    let failuresLeft = 2;
    const { engine, timers, state } = setup(async () => {
      if (failuresLeft-- > 0) throw new ApiError(502, 'http_error', 'HTTP 502');
    });
    engine.start();
    await flush();
    expect(engine.getStatus()).toEqual({ phase: 'error', error: 'HTTP 502', retryAt: 2_000 });
    await timers.advance(2_000);
    expect(state.runs).toBe(2);
    expect(engine.getStatus()).toEqual({ phase: 'error', error: 'HTTP 502', retryAt: 6_000 });
    await timers.advance(4_000);
    expect(state.runs).toBe(3);
    expect(engine.getStatus().phase).toBe('idle');
  });

  it('stops on 401 until resumed after sign-in', async () => {
    let expired = true;
    const { engine, timers, state } = setup(async () => {
      if (expired) throw new ApiError(401, 'unauthorized', 'Session expired or revoked');
    });
    engine.start();
    await flush();
    expect(engine.getStatus()).toEqual({ phase: 'signed_out', error: SIGNED_OUT_MESSAGE, retryAt: null });
    expect(state.authExpired).toBe(1);
    engine.requestSync();
    await timers.advance(60_000);
    expect(state.runs).toBe(1);
    expired = false;
    engine.resume();
    await flush();
    expect(state.runs).toBe(2);
    expect(engine.getStatus().phase).toBe('idle');
  });

  it('runs once more when a sync is requested during a sync', async () => {
    let release: () => void = () => {};
    let first = true;
    const { engine, state } = setup(async () => {
      if (first) {
        first = false;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
    });
    engine.start();
    await flush();
    void engine.syncNow();
    expect(state.runs).toBe(1);
    release();
    await flush();
    expect(state.runs).toBe(2);
  });

  it('applies +/-20% jitter to the retry delay', async () => {
    let failuresLeft = 1;
    const { engine, timers, state } = setup(
      async () => {
        if (failuresLeft-- > 0) throw new ApiError(502, 'http_error', 'HTTP 502');
      },
      { random: () => 1 }, // max jitter: +20%
    );
    engine.start();
    await flush();
    expect(engine.getStatus().retryAt).toBe(2_400); // 2000 * 1.2
    await timers.advance(2_400);
    expect(state.runs).toBe(2);
  });

  it('stops scheduling retries once stop() is called during an in-flight failing sync', async () => {
    let rejectRun: ((error: unknown) => void) | null = null;
    const { engine, timers, state } = setup(async () => {
      await new Promise<void>((_resolve, reject) => {
        rejectRun = reject;
      });
    });
    engine.start();
    await flush();
    expect(state.runs).toBe(1);
    engine.stop();
    // The in-flight run fails after stop(); no retry should be scheduled under the old session.
    rejectRun!(new ApiError(502, 'http_error', 'HTTP 502'));
    await flush();
    await timers.advance(10 * 60_000);
    expect(state.runs).toBe(1);
  });

  it('does not schedule a debounced sync from requestSync after stop()', async () => {
    const { engine, timers, state } = setup();
    engine.start();
    await flush();
    engine.stop();
    engine.requestSync();
    await timers.advance(2_000);
    expect(state.runs).toBe(1);
  });

  it('notifies subscribers and stops cleanly', async () => {
    const { engine, timers, state } = setup();
    const phases: SyncPhase[] = [];
    const unsubscribe = engine.subscribe(() => phases.push(engine.getStatus().phase));
    engine.start();
    await flush();
    expect(phases).toEqual(['syncing', 'idle']);
    unsubscribe();
    engine.stop();
    await timers.advance(120_000);
    expect(state.runs).toBe(1);
  });
});
