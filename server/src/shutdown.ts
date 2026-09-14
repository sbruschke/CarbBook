export interface ShutdownDeps {
  close: () => Promise<void>;
  closeDb: () => void;
  log: (message: string, signal: string) => void;
  exit: (code: number) => void;
  setTimeout: typeof globalThis.setTimeout;
  /** Defaults to 10s. */
  forceExitMs?: number;
}

export type ShutdownHandler = (signal: string) => Promise<void>;

/**
 * Builds a signal handler that closes the app and db exactly once (repeat
 * signals during shutdown are ignored) and forces an exit if close hangs.
 */
export function createShutdownHandler(deps: ShutdownDeps): ShutdownHandler {
  let shuttingDown = false;
  return async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;

    const forceExitTimer = deps.setTimeout(() => deps.exit(1), deps.forceExitMs ?? 10_000);
    forceExitTimer.unref?.();

    deps.log('shutting down', signal);
    await deps.close();
    deps.closeDb();
    deps.exit(0);
  };
}
