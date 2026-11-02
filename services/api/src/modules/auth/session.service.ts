import { Inject, Injectable } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AppConfig, CONFIG } from '../../config';
import { hmacHex, randomToken } from '../../platform/crypto';
import { PrismaService } from '../../platform/prisma.service';

export const CITIZEN_COOKIE = 'dscc_sid';
export const STAFF_COOKIE = 'dscc_staff_sid';

const POLICY = {
  USER: { absoluteMs: 30 * 24 * 3600_000, idleMs: 7 * 24 * 3600_000 },
  STAFF: { absoluteMs: 12 * 3600_000, idleMs: 30 * 60_000 },
} as const;

export interface SessionRecord {
  id: string;
  subjectType: 'USER' | 'STAFF';
  userId: string | null;
  staffId: string | null;
  mfaVerified: boolean;
}

@Injectable()
export class SessionService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  private hash(token: string): string {
    return hmacHex(this.config.SESSION_HMAC_KEY, token);
  }

  async create(
    subject: { type: 'USER'; userId: string } | { type: 'STAFF'; staffId: string },
    req: Request,
    mfaVerified = false,
  ): Promise<string> {
    const token = randomToken(32);
    const policy = POLICY[subject.type];
    await this.prisma.authSession.create({
      data: {
        tokenHash: this.hash(token),
        subjectType: subject.type,
        userId: subject.type === 'USER' ? subject.userId : null,
        staffId: subject.type === 'STAFF' ? subject.staffId : null,
        mfaVerified,
        ip: req.ip ?? null,
        userAgent: (req.headers['user-agent'] ?? '').slice(0, 300),
        expiresAt: new Date(Date.now() + policy.absoluteMs),
      },
    });
    return token;
  }

  async resolve(token: string | undefined, type: 'USER' | 'STAFF'): Promise<SessionRecord | null> {
    if (!token || token.length > 200) return null;
    const s = await this.prisma.authSession.findUnique({ where: { tokenHash: this.hash(token) } });
    const now = Date.now();
    if (!s || s.subjectType !== type || s.revokedAt || s.expiresAt.getTime() <= now) return null;
    if (now - s.lastSeenAt.getTime() > POLICY[type].idleMs) {
      await this.prisma.authSession.update({ where: { id: s.id }, data: { revokedAt: new Date() } });
      return null;
    }
    if (now - s.lastSeenAt.getTime() > 60_000) {
      await this.prisma.authSession.update({ where: { id: s.id }, data: { lastSeenAt: new Date() } });
    }
    return { id: s.id, subjectType: type, userId: s.userId, staffId: s.staffId, mfaVerified: s.mfaVerified };
  }

  async markMfaVerified(sessionId: string): Promise<void> {
    await this.prisma.authSession.update({ where: { id: sessionId }, data: { mfaVerified: true, lastSeenAt: new Date() } });
  }

  async revoke(sessionId: string): Promise<void> {
    await this.prisma.authSession.update({ where: { id: sessionId }, data: { revokedAt: new Date() } });
  }

  setCookie(res: Response, name: string, token: string, type: 'USER' | 'STAFF'): void {
    res.cookie(name, token, {
      httpOnly: true,
      secure: this.config.COOKIE_SECURE,
      sameSite: 'strict',
      path: '/api',
      maxAge: POLICY[type].absoluteMs,
    });
  }

  clearCookie(res: Response, name: string): void {
    res.clearCookie(name, { httpOnly: true, secure: this.config.COOKIE_SECURE, sameSite: 'strict', path: '/api' });
  }
}
