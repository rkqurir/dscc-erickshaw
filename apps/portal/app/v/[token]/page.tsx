'use client';

import { DefinitionList, ErrorAlert, Notice, PlateView, Spinner, ZoneChip, api, useI18n } from '@dscc/web-ui';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';

interface Result {
  result: 'VALID' | 'REVOKED' | 'EXPIRED' | 'SUSPENDED' | 'CANCELLED' | 'UNKNOWN' | 'INVALID';
  city?: { nameBn: string; nameEn: string };
  plate?: { systemId: string; textBn: string };
  zone?: { code: string; nameBn: string; nameEn: string; uiColour: string };
  registration?: { status: string; registeredOn: string; validUntil: string; endOfLifeOn: string };
  fitness?: { validUntil: string | null; valid: boolean };
  vehicle?: { seatType: string; model: string | null; colour: string | null };
  checkedAt?: string;
}

/** Public QR verification page (no login). Shows registration validity only — no personal data. */
export default function Verify() {
  const { token } = useParams<{ token: string }>();
  const { t, tk, date, lang } = useI18n();
  const [r, setR] = useState<Result | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    void api<Result>(`/public/verify/${encodeURIComponent(token)}`).then(setR).catch(setError);
  }, [token]);
  if (error) return <ErrorAlert error={error} />;
  if (!r) return <Spinner />;
  const cls = r.result === 'VALID' ? 'valid' : r.result === 'EXPIRED' || r.result === 'SUSPENDED' ? 'warn' : 'bad';
  return (
    <div className="narrow">
      <h1>{t('verify.title')}</h1>
      <div className={`verify-hero ${cls}`} role="status" data-testid="verify-result">
        {r.result === 'VALID' ? '✓ ' : '✗ '}
        {tk(`verify.result.${r.result}`)}
      </div>
      {r.plate && r.zone && r.registration && (
        <div className="card">
          <PlateView textBn={r.plate.textBn} systemId={r.plate.systemId} background={r.zone.uiColour} />
          <DefinitionList
            rows={[
              [t('app.city'), r.city ? (lang === 'bn' ? r.city.nameBn : r.city.nameEn) : null],
              [t('location.zone'), <ZoneChip key="z" zone={r.zone} />],
              [t('vehicle.seatType'), r.vehicle ? tk(`seat.${r.vehicle.seatType}`) : null],
              [t('vehicle.model'), r.vehicle?.model],
              [t('dash.col.status'), tk(`regstatus.${r.registration.status}`)],
              [t('reg.validUntil'), date(r.registration.validUntil)],
              [t('reg.endOfLife'), date(r.registration.endOfLifeOn)],
              [t('verify.fitness'), r.fitness?.valid ? t('verify.fitnessValid', { date: date(r.fitness.validUntil) }) : t('verify.fitnessMissing')],
            ]}
          />
          {r.checkedAt && <p className="small muted">{t('verify.checkedAt', { time: date(r.checkedAt, true) })}</p>}
        </div>
      )}
      <Notice>{t('verify.privacy')}</Notice>
    </div>
  );
}
