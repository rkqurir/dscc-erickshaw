import { Inject, Injectable } from '@nestjs/common';
import { AppConfig, CONFIG } from '../config';
import { PrismaService } from './prisma.service';

export interface CityInfo {
  id: string;
  code: string;
  nameBn: string;
  nameEn: string;
  plateCityNameBn: string;
}

/** Citizens apply to the deployment's configured city (DSCC); staff are bound to their own city. */
@Injectable()
export class CityService {
  private cache = new Map<string, CityInfo>();

  constructor(
    private readonly prisma: PrismaService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  async byCode(code: string): Promise<CityInfo> {
    const hit = this.cache.get(code);
    if (hit) return hit;
    const c = await this.prisma.city.findUniqueOrThrow({ where: { code } });
    const info = { id: c.id, code: c.code, nameBn: c.nameBn, nameEn: c.nameEn, plateCityNameBn: c.plateCityNameBn };
    this.cache.set(code, info);
    return info;
  }

  async byId(id: string): Promise<CityInfo> {
    for (const c of this.cache.values()) if (c.id === id) return c;
    const c = await this.prisma.city.findUniqueOrThrow({ where: { id } });
    return this.byCode(c.code);
  }

  defaultCity(): Promise<CityInfo> {
    return this.byCode(this.config.CITY_CODE);
  }

  async holidays(): Promise<Set<string>> {
    const rows = await this.prisma.workingDayHoliday.findMany({ select: { date: true } });
    return new Set(rows.map((r) => r.date.toISOString().slice(0, 10)));
  }
}
