import { Inject, Injectable } from '@nestjs/common';
import {
  ECONOMIC_LIFE_MONTHS,
  PLATE_SERIAL_MAX,
  REGISTRATION_VALIDITY_MONTHS,
  formatPlateBengali,
  formatPlateSystemId,
  maskNid,
  parseQrToken,
  periodEndIso,
  qrSignedMessage,
} from '@dscc/domain';
import { KeyObject, randomBytes } from 'node:crypto';
import QRCode from 'qrcode';
import { z } from 'zod';
import { AppConfig, CONFIG } from '../../config';
import { AuditService } from '../../platform/audit.service';
import { CityService } from '../../platform/city.service';
import { ed25519KeyFromSeed, ed25519Sign, ed25519Verify, hmacHex } from '../../platform/crypto';
import { AppError, conflict, notFound, parseOrThrow } from '../../platform/errors';
import { OutboxService } from '../../platform/outbox.service';
import { PrismaService, Tx } from '../../platform/prisma.service';
import { nextSerial } from '../../platform/serials';
import { StaffContext } from '../auth/guards';
import { StepUpService } from '../auth/step-up.service';
import { InspectionService } from './inspection.service';
import { UUID_RE, dhakaToday, isoDate, loadStaffApplication, notifyApplicant, zoneFilter } from './scope';

const issueSchema = z.object({ totp: z.string().regex(/^\d{6}$/, 'MFA_INVALID') });
const reissueSchema = z.object({
  reason: z.enum(['LOST', 'DAMAGED', 'COMPROMISED', 'OTHER']),
  totp: z.string().regex(/^\d{6}$/, 'MFA_INVALID'),
});

/**
 * Plate number and QR credential issuance after approval (Rule 4(4), Schedule 3).
 * - Plate serial: atomic per city + zone counter, 000001–999999, never reused.
 * - Dual plate form (system ID format confirmed by DSCC, 2026-11-02): system ID DSCC-Z1-000001 and the
 *   Schedule 3 Bengali text "ঢাকা দক্ষিণ-ক-০০০০০১", both derived from the same row.
 * - QR: random 128-bit id + version, Ed25519-signed; no NID, phone or name in the code.
 */
@Injectable()
export class RegistrationService {
  private readonly keys: { privateKey: KeyObject; publicKey: KeyObject };
  private readonly scanWindow = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly cities: CityService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly stepUp: StepUpService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {
    this.keys = ed25519KeyFromSeed(config.QR_SIGNING_KEY);
  }

  publicKey() {
    return {
      alg: 'Ed25519',
      format: 'Q1.<CITY>.<tokenId>.<version>.<signature>; signature covers the text before the last dot',
      jwk: this.keys.publicKey.export({ format: 'jwk' }),
      pem: this.keys.publicKey.export({ format: 'pem', type: 'spki' }).toString(),
    };
  }

  token(cityCode: string, tokenId: string, version: number): string {
    const msg = qrSignedMessage(cityCode, tokenId, version);
    return `${msg}.${ed25519Sign(this.keys.privateKey, msg)}`;
  }

  verifyUrl(token: string): string {
    return `${this.config.PUBLIC_VERIFY_BASE_URL.replace(/\/$/, '')}/v/${token}`;
  }

  async qrPayload(cityCode: string, cred: { tokenId: string; version: number }) {
    const url = this.verifyUrl(this.token(cityCode, cred.tokenId, cred.version));
    return { url, qrDataUrl: await QRCode.toDataURL(url, { errorCorrectionLevel: 'M', margin: 2, width: 280 }) };
  }

  private async createCredential(tx: Tx, cityId: string, registrationId: string, version: number, staffId: string) {
    return tx.qrCredential.create({
      data: { cityId, registrationId, tokenId: randomBytes(16).toString('base64url'), version, status: 'ACTIVE', issuedBy: staffId },
    });
  }

  // ─── Plate officer ───
  async queue(s: StaffContext) {
    const scope = zoneFilter(s);
    return this.prisma.inCity(s.cityId, async (tx) => {
      const apps = await tx.application.findMany({
        where: { status: 'APPROVED', deletedAt: null, ...(scope ? { zoneId: { in: scope } } : {}) },
        orderBy: { decidedAt: 'asc' },
        take: 200,
      });
      const regs = await tx.registration.findMany({ where: { applicationId: { in: apps.map((a) => a.id) } } });
      const rmap = new Map(regs.map((r) => [r.applicationId, r]));
      const owners = await tx.ownerIdentity.findMany({ where: { id: { in: apps.map((a) => a.ownerIdentityId) } } });
      const omap = new Map(owners.map((o) => [o.id, o]));
      const zones = await tx.zone.findMany();
      const zmap = new Map(zones.map((z) => [z.id, z]));
      return apps.map((a) => {
        const r = rmap.get(a.id);
        const o = omap.get(a.ownerIdentityId);
        const z = a.zoneId ? zmap.get(a.zoneId) : undefined;
        return {
          applicationId: a.id,
          applicationNumber: a.applicationNumber,
          decidedAt: a.decidedAt,
          owner: o ? { nameBn: o.nameBn, nidMasked: maskNid(o.nidLast4) } : null,
          zone: z ? { code: z.code, nameBn: z.nameBn, nameEn: z.nameEn, uiColour: z.uiColour } : null,
          registration: r ? { id: r.id, plateSystemId: r.plateSystemId, plateTextBn: r.plateTextBn, status: r.status, issuedAt: r.issuedAt } : null,
        };
      });
    });
  }

  async issue(s: StaffContext, applicationId: string, body: unknown, ip: string | null) {
    const input = parseOrThrow(issueSchema, body);
    const city = await this.cities.byId(s.cityId);
    return this.prisma.inCity(s.cityId, async (tx) => {
      const app = await loadStaffApplication(tx, s, applicationId, true);
      if (app.status !== 'APPROVED' || !app.vehicleId || !app.zoneId) throw conflict('APPLICATION_INVALID_STATE');
      if (await tx.registration.findUnique({ where: { applicationId: app.id } })) throw conflict('REGISTRATION_ALREADY_ISSUED');
      const approval = await tx.applicationDecision.findFirst({ where: { applicationId: app.id, decision: 'APPROVED' }, orderBy: { decidedAt: 'desc' } });
      if (approval?.decidedBy === s.staffId) throw new AppError('SEPARATION_OF_DUTIES', 403);
      await this.stepUp.verify(tx, s.staffId, input.totp, 'issue_registration');
      const zone = await tx.zone.findUniqueOrThrow({ where: { id: app.zoneId } });
      const serial = await nextSerial(tx, s.cityId, 'PLATE', zone.code);
      if (serial > PLATE_SERIAL_MAX) throw conflict('PLATE_SERIES_EXHAUSTED');
      const plateSystemId = formatPlateSystemId(city.code, zone.code, serial);
      const plateTextBn = formatPlateBengali(city.plateCityNameBn, zone.plateAreaCodeBn, serial);
      const today = dhakaToday();
      const reg = await tx.registration.create({
        data: {
          cityId: s.cityId,
          applicationId: app.id,
          vehicleId: app.vehicleId,
          ownerIdentityId: app.ownerIdentityId,
          zoneId: zone.id,
          plateSerial: serial,
          plateSystemId,
          plateTextBn,
          registeredOn: new Date(`${today}T00:00:00Z`),
          validUntil: new Date(`${periodEndIso(today, REGISTRATION_VALIDITY_MONTHS)}T00:00:00Z`),
          endOfLifeOn: new Date(`${periodEndIso(today, ECONOMIC_LIFE_MONTHS)}T00:00:00Z`),
          status: 'ACTIVE',
          issuedBy: s.staffId,
        },
      });
      const cred = await this.createCredential(tx, s.cityId, reg.id, 1, s.staffId);
      await tx.vehicle.update({ where: { id: app.vehicleId }, data: { status: 'ACTIVE' } });
      await this.audit.record(tx, {
        cityId: s.cityId,
        actorType: 'STAFF',
        actorId: s.staffId,
        action: 'registration.issued',
        entityType: 'application',
        entityId: app.id,
        data: { plateSystemId, plateTextBn, registrationId: reg.id, qrVersion: cred.version },
        ip,
      });
      await notifyApplicant(tx, this.outbox, app.applicantUserId, `DSCC ই-রিকশা: আবেদন ${app.applicationNumber}-এর নম্বর প্লেট ${plateTextBn} (${plateSystemId}) ইস্যু হয়েছে। প্লেট ও QR কোড সংগ্রহ করুন।`);
      return { ...this.regView(reg), qr: { version: cred.version, ...(await this.qrPayload(city.code, cred)) } };
    });
  }

  /** Revoke the active QR credential and issue the next version (lost, damaged or compromised plate/QR). */
  async reissueQr(s: StaffContext, registrationId: string, body: unknown, ip: string | null) {
    const input = parseOrThrow(reissueSchema, body);
    if (!UUID_RE.test(registrationId)) throw notFound();
    const city = await this.cities.byId(s.cityId);
    return this.prisma.inCity(s.cityId, async (tx) => {
      await tx.$queryRaw`SELECT id FROM registrations WHERE id = ${registrationId}::uuid FOR UPDATE`;
      const reg = await tx.registration.findUnique({ where: { id: registrationId } });
      if (!reg) throw notFound();
      await loadStaffApplication(tx, s, reg.applicationId);
      await this.stepUp.verify(tx, s.staffId, input.totp, 'reissue_qr');
      if (reg.status !== 'ACTIVE') throw conflict('REGISTRATION_NOT_ACTIVE');
      const current = await tx.qrCredential.findFirst({ where: { registrationId: reg.id, status: 'ACTIVE' } });
      const last = await tx.qrCredential.findFirst({ where: { registrationId: reg.id }, orderBy: { version: 'desc' } });
      if (current) await tx.qrCredential.update({ where: { id: current.id }, data: { status: 'REVOKED', revokedAt: new Date(), revokeReason: input.reason } });
      const cred = await this.createCredential(tx, s.cityId, reg.id, (last?.version ?? 0) + 1, s.staffId);
      await this.audit.record(tx, { cityId: s.cityId, actorType: 'STAFF', actorId: s.staffId, action: 'qr.reissued', entityType: 'registration', entityId: reg.id, data: { reason: input.reason, revokedVersion: current?.version ?? null, newVersion: cred.version }, ip });
      return { ...this.regView(reg), qr: { version: cred.version, ...(await this.qrPayload(city.code, cred)) } };
    });
  }

  regView(r: { id: string; plateSystemId: string; plateTextBn: string; registeredOn: Date; validUntil: Date; endOfLifeOn: Date; status: string; issuedAt: Date }) {
    return {
      id: r.id,
      plateSystemId: r.plateSystemId,
      plateTextBn: r.plateTextBn,
      registeredOn: isoDate(r.registeredOn),
      validUntil: isoDate(r.validUntil),
      endOfLifeOn: isoDate(r.endOfLifeOn),
      status: r.status,
      issuedAt: r.issuedAt,
    };
  }

  /** Registration with the active QR, for the plate officer or the owner. */
  async registrationFor(tx: Tx, cityCode: string, applicationId: string) {
    const reg = await tx.registration.findUnique({ where: { applicationId } });
    if (!reg) return null;
    const cred = await tx.qrCredential.findFirst({ where: { registrationId: reg.id, status: 'ACTIVE' } });
    const zone = await tx.zone.findUniqueOrThrow({ where: { id: reg.zoneId } });
    return {
      ...this.regView(reg),
      zone: { code: zone.code, nameBn: zone.nameBn, nameEn: zone.nameEn, uiColour: zone.uiColour, plateBackgroundColour: zone.plateBackgroundColour },
      qr: cred ? { version: cred.version, ...(await this.qrPayload(cityCode, cred)) } : null,
    };
  }

  async staffRegistration(s: StaffContext, applicationId: string) {
    const city = await this.cities.byId(s.cityId);
    return this.prisma.inCity(s.cityId, async (tx) => {
      const app = await loadStaffApplication(tx, s, applicationId);
      const r = await this.registrationFor(tx, city.code, app.id);
      if (!r) throw notFound();
      return r;
    });
  }

  // ─── Public verification (anyone scanning the QR) ───
  private rateLimited(ip: string): boolean {
    const now = Date.now();
    const w = this.scanWindow.get(ip);
    if (!w || w.resetAt < now) {
      if (this.scanWindow.size > 10_000) this.scanWindow.clear();
      this.scanWindow.set(ip, { count: 1, resetAt: now + 60_000 });
      return false;
    }
    w.count++;
    return w.count > 60;
  }

  async publicVerify(token: string, ip: string | null) {
    if (ip && this.rateLimited(ip)) throw new AppError('RATE_LIMITED', 429);
    const parsed = parseQrToken(token);
    if (!parsed || !ed25519Verify(this.keys.publicKey, parsed.message, parsed.signature)) return { result: 'INVALID' as const };
    const city = await this.cities.byCode(parsed.cityCode).catch(() => null);
    if (!city) return { result: 'INVALID' as const };
    return this.prisma.inCity(city.id, async (tx) => {
      const cred = await tx.qrCredential.findUnique({ where: { tokenId: parsed.tokenId } });
      const log = async (result: string) =>
        tx.qrScanEvent.create({ data: { cityId: city.id, tokenId: parsed.tokenId, result, ipHash: ip ? hmacHex(this.config.SESSION_HMAC_KEY, `scan:${ip}`) : null } });
      if (!cred || cred.version !== parsed.version) {
        await log('UNKNOWN');
        return { result: 'UNKNOWN' as const };
      }
      const reg = await tx.registration.findUniqueOrThrow({ where: { id: cred.registrationId } });
      const [vehicle, zone] = await Promise.all([
        tx.vehicle.findUniqueOrThrow({ where: { id: reg.vehicleId } }),
        tx.zone.findUniqueOrThrow({ where: { id: reg.zoneId } }),
      ]);
      const model = await tx.approvedModel.findUnique({ where: { id: vehicle.modelId }, include: { manufacturer: true } });
      const cert = await InspectionService.validCertificate(tx, reg.applicationId);
      const today = dhakaToday();
      const expired = isoDate(reg.validUntil)! < today;
      const result = cred.status === 'REVOKED' ? 'REVOKED' : reg.status !== 'ACTIVE' ? reg.status : expired ? 'EXPIRED' : 'VALID';
      await log(result);
      // Deliberately no owner/driver name, NID, phone or address (Phase 0: public scan view).
      return {
        result,
        city: { code: city.code, nameBn: city.nameBn, nameEn: city.nameEn },
        plate: { systemId: reg.plateSystemId, textBn: reg.plateTextBn },
        zone: { code: zone.code, nameBn: zone.nameBn, nameEn: zone.nameEn, uiColour: zone.uiColour },
        registration: { status: reg.status, registeredOn: isoDate(reg.registeredOn), validUntil: isoDate(reg.validUntil), endOfLifeOn: isoDate(reg.endOfLifeOn) },
        fitness: cert ? { validUntil: isoDate(cert.validUntil), valid: true } : { validUntil: null, valid: false },
        vehicle: { seatType: vehicle.seatType, model: model ? `${model.manufacturer.nameBn} ${model.name}` : null, colour: vehicle.colour },
        qr: { version: cred.version, status: cred.status },
        checkedAt: new Date().toISOString(),
      };
    });
  }
}
