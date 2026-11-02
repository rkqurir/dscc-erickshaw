# Requirements traceability — Phases 1 and 2

Source: S.R.O. 384-Law/2026 (ই-রিকশা নিবন্ধন ও চলাচল বিধিমালা, gazette 29 Oct 2026) and the approved Phase 0 report.
Rule numbers 4(8), 9, 19 and Schedules 2–3 were checked against the gazette in Phase 0; the other rule numbers below are to be re-verified against the gazette text before Gate C.

"API test" = `services/api/test/*.test.ts`, "E2E" = `e2e/tests/*.spec.ts`, "Unit" = `packages/*/test` and `services/api/test/unit.test.ts`.

| Requirement | Source | Code | Tests |
| --- | --- | --- | --- |
| Max 5 e-rickshaws per NID, counted across all city corporations | Rule 4(8) | `services/api/src/modules/owners/quota.service.ts`; DB trigger in `prisma/migrations/0002_security`; `MAX_VEHICLES_PER_NID` in `packages/domain/src/schemas.ts` | API `quota.test.ts` (0→5 allowed, 6th blocked with Bengali message; shared across phones; 13/17-digit NID; withdrawal frees slot; other-city declarations; trigger bypass; concurrent slot 4). E2E `citizen.spec.ts` sixth-vehicle test |
| Owner is a Bangladeshi adult citizen, not declared of unsound mind | Rule 4 (owner eligibility) | `ownerIdentitySchema` in `packages/domain/src/schemas.ts`; `owners.ts` | API `applications.test.ts` "rejects minors, missing declarations…" ; E2E owner form |
| NID identifies the owner; 13- and 17-digit forms are the same person | Rule 4, Form | `packages/domain/src/nid.ts`; NID HMAC in `platform/crypto.ts` | Unit `domain.test.ts`; API "treats 13- and 17-digit forms…" |
| Application documents (NID copy, photos, fitness certificate, fee receipt, driver docs) required at application | Rule 5 & Schedule 1 form | `DOCUMENT_TYPES` in `schemas.ts`; `applications.service.ts` `submit` | API "refuses incomplete submissions…"; E2E review step lists missing documents |
| Vehicle must be an approved model matching seat type (2 or 4 seats) | Rule 5, Schedule 2 | `catalog.ts`; `applications.service.ts` | API "rejects … a model that does not match the seat type" |
| Charging station / garage recorded with the application | Schedule (blue book contents) | `chargingStation` field, `applicationSubmitSchema` | E2E citizen application |
| Registration decision within 30 working days (Fri/Sat weekend, holidays) | Rule 6 | `packages/domain/src/working-days.ts`; SLA in `admin-applications.ts` | Unit working-day tests; API unit "marks 20+ working days at risk and 31+ overdue"; E2E queue shows "সময়মতো" |
| Zones with distinct colours; vehicles run only in their zone | Rule 9 | Zone model, `admin-zones.ts`; ward must belong to chosen zone | API "rejects a ward from another zone"; "updates a zone with optimistic locking…"; E2E zone edit |
| Plate: "[city] [area code]-[number]", white letters on prescribed colour | Schedule 3 | `formatPlateBengali`, `formatPlateSystemId` in `identifiers.ts`; contrast check `colour.ts` | Unit identifier/contrast tests; API "flags poor white-on-yellow contrast"; E2E plate preview |
| Unique application number DSCC-YYYY-NNNNNN | Phase 0 §8 | `formatApplicationNumber`; counter upsert in `applications.service.ts` | API "submits, allocates…, is idempotent"; "unique and gap-free across 20 parallel submissions" |
| One chassis/motor number cannot be registered twice | Rule 5 | partial unique indexes in `0002_security` | API "blocks a chassis or motor number that is already live" |
| Applicant privacy: NIDs encrypted, masked everywhere, consent recorded | Phase 0 §11, Digital Security / data protection practice | `platform/crypto.ts`, `guards.ts` consent, masked DTOs | API "encrypts the NID…"; "requires privacy consent…"; IDOR test |
| Staff access: password + TOTP, role permissions, zone scope, audited views | Phase 0 §10 | `staff-auth.ts`, `guards.ts`, `admin-applications.ts` | API auth tests (MFA, lockout, replay, 403); "restricts zone-scoped officers"; "audits every view and download"; E2E admin login |
| Tamper-evident audit log | Phase 0 §11 | `platform/audit.service.ts`; append-only triggers | API "audit hash chain verifies"; "runtime role cannot delete records or rewrite the audit log" |
| City data isolation | Phase 0 §7 | RLS policies in `0002_security`; `PrismaService.inCity` | API "row-level security hides city data…" |
| Bengali primary UI, English optional, accessible on mobile | Project rules | `packages/localization`, `packages/web-ui` | E2E language switch, axe WCAG 2 AA checks, mobile layout test |

## Phase 2

"API workflow" = `services/api/test/workflow.test.ts`, "Domain" = `packages/domain/test/workflow.test.ts`, "E2E workflow" = `e2e/tests/workflow.spec.ts`.

| Requirement | Source | Code | Tests |
| --- | --- | --- | --- |
| Officer verifies the file item by item; latest result per item counts | Rule 4 (scrutiny), Phase 0 §6 | `VERIFICATION_ITEMS`, `checklistComplete` in `packages/domain/src/workflow.ts`; `DecisionService.recordCheck` | Domain "uses the latest result per item…"; E2E workflow verification step |
| Owner NID confirmed before approval (manual check when the simulator says pending) | Rule 4(1) | `OWNER_IDENTITY` PASS sets owner VERIFIED; gate `OWNER_NID_VERIFIED` | API workflow "approves only when every gate is met…" |
| Correction request; applicant corrects and resubmits under the same number | Phase 0 §6 | `requestCorrection`; `ApplicationsService.applyResubmission`; wizard correction mode | API "sends the file back, lets the applicant correct and resubmit…"; E2E workflow correction step |
| Approval only when every gate holds | Rules 3, 4, 5 | `APPROVAL_GATES`, `DecisionService.computeGates`/`approve`; DB trigger `enforce_approval_has_decision` | API "refuses approval with unmet gates, without a fresh TOTP, by the verifying officer…"; E2E approval step |
| Zone vehicle ceiling | Rule 3 | gate `ZONE_QUOTA_AVAILABLE` | API "enforces the zone vehicle quota (Rule 3) at approval" |
| Rejection reasons in writing, sent to the applicant | Rule 4(6) | `rejectionSchema` (reason codes + text ≥10 chars); SMS via outbox; citizen `RejectionCard` | Domain "requires written rejection reasons…"; API rejection test; E2E citizen sees reasons |
| Appeal within 10 working days to the appeal authority (DSCC, confirmed 2026-11-02), heard by an officer who did not reject | Rule 4(7) | `APPEAL_WINDOW_WORKING_DAYS`; `fileAppeal`, `decideAppeal`; DB trigger `enforce_appeal_separation`; `finalizeExpiredRejections` | API "requires written reasons, keeps the quota slot during the appeal window…"; "finalises a rejection once the appeal window passes…"; E2E appeal allowed |
| Quota slot held while an appeal is possible, released when final | Rule 4(8) | `QUOTA_HOLDING_APPLICATION_STATUSES` includes REJECTED; slot released on finalisation | API rejection/appeal test |
| Fitness inspection on Schedule 4 items, countersigned by a different traffic officer | Rule 4(11), Schedule 4, Rule 5(3) speedometer | `FITNESS_ITEMS`; `InspectionService`; CHECK `fitness_inspections_two_people_chk` | Domain "passes only when every Schedule 4 item passes"; API "records a failed inspection, allows re-inspection and needs a different officer to countersign"; E2E inspection step |
| Fees per Schedule 2 (2-seat / 4-seat, fitness) from a dated fee table | Schedule 2 | `fee_schedules` seed `FEE_SCHEDULE_2026`; `feeFor`; `FeesService`; DB trigger `enforce_payment_amount` | Domain fee tests; API "creates the Schedule 2 invoice at submission…"; "lets a revenue officer record a bank challan once…"; E2E payment step |
| Payment confirmed only by a signed, idempotent gateway callback (simulator) | Phase 0 §9 | `FeesService.handleCallback` (HMAC over canonical JSON, unique provider ref) | API payment tests (forged signature, replay, declined); E2E forged callback refused |
| Registration valid 5 years; economic life 12 years | Rules 4(5), 5(2) | `REGISTRATION_VALIDITY_MONTHS`, `ECONOMIC_LIFE_MONTHS`, `periodEndIso` | Domain "computes validity periods…"; API full-flow test |
| Plate number per zone, Bengali print form and system ID from one record | Schedule 3 (format pending DSCC) | `RegistrationService.issue`; `serial_counters`; `enforce_issue_separation` | API "allocates distinct plate serials when officers issue at the same time"; E2E plate step |
| QR on the vehicle that anyone can verify, with no personal data | Rule 4(4) | Ed25519-signed token `parseQrToken`/`qrSignedMessage`; `publicVerify`; portal `/v/[token]`; scan log with hashed IP | Domain "QR token format"; API full-flow test (forged token, revoked QR after reissue); E2E public verify page and tampered token |
| Irreversible actions need a fresh second factor; each code works once | Phase 0 §10 | `StepUpService` | API "refuses approval … without a fresh TOTP"; E2E wrong code refused |
| New workflow records are city-isolated and cannot be rewritten | Phase 0 §7, §11 | RLS + append-only triggers in `0003_phase2_workflow`; grants in `scripts/migrate.js` | API "keeps new workflow tables city-isolated and append-only…" |

## Not built yet (by design)

Blue book, renewal, traffic portal, fines (Rule 19 lists offences without amounts — blocked until DSCC legal confirms),
RFID (not in the gazette), live payment gateway and live NID/SMS integrations (simulators only).
