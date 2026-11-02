/** Browser API client. Requests go to same-origin /api/v1 (proxied by Next.js to the API service). */

export interface ApiErrorBody {
  code: string;
  message: string;
  messageEn: string;
  details?: { fields?: Record<string, string>; missing?: string[]; [k: string]: unknown };
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: ApiErrorBody,
  ) {
    super(body.code);
  }
  get code(): string {
    return this.body.code;
  }
  get fields(): Record<string, string> {
    return this.body.details?.fields ?? {};
  }
  localized(lang: 'bn' | 'en'): string {
    return lang === 'en' ? this.body.messageEn : this.body.message;
  }
}

const NETWORK_ERROR: ApiErrorBody = {
  code: 'NETWORK_ERROR',
  message: 'সার্ভারের সাথে সংযোগ হয়নি। ইন্টারনেট সংযোগ দেখে আবার চেষ্টা করুন।',
  messageEn: 'Could not reach the server. Check your connection and try again.',
};

export async function api<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const headers = new Headers(init.headers);
  const method = (init.method ?? 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') headers.set('x-dscc-csrf', '1');
  let body = init.body;
  if (init.json !== undefined) {
    headers.set('content-type', 'application/json');
    body = JSON.stringify(init.json);
  }
  let res: Response;
  try {
    res = await fetch(`/api/v1${path}`, { ...init, method, headers, body, credentials: 'same-origin', cache: 'no-store' });
  } catch {
    throw new ApiError(0, NETWORK_ERROR);
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const err = (data as { error?: ApiErrorBody } | null)?.error;
    throw new ApiError(res.status, err ?? { code: 'INTERNAL_ERROR', message: 'একটি সমস্যা হয়েছে।', messageEn: 'Something went wrong.' });
  }
  return data as T;
}

export function newIdempotencyKey(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}
