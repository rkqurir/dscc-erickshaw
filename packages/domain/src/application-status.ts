/**
 * Application lifecycle — the single source of truth for status transitions.
 *
 * Phase 1: DRAFT → SUBMITTED, withdrawal.
 * Phase 2: verification, correction requests, approval / rejection with reasons, and the
 * Rule 4(7) appeal that can reopen a rejected application.
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
  | 'REJECT'
  | 'REOPEN_ON_APPEAL';

const TRANSITIONS: Record<ApplicationAction, { from: ApplicationStatus[]; to: ApplicationStatus }> = {
  SUBMIT: { from: ['DRAFT'], to: 'SUBMITTED' },
  WITHDRAW: { from: ['SUBMITTED', 'UNDER_VERIFICATION', 'CORRECTION_REQUESTED'], to: 'WITHDRAWN' },
  START_VERIFICATION: { from: ['SUBMITTED'], to: 'UNDER_VERIFICATION' },
  REQUEST_CORRECTION: { from: ['UNDER_VERIFICATION'], to: 'CORRECTION_REQUESTED' },
  RESUBMIT: { from: ['CORRECTION_REQUESTED'], to: 'SUBMITTED' },
  APPROVE: { from: ['UNDER_VERIFICATION'], to: 'APPROVED' },
  REJECT: { from: ['UNDER_VERIFICATION'], to: 'REJECTED' },
  // Rule 4(7): an appeal allowed by the higher authority sends the case back for a fresh decision.
  REOPEN_ON_APPEAL: { from: ['REJECTED'], to: 'UNDER_VERIFICATION' },
};

export function nextStatus(from: ApplicationStatus, action: ApplicationAction): ApplicationStatus | null {
  const t = TRANSITIONS[action];
  return t.from.includes(from) ? t.to : null;
}

/** Statuses in which the applicant may edit the form and documents. */
export const EDITABLE_APPLICATION_STATUSES: ReadonlySet<ApplicationStatus> = new Set(['DRAFT', 'CORRECTION_REQUESTED']);

/**
 * Statuses whose vehicle holds one of the owner's five quota slots (Rule 4(8)).
 * A REJECTED application keeps its slot until the appeal window closes or the appeal is dismissed
 * (see application finalisation), so an owner cannot fill the slot while an appeal could reopen it.
 */
export const QUOTA_HOLDING_APPLICATION_STATUSES: ReadonlySet<ApplicationStatus> = new Set([
  'SUBMITTED',
  'UNDER_VERIFICATION',
  'CORRECTION_REQUESTED',
  'APPROVED',
  'REJECTED',
]);

/** Statutory decision deadline in working days after submission (Rule 4(3)). */
export const DECISION_DEADLINE_WORKING_DAYS = 30;
/** Rejection reasons must be communicated in writing within 7 working days (Rule 4(6)). */
export const REJECTION_NOTICE_WORKING_DAYS = 7;
/** An appeal against rejection may be filed within 10 working days of the order (Rule 4(7)). */
export const APPEAL_WINDOW_WORKING_DAYS = 10;
