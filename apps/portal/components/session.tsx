'use client';

import { ApiError, api } from '@dscc/web-ui';
import { useRouter } from 'next/navigation';
import { ReactNode, createContext, useCallback, useContext, useEffect, useState } from 'react';

export interface Me {
  phone: string;
  hasConsent: boolean;
  privacyNoticeVersion: string;
  owner: { nameBn: string; nameEn: string | null; nidMasked: string; verificationStatus: string } | null;
}

type State = { status: 'loading' } | { status: 'anonymous' } | { status: 'ready'; me: Me };

const Ctx = createContext<{ state: State; refresh: () => Promise<void>; logout: () => Promise<void> } | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>({ status: 'loading' });
  const refresh = useCallback(async () => {
    try {
      const me = await api<Me>('/me');
      setState({ status: 'ready', me });
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setState({ status: 'anonymous' });
      else setState({ status: 'anonymous' });
    }
  }, []);
  const logout = useCallback(async () => {
    try {
      await api('/auth/logout', { method: 'POST' });
    } finally {
      setState({ status: 'anonymous' });
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  return <Ctx.Provider value={{ state, refresh, logout }}>{children}</Ctx.Provider>;
}

export function useSession() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useSession outside SessionProvider');
  return v;
}

/**
 * Guard for pages that need a signed-in citizen. Redirects to login, to the consent page, or (when
 * `owner` is required) to owner registration. Returns the session once the requirements are met.
 */
export function useRequireCitizen(opts: { owner?: boolean } = {}): Me | null {
  const { state } = useSession();
  const router = useRouter();
  const needsOwner = !!opts.owner;
  useEffect(() => {
    if (state.status === 'anonymous') router.replace('/login');
    else if (state.status === 'ready' && !state.me.hasConsent) router.replace('/consent');
    else if (state.status === 'ready' && needsOwner && !state.me.owner) router.replace('/owner/register');
  }, [state, router, needsOwner]);
  if (state.status !== 'ready' || !state.me.hasConsent || (needsOwner && !state.me.owner)) return null;
  return state.me;
}
