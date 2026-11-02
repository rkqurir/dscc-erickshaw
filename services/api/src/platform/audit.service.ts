import { Injectable } from '@nestjs/common';
import { sha256Hex } from './crypto';
import { PrismaService, Tx } from './prisma.service';

export interface AuditInput {
  cityId?: string | null;
  actorType: 'USER' | 'STAFF' | 'SYSTEM' | 'ANONYMOUS';
  actorId?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  data?: Record<string, unknown>;
  ip?: string | null;
}

export const GENESIS_HASH = '0'.repeat(64);

/** Canonical JSON (sorted keys) so the hash is reproducible during verification. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
    .join(',')}}`;
}

export function auditHash(prevHash: string, e: { occurredAt: string } & AuditInput): string {
  return sha256Hex(
    prevHash +
      canonicalJson({
        occurredAt: e.occurredAt,
        cityId: e.cityId ?? null,
        actorType: e.actorType,
        actorId: e.actorId ?? null,
        action: e.action,
        entityType: e.entityType,
        entityId: e.entityId ?? null,
        data: e.data ?? {},
      }),
  );
}

/**
 * Hash-chained, append-only audit log. Each row stores the previous row's hash; the table rejects
 * UPDATE/DELETE at the database level. Writes are serialized with a transaction-scoped advisory lock.
 */
@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async record(tx: Tx, e: AuditInput): Promise<void> {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(7243001)::text AS locked`;
    const last = await tx.auditEvent.findFirst({ orderBy: { id: 'desc' }, select: { hash: true } });
    const prevHash = last?.hash ?? GENESIS_HASH;
    const occurredAt = new Date();
    const hash = auditHash(prevHash, { ...e, occurredAt: occurredAt.toISOString() });
    await tx.auditEvent.create({
      data: {
        occurredAt,
        cityId: e.cityId ?? null,
        actorType: e.actorType,
        actorId: e.actorId ?? null,
        action: e.action,
        entityType: e.entityType,
        entityId: e.entityId ?? null,
        data: (e.data ?? {}) as object,
        ip: e.ip ?? null,
        prevHash,
        hash,
      },
    });
  }

  /** Record outside an existing transaction. */
  recordStandalone(e: AuditInput): Promise<void> {
    return this.prisma.$transaction((tx) => this.record(tx, e));
  }

  /** Recompute the whole chain; returns the id of the first broken row, or null if intact. */
  async verifyChain(): Promise<bigint | null> {
    const rows = await this.prisma.auditEvent.findMany({ orderBy: { id: 'asc' } });
    let prev = GENESIS_HASH;
    for (const r of rows) {
      const expected = auditHash(prev, {
        occurredAt: r.occurredAt.toISOString(),
        cityId: r.cityId,
        actorType: r.actorType as AuditInput['actorType'],
        actorId: r.actorId,
        action: r.action,
        entityType: r.entityType,
        entityId: r.entityId,
        data: r.data as Record<string, unknown>,
      });
      if (r.prevHash !== prev || r.hash !== expected) return r.id;
      prev = r.hash;
    }
    return null;
  }
}
