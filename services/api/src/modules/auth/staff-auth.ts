import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import QRCode from 'qrcode';
import { z } from 'zod';
import { AppConfig, CONFIG } from '../../config';
import { AuditService } from '../../platform/audit.service';
import { decryptField, encryptField, verifyPassword } from '../../platform/crypto';
import { AppError, conflict, parseOrThrow, unauthorized } from '../../platform/errors';
import { PrismaService } from '../../platform/prisma.service';
import { generateTotpSecret, otpauthUri, verifyTotp } from '../../platform/totp';
import { PendingStaff, RequirePermissions, Staff, StaffContext, StaffGuard, StaffPendingMfaGuard } from './guards';
import { STAFF_COOKIE, SessionService } from './session.service';

const MAX_FAILURES = 5;
const LOCK_MS = 15 * 60_000;
// Constant-time-ish path for unknown emails: compare against a fixed dummy hash.
const DUMMY_HASH = 'scrypt$16384$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

const loginSchema = z.object({ email: z.string().trim().toLowerCase().email().max(200), password: z.string().min(1).max(200) });
const codeSchema = z.object({ code: z.string().regex(/^\d{6}$/, 'MFA_INVALID') });

@Controller('staff/auth')
export class StaffAuthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  @Post('login')
  @HttpCode(200)
  async login(@Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const r = loginSchema.safeParse(body);
    if (!r.success) throw new AppError('STAFF_LOGIN_FAILED', 401);
    const staff = await this.prisma.staffAccount.findUnique({ where: { email: r.data.email } });
    if (!staff || staff.status !== 'ACTIVE') {
      await verifyPassword(r.data.password, DUMMY_HASH).catch(() => false);
      throw new AppError('STAFF_LOGIN_FAILED', 401);
    }
    if (staff.lockedUntil && staff.lockedUntil.getTime() > Date.now()) throw new AppError('STAFF_LOCKED', 423);
    const ok = await verifyPassword(r.data.password, staff.passwordHash);
    if (!ok) {
      await this.registerFailure(staff.id, staff.cityId, req, 'password');
      throw new AppError('STAFF_LOGIN_FAILED', 401);
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.staffAccount.update({ where: { id: staff.id }, data: { failedAttempts: 0, lockedUntil: null } });
      await this.audit.record(tx, {
        cityId: staff.cityId,
        actorType: 'STAFF',
        actorId: staff.id,
        action: 'staff.password_ok',
        entityType: 'staff',
        entityId: staff.id,
        ip: req.ip,
      });
    });
    const token = await this.sessions.create({ type: 'STAFF', staffId: staff.id }, req, false);
    this.sessions.setCookie(res, STAFF_COOKIE, token, 'STAFF');
    return { mfaEnrolled: !!staff.mfaEnrolledAt };
  }

  private async registerFailure(staffId: string, cityId: string, req: Request, factor: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ failed_attempts: number }[]>`
        UPDATE staff_accounts SET failed_attempts = failed_attempts + 1 WHERE id = ${staffId}::uuid RETURNING failed_attempts`;
      const n = rows[0]?.failed_attempts ?? 0;
      if (n >= MAX_FAILURES) {
        await tx.staffAccount.update({ where: { id: staffId }, data: { lockedUntil: new Date(Date.now() + LOCK_MS), failedAttempts: 0 } });
      }
      await this.audit.record(tx, {
        cityId,
        actorType: 'STAFF',
        actorId: staffId,
        action: n >= MAX_FAILURES ? 'staff.locked' : 'staff.login_failed',
        entityType: 'staff',
        entityId: staffId,
        data: { factor },
        ip: req.ip,
      });
    });
  }

  /** First login: generate a TOTP secret and show it as a QR code for an authenticator app. */
  @Get('mfa/enrollment')
  @UseGuards(StaffPendingMfaGuard)
  async enrollment(@PendingStaff() p: { staffId: string }) {
    const staff = await this.prisma.staffAccount.findUniqueOrThrow({ where: { id: p.staffId } });
    if (staff.mfaEnrolledAt) throw conflict('MFA_ALREADY_ENROLLED');
    let secret: string;
    if (staff.totpSecretEnc) {
      secret = decryptField(this.config.DATA_ENCRYPTION_KEY, staff.totpSecretEnc);
    } else {
      secret = generateTotpSecret();
      await this.prisma.staffAccount.update({
        where: { id: staff.id },
        data: { totpSecretEnc: encryptField(this.config.DATA_ENCRYPTION_KEY, secret) },
      });
    }
    const uri = otpauthUri(secret, staff.email);
    return { secret, otpauthUri: uri, qrDataUrl: await QRCode.toDataURL(uri, { margin: 1, width: 220 }) };
  }

  @Post('mfa/verify')
  @HttpCode(200)
  @UseGuards(StaffPendingMfaGuard)
  async verifyMfa(@PendingStaff() p: { sessionId: string; staffId: string }, @Body() body: unknown, @Req() req: Request) {
    const { code } = parseOrThrow(codeSchema, body);
    const staff = await this.prisma.staffAccount.findUniqueOrThrow({ where: { id: p.staffId } });
    if (staff.lockedUntil && staff.lockedUntil.getTime() > Date.now()) throw new AppError('STAFF_LOCKED', 423);
    if (!staff.totpSecretEnc) throw unauthorized('MFA_REQUIRED');
    const secret = decryptField(this.config.DATA_ENCRYPTION_KEY, staff.totpSecretEnc);
    const step = verifyTotp(secret, code, Date.now(), staff.lastTotpStep);
    if (step === null) {
      await this.registerFailure(staff.id, staff.cityId, req, 'totp');
      throw new AppError('MFA_INVALID', 401);
    }
    await this.prisma.$transaction(async (tx) => {
      // Compare-and-set on the step prevents replay of the same code in a parallel request.
      const upd = await tx.staffAccount.updateMany({
        where: { id: staff.id, OR: [{ lastTotpStep: null }, { lastTotpStep: { lt: step } }] },
        data: { lastTotpStep: step, failedAttempts: 0, mfaEnrolledAt: staff.mfaEnrolledAt ?? new Date() },
      });
      if (upd.count !== 1) throw new AppError('MFA_INVALID', 401);
      await this.audit.record(tx, {
        cityId: staff.cityId,
        actorType: 'STAFF',
        actorId: staff.id,
        action: staff.mfaEnrolledAt ? 'staff.login' : 'staff.mfa_enrolled',
        entityType: 'staff',
        entityId: staff.id,
        ip: req.ip,
      });
    });
    await this.sessions.markMfaVerified(p.sessionId);
    return { ok: true };
  }

  @Get('me')
  @UseGuards(StaffGuard)
  @RequirePermissions()
  me(@Staff() s: StaffContext) {
    return { email: s.email, fullName: s.fullName, roles: s.roles, permissions: [...s.permissions].sort() };
  }

  @Post('logout')
  @HttpCode(204)
  @UseGuards(StaffPendingMfaGuard)
  async logout(@PendingStaff() p: { sessionId: string }, @Res({ passthrough: true }) res: Response) {
    await this.sessions.revoke(p.sessionId);
    this.sessions.clearCookie(res, STAFF_COOKIE);
  }
}
