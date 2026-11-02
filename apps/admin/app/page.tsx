'use client';

import { Spinner } from '@dscc/web-ui';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { useStaffSession } from '../components/session';

export default function Home() {
  const { state } = useStaffSession();
  const router = useRouter();
  useEffect(() => {
    if (state.status === 'anonymous') router.replace('/login');
    if (state.status === 'ready') {
      const p = state.me.permissions;
      const first: [string, string][] = [
        ['application.read', '/applications'],
        ['inspection.read', '/inspections'],
        ['payment.read', '/payments'],
        ['registration.read', '/registrations'],
        ['appeal.read', '/appeals'],
      ];
      router.replace(first.find(([perm]) => p.includes(perm))?.[1] ?? '/zones');
    }
  }, [state, router]);
  return <Spinner />;
}
