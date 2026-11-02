'use client';

import { DefinitionList, ErrorAlert, Notice, Spinner, StatusBadge, ZoneChip, api, useI18n } from '@dscc/web-ui';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { useRequireStaff } from '../../../components/session';
import { WorkflowPanel } from '../../../components/workflow-panel';

interface Detail {
  id: string;
  applicationNumber: string;
  status: string;
  submittedAt: string;
  withdrawnAt: string | null;
  decisionDueDate: string | null;
  workingDaysElapsed: number;
  sla: string | null;
  applicantPhone: string;
  owner: {
    nameBn: string;
    nameEn: string | null;
    nidMasked: string;
    nidKind: string;
    dateOfBirth: string;
    fatherNameBn: string;
    motherNameBn: string;
    presentAddress: string;
    permanentAddress: string;
    education: string;
    verificationStatus: string;
    quota: { used: number; remaining: number };
  };
  vehicle: {
    seatType: string;
    manufacturer: string | null;
    model: string | null;
    manufactureYear: number;
    chassisNo: string;
    motorNo: string;
    batteryType: string;
    hasSpeedometer: boolean;
    insurancePolicyNo: string | null;
    colour: string | null;
    chargingLocation: string;
    status: string;
  } | null;
  zone: { code: string; nameBn: string; nameEn: string; uiColour: string } | null;
  ward: { number: number; nameBn: string; nameEn: string } | null;
  driver: { nameBn: string; nameEn: string | null; nidMasked: string; dateOfBirth: string; phone: string; address: string; trainingCertificateNo: string | null } | null;
  documents: { id: string; docType: string; mimeType: string; sizeBytes: number; sha256: string; uploadedAt: string }[];
  timeline: { fromStatus: string | null; toStatus: string; actorType: string; note: string | null; at: string }[];
}

export default function Detail() {
  const me = useRequireStaff('application.read');
  const { id } = useParams<{ id: string }>();
  const { t, tk, date, num, lang } = useI18n();
  const [d, setD] = useState<Detail | null>(null);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(() => {
    void api<Detail>(`/admin/applications/${id}`).then(setD).catch(setError);
  }, [id]);
  useEffect(() => {
    if (me) load();
  }, [me, load]);

  if (!me) return <Spinner />;
  if (error) return <ErrorAlert error={error} />;
  if (!d) return <Spinner />;

  return (
    <>
      <p>
        <Link href="/applications">← {t('admin.queue.title')}</Link>
      </p>
      <h1>
        {d.applicationNumber} <StatusBadge status={d.status} />
      </h1>
      <p className="muted">
        {t('admin.detail.due', { date: date(d.decisionDueDate), days: d.workingDaysElapsed })}{' '}
        {d.sla && <span className={`badge badge-${d.sla.toLowerCase()}`}>{tk(`sla.${d.sla}`)}</span>}
      </p>
      <Notice>{t('admin.detail.auditNote')}</Notice>
      <WorkflowPanel id={d.id} onChanged={load} />
      <div className="grid2">
        <div className="card">
          <h2>{t('admin.detail.owner')}</h2>
          <DefinitionList
            rows={[
              [t('owner.nameBn'), d.owner.nameBn],
              [t('owner.nameEn'), d.owner.nameEn],
              [t('owner.nid'), d.owner.nidMasked],
              [t('owner.dob'), date(d.owner.dateOfBirth)],
              [t('owner.father'), d.owner.fatherNameBn],
              [t('owner.mother'), d.owner.motherNameBn],
              [t('owner.presentAddress'), d.owner.presentAddress],
              [t('owner.permanentAddress'), d.owner.permanentAddress],
              [t('owner.education'), tk(`education.${d.owner.education}`)],
              [t('admin.detail.applicantPhone'), num(d.applicantPhone.replace('+88', ''))],
              ['NID', tk(`verification.${d.owner.verificationStatus}`)],
            ]}
          />
          <p className={d.owner.quota.remaining === 0 ? 'alert alert-warning' : 'muted'} data-testid="owner-quota">
            {t('admin.detail.quota', { used: d.owner.quota.used, remaining: d.owner.quota.remaining })}
          </p>
        </div>
        <div className="card">
          <h2>{t('admin.detail.vehicle')}</h2>
          {d.vehicle && (
            <DefinitionList
              rows={[
                [t('vehicle.seatType'), tk(`seat.${d.vehicle.seatType}`)],
                [t('vehicle.model'), `${d.vehicle.manufacturer ?? ''} ${d.vehicle.model ?? ''}`],
                [t('vehicle.year'), num(d.vehicle.manufactureYear)],
                [t('vehicle.chassis'), d.vehicle.chassisNo],
                [t('vehicle.motor'), d.vehicle.motorNo],
                [t('vehicle.battery'), tk(`battery.${d.vehicle.batteryType}`)],
                [t('vehicle.speedometer'), d.vehicle.hasSpeedometer ? t('common.yes') : t('common.no')],
                [t('vehicle.insurance'), d.vehicle.insurancePolicyNo],
                [t('vehicle.colour'), d.vehicle.colour],
                [t('location.charging'), d.vehicle.chargingLocation],
              ]}
            />
          )}
          <h3>{t('admin.detail.location')}</h3>
          <DefinitionList
            rows={[
              [t('location.zone'), <ZoneChip key="z" zone={d.zone} />],
              [t('location.ward'), d.ward ? (lang === 'bn' ? d.ward.nameBn : d.ward.nameEn) : null],
            ]}
          />
        </div>
        <div className="card">
          <h2>{t('admin.detail.driver')}</h2>
          {d.driver && (
            <DefinitionList
              rows={[
                [t('driver.nameBn'), d.driver.nameBn],
                [t('driver.nameEn'), d.driver.nameEn],
                [t('driver.nid'), d.driver.nidMasked],
                [t('driver.dob'), date(d.driver.dateOfBirth)],
                [t('driver.phone'), num(d.driver.phone.replace('+88', ''))],
                [t('driver.address'), d.driver.address],
                [t('driver.training'), d.driver.trainingCertificateNo],
              ]}
            />
          )}
        </div>
        <div className="card">
          <h2>{t('admin.detail.documents')}</h2>
          <ul>
            {d.documents.map((doc) => (
              <li key={doc.id}>
                <a href={`/api/v1/admin/applications/${d.id}/documents/${doc.id}/file`} target="_blank" rel="noopener noreferrer">
                  {tk(`doc.${doc.docType}`)}
                </a>{' '}
                <span className="muted small">
                  ({doc.mimeType}, {num(Math.ceil(doc.sizeBytes / 1024))} KB, SHA-256 {doc.sha256.slice(0, 12)}…)
                </span>
              </li>
            ))}
          </ul>
          <h3>{t('admin.detail.timeline')}</h3>
          <ol className="timeline">
            {d.timeline.map((e, i) => (
              <li key={i}>
                <StatusBadge status={e.toStatus} /> <span className="muted small">{date(e.at, true)} · {tk(`actor.${e.actorType}`)}</span>
                {e.note && <p className="small">{e.note}</p>}
              </li>
            ))}
          </ol>
        </div>
      </div>
    </>
  );
}
