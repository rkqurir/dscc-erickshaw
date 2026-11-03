import { notFound } from '../../platform/errors';
import { OutboxService } from '../../platform/outbox.service';
import { Tx } from '../../platform/prisma.service';
import { StaffContext } from '../auth/guards';

/** Staff assigned only to specific zones see only those zones; a city-wide assignment sees all. */
export function zoneFilter(s: StaffContext): string[] | null {
  return s.zoneScopes.includes(null) ? null : (s.zoneScopes as string[]);
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Load a submitted application the officer may see, optionally locking it; anything else is 404.
 * Drafts are visible only where asked for: fitness inspections are requested before submission.
 */
export async function loadStaffApplication(tx: Tx, s: StaffContext, id: string, lock = false, includeDrafts = false) {
  if (!UUID_RE.test(id)) throw notFound();
  if (lock) await tx.$queryRaw`SELECT id FROM applications WHERE id = ${id}::uuid FOR UPDATE`;
  const scope = zoneFilter(s);
  const app = await tx.application.findFirst({
    where: { id, ...(includeDrafts ? {} : { status: { not: 'DRAFT' } }), deletedAt: null, ...(scope ? { zoneId: { in: scope } } : {}) },
  });
  if (!app) throw notFound();
  return app;
}

/** Queue an SMS to the applicant in the same transaction as the change it reports. */
export async function notifyApplicant(tx: Tx, outbox: OutboxService, applicantUserId: string, body: string): Promise<void> {
  const user = await tx.user.findUniqueOrThrow({ where: { id: applicantUserId } });
  await outbox.enqueue(tx, 'sms.send', { to: user.phoneE164, body });
}

export function dhakaToday(): string {
  return new Date(Date.now() + 6 * 3600_000).toISOString().slice(0, 10);
}

export function isoDate(d: Date | null | undefined): string | null {
  return d ? d.toISOString().slice(0, 10) : null;
}
