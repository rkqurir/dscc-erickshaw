# DSCC ই-রিকশা ব্যবস্থাপনা সিস্টেম — ফেজ ১

ঢাকা দক্ষিণ সিটি কর্পোরেশনের ই-রিকশা নিবন্ধন ব্যবস্থা। ফেজ ১-এ আছে: নাগরিক OTP লগইন, মালিক (NID) নিবন্ধন,
গাড়ি + চালক + নথিসহ আবেদন, আবেদন নম্বর (DSCC-YYYY-NNNNNN), এক NID-এ সর্বোচ্চ ৫টি গাড়ি (বিধি ৪(৮)),
কর্মকর্তা লগইন (পাসওয়ার্ড + TOTP), আবেদন ক্যু (শুধু দেখা) এবং জোন Z1–Z4 কনফিগারেশন।

অনুমোদন/বাতিল, ফিটনেস, পেমেন্ট, প্লেট/QR/RFID, ব্লু বুক ও ট্রাফিক পোর্টাল এই ফেজে নেই।
সব SMS ও NID যাচাই সিমুলেটর; কোনো সরকারি সিস্টেমের সাথে লাইভ সংযোগ নেই।

## Layout

| Path | What |
| --- | --- |
| `packages/domain` | Pure rules: phone/NID normalisation, application & plate numbers, working days, zod schemas |
| `packages/localization` | Bengali (primary) and English UI text and error messages |
| `packages/web-ui` | Shared React components, i18n provider, API client, CSS |
| `services/api` | NestJS + Prisma + PostgreSQL 16 API (`/api/v1`) |
| `apps/portal` | Citizen portal (Next.js), port 3000 |
| `apps/admin` | DSCC staff dashboard (Next.js), port 3001 |
| `e2e` | Playwright end-to-end tests (desktop + mobile, axe accessibility checks) |
| `docs/requirements-traceability.md` | Gazette rule → code → test |

## Run locally

Requires Node 22, pnpm 10 and PostgreSQL 16.

```bash
docker compose up -d postgres            # or: psql -U postgres -f infra/postgres/init.sql on a local server
pnpm install
cp services/api/.env.example services/api/.env   # fill the four 32-byte keys
pnpm --filter @dscc/api run prisma:generate
pnpm build
cd services/api && set -a && . ./.env && set +a
node scripts/migrate.js && node dist/seed/seed.js
STAFF_PASSWORD='choose-a-long-password' node dist/seed/create-staff.js admin@dscc.test "প্রশাসক" DSCC_ADMIN
node dist/main.js                         # API on :4000
pnpm --filter @dscc/portal start          # http://localhost:3000
pnpm --filter @dscc/admin start           # http://localhost:3001
```

In development the simulated SMS inbox is at `GET /api/v1/dev/sms?phone=+8801...` (disabled in production).
Simulated NID checks fail for NID numbers ending in `0000`.

## Tests

```bash
pnpm typecheck
pnpm test        # domain, localization, API unit + integration (uses dscc_test)
pnpm test:e2e    # builds must exist; recreates dscc_e2e
```

## Rules for this repository

- No deploy, merge to main, or live government integration without explicit DSCC approval.
- Fines are disabled until DSCC legal confirms them. Plate format follows the Phase 0 recommendation
  (system ID `DSCC-Z1-2324`, printed `ঢাকা দক্ষিণ-ক-২৩২৪`) pending DSCC decision.
- Zone wards, vehicle models and holidays in the seed are samples until DSCC supplies official lists.
