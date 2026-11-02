import { Body, Controller, Get, HttpCode, Inject, Injectable, Post, Req, Res, UseGuards } from '@nestjs/common';
import { bdMobileSchema, maskNid, maskPhone } from '@dscc/domain';
import type { Request, Response } from 'express';
import { randomInt } from 'node:crypto';
import { z } from 'zod';
import { AppConfig, CONFIG } from '../../config';
import { AuditService } from '../../platform/audit.service';
import { hmacHex, safeEqualHex } from '../../platform/crypto';
import { AppError, badRequest, parseOrThrow } from '../../platform/errors';
import { OutboxService } from '../../platform/outbox.service';
import { PrismaService } from '../../platform/prisma.service';
import { Citizen, CitizenContext, CitizenGuard, PRIVACY_NOTICE_VERSION, SkipConsent } from './guards';
import { CITIZEN_COOKIE, SessionService } from './session.service';

export const OTP_POLICY = {
  ttlMs: 5 * 60_000,
  maxAttempts: 5,
  resendCooldownMs: 60_000,
  perPhonePerHour: 5,
};

@Injectable()
export class OtpService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
    private readonly audit: AuditService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  private codeHash(challengeId: string, code: string): string {
    return hmacHex(this.config.OTP_HMAC_KEY, `${challengeId}:${code}`);
  }

  async request(phoneE164: string, ip: string | null): Promise<{ challengeId: string; expiresInSeconds: number; resendAfterSeconds: number }> {
    return this.prisma.$transaction(async (tx) => {
      // Serialize concurrent requests for the same phone so cooldown/limits cannot be raced.
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${"otp:" + phoneE164}))::text AS locked`;
      const hourAgo = new Date(Date.now() - 3600_000);
      const recent = await tx.otpChallenge.findMany({
        where: { phoneE164, createdAt: { gt: hourAgo } },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      });
      if (recent[0] && Date.now() - recent[0].createdAt.getTime() < OTP_POLICY.resendCooldownMs) {
        throw new AppError('OTP_RESEND_COOLDOWN', 429);
      }
      if (recent.length >= OTP_POLICY.perPhonePerHour) throw new AppError('RATE_LIMITED', 429);
      if (ip) {
        const ipCount = await tx.otpChallenge.count({ where: { ip, createdAt: { gt: hourAgo } } });
        if (ipCount >= this.config.OTP_IP_HOURLY_LIMIT) throw new AppError('RATE_LIMITED', 429);
      }
      const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
      const ch = await tx.otpChallenge.create({
        data: { phoneE164, codeHash: 'pending', ip, expiresAt: new Date(Date.now() + OTP_POLICY.ttlMs) },
      });
      await tx.otpChallenge.update({ where: { id: ch.id }, data: { codeHash: this.codeHash(ch.id, code) } });
      await this.outbox.enqueue(tx, 'sms.send', {
        to: phoneE164,
        body: `DSCC ই-রিকশা: আপনার OTP ${code}। মেয়াদ ৫ মিনিট। কাউকে এই কোড জানাবেন না।`,
      });
      return { challengeId: ch.id, expiresInSeconds: OTP_POLICY.ttlMs / 1000, resendAfterSeconds: OTP_POLICY.resendCooldownMs / 1000 };
    });
  }

  /** Returns the verified phone number, or throws OTP_INVALID (same error for every failure mode). */
  async verify(challengeId: string, code: string): Promise<string> {
    const invalid = new AppError('OTP_INVALID', 400);
    if (!/^[0-9a-f-]{36}$/.test(challengeId) || !/^\d{6}$/.test(code)) throw invalid;
    // Consume one attempt atomically before comparing.
    const rows = await this.prisma.$queryRaw<{ id: string; phone_e164: string; code_hash: string }[]>`
      UPDATE otp_challenges SET attempts = attempts + 1
      WHERE id = ${challengeId}::uuid AND consumed_at IS NULL AND expires_at > now() AND attempts < ${OTP_POLICY.maxAttempts}
      RETURNING id, phone_e164, code_hash`;
    const ch = rows[0];
    if (!ch || !safeEqualHex(ch.code_hash, this.codeHash(ch.id, code))) throw invalid;
    const consumed = await this.prisma.otpChallenge.updateMany({
      where: { id: ch.id, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    if (consumed.count !== 1) throw invalid;
    return ch.phone_e164;
  }
}

const requestSchema = z.object({ phone: bdMobileSchema });
const verifySchema = z.object({ challengeId: z.string(), code: z.string() });
const consentSchema = z.object({ noticeVersion: z.literal(PRIVACY_NOTICE_VERSION) });

@Controller('auth')
export class CitizenAuthController {
  constructor(
    private readonly otp: OtpService,
    private readonly sessions: SessionService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Same response whether or not the number is already registered (no account enumeration). */
  @Post('otp/request')
  @HttpCode(200)
  async requestOtp(@Body() body: unknown, @Req() req: Request) {
    const { phone } = parseOrThrow(requestSchema, body);
    return this.otp.request(phone, req.ip ?? null);
  }

  @Post('otp/verify')
  @HttpCode(200)
  async verifyOtp(@Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const { challengeId, code } = parseOrThrow(verifySchema, body);
    const phone = await this.otp.verify(challengeId, code);
    const user = await this.prisma.$transaction(async (tx) => {
      const u = await tx.user.upsert({
        where: { phoneE164: phone },
        create: { phoneE164: phone, lastLoginAt: new Date() },
        update: { lastLoginAt: new Date() },
      });
      if (u.status !== 'ACTIVE') throw new AppError('UNAUTHENTICATED', 401);
      await this.audit.record(tx, {
        actorType: 'USER',
        actorId: u.id,
        action: 'citizen.login',
        entityType: 'user',
        entityId: u.id,
        data: { phone: maskPhone(phone) },
        ip: req.ip,
      });
      return u;
    });
    const token = await this.sessions.create({ type: 'USER', userId: user.id }, req);
    this.sessions.setCookie(res, CITIZEN_COOKIE, token, 'USER');
    const consent = await this.prisma.consent.findUnique({
      where: { userId_noticeVersion: { userId: user.id, noticeVersion: PRIVACY_NOTICE_VERSION } },
    });
    return { phone: user.phoneE164, needsConsent: !consent };
  }

  @Post('logout')
  @HttpCode(204)
  @UseGuards(CitizenGuard)
  @SkipConsent()
  async logout(@Citizen() c: CitizenContext, @Res({ passthrough: true }) res: Response) {
    await this.sessions.revoke(c.sessionId);
    this.sessions.clearCookie(res, CITIZEN_COOKIE);
  }
}

@Controller('me')
@UseGuards(CitizenGuard)
@SkipConsent()
export class MeController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  async me(@Citizen() c: CitizenContext) {
    const acct = await this.prisma.ownerAccount.findUnique({ where: { userId: c.userId }, include: { ownerIdentity: true } });
    const o = acct?.ownerIdentity;
    return {
      phone: c.phoneE164,
      hasConsent: c.hasConsent,
      privacyNoticeVersion: PRIVACY_NOTICE_VERSION,
      owner: o
        ? {
            nameBn: o.nameBn,
            nameEn: o.nameEn,
            nidMasked: maskNid(o.nidLast4),
            verificationStatus: o.verificationStatus,
          }
        : null,
    };
  }

  @Post('consent')
  @HttpCode(200)
  async consent(@Citizen() c: CitizenContext, @Body() body: unknown, @Req() req: Request) {
    const r = consentSchema.safeParse(body);
    if (!r.success) throw badRequest('VALIDATION_FAILED');
    await this.prisma.$transaction(async (tx) => {
      await tx.consent.upsert({
        where: { userId_noticeVersion: { userId: c.userId, noticeVersion: r.data.noticeVersion } },
        create: { userId: c.userId, noticeVersion: r.data.noticeVersion, ip: req.ip ?? null },
        update: {},
      });
      await this.audit.record(tx, {
        actorType: 'USER',
        actorId: c.userId,
        action: 'citizen.consent',
        entityType: 'user',
        entityId: c.userId,
        data: { noticeVersion: r.data.noticeVersion },
        ip: req.ip,
      });
    });
    return { hasConsent: true };
  }
}
