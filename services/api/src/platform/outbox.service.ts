import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { AppConfig, CONFIG } from '../config';
import { SMS_ADAPTER, SmsAdapter } from './adapters';
import { PrismaService, Tx } from './prisma.service';

export type OutboxTopic = 'sms.send';

/**
 * Transactional outbox: side effects (SMS now; PDFs and payment callbacks later) are stored in the
 * same transaction as the business change, then dispatched by a poller. A crash can delay a message
 * but can never send one for a change that rolled back.
 */
@Injectable()
export class OutboxService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Outbox');
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(SMS_ADAPTER) private readonly sms: SmsAdapter,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  onModuleInit(): void {
    if (this.config.NODE_ENV !== 'test' && this.config.OUTBOX_POLL_MS > 0) {
      this.timer = setInterval(() => void this.dispatchPending(), this.config.OUTBOX_POLL_MS);
    }
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async enqueue(tx: Tx, topic: OutboxTopic, payload: Record<string, unknown>): Promise<void> {
    await tx.outboxEvent.create({ data: { topic, payload: payload as object } });
  }

  /** Process due events; safe to run concurrently (SKIP LOCKED). Returns the number processed. */
  async dispatchPending(limit = 20): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let processed = 0;
    try {
      for (let i = 0; i < limit; i++) {
        const done = await this.prisma.$transaction(async (tx) => {
          const rows = await tx.$queryRaw<{ id: string; topic: string; payload: Record<string, unknown>; attempts: number }[]>`
            SELECT id, topic, payload, attempts FROM outbox_events
            WHERE status = 'PENDING' AND available_at <= now()
            ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED`;
          const ev = rows[0];
          if (!ev) return false;
          try {
            await this.handle(ev.topic, ev.payload);
            await tx.outboxEvent.update({ where: { id: ev.id }, data: { status: 'DONE', processedAt: new Date(), attempts: ev.attempts + 1 } });
          } catch (e) {
            const attempts = ev.attempts + 1;
            await tx.outboxEvent.update({
              where: { id: ev.id },
              data: {
                attempts,
                status: attempts >= 5 ? 'FAILED' : 'PENDING',
                availableAt: new Date(Date.now() + 2 ** attempts * 1000),
                lastError: e instanceof Error ? e.message.slice(0, 500) : 'error',
              },
            });
            this.log.warn(`outbox ${ev.id} failed (attempt ${attempts})`);
          }
          return true;
        });
        if (!done) break;
        processed++;
      }
    } finally {
      this.running = false;
    }
    return processed;
  }

  private async handle(topic: string, payload: Record<string, unknown>): Promise<void> {
    switch (topic) {
      case 'sms.send':
        await this.sms.send(String(payload.to), String(payload.body));
        return;
      default:
        throw new Error(`unknown topic ${topic}`);
    }
  }
}
