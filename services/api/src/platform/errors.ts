import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { errorMessage } from '@dscc/localization';
import type { Response } from 'express';
import { Prisma } from '@prisma/client';
import { ZodError, ZodTypeAny, z } from 'zod';

export class AppError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    public readonly details?: unknown,
  ) {
    super(code);
  }
}

export const badRequest = (code: string, details?: unknown) => new AppError(code, 400, details);
export const unauthorized = (code = 'UNAUTHENTICATED') => new AppError(code, 401);
export const forbidden = (code = 'FORBIDDEN') => new AppError(code, 403);
export const notFound = () => new AppError('NOT_FOUND', 404);
export const conflict = (code: string, details?: unknown) => new AppError(code, 409, details);

/** Parse with zod and convert failures into a VALIDATION_FAILED error listing field codes. */
export function parseOrThrow<S extends ZodTypeAny>(schema: S, input: unknown): z.output<S> {
  const r = schema.safeParse(input);
  if (!r.success) throw validationError(r.error);
  return r.data;
}

export function validationError(e: ZodError): AppError {
  const fields: Record<string, string> = {};
  for (const i of e.issues) {
    const key = i.path.join('.') || '_';
    if (!fields[key]) fields[key] = /^[A-Z0-9_]+$/.test(i.message) ? i.message : 'INVALID';
  }
  return new AppError('VALIDATION_FAILED', 400, { fields });
}

/** Postgres error raised by a trigger with a known code as its message. */
export function mapDbError(e: unknown): AppError | null {
  const msg = e instanceof Error ? e.message : String(e);
  if (msg.includes('OWNER_NID_VEHICLE_LIMIT_REACHED')) return conflict('OWNER_NID_VEHICLE_LIMIT_REACHED');
  if (msg.includes('vehicles_city_chassis_live_uq')) return conflict('CHASSIS_ALREADY_REGISTERED');
  if (msg.includes('vehicles_city_motor_live_uq')) return conflict('MOTOR_ALREADY_REGISTERED');
  if (msg.includes('SEPARATION_OF_DUTIES')) return new AppError('SEPARATION_OF_DUTIES', 403);
  if (msg.includes('PAYMENT_AMOUNT_MISMATCH')) return badRequest('PAYMENT_AMOUNT_MISMATCH');
  if (msg.includes('APPROVAL_DECISION_MISSING')) return conflict('APPROVAL_DECISION_MISSING');
  if (msg.includes('registrations_zone_id_plate_serial_key') || msg.includes('registrations_vehicle_live_uq')) return conflict('REGISTRATION_ALREADY_ISSUED');
  return null;
}

@Catch()
export class AppExceptionFilter implements ExceptionFilter {
  private readonly log = new Logger('Errors');

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    let err: AppError;
    if (exception instanceof AppError) {
      err = exception;
    } else if (exception instanceof ZodError) {
      err = validationError(exception);
    } else if (mapDbError(exception)) {
      err = mapDbError(exception)!;
    } else if (exception instanceof Prisma.PrismaClientKnownRequestError && (exception.code === 'P2028' || exception.code === 'P2024')) {
      this.log.warn(`database busy: ${exception.code}`);
      err = new AppError('SERVICE_BUSY', HttpStatus.SERVICE_UNAVAILABLE);
    } else if (exception instanceof Prisma.PrismaClientKnownRequestError && exception.code === 'P2025') {
      err = notFound();
    } else if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const code =
        status === 404 ? 'NOT_FOUND' : status === 413 ? 'FILE_TOO_LARGE' : status === 429 ? 'RATE_LIMITED' : status < 500 ? 'VALIDATION_FAILED' : 'INTERNAL_ERROR';
      err = new AppError(code, status);
    } else {
      this.log.error(exception instanceof Error ? exception.stack : String(exception));
      err = new AppError('INTERNAL_ERROR', HttpStatus.INTERNAL_SERVER_ERROR);
    }
    res.status(err.status).json({
      error: {
        code: err.code,
        message: errorMessage(err.code, 'bn'),
        messageEn: errorMessage(err.code, 'en'),
        details: err.details,
      },
    });
  }
}
