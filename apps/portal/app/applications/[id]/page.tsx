'use client';

import { ErrorAlert, Spinner, api, useI18n } from '@dscc/web-ui';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { useRequireCitizen } from '../../../components/session';
import { ApplicationView } from '../../../components/application-view';
import { ApplicationWizard } from '../../../components/application-wizard';
import type { ApplicationDetail } from '../../../components/types';

export default function ApplicationPage() {
  const me = useRequireCitizen({ owner: true });
  const { id } = useParams<{ id: string }>();
  const [app, setApp] = useState<ApplicationDetail | null>(null);
  const [error, setError] = useState<unknown>(null);
  const { t } = useI18n();

  const load = useCallback(async () => {
    try {
      setApp(await api<ApplicationDetail>(`/applications/${id}`));
    } catch (e) {
      setError(e);
    }
  }, [id]);

  useEffect(() => {
    if (me) void load();
  }, [me, load]);

  if (!me) return <Spinner />;
  if (error && !app) {
    return (
      <>
        <ErrorAlert error={error} />
        <a href="/dashboard">{t('common.back')}</a>
      </>
    );
  }
  if (!app) return <Spinner />;
  // Drafts and files returned for correction open in the editable wizard; everything else is read-only.
  return app.status === 'DRAFT' || app.status === 'CORRECTION_REQUESTED' ? (
    <ApplicationWizard key={app.status} initial={app} onSubmitted={load} />
  ) : (
    <ApplicationView app={app} onChange={load} />
  );
}
