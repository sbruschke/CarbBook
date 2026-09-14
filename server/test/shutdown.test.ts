import { describe, expect, it, vi } from 'vitest';
import { createShutdownHandler } from '../src/shutdown';

function makeDeps() {
  const timers: { delay: number; unref: ReturnType<typeof vi.fn> }[] = [];
  const fakeSetTimeout = vi.fn((_fn: () => void, delay: number) => {
    const unref = vi.fn();
    timers.push({ delay, unref });
    return { unref } as unknown as NodeJS.Timeout;
  });
  return {
    close: vi.fn().mockResolvedValue(undefined),
    closeDb: vi.fn(),
    log: vi.fn(),
    exit: vi.fn(),
    setTimeout: fakeSetTimeout as unknown as typeof setTimeout,
    timers,
  };
}

describe('createShutdownHandler', () => {
  it('closes the app and db once and exits 0', async () => {
    const deps = makeDeps();
    const shutdown = createShutdownHandler(deps);
    await shutdown('SIGTERM');
    expect(deps.close).toHaveBeenCalledTimes(1);
    expect(deps.closeDb).toHaveBeenCalledTimes(1);
    expect(deps.exit).toHaveBeenCalledWith(0);
  });

  it('is idempotent: a second call is a no-op', async () => {
    const deps = makeDeps();
    const shutdown = createShutdownHandler(deps);
    await Promise.all([shutdown('SIGTERM'), shutdown('SIGINT')]);
    await shutdown('SIGTERM');
    expect(deps.close).toHaveBeenCalledTimes(1);
    expect(deps.closeDb).toHaveBeenCalledTimes(1);
    expect(deps.exit).toHaveBeenCalledTimes(1);
  });

  it('schedules an unref()d forced-exit timer', async () => {
    const deps = makeDeps();
    const shutdown = createShutdownHandler(deps);
    await shutdown('SIGTERM');
    expect(deps.setTimeout).toHaveBeenCalledTimes(1);
    expect(deps.timers[0]!.delay).toBe(10_000);
    expect(deps.timers[0]!.unref).toHaveBeenCalledTimes(1);
  });
});
