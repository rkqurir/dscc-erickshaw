import { Inject, Injectable } from '@nestjs/common';
import { AppConfig, CONFIG } from '../../config';
import { AuditService } from '../../platform/audit.service';
import { decryptField } from '../../platform/crypto';
import { AppError } from '../../platform/errors';
import { Tx } from '../../platform/prisma.service';
import { verifyTotp } from '../../platform/totp';

/**
 * Step-up re-authentication for irreversible officer actions (approve, reject, issue plate/QR,
 * decide appeal): the officer re-enters a fresh TOTP code. A code (time step) can be used once,
 * shared with login replay protection, so a captured code cannot be replayed.
 */
@Injectable()
export class StepUpService {
  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly audit: AuditService,
  ) {}

  async verify(tx: Tx, staffId: string, code: string, action: string): Promise<void> {
    const staff = await tx.staffAccount.findUniqueOrThrow({ where: { id: staffId } });
    const step = staff.totpSecretEnc ? verifyTotp(decryptField(this.config.DATA_ENCRYPTION_KEY, staff.totpSecretEnc), code, Date.now(), staff.lastTotpStep) : null;
    if (step !== null) {
      const upd = await tx.staffAccount.updateMany({
        where: { id: staff.id, OR: [{ lastTotpStep: null }, { lastTotpStep: { lt: step } }] },
        data: { lastTotpStep: step },
      });
      if (upd.count === 1) return;
    }
    throw new AppError('STEP_UP_INVALID', 403, { action });
  }
}
