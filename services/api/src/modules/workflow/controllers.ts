import { Body, Controller, Get, Headers, HttpCode, Inject, Injectable, OnModuleDestroy, OnModuleInit, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { AppConfig, CONFIG } from '../../config';
import { parseOrThrow } from '../../platform/errors';
import { PrismaService } from '../../platform/prisma.service';
import { Citizen, CitizenContext, CitizenGuard, RequirePermissions, Staff, StaffContext, StaffGuard } from '../auth/guards';
import { DecisionService } from './decision.service';
import { FeesService } from './fees.service';
import { InspectionService } from './inspection.service';
import { RegistrationService } from './registration.service';
import { isoDate } from './scope';

const ip = (req: Request) => req.ip ?? null;

// ─── Officer: application workflow ───
@Controller('admin/applications')
@UseGuards(StaffGuard)
export class AdminWorkflowController {
  constructor(
    private readonly decisions: DecisionService,
    private readonly inspections: InspectionService,
    private readonly registrations: RegistrationService,
  ) {}

  @Get(':id/workflow')
  @RequirePermissions('application.read')
  workflow(@Staff() s: StaffContext, @Param('id') id: string) {
    return this.decisions.workflow(s, id);
  }

  @Post(':id/start-verification')
  @HttpCode(200)
  @RequirePermissions('application.verify')
  start(@Staff() s: StaffContext, @Param('id') id: string) {
    return this.decisions.startVerification(s, id);
  }

  @Post(':id/checks')
  @HttpCode(201)
  @RequirePermissions('application.verify')
  check(@Staff() s: StaffContext, @Param('id') id: string, @Body() body: unknown) {
    return this.decisions.recordCheck(s, id, body);
  }

  @Post(':id/request-correction')
  @HttpCode(200)
  @RequirePermissions('application.verify')
  correction(@Staff() s: StaffContext, @Param('id') id: string, @Body() body: unknown) {
    return this.decisions.requestCorrection(s, id, body);
  }

  @Post(':id/inspections')
  @HttpCode(201)
  @RequirePermissions('inspection.schedule')
  schedule(@Staff() s: StaffContext, @Param('id') id: string, @Body() body: unknown) {
    return this.inspections.schedule(s, id, body);
  }

  @Post(':id/approve')
  @HttpCode(200)
  @RequirePermissions('application.decide')
  approve(@Staff() s: StaffContext, @Param('id') id: string, @Body() body: unknown, @Req() req: Request) {
    return this.decisions.approve(s, id, body, ip(req));
  }

  @Post(':id/reject')
  @HttpCode(200)
  @RequirePermissions('application.decide')
  reject(@Staff() s: StaffContext, @Param('id') id: string, @Body() body: unknown, @Req() req: Request) {
    return this.decisions.reject(s, id, body, ip(req));
  }

  @Post(':id/registration')
  @HttpCode(201)
  @RequirePermissions('registration.issue')
  issue(@Staff() s: StaffContext, @Param('id') id: string, @Body() body: unknown, @Req() req: Request) {
    return this.registrations.issue(s, id, body, ip(req));
  }

  @Get(':id/registration')
  @RequirePermissions('registration.read')
  registration(@Staff() s: StaffContext, @Param('id') id: string) {
    return this.registrations.staffRegistration(s, id);
  }
}

const statusQuery = (values: readonly [string, ...string[]]) => z.object({ status: z.enum(values).optional() });

// ─── Officer: fitness inspections ───
@Controller('admin/inspections')
@UseGuards(StaffGuard)
export class AdminInspectionsController {
  constructor(private readonly inspections: InspectionService) {}

  @Get()
  @RequirePermissions('inspection.read')
  list(@Staff() s: StaffContext, @Query() q: unknown) {
    const { status } = parseOrThrow(statusQuery(['SCHEDULED', 'PASSED', 'FAILED', 'CANCELLED']), q);
    return this.inspections.list(s, status);
  }

  @Post(':id/result')
  @HttpCode(200)
  @RequirePermissions('inspection.record')
  result(@Staff() s: StaffContext, @Param('id') id: string, @Body() body: unknown) {
    return this.inspections.recordResult(s, id, body);
  }

  @Post(':id/countersign')
  @HttpCode(200)
  @RequirePermissions('inspection.countersign')
  countersign(@Staff() s: StaffContext, @Param('id') id: string) {
    return this.inspections.countersign(s, id);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @RequirePermissions('inspection.schedule')
  cancel(@Staff() s: StaffContext, @Param('id') id: string) {
    return this.inspections.cancel(s, id);
  }
}

// ─── Officer: fees and payments ───
@Controller('admin')
@UseGuards(StaffGuard)
export class AdminPaymentsController {
  constructor(
    private readonly fees: FeesService,
    private readonly prisma: PrismaService,
  ) {}

  @Get('invoices')
  @RequirePermissions('payment.read')
  list(@Staff() s: StaffContext, @Query() q: unknown) {
    const { status } = parseOrThrow(statusQuery(['UNPAID', 'PAID', 'CANCELLED']), q);
    return this.fees.listInvoices(s, { status });
  }

  @Post('invoices/:id/counter-payment')
  @HttpCode(200)
  @RequirePermissions('payment.record')
  counter(@Staff() s: StaffContext, @Param('id') id: string, @Body() body: unknown, @Req() req: Request) {
    return this.fees.recordCounterPayment(s, id, body, ip(req));
  }

  @Get('fee-schedules')
  @RequirePermissions('fee.read')
  async schedules() {
    return this.fees.scheduleRows(this.prisma);
  }
}

// ─── Officer: plates/QR and appeals ───
@Controller('admin')
@UseGuards(StaffGuard)
export class AdminRegistrationsController {
  constructor(
    private readonly registrations: RegistrationService,
    private readonly decisions: DecisionService,
  ) {}

  @Get('registrations/queue')
  @RequirePermissions('registration.read')
  queue(@Staff() s: StaffContext) {
    return this.registrations.queue(s);
  }

  @Post('registrations/:id/reissue-qr')
  @HttpCode(200)
  @RequirePermissions('registration.issue')
  reissue(@Staff() s: StaffContext, @Param('id') id: string, @Body() body: unknown, @Req() req: Request) {
    return this.registrations.reissueQr(s, id, body, ip(req));
  }

  @Get('appeals')
  @RequirePermissions('appeal.read')
  appeals(@Staff() s: StaffContext, @Query() q: unknown) {
    const { status } = parseOrThrow(statusQuery(['PENDING', 'ALLOWED', 'DISMISSED']), q);
    return this.decisions.listAppeals(s, status);
  }

  @Post('appeals/:id/decide')
  @HttpCode(200)
  @RequirePermissions('appeal.decide')
  decide(@Staff() s: StaffContext, @Param('id') id: string, @Body() body: unknown, @Req() req: Request) {
    return this.decisions.decideAppeal(s, id, body, ip(req));
  }
}

// ─── Citizen: pay and appeal ───
@Controller('applications')
@UseGuards(CitizenGuard)
export class CitizenWorkflowController {
  constructor(
    private readonly fees: FeesService,
    private readonly decisions: DecisionService,
  ) {}

  @Post(':id/payments/checkout')
  @HttpCode(201)
  checkout(@Citizen() c: CitizenContext, @Param('id') id: string) {
    return this.fees.checkout(c.userId, id);
  }

  @Post(':id/appeal')
  @HttpCode(201)
  appeal(@Citizen() c: CitizenContext, @Param('id') id: string, @Body() body: unknown) {
    return this.decisions.fileAppeal(c.userId, id, body);
  }
}

// ─── Payment gateway callback (server-to-server; exempt from the CSRF header, authenticated by HMAC) ───
@Controller('payments/webhook')
export class PaymentWebhookController {
  constructor(private readonly fees: FeesService) {}

  @Post('simulator')
  @HttpCode(200)
  callback(@Body() body: unknown, @Headers('x-payment-signature') sig: string | undefined) {
    return this.fees.handleCallback(body, sig);
  }
}

/** Development-only payment gateway simulator. Not registered in production (and config forbids it there). */
@Controller('dev/payment-gateway')
@UseGuards(CitizenGuard)
export class DevPaymentGatewayController {
  constructor(private readonly fees: FeesService) {}

  @Get('sessions/:id')
  session(@Citizen() c: CitizenContext, @Param('id') id: string) {
    return this.fees.simulatorSession(c.userId, id);
  }

  @Post('sessions/:id/complete')
  @HttpCode(200)
  complete(@Citizen() c: CitizenContext, @Param('id') id: string, @Body() body: unknown) {
    const { outcome } = parseOrThrow(z.object({ outcome: z.enum(['SUCCESS', 'FAILED']) }), body);
    return this.fees.simulatorComplete(c.userId, id, outcome);
  }
}

// ─── Public QR verification ───
@Controller('public')
export class PublicVerifyController {
  constructor(private readonly registrations: RegistrationService) {}

  @Get('verify/:token')
  verify(@Param('token') token: string, @Req() req: Request) {
    return this.registrations.publicVerify(token, ip(req));
  }

  @Get('qr-key')
  key() {
    return this.registrations.publicKey();
  }
}

/** Periodic jobs: close rejections whose appeal window has passed. */
@Injectable()
export class MaintenanceService implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  constructor(
    private readonly decisions: DecisionService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}
  onModuleInit(): void {
    if (this.config.NODE_ENV !== 'test' && this.config.MAINTENANCE_POLL_MS > 0) {
      this.timer = setInterval(() => void this.decisions.finalizeExpiredRejections().catch(() => undefined), this.config.MAINTENANCE_POLL_MS);
    }
  }
  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }
}

