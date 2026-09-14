import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { findUserByUsername } from '../src/auth/users';
import { muteWritable, promptPassword, runCli, type CliIo } from '../src/cli';
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

  it('rejects --role with a missing or invalid value instead of defaulting to viewer', async () => {
    const t = io();
    expect(await runCli(['user', 'add', 'brett', '--role'], t.io)).toBe(2);
    expect(t.err[0]).toMatch(/Usage/);
    expect(findUserByUsername(t.io.db!, 'brett')).toBeUndefined();

    const t2 = io();
    expect(await runCli(['user', 'add', 'brett', '--role', 'admin'], t2.io)).toBe(2);
    expect(t2.err[0]).toMatch(/Usage/);
    expect(findUserByUsername(t2.io.db!, 'brett')).toBeUndefined();
  });

  it('prefers CARBBOOK_PASSWORD and never prompts twice for confirmation (non-TTY/env path)', async () => {
    let calls = 0;
    const t = io({
      env: { CARBBOOK_PASSWORD: 'from env var' },
      readPassword: async () => {
        calls++;
        return 'unused';
      },
    });
    expect(await runCli(['user', 'add', 'kim'], t.io)).toBe(0);
    expect(calls).toBe(0);
  });

  it('rejects a mismatched password confirmation without creating the user', async () => {
    let call = 0;
    const t = io({
      readPassword: async () => {
        call++;
        return call === 1 ? 'first password' : 'different password';
      },
    });
    expect(await runCli(['user', 'add', 'brett'], t.io)).toBe(1);
    expect(t.err[0]).toMatch(/do not match/i);
    expect(findUserByUsername(t.io.db!, 'brett')).toBeUndefined();
  });

  it('prompts for the password and its confirmation, and they must match to succeed', async () => {
    const prompts: string[] = [];
    const t = io({
      readPassword: async (prompt: string) => {
        prompts.push(prompt);
        return 'matching password';
      },
    });
    expect(await runCli(['user', 'add', 'brett'], t.io)).toBe(0);
    expect(prompts).toEqual(['Password: ', 'Confirm password: ']);
  });
});

describe('carbbook import-usda', () => {
  it('prints a clear message to stderr and exits 1 for a bad directory, without throwing', async () => {
    const t = io();
    const bad = mkdtempSync(join(tmpdir(), 'carbbook-cli-bad-'));
    await expect(runCli(['import-usda', bad], t.io)).resolves.toBe(1);
    expect(t.err[0]).toMatch(`${bad} is missing food.csv`);
  });
});

describe('muteWritable', () => {
  it('suppresses writes until unmuted, using a fake writable stream', () => {
    const chunks: unknown[] = [];
    const fake = { write: (chunk: unknown) => { chunks.push(chunk); return true; } } as unknown as NodeJS.WritableStream;
    const unmute = muteWritable(fake);
    fake.write('secret-keystrokes');
    expect(chunks).toEqual([]);
    unmute();
    fake.write('visible');
    expect(chunks).toEqual(['visible']);
  });
});

describe('promptPassword', () => {
  it('reads via readline without muting when stdin is not a TTY', async () => {
    const input = Readable.from(['s3cret\n']);
    const chunks: string[] = [];
    const output = { write: (chunk: unknown) => { chunks.push(String(chunk)); return true; } } as unknown as NodeJS.WritableStream;
    const value = await promptPassword('Password: ', { stdin: input, stdout: output });
    expect(value).toBe('s3cret');
    expect(chunks.join('')).toContain('Password: ');
  });
});
