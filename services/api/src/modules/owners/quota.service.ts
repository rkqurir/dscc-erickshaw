import { Injectable } from '@nestjs/common';
import { MAX_VEHICLES_PER_NID } from '@dscc/domain';
import { uuidv7 } from '../../platform/crypto';
import { conflict } from '../../platform/errors';
import { Tx } from '../../platform/prisma.service';
import { AuditService } from '../../platform/audit.service';

export interface QuotaSummary {
  limit: number;
  registered: number;
  pending: number;
  otherCities: number;
  used: number;
  remaining: number;
}

/**
 * Rule 4(8): at most five e-rickshaws per owner NID across all city corporations.
 * Every code path that attaches a vehicle to an owner must call reserve() inside its transaction.
 * The vehicle_quota_slots trigger is a second, independent guard.
 */
@Injectable()
export class QuotaService {
  constructor(private readonly audit: AuditService) {}

  async summary(tx: Tx, ownerIdentityId: string): Promise<QuotaSummary> {
    const rows = await tx.$queryRaw<{ registered: number; pending: number; external: number }[]>`
      SELECT
        (SELECT count(*)::int FROM vehicle_quota_slots WHERE owner_identity_id = ${ownerIdentityId}::uuid AND state = 'HELD') AS registered,
        (SELECT count(*)::int FROM vehicle_quota_slots WHERE owner_identity_id = ${ownerIdentityId}::uuid AND state = 'RESERVED') AS pending,
        (SELECT count(*)::int FROM external_city_registrations WHERE owner_identity_id = ${ownerIdentityId}::uuid AND status <> 'REJECTED') AS external`;
    const r = rows[0];
    const used = r.registered + r.pending + r.external;
    return {
      limit: MAX_VEHICLES_PER_NID,
      registered: r.registered,
      pending: r.pending,
      otherCities: r.external,
      used,
      remaining: Math.max(0, MAX_VEHICLES_PER_NID - used),
    };
  }

  /** Lock the owner row, count live slots and reserve one more, or throw 409. */
  async reserve(
    tx: Tx,
    p: { ownerIdentityId: string; vehicleId: string; cityId: string; source: string; actor: { type: 'USER' | 'STAFF' | 'SYSTEM'; id: string | null } },
  ): Promise<void> {
    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM owner_identities WHERE id = ${p.ownerIdentityId}::uuid FOR UPDATE`;
    if (locked.length !== 1) throw new Error('owner identity not found');
    const s = await this.summary(tx, p.ownerIdentityId);
    if (s.used >= MAX_VEHICLES_PER_NID) {
      throw conflict('OWNER_NID_VEHICLE_LIMIT_REACHED', { limit: s.limit, used: s.used });
    }
    await tx.$executeRaw`
      INSERT INTO vehicle_quota_slots (id, owner_identity_id, vehicle_id, city_id, state, source)
      VALUES (${uuidv7()}::uuid, ${p.ownerIdentityId}::uuid, ${p.vehicleId}::uuid, ${p.cityId}::uuid, 'RESERVED', ${p.source})`;
    await this.audit.record(tx, {
      cityId: p.cityId,
      actorType: p.actor.type,
      actorId: p.actor.id,
      action: 'quota.reserve',
      entityType: 'vehicle',
      entityId: p.vehicleId,
      data: { ownerIdentityId: p.ownerIdentityId, usedBefore: s.used, source: p.source },
    });
  }

  async release(
    tx: Tx,
    p: { vehicleId: string; cityId: string; reason: string; actor: { type: 'USER' | 'STAFF' | 'SYSTEM'; id: string | null } },
  ): Promise<void> {
    const n = await tx.$executeRaw`
      UPDATE vehicle_quota_slots SET state = 'RELEASED', release_reason = ${p.reason}, released_at = now()
      WHERE vehicle_id = ${p.vehicleId}::uuid AND state <> 'RELEASED'`;
    if (n > 0) {
      await this.audit.record(tx, {
        cityId: p.cityId,
        actorType: p.actor.type,
        actorId: p.actor.id,
        action: 'quota.release',
        entityType: 'vehicle',
        entityId: p.vehicleId,
        data: { reason: p.reason },
      });
    }
  }
}
