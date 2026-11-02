# Requirements traceability — Phase 1

Source: S.R.O. 384-Law/2026 (ই-রিকশা নিবন্ধন ও চলাচল বিধিমালা, gazette 29 Oct 2026) and the approved Phase 0 report.
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

## Not in Phase 1 (by design)

Approve/reject decisions and reasons (Rule 6, 7 working days), appeal (10 working days), fitness inspection, fee payment,
plate/QR issue, blue book, renewal, traffic portal, fines (Rule 19 lists offences without amounts — blocked until DSCC legal
confirms), RFID (not in the gazette).
