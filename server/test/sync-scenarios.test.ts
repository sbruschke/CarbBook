import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import type { PushResult } from '../src/sync/push';
import { addUser, loginBearer, loginCookie, makeTestApp } from './helpers';
import { doseSettings, food, portion } from './sync-helpers';

type Rec = Record<string, unknown> & { id: string };

/** A minimal offline-first client: local rows + pending queue, push then pull until drained (spec §5). */
class SimClient {
  rows = new Map<string, Rec>();
  pending = new Map<string, { table: string; record: Rec }>();
  since = 0;
  lastResults: PushResult[] = [];

  constructor(
    private app: FastifyInstance,
    private headers: Record<string, string>,
    readonly deviceId: string,
  ) {}

  write(table: string, record: Rec, at: number): void {
    const stamped = { ...record, updated_at: at, updated_by: this.deviceId };
    this.rows.set(`${table}/${record.id}`, stamped);
    this.pending.set(`${table}/${record.id}`, { table, record: stamped });
  }

  get(table: string, id: string): Rec | undefined {
    return this.rows.get(`${table}/${id}`);
  }

  async sync(): Promise<void> {
    if (this.pending.size > 0) {
      const push = await this.app.inject({
        method: 'POST',
        url: '/api/sync/push',
        headers: this.headers,
        payload: { changes: [...this.pending.values()] },
      });
      if (push.statusCode !== 200) throw new Error(`push failed ${push.statusCode}: ${push.body}`);
      this.lastResults = push.json().results;
      this.pending.clear();
    }
    for (;;) {
      const pull = await this.app.inject({ url: `/api/sync/pull?since=${this.since}&limit=2`, headers: this.headers });
      const page = pull.json() as { changes: { table: string; record: Rec }[]; next_since: number; has_more: boolean };
      for (const change of page.changes) this.rows.set(`${change.table}/${change.record.id}`, change.record);
      this.since = page.next_since;
      if (!page.has_more) break;
    }
  }
}

async function setup() {
  const t = await makeTestApp();
  await addUser(t.db, 'brett', 'owner');
  await addUser(t.db, 'kim', 'viewer');
  const phone = new SimClient(t.app, { authorization: await loginBearer(t.app, 'brett') }, 'phone');
  const laptop = new SimClient(t.app, { cookie: await loginCookie(t.app, 'brett') }, 'laptop');
  const viewer = new SimClient(t.app, { cookie: await loginCookie(t.app, 'kim') }, 'kim-web');
  return { ...t, phone, laptop, viewer };
}

describe('two clients syncing through the server', () => {
  it('converges on the newer offline edit regardless of reconnect order', async () => {
    const { phone, laptop } = await setup();
    phone.write('food', food({ id: 'f1', name: 'Tortilla' }), 1000);
    await phone.sync();
    await laptop.sync();
    expect(laptop.get('food', 'f1')?.name).toBe('Tortilla');

    // Both go offline and edit the same food; the laptop edit is newer but reconnects first.
    phone.write('food', { ...phone.get('food', 'f1')!, name: 'Phone edit' }, 2000);
    laptop.write('food', { ...laptop.get('food', 'f1')!, name: 'Laptop edit' }, 3000);
    await laptop.sync();
    await phone.sync();
    expect(phone.lastResults[0]).toMatchObject({ status: 'ignored' });
    await laptop.sync();

    expect(phone.get('food', 'f1')?.name).toBe('Laptop edit');
    expect(laptop.get('food', 'f1')?.name).toBe('Laptop edit');
  });

  it('breaks updated_at ties by the higher device id on both clients', async () => {
    const { phone, laptop } = await setup();
    phone.write('food', food({ id: 'f1', name: 'from phone' }), 5000);
    laptop.write('food', food({ id: 'f1', name: 'from laptop' }), 5000);
    await phone.sync();
    await laptop.sync();
    await phone.sync();
    expect(phone.get('food', 'f1')?.name).toBe('from phone');
    expect(laptop.get('food', 'f1')?.name).toBe('from phone');
  });

  it('propagates a newer offline delete over an older edit, and a later edit restores the record', async () => {
    const { phone, laptop } = await setup();
    phone.write('food', food({ id: 'f1' }), 1000);
    await phone.sync();
    await laptop.sync();

    laptop.write('food', { ...laptop.get('food', 'f1')!, name: 'Edited' }, 2000);
    phone.write('food', { ...phone.get('food', 'f1')!, deleted: 1 }, 2500);
    await phone.sync();
    await laptop.sync();
    await phone.sync();
    expect(laptop.get('food', 'f1')).toMatchObject({ deleted: 1 });
    expect(phone.get('food', 'f1')).toMatchObject({ deleted: 1 });

    laptop.write('food', { ...laptop.get('food', 'f1')!, deleted: 0, name: 'Restored' }, 4000);
    await laptop.sync();
    await phone.sync();
    expect(phone.get('food', 'f1')).toMatchObject({ deleted: 0, name: 'Restored' });
  });

  it('rejects viewer dose_settings while syncing the rest of the batch', async () => {
    const { phone, viewer } = await setup();
    viewer.write('food', food({ id: 'kim-food', name: 'Kim snack' }), 1000);
    viewer.write('dose_settings', doseSettings({ id: 'kim-dose' }), 1000);
    await viewer.sync();
    expect(viewer.lastResults.map((r) => r.status)).toEqual(['accepted', 'rejected']);

    await phone.sync();
    expect(phone.get('food', 'kim-food')?.name).toBe('Kim snack');
    expect(phone.get('dose_settings', 'kim-dose')).toBeUndefined();
    // The viewer's local copy still holds its rejected row plus the two seeded versions from the server.
    expect([...viewer.rows.keys()].filter((k) => k.startsWith('dose_settings/'))).toHaveLength(3);
  });

  it('round-trips a volume-basis food and a carbs_g-only portion between two clients', async () => {
    const { phone, laptop } = await setup();
    phone.write('food', food({ id: 'rice', name: 'Calrose rice', carbs_per_100g: null, carbs_per_100ml: 20.2884136211058 }), 1000);
    phone.write('portion', portion('rice', { id: 'bar', label: 'bar', grams: null, carbs_g: 22 }), 1000);
    await phone.sync();
    expect(phone.lastResults.every((r) => r.status === 'accepted')).toBe(true);

    await laptop.sync();
    expect(laptop.get('food', 'rice')).toMatchObject({ carbs_per_100g: null, carbs_per_100ml: 20.2884136211058 });
    expect(laptop.get('portion', 'bar')).toMatchObject({ grams: null, carbs_g: 22 });
  });
});
