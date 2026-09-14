import { ApiError } from '../lib/api';

export type SyncPhase = 'idle' | 'syncing' | 'offline' | 'error' | 'signed_out';

export interface SyncStatus {
  phase: SyncPhase;
  error: string | null;
  /** When the next automatic retry runs (phase `error`). */
  retryAt: number | null;
}

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface ConnectivityEvents {
  addEventListener(type: 'online' | 'offline', listener: () => void): void;
  removeEventListener(type: 'online' | 'offline', listener: () => void): void;
}

export interface SyncEngineOptions {
  /** One full sync pass, normally `() => syncOnce(db, api)`. */
  run: () => Promise<void>;
  isOnline?: () => boolean;
  events?: ConnectivityEvents;
  timers?: Timers;
  now?: () => number;
  /** Called when the server answers 401; pending changes stay in IndexedDB. */
  onAuthExpired?: () => void;
}

export const WRITE_DEBOUNCE_MS = 2_000;
export const SYNC_INTERVAL_MS = 60_000;
export const RETRY_BASE_MS = 2_000;
export const RETRY_MAX_MS = 5 * 60_000;

export const SIGNED_OUT_MESSAGE = 'Signed out. Sign in again to sync; unsynced changes are kept on this device.';

const browserTimers: Timers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
  clearInterval: (handle) => globalThis.clearInterval(handle as ReturnType<typeof setInterval>),
};

/**
 * Schedules sync passes (spec §5): on start, on reconnect, 2 s after local writes, every 60 s
 * while online; retries failures with exponential backoff; stops on 401 until `resume()`.
 */
export class SyncEngine {
  private status: SyncStatus = { phase: 'idle', error: null, retryAt: null };
  private readonly listeners = new Set<() => void>();
  private readonly timers: Timers;
  private readonly isOnline: () => boolean;
  private readonly events: ConnectivityEvents;
  private readonly now: () => number;
  private running: Promise<void> | null = null;
  private rerun = false;
  private failures = 0;
  private debounceHandle: unknown = null;
  private retryHandle: unknown = null;
  private intervalHandle: unknown = null;
  private started = false;

  constructor(private readonly options: SyncEngineOptions) {
    this.timers = options.timers ?? browserTimers;
    this.isOnline = options.isOnline ?? (() => navigator.onLine);
    this.events = options.events ?? window;
    this.now = options.now ?? Date.now;
  }

  getStatus = (): SyncStatus => this.status;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  start(): void {
    if (this.started) return;
    this.started = true;
    this.events.addEventListener('online', this.handleOnline);
    this.events.addEventListener('offline', this.handleOffline);
    this.intervalHandle = this.timers.setInterval(() => {
      if (this.status.phase !== 'error') void this.syncNow();
    }, SYNC_INTERVAL_MS);
    void this.syncNow();
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.events.removeEventListener('online', this.handleOnline);
    this.events.removeEventListener('offline', this.handleOffline);
    this.timers.clearInterval(this.intervalHandle);
    this.clearDebounce();
    this.clearRetry();
  }

  /** Call after a local write; syncs once writes pause for 2 s. */
  requestSync = (): void => {
    this.clearDebounce();
    this.debounceHandle = this.timers.setTimeout(() => {
      this.debounceHandle = null;
      void this.syncNow();
    }, WRITE_DEBOUNCE_MS);
  };

  /** Re-enables syncing after the user signs in again (syncs right away if started). */
  resume(): void {
    this.failures = 0;
    this.setStatus({ phase: 'idle', error: null, retryAt: null });
    if (this.started) void this.syncNow();
  }

  syncNow(): Promise<void> {
    if (this.status.phase === 'signed_out') return Promise.resolve();
    if (!this.isOnline()) {
      this.setStatus({ phase: 'offline', error: null, retryAt: null });
      return Promise.resolve();
    }
    if (this.running) {
      this.rerun = true;
      return this.running;
    }
    this.clearRetry();
    this.running = this.loop().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async loop(): Promise<void> {
    this.setStatus({ phase: 'syncing', error: null, retryAt: null });
    try {
      do {
        this.rerun = false;
        await this.options.run();
      } while (this.rerun);
      this.failures = 0;
      this.setStatus({ phase: 'idle', error: null, retryAt: null });
    } catch (error) {
      this.handleFailure(error);
    }
  }

  private handleFailure(error: unknown): void {
    if (error instanceof ApiError && error.status === 401) {
      this.setStatus({ phase: 'signed_out', error: SIGNED_OUT_MESSAGE, retryAt: null });
      this.options.onAuthExpired?.();
      return;
    }
    if (!this.isOnline()) {
      this.setStatus({ phase: 'offline', error: null, retryAt: null });
      return;
    }
    this.failures++;
    const delay = Math.min(RETRY_BASE_MS * 2 ** (this.failures - 1), RETRY_MAX_MS);
    this.retryHandle = this.timers.setTimeout(() => {
      this.retryHandle = null;
      void this.syncNow();
    }, delay);
    this.setStatus({
      phase: 'error',
      error: error instanceof Error ? error.message : String(error),
      retryAt: this.now() + delay,
    });
  }

  private readonly handleOnline = (): void => {
    void this.syncNow();
  };

  private readonly handleOffline = (): void => {
    if (this.status.phase !== 'signed_out') this.setStatus({ phase: 'offline', error: null, retryAt: null });
  };

  private clearDebounce(): void {
    if (this.debounceHandle !== null) this.timers.clearTimeout(this.debounceHandle);
    this.debounceHandle = null;
  }

  private clearRetry(): void {
    if (this.retryHandle !== null) this.timers.clearTimeout(this.retryHandle);
    this.retryHandle = null;
  }

  private setStatus(status: SyncStatus): void {
    this.status = status;
    for (const listener of this.listeners) listener();
  }
}
