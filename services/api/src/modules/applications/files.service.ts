import { Inject, Injectable } from '@nestjs/common';
import { MAX_UPLOAD_BYTES } from '@dscc/domain';
import { FILE_SCANNER, FileScanner, STORAGE_ADAPTER, StorageAdapter, sniffMime } from '../../platform/adapters';
import { sha256Hex, uuidv7 } from '../../platform/crypto';
import { AppError } from '../../platform/errors';
import { Tx } from '../../platform/prisma.service';

export interface UploadedFileInput {
  buffer: Buffer;
  originalname: string;
  size: number;
}

@Injectable()
export class FilesService {
  constructor(
    @Inject(STORAGE_ADAPTER) private readonly storage: StorageAdapter,
    @Inject(FILE_SCANNER) private readonly scanner: FileScanner,
  ) {}

  /** Validate (size, magic bytes, malware scan), store privately and record metadata. */
  async store(tx: Tx, p: { cityId: string; ownerUserId: string; file: UploadedFileInput }): Promise<{ id: string; mimeType: string; sizeBytes: number; sha256: string }> {
    const { buffer } = p.file;
    if (!buffer || buffer.length === 0) throw new AppError('FILE_TYPE_NOT_ALLOWED', 400);
    if (buffer.length > MAX_UPLOAD_BYTES) throw new AppError('FILE_TOO_LARGE', 413);
    const mime = sniffMime(buffer);
    if (!mime) throw new AppError('FILE_TYPE_NOT_ALLOWED', 415);
    const verdict = await this.scanner.scan(buffer);
    if (verdict !== 'CLEAN') throw new AppError('FILE_REJECTED_BY_SCAN', 422);
    const id = uuidv7();
    const key = `${p.cityId}/${id}`;
    await this.storage.put(key, buffer);
    const sha256 = sha256Hex(buffer);
    await tx.storedFile.create({
      data: {
        id,
        cityId: p.cityId,
        ownerUserId: p.ownerUserId,
        storageKey: key,
        mimeType: mime,
        sizeBytes: buffer.length,
        sha256,
        originalName: sanitizeName(p.file.originalname),
        scanStatus: verdict,
        scanEngine: this.scanner.engine,
      },
    });
    return { id, mimeType: mime, sizeBytes: buffer.length, sha256 };
  }

  read(storageKey: string): Promise<Buffer> {
    return this.storage.get(storageKey);
  }
}

function sanitizeName(name: string): string {
  // multer decodes the multipart filename as latin1; restore UTF-8 so Bengali names survive.
  let n = name;
  try {
    n = Buffer.from(name, 'latin1').toString('utf8');
  } catch {
    /* keep original */
  }
  return n.replace(/[\\/\r\n"<>]/g, '_').slice(0, 150) || 'file';
}

export function contentDisposition(name: string, mime: string): string {
  const ext = mime === 'application/pdf' ? 'pdf' : mime === 'image/png' ? 'png' : 'jpg';
  const ascii = `document.${ext}`;
  return `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}
