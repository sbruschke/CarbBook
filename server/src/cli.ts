import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';
import { createUser, type Role, UserError } from './auth/users';
import { type Env, loadConfig } from './config';
import type { Db } from './db';
import { initDatabase } from './init';
import { buildUsdaBundles } from './usda/bundle';
import { importUsda } from './usda/import';

export interface CliIo {
  env: Env;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  readPassword: (prompt: string) => Promise<string>;
  /** Tests pass an in-memory database; otherwise DATABASE_PATH is opened. */
  db?: Db;
  now?: () => number;
}

const USAGE = `Usage:
  carbbook user add <username> [--role owner|viewer]   (password from CARBBOOK_PASSWORD or prompt)
  carbbook import-usda <csv-dir> [<csv-dir>...]        (extracted FoodData Central CSV folders)`;

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

export async function runCli(argv: string[], io: CliIo): Promise<number> {
  const [group, command, ...rest] = argv;
  if (group === 'user' && command === 'add') {
    const username = rest[0];
    if (!username || username.startsWith('--')) {
      io.stderr(USAGE);
      return 2;
    }
    const VALID_ROLES: Role[] = ['owner', 'viewer'];
    const roleFlagIndex = rest.indexOf('--role');
    let role: Role = 'viewer';
    if (roleFlagIndex >= 0) {
      const roleValue = flag(rest, '--role');
      if (!roleValue || !(VALID_ROLES as string[]).includes(roleValue)) {
        io.stderr(USAGE);
        return 2;
      }
      role = roleValue as Role;
    }
    let password: string;
    if (io.env.CARBBOOK_PASSWORD) {
      password = io.env.CARBBOOK_PASSWORD;
    } else {
      const typed = await io.readPassword('Password: ');
      const confirmed = await io.readPassword('Confirm password: ');
      if (typed !== confirmed) {
        io.stderr('Passwords do not match');
        return 1;
      }
      password = typed;
    }
    const db = io.db ?? initDatabase(loadConfig(io.env).databasePath);
    try {
      const user = await createUser(db, { username, password, role }, (io.now ?? Date.now)());
      io.stdout(`Created ${user.role} "${user.username}" (id ${user.id})`);
      return 0;
    } catch (error) {
      if (error instanceof UserError) {
        io.stderr(error.message);
        return 1;
      }
      throw error;
    } finally {
      if (!io.db) db.close();
    }
  }
  if (group === 'import-usda') {
    const dirs = [command, ...rest].filter((d): d is string => Boolean(d));
    if (dirs.length === 0) {
      io.stderr(USAGE);
      return 2;
    }
    const config = loadConfig(io.env);
    const db = io.db ?? initDatabase(config.databasePath);
    try {
      const stats = await importUsda(db, dirs);
      const manifest = buildUsdaBundles(db, config.usdaDir, (io.now ?? Date.now)());
      io.stdout(
        `Imported ${stats.foods} foods and ${stats.portions} portions (${stats.skipped_portions} skipped) from ${stats.datasets} datasets`,
      );
      io.stdout(`USDA bundle ${manifest.version} written to ${config.usdaDir}`);
      return 0;
    } finally {
      if (!io.db) db.close();
    }
  }
  io.stderr(USAGE);
  return 2;
}

/**
 * Replaces `stream.write` with a no-op and returns a function that restores the original.
 * Used to hide keystroke echo while a password is typed; tested directly against a fake stream.
 */
export function muteWritable(stream: NodeJS.WritableStream): () => void {
  const original = stream.write.bind(stream);
  (stream as { write: NodeJS.WritableStream['write'] }).write = (() => true) as NodeJS.WritableStream['write'];
  return () => {
    (stream as { write: NodeJS.WritableStream['write'] }).write = original;
  };
}

/**
 * Prompts on `stdout` and reads a line from `stdin`. When both ends are a TTY, the typed
 * characters are not echoed: the prompt text is written first, then the output stream is muted
 * for the duration of the read (readline still re-renders the line on every keystroke, it just
 * writes nowhere), and a newline is printed after Enter once unmuted.
 */
export async function promptPassword(
  prompt: string,
  streams: { stdin: NodeJS.ReadableStream; stdout: NodeJS.WritableStream } = { stdin: process.stdin, stdout: process.stderr },
): Promise<string> {
  const isTTY = Boolean((streams.stdin as NodeJS.ReadStream).isTTY && (streams.stdout as NodeJS.WriteStream).isTTY);
  const rl = createInterface({ input: streams.stdin, output: streams.stdout, terminal: isTTY });
  try {
    if (!isTTY) return await rl.question(prompt);
    streams.stdout.write(prompt);
    const unmute = muteWritable(streams.stdout);
    try {
      return await rl.question('');
    } finally {
      unmute();
      streams.stdout.write('\n');
    }
  } finally {
    rl.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli(process.argv.slice(2), {
    env: process.env,
    stdout: (line) => console.log(line),
    stderr: (line) => console.error(line),
    readPassword: (prompt) => promptPassword(prompt),
  }).then((code) => process.exit(code));
}
