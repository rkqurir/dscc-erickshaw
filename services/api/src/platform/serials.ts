import { Tx } from './prisma.service';

/**
 * Atomic per-city counters (invoice, receipt, fitness certificate, plate serial per zone).
 * INSERT … ON CONFLICT DO UPDATE … RETURNING takes a row lock, so concurrent callers get distinct
 * values and a rolled-back transaction never consumes one visibly.
 */
export async function nextSerial(tx: Tx, cityId: string, kind: 'INVOICE' | 'RECEIPT' | 'FITNESS' | 'PLATE', scope: string): Promise<number> {
  const rows = await tx.$queryRaw<{ last_value: number }[]>`
    INSERT INTO serial_counters (city_id, kind, scope, last_value) VALUES (${cityId}::uuid, ${kind}, ${scope}, 1)
    ON CONFLICT (city_id, kind, scope) DO UPDATE SET last_value = serial_counters.last_value + 1
    RETURNING last_value`;
  return rows[0].last_value;
}
