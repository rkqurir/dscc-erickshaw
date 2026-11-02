import { Injectable } from '@nestjs/common';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PrismaService } from './prisma.service';

/**
 * External integrations sit behind these interfaces. Phase 1 ships only simulators; real
 * SMS gateway, Election Commission NID service and object storage need Gate D approval.
 */

// ─── SMS ───
export interface SmsAdapter {
  readonly name: string;
  send(toE164: string, body: string): Promise<void>;
}
export const SMS_ADAPTER = Symbol('SMS_ADAPTER');

/** Writes messages to sim_sms_messages so developers and E2E tests can read the OTP. */
@Injectable()
export class SimulatorSmsAdapter implements SmsAdapter {
  readonly name = 'simulator';
  constructor(private readonly prisma: PrismaService) {}
  async send(toE164: string, body: string): Promise<void> {
    await this.prisma.simulatedSms.create({ data: { toPhone: toE164, body } });
  }
}

// ─── NID verification ───
export interface NidVerificationRequest {
  nidDigits: string;
  dateOfBirth: string;
  nameBn: string;
}
export interface NidVerificationResult {
  status: 'SIMULATED_VERIFIED' | 'PENDING_MANUAL' | 'FAILED';
  source: string;
}
export interface NidVerificationAdapter {
  verify(req: NidVerificationRequest): Promise<NidVerificationResult>;
}
export const NID_ADAPTER = Symbol('NID_ADAPTER');

/**
 * Deterministic simulator: synthetic NIDs ending in "0000" fail, everything else is marked
 * SIMULATED_VERIFIED (shown as "DEMO" in the UI). Never used in production (config refuses it).
 */
export class SimulatorNidAdapter implements NidVerificationAdapter {
  async verify(req: NidVerificationRequest): Promise<NidVerificationResult> {
    if (req.nidDigits.endsWith('0000')) return { status: 'FAILED', source: 'simulator' };
    return { status: 'SIMULATED_VERIFIED', source: 'simulator' };
  }
}

/** Until the EC contract exists, officers verify NIDs manually against the uploaded copy. */
export class ManualNidAdapter implements NidVerificationAdapter {
  async verify(): Promise<NidVerificationResult> {
    return { status: 'PENDING_MANUAL', source: 'manual' };
  }
}

// ─── File storage ───
export interface StorageAdapter {
  put(key: string, data: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
}
export const STORAGE_ADAPTER = Symbol('STORAGE_ADAPTER');

export class LocalDiskStorage implements StorageAdapter {
  constructor(private readonly root: string) {}
  private resolve(key: string): string {
    if (!/^[a-z0-9/-]+$/.test(key) || key.includes('..')) throw new Error('invalid storage key');
    return path.join(path.resolve(this.root), key);
  }
  async put(key: string, data: Buffer): Promise<void> {
    const p = this.resolve(key);
    await mkdir(path.dirname(p), { recursive: true });
    await writeFile(p, data, { flag: 'wx', mode: 0o600 });
  }
  get(key: string): Promise<Buffer> {
    return readFile(this.resolve(key));
  }
}

// ─── Malware scanning ───
export interface FileScanner {
  readonly engine: string;
  scan(data: Buffer): Promise<'CLEAN' | 'INFECTED'>;
}
export const FILE_SCANNER = Symbol('FILE_SCANNER');

const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

/**
 * Signature scanner for development: rejects the EICAR test file and PDFs with embedded
 * JavaScript or auto-launch actions. Production uses ClamAV (Phase 0 plan) behind this interface.
 */
export class SignatureScanner implements FileScanner {
  readonly engine = 'signature-dev';
  async scan(data: Buffer): Promise<'CLEAN' | 'INFECTED'> {
    const s = data.toString('latin1');
    if (s.includes(EICAR)) return 'INFECTED';
    if (s.startsWith('%PDF') && /\/(JavaScript|JS|Launch|EmbeddedFile)\b/.test(s)) return 'INFECTED';
    return 'CLEAN';
  }
}

/** Detect file type from magic bytes; the client-declared MIME type is never trusted. */
export function sniffMime(data: Buffer): 'image/jpeg' | 'image/png' | 'application/pdf' | null {
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (data.length >= 5 && data.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  return null;
}
