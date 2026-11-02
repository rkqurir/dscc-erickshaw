import { describe, expect, it } from 'vitest';
import { auditHash, canonicalJson, GENESIS_HASH } from '../src/platform/audit.service';
import { decryptField, encryptField, hashPassword, uuidv7, verifyPassword } from '../src/platform/crypto';
import { SignatureScanner, sniffMime } from '../src/platform/adapters';
import { base32Decode, base32Encode, hotp, verifyTotp, totpAt } from '../src/platform/totp';
import { slaState } from '../src/modules/admin/admin-applications';

const KEY = Buffer.alloc(32, 7).toString('base64');

describe('TOTP (RFC 6238 / RFC 4226 vectors)', () => {
  const secret = Buffer.from('12345678901234567890');
  it.each([
    [59, '94287082'],
    [1111111109, '07081804'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
  ])('T=%i → %s', (t, code) => {
    expect(hotp(secret, BigInt(Math.floor(t / 30)), 8)).toBe(code);
  });
  it('round-trips base32 and enforces single use per step', () => {
    const b32 = base32Encode(secret);
    expect(base32Decode(b32).equals(secret)).toBe(true);
    const now = 1_700_000_000_000;
    const code = totpAt(b32, now);
    const step = verifyTotp(b32, code, now);
    expect(step).not.toBeNull();
    expect(verifyTotp(b32, code, now, step)).toBeNull();
    expect(verifyTotp(b32, '12345', now)).toBeNull();
  });
});

describe('field encryption and passwords', () => {
  it('encrypts with a random IV and detects tampering', () => {
    const a = encryptField(KEY, '1234567890');
    const b = encryptField(KEY, '1234567890');
    expect(a).not.toBe(b);
    expect(decryptField(KEY, a)).toBe('1234567890');
    const parts = a.split('.');
    parts[3] = Buffer.from('0000000000').toString('base64url');
    expect(() => decryptField(KEY, parts.join('.'))).toThrow();
  });
  it('hashes passwords with scrypt', async () => {
    const h = await hashPassword('correct horse battery staple');
    expect(await verifyPassword('correct horse battery staple', h)).toBe(true);
    expect(await verifyPassword('wrong', h)).toBe(false);
  });
  it('generates time-ordered UUIDv7', () => {
    const a = uuidv7();
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe('audit hashing', () => {
  it('is canonical and chains', () => {
    expect(canonicalJson({ b: 1, a: [1, { d: 2, c: 3 }] })).toBe('{"a":[1,{"c":3,"d":2}],"b":1}');
    const e = { occurredAt: '2026-11-02T00:00:00.000Z', actorType: 'SYSTEM' as const, action: 'x', entityType: 'y' };
    const h1 = auditHash(GENESIS_HASH, e);
    expect(auditHash(GENESIS_HASH, e)).toBe(h1);
    expect(auditHash(h1, e)).not.toBe(h1);
  });
});

describe('file checks', () => {
  it('sniffs types from magic bytes', () => {
    expect(sniffMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffMime(Buffer.from('%PDF-1.7'))).toBe('application/pdf');
    expect(sniffMime(Buffer.from('<html>'))).toBeNull();
  });
  it('flags EICAR and active PDF content', async () => {
    const s = new SignatureScanner();
    expect(await s.scan(Buffer.from('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*'))).toBe('INFECTED');
    expect(await s.scan(Buffer.from('%PDF-1.4 /OpenAction << /S /Launch >>'))).toBe('INFECTED');
    expect(await s.scan(Buffer.from('%PDF-1.4 plain'))).toBe('CLEAN');
  });
});

describe('SLA', () => {
  it('marks 20+ working days at risk and 31+ overdue', () => {
    expect(slaState(0)).toBe('ON_TRACK');
    expect(slaState(20)).toBe('AT_RISK');
    expect(slaState(30)).toBe('AT_RISK');
    expect(slaState(31)).toBe('OVERDUE');
  });
});
