import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';
import { createUser, type Role, UserError } from './auth/users';
import { type Env, loadConfig } from './config';
import type { Db } from './db';
import { initDatabase } from './init';

export interface CliIo {
  env: Env;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  readPassword: () => Promise<string>;
  /** Tests pass an in-memory database; otherwise DATABASE_PATH is opened. */
  db?: Db;
  now?: () => number;
}

const USAGE = `Usage:
  carbbook user add <username> [--role owner|viewer]   (password from CARBBOOK_PASSWORD or prompt)`;

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
    const role = (flag(rest, '--role') ?? 'viewer') as Role;
    const password = io.env.CARBBOOK_PASSWORD ?? (await io.readPassword());
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
  io.stderr(USAGE);
  return 2;
}

async function promptPassword(): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await rl.question('Password: ');
  } finally {
    rl.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli(process.argv.slice(2), {
    env: process.env,
    stdout: (line) => console.log(line),
    stderr: (line) => console.error(line),
    readPassword: promptPassword,
  }).then((code) => process.exit(code));
}
