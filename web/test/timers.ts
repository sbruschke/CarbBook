import type { ConnectivityEvents, Timers } from '../src/sync/engine';
import { flush } from './helpers';

/** Deterministic timers for the sync engine (real timers stay free for fake-indexeddb). */
export class ManualTimers implements Timers {
  now = 0;
  private nextId = 1;
  private readonly tasks = new Map<number, { at: number; fn: () => void; every: number | null }>();

  setTimeout = (fn: () => void, ms: number): unknown => this.add(fn, ms, null);
  setInterval = (fn: () => void, ms: number): unknown => this.add(fn, ms, ms);
  clearTimeout = (handle: unknown): void => {
    this.tasks.delete(handle as number);
  };
  clearInterval = (handle: unknown): void => {
    this.tasks.delete(handle as number);
  };

  private add(fn: () => void, ms: number, every: number | null): number {
    const id = this.nextId++;
    this.tasks.set(id, { at: this.now + ms, fn, every });
    return id;
  }

  /** Runs every task due within `ms`, in time order, flushing promises after each. */
  async advance(ms: number): Promise<void> {
    const end = this.now + ms;
    for (;;) {
      const due = [...this.tasks.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      const [id, task] = due;
      this.now = task.at;
      if (task.every === null) this.tasks.delete(id);
      else task.at += task.every;
      task.fn();
      await flush();
    }
    this.now = end;
  }
}

export class FakeEvents implements ConnectivityEvents {
  private readonly listeners = new Map<string, Set<() => void>>();

  addEventListener(type: 'online' | 'offline', listener: () => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }

  removeEventListener(type: 'online' | 'offline', listener: () => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type: 'online' | 'offline'): void {
    for (const listener of this.listeners.get(type) ?? []) listener();
  }
}
