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
    if (state.status === 'ready') router.replace(state.me.permissions.includes('application.read') ? '/applications' : '/zones');
  }, [state, router]);
  return <Spinner />;
}
