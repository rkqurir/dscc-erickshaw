import { Injectable } from '@nestjs/common';
import {
  DECISION_DEADLINE_WORKING_DAYS,
  DOCUMENT_TYPE_LIST,
  DocumentType,
  REQUIRED_DOCUMENT_TYPES,
  addWorkingDays,
  applicationDraftSchema,
  applicationSubmitSchema,
  dhakaYear,
  formatApplicationNumber,
  maskNid,
  nextStatus,
  normalizeNid,
  ApplicationStatus,
} from '@dscc/domain';
import { AuditService } from '../../platform/audit.service';
import { CityService } from '../../platform/city.service';
import { sha256Hex, uuidv7 } from '../../platform/crypto';
import { AppError, badRequest, conflict, notFound, parseOrThrow, validationError } from '../../platform/errors';
import { OutboxService } from '../../platform/outbox.service';
import { PrismaService, Tx } from '../../platform/prisma.service';
import { OwnerService } from '../owners/owners';
import { QuotaService } from '../owners/quota.service';
import { FilesService, UploadedFileInput } from './files.service';

const MAX_OPEN_DRAFTS = 5;

export interface Actor {
  userId: string;
  ip: string | null;
}

@Injectable()
export class ApplicationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cities: CityService,
    private readonly owners: OwnerService,
    private readonly quota: QuotaService,
    private readonly files: FilesService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  private async city() {
    return this.cities.defaultCity();
  }

  /** Load an application owned by this citizen; anything else is reported as not found (no IDOR oracle). */
  private async ownApplication(tx: Tx, id: string, userId: string, lock = false) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound();
    if (lock) await tx.$queryRaw`SELECT id FROM applications WHERE id = ${id}::uuid FOR UPDATE`;
    const app = await tx.application.findFirst({ where: { id, applicantUserId: userId, deletedAt: null } });
    if (!app) throw notFound();
    return app;
  }

  async createDraft(actor: Actor) {
    const ownerId = await this.owners.requireOwnerId(actor.userId);
    const city = await this.city();
    return this.prisma.inCity(city.id, async (tx) => {
      const drafts = await tx.application.count({ where: { applicantUserId: actor.userId, status: 'DRAFT', deletedAt: null } });
      if (drafts >= MAX_OPEN_DRAFTS) throw conflict('DRAFT_LIMIT_REACHED');
      const app = await tx.application.create({
        data: { cityId: city.id, applicantUserId: actor.userId, ownerIdentityId: ownerId, status: 'DRAFT', formData: {} },
      });
      await tx.applicationStatusEvent.create({
        data: { applicationId: app.id, cityId: city.id, fromStatus: null, toStatus: 'DRAFT', actorType: 'USER', actorId: actor.userId },
      });
      return { id: app.id, status: app.status, version: app.version };
    });
  }

  async list(userId: string) {
    const city = await this.city();
    return this.prisma.inCity(city.id, async (tx) => {
      const apps = await tx.application.findMany({
        where: { applicantUserId: userId, deletedAt: null },
        orderBy: { createdAt: 'desc' },
      });
      const zones = await tx.zone.findMany();
      const zmap = new Map(zones.map((z) => [z.id, z]));
      return apps.map((a) => {
        const z = a.zoneId ? zmap.get(a.zoneId) : undefined;
        const f = a.formData as { vehicle?: { chassisNo?: string } };
        return {
          id: a.id,
          applicationNumber: a.applicationNumber,
          status: a.status,
          createdAt: a.createdAt,
          submittedAt: a.submittedAt,
          decisionDueDate: a.decisionDueDate ? a.decisionDueDate.toISOString().slice(0, 10) : null,
          zone: z ? { code: z.code, nameBn: z.nameBn, nameEn: z.nameEn, uiColour: z.uiColour } : null,
          chassisNo: typeof f.vehicle?.chassisNo === 'string' ? f.vehicle.chassisNo : null,
        };
      });
    });
  }

  async get(id: string, userId: string) {
    const city = await this.city();
    return this.prisma.inCity(city.id, async (tx) => {
      const app = await this.ownApplication(tx, id, userId);
      const docs = await tx.applicationDocument.findMany({
        where: { applicationId: app.id, supersededAt: null },
        include: { file: true },
        orderBy: { uploadedAt: 'asc' },
      });
      const events = await tx.applicationStatusEvent.findMany({ where: { applicationId: app.id }, orderBy: { createdAt: 'asc' } });
      return {
        id: app.id,
        applicationNumber: app.applicationNumber,
        status: app.status,
        version: app.version,
        form: app.formData,
        createdAt: app.createdAt,
        submittedAt: app.submittedAt,
        withdrawnAt: app.withdrawnAt,
        decisionDueDate: app.decisionDueDate ? app.decisionDueDate.toISOString().slice(0, 10) : null,
        documents: docs.map((d) => ({
          id: d.id,
          docType: d.docType,
          originalName: d.file.originalName,
          mimeType: d.file.mimeType,
          sizeBytes: d.file.sizeBytes,
          uploadedAt: d.uploadedAt,
        })),
        timeline: events.map((e) => ({ fromStatus: e.fromStatus, toStatus: e.toStatus, actorType: e.actorType, note: e.note, at: e.createdAt })),
        requiredDocuments: REQUIRED_DOCUMENT_TYPES,
      };
    });
  }

  async saveDraft(id: string, userId: string, body: unknown) {
    const parsed = parseOrThrow(applicationDraftSchema, (body as { form?: unknown })?.form ?? {});
    const version = Number((body as { version?: unknown })?.version);
    if (!Number.isInteger(version)) throw badRequest('VALIDATION_FAILED', { fields: { version: 'REQUIRED' } });
    const city = await this.city();
    return this.prisma.inCity(city.id, async (tx) => {
      const app = await this.ownApplication(tx, id, userId);
      if (app.status !== 'DRAFT') throw conflict('APPLICATION_INVALID_STATE');
      const loc = parsed.location as { zoneId?: unknown; wardId?: unknown } | undefined;
      const uuid = (v: unknown) => (typeof v === 'string' && /^[0-9a-f-]{36}$/i.test(v) ? v : null);
      const upd = await tx.application.updateMany({
        where: { id: app.id, version },
        data: { formData: parsed as object, version: { increment: 1 }, zoneId: uuid(loc?.zoneId), wardId: uuid(loc?.wardId) },
      });
      if (upd.count !== 1) throw conflict('CONFLICT');
      return { id: app.id, version: version + 1, savedAt: new Date() };
    });
  }

  async deleteDraft(id: string, userId: string) {
    const city = await this.city();
    await this.prisma.inCity(city.id, async (tx) => {
      const app = await this.ownApplication(tx, id, userId, true);
      if (app.status !== 'DRAFT') throw conflict('APPLICATION_INVALID_STATE');
      await tx.application.update({ where: { id: app.id }, data: { deletedAt: new Date() } });
    });
  }

  async uploadDocument(id: string, actor: Actor, docType: string, file: UploadedFileInput | undefined) {
    if (!DOCUMENT_TYPE_LIST.includes(docType as DocumentType)) throw badRequest('DOCUMENT_TYPE_INVALID');
    if (!file) throw badRequest('FILE_TYPE_NOT_ALLOWED');
    const city = await this.city();
    return this.prisma.inCity(city.id, async (tx) => {
      const app = await this.ownApplication(tx, id, actor.userId, true);
      if (app.status !== 'DRAFT') throw conflict('APPLICATION_INVALID_STATE');
      const stored = await this.files.store(tx, { cityId: city.id, ownerUserId: actor.userId, file });
      await tx.applicationDocument.updateMany({
        where: { applicationId: app.id, docType, supersededAt: null },
        data: { supersededAt: new Date() },
      });
      const doc = await tx.applicationDocument.create({
        data: { applicationId: app.id, cityId: city.id, docType, fileId: stored.id },
      });
      await this.audit.record(tx, {
        cityId: city.id,
        actorType: 'USER',
        actorId: actor.userId,
        action: 'application.document_uploaded',
        entityType: 'application',
        entityId: app.id,
        data: { docType, sha256: stored.sha256, sizeBytes: stored.sizeBytes, mimeType: stored.mimeType },
        ip: actor.ip,
      });
      return { id: doc.id, docType, mimeType: stored.mimeType, sizeBytes: stored.sizeBytes, originalName: file.originalname };
    }, { timeout: 30_000 });
  }

  async readDocument(id: string, docId: string, userId: string) {
    const city = await this.city();
    const meta = await this.prisma.inCity(city.id, async (tx) => {
      const app = await this.ownApplication(tx, id, userId);
      if (!/^[0-9a-f-]{36}$/i.test(docId)) throw notFound();
      const doc = await tx.applicationDocument.findFirst({ where: { id: docId, applicationId: app.id }, include: { file: true } });
      if (!doc) throw notFound();
      return doc.file;
    });
    return { meta, data: await this.files.read(meta.storageKey) };
  }

  /**
   * Submit: validates the complete form and documents, reserves a quota slot (Rule 4(8)),
   * allocates DSCC-YYYY-NNNNNN and records an immutable revision — all in one transaction.
   */
  async submit(id: string, actor: Actor, idempotencyKey: string | undefined) {
    if (idempotencyKey !== undefined && !/^[A-Za-z0-9_-]{8,100}$/.test(idempotencyKey)) {
      throw badRequest('VALIDATION_FAILED', { fields: { 'Idempotency-Key': 'INVALID' } });
    }
    const city = await this.city();
    const holidays = await this.cities.holidays();
    return this.prisma.inCity(
      city.id,
      async (tx) => {
        const app = await this.ownApplication(tx, id, actor.userId, true);
        const scope = `user:${actor.userId}`;
        const requestHash = sha256Hex(`submit:${app.id}`);
        if (idempotencyKey) {
          const prev = await tx.idempotencyKey.findUnique({ where: { scope_key: { scope, key: idempotencyKey } } });
          if (prev) {
            if (prev.requestHash !== requestHash) throw conflict('IDEMPOTENCY_KEY_REUSED');
            return prev.response as Record<string, unknown>;
          }
        }
        const to = nextStatus(app.status as ApplicationStatus, 'SUBMIT');
        if (!to) throw conflict('APPLICATION_INVALID_STATE');

        const r = applicationSubmitSchema.safeParse(app.formData);
        if (!r.success) {
          const e = validationError(r.error);
          throw new AppError('APPLICATION_INCOMPLETE', 400, e.details);
        }
        const form = r.data;

        const docs = await tx.applicationDocument.findMany({ where: { applicationId: app.id, supersededAt: null }, include: { file: true } });
        const present = new Set(docs.map((d) => d.docType));
        const missing = REQUIRED_DOCUMENT_TYPES.filter((t) => !present.has(t));
        if (missing.length) throw new AppError('DOCUMENTS_MISSING', 400, { missing });

        const ward = await tx.ward.findUnique({ where: { id: form.location.wardId } });
        const zone = await tx.zone.findUnique({ where: { id: form.location.zoneId } });
        if (!zone || !ward || ward.zoneId !== zone.id) throw badRequest('ZONE_WARD_MISMATCH');
        const model = await tx.approvedModel.findUnique({ where: { id: form.vehicle.modelId } });
        if (!model || !model.isActive) throw badRequest('VALIDATION_FAILED', { fields: { 'vehicle.modelId': 'REQUIRED' } });
        if (model.seatType !== form.vehicle.seatType) throw badRequest('MODEL_SEAT_MISMATCH');

        const live = await tx.vehicle.findFirst({
          where: { OR: [{ chassisNo: form.vehicle.chassisNo }, { motorNo: form.vehicle.motorNo }], status: { notIn: ['WITHDRAWN', 'REJECTED'] } },
          select: { chassisNo: true },
        });
        if (live) throw conflict(live.chassisNo === form.vehicle.chassisNo ? 'CHASSIS_ALREADY_REGISTERED' : 'MOTOR_ALREADY_REGISTERED');

        const vehicleId = uuidv7();
        await tx.$executeRaw`
          INSERT INTO vehicles (id, city_id, owner_identity_id, model_id, seat_type, chassis_no, motor_no, manufacture_year,
            battery_type, has_speedometer, insurance_policy_no, colour, zone_id, ward_id, charging_location, status)
          VALUES (${vehicleId}::uuid, ${city.id}::uuid, ${app.ownerIdentityId}::uuid, ${model.id}::uuid, ${form.vehicle.seatType},
            ${form.vehicle.chassisNo}, ${form.vehicle.motorNo}, ${form.vehicle.manufactureYear}, ${form.vehicle.batteryType},
            ${form.vehicle.hasSpeedometer}, ${form.vehicle.insurancePolicyNo ?? null}, ${form.vehicle.colour ?? null},
            ${zone.id}::uuid, ${ward.id}::uuid, ${form.location.chargingLocation}, 'PENDING_APPROVAL')`;

        await this.quota.reserve(tx, {
          ownerIdentityId: app.ownerIdentityId,
          vehicleId,
          cityId: city.id,
          source: 'APPLICATION_SUBMIT',
          actor: { type: 'USER', id: actor.userId },
        });

        const dn = normalizeNid(form.driver.nid, form.driver.dateOfBirth);
        if (!dn.ok) throw badRequest('VALIDATION_FAILED', { fields: { 'driver.nid': dn.error } });
        const driver = await tx.driver.create({
          data: {
            cityId: city.id,
            nidHmac: this.owners.nidHmac(dn.value.canonical),
            nidEncrypted: this.owners.encryptNid(dn.value.digits),
            nidLast4: dn.value.digits.slice(-4),
            nameBn: form.driver.nameBn,
            nameEn: form.driver.nameEn ?? null,
            dateOfBirth: new Date(`${form.driver.dateOfBirth}T00:00:00Z`),
            phoneE164: form.driver.phone,
            address: form.driver.address,
            trainingCertificateNo: form.driver.trainingCertificateNo ?? null,
          },
        });
        await tx.vehicleDriverAssignment.create({ data: { cityId: city.id, vehicleId, driverId: driver.id } });

        const now = new Date();
        const year = dhakaYear(now);
        const counter = await tx.$queryRaw<{ last_value: number }[]>`
          INSERT INTO application_counters (city_id, year, last_value) VALUES (${city.id}::uuid, ${year}, 1)
          ON CONFLICT (city_id, year) DO UPDATE SET last_value = application_counters.last_value + 1
          RETURNING last_value`;
        const applicationNumber = formatApplicationNumber(city.code, year, counter[0].last_value);
        const due = addWorkingDays(now, DECISION_DEADLINE_WORKING_DAYS, holidays);

        await tx.application.update({
          where: { id: app.id },
          data: {
            status: to,
            applicationNumber,
            submittedAt: now,
            vehicleId,
            zoneId: zone.id,
            wardId: ward.id,
            decisionDueDate: new Date(`${due}T00:00:00Z`),
            version: { increment: 1 },
            formData: form as object,
          },
        });
        const revCount = await tx.applicationRevision.count({ where: { applicationId: app.id } });
        // Snapshot keeps NIDs masked: the encrypted originals live in owner_identities / drivers.
        const snapshotForm = { ...form, driver: { ...form.driver, nid: maskNid(dn.value.digits) } };
        await tx.applicationRevision.create({
          data: {
            applicationId: app.id,
            cityId: city.id,
            revisionNo: revCount + 1,
            snapshot: {
              applicationNumber,
              form: snapshotForm,
              documents: docs.map((d) => ({ docType: d.docType, fileId: d.fileId, sha256: d.file.sha256 })),
              submittedAt: now.toISOString(),
            },
          },
        });
        await tx.applicationStatusEvent.create({
          data: { applicationId: app.id, cityId: city.id, fromStatus: app.status, toStatus: to, actorType: 'USER', actorId: actor.userId },
        });
        const user = await tx.user.findUniqueOrThrow({ where: { id: actor.userId } });
        await this.outbox.enqueue(tx, 'sms.send', {
          to: user.phoneE164,
          body: `DSCC ই-রিকশা: আপনার আবেদন ${applicationNumber} সফলভাবে জমা হয়েছে। সিদ্ধান্তের শেষ তারিখ ${due}।`,
        });
        await this.audit.record(tx, {
          cityId: city.id,
          actorType: 'USER',
          actorId: actor.userId,
          action: 'application.submitted',
          entityType: 'application',
          entityId: app.id,
          data: { applicationNumber, vehicleId, zone: zone.code },
          ip: actor.ip,
        });
        const response = { id: app.id, applicationNumber, status: to, submittedAt: now.toISOString(), decisionDueDate: due };
        if (idempotencyKey) {
          await tx.idempotencyKey.create({ data: { scope, key: idempotencyKey, requestHash, statusCode: 200, response } });
        }
        return response;
      },
      { timeout: 30_000 },
    );
  }

  /** Withdraw a submitted application; releases the owner's quota slot in the same transaction. */
  async withdraw(id: string, actor: Actor) {
    const city = await this.city();
    return this.prisma.inCity(city.id, async (tx) => {
      const app = await this.ownApplication(tx, id, actor.userId, true);
      const to = nextStatus(app.status as ApplicationStatus, 'WITHDRAW');
      if (!to) throw conflict('APPLICATION_INVALID_STATE');
      const now = new Date();
      await tx.application.update({ where: { id: app.id }, data: { status: to, withdrawnAt: now, version: { increment: 1 } } });
      if (app.vehicleId) {
        await tx.vehicle.update({ where: { id: app.vehicleId }, data: { status: 'WITHDRAWN' } });
        await tx.vehicleDriverAssignment.updateMany({ where: { vehicleId: app.vehicleId, validTo: null }, data: { validTo: now } });
        await this.quota.release(tx, { vehicleId: app.vehicleId, cityId: city.id, reason: 'APPLICATION_WITHDRAWN', actor: { type: 'USER', id: actor.userId } });
      }
      await tx.applicationStatusEvent.create({
        data: { applicationId: app.id, cityId: city.id, fromStatus: app.status, toStatus: to, actorType: 'USER', actorId: actor.userId },
      });
      await this.audit.record(tx, {
        cityId: city.id,
        actorType: 'USER',
        actorId: actor.userId,
        action: 'application.withdrawn',
        entityType: 'application',
        entityId: app.id,
        data: { applicationNumber: app.applicationNumber },
        ip: actor.ip,
      });
      return { id: app.id, status: to };
    });
  }
}
