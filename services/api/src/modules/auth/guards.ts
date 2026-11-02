import { CanActivate, ExecutionContext, Injectable, SetMetadata, createParamDecorator } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { forbidden, unauthorized } from '../../platform/errors';
import { PrismaService } from '../../platform/prisma.service';
import { CITIZEN_COOKIE, STAFF_COOKIE, SessionService } from './session.service';

export const PRIVACY_NOTICE_VERSION = '2026-11-v1';

export interface CitizenContext {
  sessionId: string;
  userId: string;
  phoneE164: string;
  hasConsent: boolean;
}

export interface StaffContext {
  sessionId: string;
  staffId: string;
  cityId: string;
  email: string;
  fullName: string;
  roles: string[];
  permissions: Set<string>;
  zoneScopes: (string | null)[];
}

type AuthedRequest = Request & { citizen?: CitizenContext; staff?: StaffContext; pendingStaff?: { sessionId: string; staffId: string } };

const SKIP_CONSENT = 'skipConsent';
export const SkipConsent = () => SetMetadata(SKIP_CONSENT, true);

const PERMISSIONS = 'permissions';
/** Every listed permission is required. Deny by default: staff routes without this decorator are refused. */
export const RequirePermissions = (...perms: string[]) => SetMetadata(PERMISSIONS, perms);

export const Citizen = createParamDecorator((_: unknown, ctx: ExecutionContext) => ctx.switchToHttp().getRequest<AuthedRequest>().citizen!);
export const Staff = createParamDecorator((_: unknown, ctx: ExecutionContext) => ctx.switchToHttp().getRequest<AuthedRequest>().staff!);
export const PendingStaff = createParamDecorator(
  (_: unknown, ctx: ExecutionContext) => ctx.switchToHttp().getRequest<AuthedRequest>().pendingStaff!,
);

@Injectable()
export class CitizenGuard implements CanActivate {
  constructor(
    private readonly sessions: SessionService,
    private readonly prisma: PrismaService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const s = await this.sessions.resolve(req.cookies?.[CITIZEN_COOKIE], 'USER');
    if (!s?.userId) throw unauthorized();
    const user = await this.prisma.user.findUnique({
      where: { id: s.userId },
      include: { consents: { where: { noticeVersion: PRIVACY_NOTICE_VERSION } } },
    });
    if (!user || user.status !== 'ACTIVE') throw unauthorized();
    req.citizen = { sessionId: s.id, userId: user.id, phoneE164: user.phoneE164, hasConsent: user.consents.length > 0 };
    const skip = this.reflector.getAllAndOverride<boolean>(SKIP_CONSENT, [ctx.getHandler(), ctx.getClass()]);
    if (!skip && !req.citizen.hasConsent) throw forbidden('CONSENT_REQUIRED');
    return true;
  }
}

@Injectable()
export class StaffGuard implements CanActivate {
  constructor(
    private readonly sessions: SessionService,
    private readonly prisma: PrismaService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const s = await this.sessions.resolve(req.cookies?.[STAFF_COOKIE], 'STAFF');
    if (!s?.staffId) throw unauthorized();
    if (!s.mfaVerified) throw unauthorized('MFA_REQUIRED');
    const staff = await this.prisma.staffAccount.findUnique({
      where: { id: s.staffId },
      include: { roleAssignments: { include: { role: { include: { permissions: true } } } } },
    });
    if (!staff || staff.status !== 'ACTIVE') throw unauthorized();
    const assignments = staff.roleAssignments.filter((a) => a.cityId === staff.cityId);
    const permissions = new Set(assignments.flatMap((a) => a.role.permissions.map((p) => p.permissionCode)));
    req.staff = {
      sessionId: s.id,
      staffId: staff.id,
      cityId: staff.cityId,
      email: staff.email,
      fullName: staff.fullName,
      roles: assignments.map((a) => a.roleCode),
      permissions,
      zoneScopes: assignments.map((a) => a.zoneId),
    };
    const required = this.reflector.getAllAndOverride<string[] | undefined>(PERMISSIONS, [ctx.getHandler(), ctx.getClass()]);
    if (required === undefined) throw forbidden();
    if (!required.every((p) => permissions.has(p))) throw forbidden();
    return true;
  }
}

/** Password accepted, second factor still outstanding. */
@Injectable()
export class StaffPendingMfaGuard implements CanActivate {
  constructor(private readonly sessions: SessionService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const s = await this.sessions.resolve(req.cookies?.[STAFF_COOKIE], 'STAFF');
    if (!s?.staffId) throw unauthorized();
    req.pendingStaff = { sessionId: s.id, staffId: s.staffId };
    return true;
  }
}
