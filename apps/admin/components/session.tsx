'use client';

import { api } from '@dscc/web-ui';
import { useRouter } from 'next/navigation';
import { ReactNode, createContext, useCallback, useContext, useEffect, useState } from 'react';

export interface StaffMe {
  email: string;
  fullName: string;
  roles: string[];
  permissions: string[];
}

type State = { status: 'loading' } | { status: 'anonymous' } | { status: 'ready'; me: StaffMe };

const Ctx = createContext<{ state: State; refresh: () => Promise<void>; logout: () => Promise<void> } | null>(null);

export function StaffSessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>({ status: 'loading' });
  const refresh = useCallback(async () => {
    try {
      setState({ status: 'ready', me: await api<StaffMe>('/staff/auth/me') });
    } catch {
      setState({ status: 'anonymous' });
    }
  }, []);
  const logout = useCallback(async () => {
    try {
      await api('/staff/auth/logout', { method: 'POST' });
    } catch {
      /* session may already be gone */
    }
    setState({ status: 'anonymous' });
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  return <Ctx.Provider value={{ state, refresh, logout }}>{children}</Ctx.Provider>;
}

export function useStaffSession() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useStaffSession outside provider');
  return v;
}

/** Requires a fully authenticated (password + TOTP) officer holding `permission`. */
export function useRequireStaff(permission?: string): StaffMe | null {
  const { state } = useStaffSession();
  const router = useRouter();
  useEffect(() => {
    if (state.status === 'anonymous') router.replace('/login');
  }, [state, router]);
  if (state.status !== 'ready') return null;
  if (permission && !state.me.permissions.includes(permission)) return null;
  return state.me;
}
