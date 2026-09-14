import { describe, expect, it } from 'vitest';
import { findUserByUsername } from '../src/auth/users';
import { runCli, type CliIo } from '../src/cli';
import { initDatabase } from '../src/init';

function io(overrides: Partial<CliIo> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const value: CliIo = {
    env: {},
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    readPassword: async () => 'typed password',
    db: initDatabase(':memory:'),
    now: () => 1,
    ...overrides,
  };
  return { io: value, out, err };
}

describe('carbbook user add', () => {
  it('creates an owner with the prompted password', async () => {
    const t = io();
    expect(await runCli(['user', 'add', 'brett', '--role', 'owner'], t.io)).toBe(0);
    expect(t.out).toEqual(['Created owner "brett" (id 1)']);
    expect(findUserByUsername(t.io.db!, 'brett')?.role).toBe('owner');
  });

  it('defaults to viewer and prefers CARBBOOK_PASSWORD', async () => {
    let prompted = false;
    const t = io({
      env: { CARBBOOK_PASSWORD: 'from env var' },
      readPassword: async () => {
        prompted = true;
        return 'x';
      },
    });
    expect(await runCli(['user', 'add', 'kim'], t.io)).toBe(0);
    expect(prompted).toBe(false);
    expect(findUserByUsername(t.io.db!, 'kim')?.role).toBe('viewer');
  });

  it('reports validation errors with exit code 1 and usage with exit code 2', async () => {
    const t = io({ readPassword: async () => 'short' });
    expect(await runCli(['user', 'add', 'kim'], t.io)).toBe(1);
    expect(t.err[0]).toMatch(/at least 8/);
    expect(await runCli(['bogus'], t.io)).toBe(2);
    expect(t.err[1]).toMatch(/Usage/);
  });
});
