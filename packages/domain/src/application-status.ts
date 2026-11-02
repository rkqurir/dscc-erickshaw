/**
 * Application lifecycle. Phase 1 implements DRAFT → SUBMITTED and withdrawal.
 * Later phases add verification, inspection and decisions; their states are declared here so the
 * transition table is the single source of truth, but no Phase 1 endpoint can reach them.
 */
export const APPLICATION_STATUSES = [
  'DRAFT',
  'SUBMITTED',
  'UNDER_VERIFICATION',
  'CORRECTION_REQUESTED',
  'APPROVED',
  'REJECTED',
  'WITHDRAWN',
] as const;

export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

export type ApplicationAction =
  | 'SUBMIT'
  | 'WITHDRAW'
  | 'START_VERIFICATION'
  | 'REQUEST_CORRECTION'
  | 'RESUBMIT'
  | 'APPROVE'
  | 'REJECT';

const TRANSITIONS: Record<ApplicationAction, { from: ApplicationStatus[]; to: ApplicationStatus }> = {
  SUBMIT: { from: ['DRAFT'], to: 'SUBMITTED' },
  WITHDRAW: { from: ['SUBMITTED', 'UNDER_VERIFICATION', 'CORRECTION_REQUESTED'], to: 'WITHDRAWN' },
  START_VERIFICATION: { from: ['SUBMITTED'], to: 'UNDER_VERIFICATION' },
  REQUEST_CORRECTION: { from: ['UNDER_VERIFICATION'], to: 'CORRECTION_REQUESTED' },
  RESUBMIT: { from: ['CORRECTION_REQUESTED'], to: 'SUBMITTED' },
  APPROVE: { from: ['UNDER_VERIFICATION'], to: 'APPROVED' },
  REJECT: { from: ['UNDER_VERIFICATION'], to: 'REJECTED' },
};

/** Actions available through the API in Phase 1. */
export const PHASE1_ACTIONS: ReadonlySet<ApplicationAction> = new Set(['SUBMIT', 'WITHDRAW']);

export function nextStatus(from: ApplicationStatus, action: ApplicationAction): ApplicationStatus | null {
  const t = TRANSITIONS[action];
  return t.from.includes(from) ? t.to : null;
}

/** Statuses whose vehicle holds one of the owner's five quota slots (Rule 4(8)). */
export const QUOTA_HOLDING_APPLICATION_STATUSES: ReadonlySet<ApplicationStatus> = new Set([
  'SUBMITTED',
  'UNDER_VERIFICATION',
  'CORRECTION_REQUESTED',
  'APPROVED',
]);

/** Statutory decision deadline in working days after submission (Rule 4). */
export const DECISION_DEADLINE_WORKING_DAYS = 30;
