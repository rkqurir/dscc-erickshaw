import { Body, Controller, Get, HttpCode, Inject, Injectable, Post, Req, UseGuards } from '@nestjs/common';
import { maskNid, normalizeNid, ownerIdentitySchema } from '@dscc/domain';
import type { Request } from 'express';
import { z } from 'zod';
import { AppConfig, CONFIG } from '../../config';
import { NID_ADAPTER, NidVerificationAdapter } from '../../platform/adapters';
import { AuditService } from '../../platform/audit.service';
import { encryptField, hmacHex } from '../../platform/crypto';
import { AppError, conflict, forbidden, parseOrThrow } from '../../platform/errors';
import { PrismaService, Tx } from '../../platform/prisma.service';
import { Citizen, CitizenContext, CitizenGuard } from '../auth/guards';
import { QuotaService } from './quota.service';

@Injectable()
export class OwnerService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  nidHmac(canonical: string): string {
    return hmacHex(this.config.NID_HMAC_KEY, canonical);
  }

  encryptNid(digits: string): string {
    return encryptField(this.config.DATA_ENCRYPTION_KEY, digits);
  }

  /** The owner identity linked to this citizen account, or OWNER_REGISTRATION_REQUIRED. */
  async requireOwnerId(userId: string, tx: Tx = this.prisma): Promise<string> {
    const acct = await tx.ownerAccount.findUnique({ where: { userId } });
    if (!acct) throw forbidden('OWNER_REGISTRATION_REQUIRED');
    return acct.ownerIdentityId;
  }
}

const externalSchema = z.object({
  cityName: z.string().trim().min(2, 'REQUIRED').max(80, 'TOO_LONG'),
  registrationNo: z.string().trim().min(2, 'REQUIRED').max(40, 'TOO_LONG'),
});

@Controller('owners/me')
@UseGuards(CitizenGuard)
export class OwnersController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly owners: OwnerService,
    private readonly quota: QuotaService,
    private readonly audit: AuditService,
    @Inject(NID_ADAPTER) private readonly nidAdapter: NidVerificationAdapter,
  ) {}

  /**
   * Register the signed-in citizen as an owner. Several phone accounts can link to one NID (same
   * person, new SIM), but they then share one five-vehicle limit. Linking to an existing NID requires
   * the same date of birth; identity details are never overwritten by a later account.
   */
  @Post('identity')
  @HttpCode(201)
  async registerIdentity(@Citizen() c: CitizenContext, @Body() body: unknown, @Req() req: Request) {
    const input = parseOrThrow(ownerIdentitySchema, body);
    const nid = normalizeNid(input.nid, input.dateOfBirth);
    if (!nid.ok) throw new AppError(nid.error, 400);
    const existingLink = await this.prisma.ownerAccount.findUnique({ where: { userId: c.userId } });
    if (existingLink) throw conflict('OWNER_ALREADY_REGISTERED');

    const verification = await this.nidAdapter.verify({ nidDigits: nid.value.digits, dateOfBirth: input.dateOfBirth, nameBn: input.nameBn });
    if (verification.status === 'FAILED') throw new AppError('NID_VERIFICATION_FAILED', 422);

    const nidHmac = this.owners.nidHmac(nid.value.canonical);
    const result = await this.prisma.$transaction(async (tx) => {
      let identity = await tx.ownerIdentity.findUnique({ where: { nidHmac } });
      let linkedExisting = false;
      if (identity) {
        if (identity.dateOfBirth.toISOString().slice(0, 10) !== input.dateOfBirth) throw conflict('NID_DETAILS_MISMATCH');
        linkedExisting = true;
      } else {
        identity = await tx.ownerIdentity.create({
          data: {
            nidHmac,
            nidEncrypted: this.owners.encryptNid(nid.value.digits),
            nidLast4: nid.value.digits.slice(-4),
            nidKind: nid.value.kind,
            dateOfBirth: new Date(`${input.dateOfBirth}T00:00:00Z`),
            nameBn: input.nameBn,
            nameEn: input.nameEn ?? null,
            fatherNameBn: input.fatherNameBn,
            motherNameBn: input.motherNameBn,
            presentAddress: input.presentAddress,
            permanentAddress: input.permanentAddress,
            education: input.education,
            verificationStatus: verification.status,
            verificationSource: verification.source,
            verifiedAt: verification.status === 'SIMULATED_VERIFIED' ? new Date() : null,
          },
        });
      }
      await tx.ownerAccount.create({ data: { userId: c.userId, ownerIdentityId: identity.id } });
      await this.audit.record(tx, {
        actorType: 'USER',
        actorId: c.userId,
        action: linkedExisting ? 'owner.account_linked' : 'owner.registered',
        entityType: 'owner_identity',
        entityId: identity.id,
        data: { nid: maskNid(nid.value.digits), verification: identity.verificationStatus },
        ip: req.ip,
      });
      return { identity, linkedExisting };
    });
    return {
      nameBn: result.identity.nameBn,
      nidMasked: maskNid(result.identity.nidLast4),
      verificationStatus: result.identity.verificationStatus,
      linkedExisting: result.linkedExisting,
    };
  }

  @Get('vehicle-quota')
  async vehicleQuota(@Citizen() c: CitizenContext) {
    const ownerId = await this.owners.requireOwnerId(c.userId);
    return this.prisma.$transaction((tx) => this.quota.summary(tx, ownerId));
  }

  @Get('external-registrations')
  async listExternal(@Citizen() c: CitizenContext) {
    const ownerId = await this.owners.requireOwnerId(c.userId);
    const rows = await this.prisma.externalCityRegistration.findMany({ where: { ownerIdentityId: ownerId }, orderBy: { declaredAt: 'asc' } });
    return rows.map((r) => ({ id: r.id, cityName: r.cityName, registrationNo: r.registrationNo, status: r.status, declaredAt: r.declaredAt }));
  }

  /** Declare an e-rickshaw already registered with another city corporation; it counts toward the limit. */
  @Post('external-registrations')
  @HttpCode(201)
  async declareExternal(@Citizen() c: CitizenContext, @Body() body: unknown, @Req() req: Request) {
    const input = parseOrThrow(externalSchema, body);
    const ownerId = await this.owners.requireOwnerId(c.userId);
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM owner_identities WHERE id = ${ownerId}::uuid FOR UPDATE`;
      const s = await this.quota.summary(tx, ownerId);
      if (s.used >= s.limit) throw conflict('OWNER_NID_VEHICLE_LIMIT_REACHED');
      const dup = await tx.externalCityRegistration.findUnique({
        where: { ownerIdentityId_cityName_registrationNo: { ownerIdentityId: ownerId, cityName: input.cityName, registrationNo: input.registrationNo } },
      });
      if (dup) throw conflict('CONFLICT');
      const r = await tx.externalCityRegistration.create({
        data: { ownerIdentityId: ownerId, cityName: input.cityName, registrationNo: input.registrationNo, declaredByUser: c.userId },
      });
      await this.audit.record(tx, {
        actorType: 'USER',
        actorId: c.userId,
        action: 'owner.external_registration_declared',
        entityType: 'owner_identity',
        entityId: ownerId,
        data: { cityName: input.cityName, registrationNo: input.registrationNo },
        ip: req.ip,
      });
      return { id: r.id, cityName: r.cityName, registrationNo: r.registrationNo, status: r.status, declaredAt: r.declaredAt };
    });
  }
}
