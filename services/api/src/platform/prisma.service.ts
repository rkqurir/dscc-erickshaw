import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';

export type Tx = Prisma.TransactionClient;

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor() {
    // Writes that touch the audit chain serialize on one advisory lock, so allow queueing for a pool slot.
    super({ transactionOptions: { maxWait: 10_000, timeout: 15_000 } });
  }

  /** Connect eagerly: lazy connection races when the first requests arrive concurrently. */
  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  /**
   * Run `fn` in a transaction scoped to one city: sets app.city_id so PostgreSQL Row-Level Security
   * only exposes that city's rows. All city-scoped reads and writes must go through here.
   */
  inCity<T>(cityId: string, fn: (tx: Tx) => Promise<T>, opts?: { timeout?: number }): Promise<T> {
    return this.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT set_config('app.city_id', ${cityId}, true)`;
        return fn(tx);
      },
      { timeout: opts?.timeout ?? 15_000, maxWait: 10_000 },
    );
  }
}
