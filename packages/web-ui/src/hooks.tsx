'use client';

import { useCallback, useState } from 'react';
import { ApiError } from './api';

/** Busy/error/success state for one form action; `fields` holds API field error codes. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState<string | null>(null);
  const run = useCallback(async <T,>(fn: () => Promise<T>, success?: (r: T) => string | null): Promise<T | undefined> => {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const r = await fn();
      if (success) setDone(success(r));
      return r;
    } catch (e) {
      setError(e);
      return undefined;
    } finally {
      setBusy(false);
    }
  }, []);
  const fields = error instanceof ApiError ? error.fields : {};
  return { busy, error, done, run, fields, setDone };
}
