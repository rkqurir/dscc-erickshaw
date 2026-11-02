import { Controller, DynamicModule, Get, MiddlewareConsumer, Module, NestModule, Query, Provider } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { bdMobileSchema } from '@dscc/domain';
import { AppConfig, CONFIG } from './config';
import {
  FILE_SCANNER,
  LocalDiskStorage,
  ManualNidAdapter,
  NID_ADAPTER,
  SMS_ADAPTER,
  STORAGE_ADAPTER,
  SignatureScanner,
  SimulatorNidAdapter,
  SimulatorSmsAdapter,
} from './platform/adapters';
import { AuditService } from './platform/audit.service';
import { CityService } from './platform/city.service';
import { AppError, AppExceptionFilter, parseOrThrow } from './platform/errors';
import { OutboxService } from './platform/outbox.service';
import { PrismaService } from './platform/prisma.service';
import { AdminApplicationsController } from './modules/admin/admin-applications';
import { AdminZonesController } from './modules/admin/admin-zones';
import { ApplicationsController } from './modules/applications/applications.controller';
import { ApplicationsService } from './modules/applications/applications.service';
import { FilesService } from './modules/applications/files.service';
import { CitizenAuthController, MeController, OtpService } from './modules/auth/citizen-auth';
import { CitizenGuard, StaffGuard, StaffPendingMfaGuard } from './modules/auth/guards';
import { SessionService } from './modules/auth/session.service';
import { StaffAuthController } from './modules/auth/staff-auth';
import { CatalogController } from './modules/catalog/catalog';
import { OwnerService, OwnersController } from './modules/owners/owners';
import { QuotaService } from './modules/owners/quota.service';
import { StepUpService } from './modules/auth/step-up.service';
import {
  AdminInspectionsController,
  AdminPaymentsController,
  AdminRegistrationsController,
  AdminWorkflowController,
  CitizenWorkflowController,
  DevPaymentGatewayController,
  MaintenanceService,
  PaymentWebhookController,
  PublicVerifyController,
} from './modules/workflow/controllers';
import { DecisionService } from './modules/workflow/decision.service';
import { FeesService } from './modules/workflow/fees.service';
import { InspectionService } from './modules/workflow/inspection.service';
import { RegistrationService } from './modules/workflow/registration.service';

/**
 * CSRF defence for cookie-authenticated APIs: state-changing requests must carry a custom header,
 * which a cross-site form or image cannot set and which forces a CORS preflight (CORS is not enabled).
 */
export function csrfHeaderMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  // Server-to-server gateway callbacks carry an HMAC signature instead (verified in FeesService).
  if (req.originalUrl.startsWith('/api/v1/payments/webhook/')) return next();
  if (req.headers['x-dscc-csrf'] === '1') return next();
  next(new AppError('CSRF_HEADER_MISSING', 403));
}

@Controller('health')
class HealthController {
  constructor(private readonly prisma: PrismaService) {}
  @Get()
  async health() {
    await this.prisma.$queryRaw`SELECT 1`;
    return { status: 'ok' };
  }
}

/** Development-only: read simulated SMS (OTP) messages. Not registered in production. */
@Controller('dev')
class DevSmsController {
  constructor(private readonly prisma: PrismaService) {}
  @Get('sms')
  async sms(@Query() q: unknown) {
    const { phone } = parseOrThrow(z.object({ phone: bdMobileSchema }), q);
    const rows = await this.prisma.simulatedSms.findMany({ where: { toPhone: phone }, orderBy: { createdAt: 'desc' }, take: 5 });
    return rows.map((r) => ({ to: r.toPhone, body: r.body, at: r.createdAt }));
  }
}

@Module({})
export class AppModule implements NestModule {
  static register(config: AppConfig): DynamicModule {
    const providers: Provider[] = [
      { provide: CONFIG, useValue: config },
      { provide: APP_FILTER, useClass: AppExceptionFilter },
      PrismaService,
      AuditService,
      OutboxService,
      CityService,
      SessionService,
      CitizenGuard,
      StaffGuard,
      StaffPendingMfaGuard,
      OtpService,
      OwnerService,
      QuotaService,
      FilesService,
      ApplicationsService,
      StepUpService,
      FeesService,
      InspectionService,
      DecisionService,
      RegistrationService,
      MaintenanceService,
      { provide: SMS_ADAPTER, useClass: SimulatorSmsAdapter },
      { provide: NID_ADAPTER, useFactory: () => (config.NID_VERIFICATION_PROVIDER === 'manual' ? new ManualNidAdapter() : new SimulatorNidAdapter()) },
      { provide: STORAGE_ADAPTER, useFactory: () => new LocalDiskStorage(config.STORAGE_DIR) },
      { provide: FILE_SCANNER, useClass: SignatureScanner },
    ];
    const controllers: DynamicModule['controllers'] = [
      HealthController,
      CitizenAuthController,
      MeController,
      StaffAuthController,
      CatalogController,
      OwnersController,
      ApplicationsController,
      AdminApplicationsController,
      AdminZonesController,
      AdminWorkflowController,
      AdminInspectionsController,
      AdminPaymentsController,
      AdminRegistrationsController,
      CitizenWorkflowController,
      PaymentWebhookController,
      PublicVerifyController,
    ];
    if (config.SMS_PROVIDER === 'simulator' && config.NODE_ENV !== 'production') controllers.push(DevSmsController);
    if (config.PAYMENT_PROVIDER === 'simulator' && config.NODE_ENV !== 'production') controllers.push(DevPaymentGatewayController);
    return { module: AppModule, providers, controllers };
  }

  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(csrfHeaderMiddleware).forRoutes('*');
  }
}
