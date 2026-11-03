# DSCC ই-রিকশা ব্যবস্থাপনা সিস্টেম — ফেজ ১ ও ২

ঢাকা দক্ষিণ সিটি কর্পোরেশনের ই-রিকশা নিবন্ধন ব্যবস্থা।

**ফেজ ১:** নাগরিক OTP লগইন, মালিক (NID) নিবন্ধন, গাড়ি + চালক + নথিসহ আবেদন, আবেদন নম্বর (DSCC-YYYY-NNNNNN),
এক NID-এ সর্বোচ্চ ৫টি গাড়ি (বিধি ৪(৮)), কর্মকর্তা লগইন (পাসওয়ার্ড + TOTP), আবেদন ক্যু এবং জোন Z1–Z4 কনফিগারেশন।

**ফেজ ২:** কর্মকর্তার যাচাই চেকলিস্ট ও সংশোধনের অনুরোধ (আবেদনকারী সংশোধন করে একই নম্বরে আবার জমা দেন),
অনুমোদনের শর্ত (gate) দেখে অনুমোদন বা লিখিত কারণসহ না-মঞ্জুর (বিধি ৪(৬)), তফসিল-৪ ফিটনেস পরিদর্শন ও ভিন্ন
ট্রাফিক কর্মকর্তার প্রতিস্বাক্ষর, তফসিল-২ ফি (অনলাইন পেমেন্ট সিমুলেটর ও ব্যাংক চালান), জোনভিত্তিক প্লেট নম্বর ও
স্বাক্ষরিত QR কোড, লগইন ছাড়া পাবলিক QR যাচাই পাতা, এবং না-মঞ্জুরের বিরুদ্ধে আপিল (বিধি ৪(৭))।
অনুমোদন, না-মঞ্জুর, আপিলের সিদ্ধান্ত, প্লেট ইস্যু ও QR পুনঃইস্যুতে নতুন TOTP কোড লাগে; প্রতিটি ধাপ ভিন্ন
কর্মকর্তা করেন (দায়িত্ব বিভাজন অ্যাপ ও ডাটাবেস দুই জায়গায় বাধ্যতামূলক)।

**ডিএসসিসির সিদ্ধান্ত (২০২৬-১১-০২):** আবেদন জমার আগেই ফিটনেস সনদ লাগবে — আবেদনকারী খসড়া থেকে পরিদর্শনের আবেদন
করেন, ফিটনেস ফি দেন, কর্মকর্তা সময় দেন, পরিদর্শন ও প্রতিস্বাক্ষরের পর সনদ ইস্যু হলে তবেই জমা দেওয়া যায়;
সনদ চেসিস ও মোটর নম্বরের সাথে বাঁধা। না-মঞ্জুর চূড়ান্ত হলে পরিশোধিত সব ফি (ফিটনেস ফিসহ) ফেরত যায় — অনলাইন
পেমেন্ট সঙ্গে সঙ্গে, ব্যাংক চালানের টাকা রাজস্ব কর্মকর্তা ব্যাংক রেফারেন্স লিখলে। ব্যাংক চালানে একজন কর্মকর্তার
এন্ট্রিই যথেষ্ট (দ্বিতীয় অনুমোদন নেই)। ৩০ কর্মদিবসের সময়সীমা সংশোধনের সময়েও চলতে থাকে। প্লেট নম্বর
`DSCC-Z1-000001` (ছয় অঙ্ক)।

ব্লু বুক, নবায়ন, ট্রাফিক পোর্টাল ও জরিমানা এখনো নেই। জরিমানা বন্ধ থাকবে; RFID গেজেটে নেই বলে রাখা হয়নি।
সব SMS, NID যাচাই ও পেমেন্ট সিমুলেটর; কোনো সরকারি সিস্টেমের সাথে লাইভ সংযোগ নেই। প্রোডাকশন মোডে
সিমুলেটর চালু থাকলে API চালুই হয় না।

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
cp services/api/.env.example services/api/.env   # fill the six 32-byte keys (openssl rand -base64 32)
pnpm --filter @dscc/api run prisma:generate
pnpm build
cd services/api && set -a && . ./.env && set +a
node scripts/migrate.js && node dist/seed/seed.js
STAFF_PASSWORD='choose-a-long-password' node dist/seed/create-staff.js admin@dscc.test "প্রশাসক" DSCC_ADMIN
# Phase 2 roles, one person each: VERIFICATION_OFFICER, APPROVING_OFFICER, INSPECTION_OFFICER,
# TRAFFIC_COUNTERSIGNER, REVENUE_OFFICER, PLATE_OFFICER, APPEAL_AUTHORITY
node dist/main.js                         # API on :4000
pnpm --filter @dscc/portal start          # http://localhost:3000
pnpm --filter @dscc/admin start           # http://localhost:3001
```

In development the simulated SMS inbox is at `GET /api/v1/dev/sms?phone=+8801...` (disabled in production).
Simulated NID checks fail for NID numbers ending in `0000`.

Phase 2 settings in `services/api/.env`:

| Variable | Purpose |
| --- | --- |
| `PAYMENT_PROVIDER` | `simulator` only; the citizen is sent to `/pay/sim/<session>` in the portal |
| `PAYMENT_WEBHOOK_SECRET` | HMAC key the gateway signs callbacks with (`POST /api/v1/payments/webhook/simulator`) |
| `QR_SIGNING_KEY` | Ed25519 seed for QR tokens; the public key is at `GET /api/v1/public/qr-key` |
| `PUBLIC_VERIFY_BASE_URL` | Base of the URL printed in the QR (`<base>/v/<token>`) |
| `FITNESS_VALIDITY_MONTHS` | Fitness certificate validity in months (gazette leaves it blank; DSCC confirmed 12) |
| `MAINTENANCE_POLL_MS` | How often expired appeal windows are finalised |

## Tests

```bash
pnpm typecheck
pnpm test        # domain, localization, API unit + integration (uses dscc_test)
pnpm test:e2e    # builds must exist; recreates dscc_e2e
```

## Rules for this repository

- No deploy, merge to main, or live government integration without explicit DSCC approval.
- Fines are disabled until DSCC legal confirms them. RFID is not in the gazette and is not built. Plate format follows the Phase 0 recommendation
  (system ID `DSCC-Z1-000001`, six digits, confirmed by DSCC on 2026-11-02; printed `ঢাকা দক্ষিণ-ক-০০০০০১`). Zone colours are still pending DSCC decision.
- Zone wards, vehicle models and holidays in the seed are samples until DSCC supplies official lists.
