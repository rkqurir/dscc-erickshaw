-- Phase 2: verification, correction requests, fitness inspection, fees and payments,
-- decisions with reasons, appeals (Rule 4(7)), plate registration and signed QR credentials.

-- AlterTable
ALTER TABLE "applications" ADD COLUMN     "appeal_deadline" DATE,
ADD COLUMN     "decided_at" TIMESTAMPTZ(3),
ADD COLUMN     "rejection_final_at" TIMESTAMPTZ(3),
ADD COLUMN     "verification_started_at" TIMESTAMPTZ(3),
ADD COLUMN     "verified_by_staff_id" UUID;

-- CreateTable
CREATE TABLE "verification_checks" (
    "id" UUID NOT NULL,
    "city_id" UUID NOT NULL,
    "application_id" UUID NOT NULL,
    "item" TEXT NOT NULL,
    "result" TEXT NOT NULL,
    "note" TEXT,
    "staff_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "verification_checks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "correction_requests" (
    "id" UUID NOT NULL,
    "city_id" UUID NOT NULL,
    "application_id" UUID NOT NULL,
    "items" TEXT[],
    "message" TEXT NOT NULL,
    "requested_by_staff_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMPTZ(3),

    CONSTRAINT "correction_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fitness_inspections" (
    "id" UUID NOT NULL,
    "city_id" UUID NOT NULL,
    "application_id" UUID NOT NULL,
    "vehicle_id" UUID NOT NULL,
    "status" TEXT NOT NULL,
    "scheduled_for" TIMESTAMPTZ(3) NOT NULL,
    "location" TEXT NOT NULL,
    "scheduled_by_staff_id" UUID NOT NULL,
    "checklist" JSONB,
    "inspector_staff_id" UUID,
    "inspected_at" TIMESTAMPTZ(3),
    "inspector_note" TEXT,
    "countersigned_by_staff_id" UUID,
    "countersigned_at" TIMESTAMPTZ(3),
    "certificate_no" TEXT,
    "valid_until" DATE,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fitness_inspections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "serial_counters" (
    "city_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "last_value" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "serial_counters_pkey" PRIMARY KEY ("city_id","kind","scope")
);

-- CreateTable
CREATE TABLE "fee_schedules" (
    "id" UUID NOT NULL,
    "service" TEXT NOT NULL,
    "seat_type" TEXT,
    "amount_bdt" INTEGER NOT NULL,
    "effective_from" DATE NOT NULL,
    "effective_to" DATE,
    "legal_ref" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fee_schedules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoices" (
    "id" UUID NOT NULL,
    "city_id" UUID NOT NULL,
    "application_id" UUID NOT NULL,
    "invoice_no" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "total_bdt" INTEGER NOT NULL,
    "lines" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paid_at" TIMESTAMPTZ(3),

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" UUID NOT NULL,
    "city_id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "method" TEXT NOT NULL,
    "provider_ref" TEXT NOT NULL,
    "amount_bdt" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "receipt_no" TEXT,
    "recorded_by_staff_id" UUID,
    "details" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_sessions" (
    "id" UUID NOT NULL,
    "city_id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "status" TEXT NOT NULL,
    "amount_bdt" INTEGER NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closed_at" TIMESTAMPTZ(3),

    CONSTRAINT "payment_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "application_decisions" (
    "id" UUID NOT NULL,
    "city_id" UUID NOT NULL,
    "application_id" UUID NOT NULL,
    "decision" TEXT NOT NULL,
    "reason_codes" TEXT[],
    "reason_text" TEXT,
    "decided_by_staff_id" UUID NOT NULL,
    "gates" JSONB NOT NULL,
    "decided_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "application_decisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "appeals" (
    "id" UUID NOT NULL,
    "city_id" UUID NOT NULL,
    "application_id" UUID NOT NULL,
    "decision_id" UUID NOT NULL,
    "filed_by_user_id" UUID NOT NULL,
    "grounds" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "filed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_by_staff_id" UUID,
    "decided_at" TIMESTAMPTZ(3),
    "decision_note" TEXT,

    CONSTRAINT "appeals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "registrations" (
    "id" UUID NOT NULL,
    "city_id" UUID NOT NULL,
    "application_id" UUID NOT NULL,
    "vehicle_id" UUID NOT NULL,
    "owner_identity_id" UUID NOT NULL,
    "zone_id" UUID NOT NULL,
    "plate_serial" INTEGER NOT NULL,
    "plate_system_id" TEXT NOT NULL,
    "plate_text_bn" TEXT NOT NULL,
    "registered_on" DATE NOT NULL,
    "valid_until" DATE NOT NULL,
    "end_of_life_on" DATE NOT NULL,
    "status" TEXT NOT NULL,
    "issued_by_staff_id" UUID NOT NULL,
    "issued_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "registrations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "qr_credentials" (
    "id" UUID NOT NULL,
    "city_id" UUID NOT NULL,
    "registration_id" UUID NOT NULL,
    "token_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "issued_by_staff_id" UUID NOT NULL,
    "issued_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMPTZ(3),
    "revoke_reason" TEXT,

    CONSTRAINT "qr_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "qr_scan_events" (
    "id" UUID NOT NULL,
    "city_id" UUID NOT NULL,
    "token_id" TEXT NOT NULL,
    "result" TEXT NOT NULL,
    "ip_hash" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "qr_scan_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "verification_checks_application_id_created_at_idx" ON "verification_checks"("application_id", "created_at");

-- CreateIndex
CREATE INDEX "correction_requests_application_id_created_at_idx" ON "correction_requests"("application_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "fitness_inspections_certificate_no_key" ON "fitness_inspections"("certificate_no");

-- CreateIndex
CREATE INDEX "fitness_inspections_application_id_idx" ON "fitness_inspections"("application_id");

-- CreateIndex
CREATE INDEX "fitness_inspections_city_id_status_scheduled_for_idx" ON "fitness_inspections"("city_id", "status", "scheduled_for");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_invoice_no_key" ON "invoices"("invoice_no");

-- CreateIndex
CREATE INDEX "invoices_application_id_idx" ON "invoices"("application_id");

-- CreateIndex
CREATE INDEX "invoices_city_id_status_created_at_idx" ON "invoices"("city_id", "status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "payments_receipt_no_key" ON "payments"("receipt_no");

-- CreateIndex
CREATE UNIQUE INDEX "payments_method_provider_ref_key" ON "payments"("method", "provider_ref");

-- CreateIndex
CREATE INDEX "payment_sessions_invoice_id_idx" ON "payment_sessions"("invoice_id");

-- CreateIndex
CREATE INDEX "application_decisions_application_id_decided_at_idx" ON "application_decisions"("application_id", "decided_at");

-- CreateIndex
CREATE UNIQUE INDEX "appeals_decision_id_key" ON "appeals"("decision_id");

-- CreateIndex
CREATE INDEX "appeals_city_id_status_filed_at_idx" ON "appeals"("city_id", "status", "filed_at");

-- CreateIndex
CREATE UNIQUE INDEX "registrations_application_id_key" ON "registrations"("application_id");

-- CreateIndex
CREATE UNIQUE INDEX "registrations_plate_system_id_key" ON "registrations"("plate_system_id");

-- CreateIndex
CREATE INDEX "registrations_vehicle_id_idx" ON "registrations"("vehicle_id");

-- CreateIndex
CREATE UNIQUE INDEX "registrations_zone_id_plate_serial_key" ON "registrations"("zone_id", "plate_serial");

-- CreateIndex
CREATE UNIQUE INDEX "qr_credentials_token_id_key" ON "qr_credentials"("token_id");

-- CreateIndex
CREATE UNIQUE INDEX "qr_credentials_registration_id_version_key" ON "qr_credentials"("registration_id", "version");

-- CreateIndex
CREATE INDEX "qr_scan_events_token_id_created_at_idx" ON "qr_scan_events"("token_id", "created_at");

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ─── Value constraints ───
ALTER TABLE verification_checks ADD CONSTRAINT verification_checks_result_chk CHECK (result IN ('PASS','FAIL'));
ALTER TABLE fitness_inspections ADD CONSTRAINT fitness_inspections_status_chk CHECK (status IN ('SCHEDULED','PASSED','FAILED','CANCELLED'));
-- Schedule 4 / Rule 4(11): the inspecting officer signs, a traffic officer countersigns — two different people.
ALTER TABLE fitness_inspections ADD CONSTRAINT fitness_inspections_two_people_chk
  CHECK (countersigned_by_staff_id IS NULL OR countersigned_by_staff_id <> inspector_staff_id);
-- A certificate number exists only for a passed, countersigned inspection.
ALTER TABLE fitness_inspections ADD CONSTRAINT fitness_inspections_certificate_chk CHECK (
  (certificate_no IS NULL) OR (status = 'PASSED' AND countersigned_by_staff_id IS NOT NULL AND valid_until IS NOT NULL));
ALTER TABLE fitness_inspections ADD CONSTRAINT fitness_inspections_result_chk CHECK (
  status IN ('SCHEDULED','CANCELLED') OR (inspector_staff_id IS NOT NULL AND inspected_at IS NOT NULL AND checklist IS NOT NULL));
ALTER TABLE fee_schedules ADD CONSTRAINT fee_schedules_service_chk CHECK (service IN ('REGISTRATION','RENEWAL','FITNESS'));
ALTER TABLE fee_schedules ADD CONSTRAINT fee_schedules_amount_chk CHECK (amount_bdt >= 0);
ALTER TABLE invoices ADD CONSTRAINT invoices_status_chk CHECK (status IN ('UNPAID','PAID','CANCELLED'));
ALTER TABLE invoices ADD CONSTRAINT invoices_paid_chk CHECK ((status = 'PAID') = (paid_at IS NOT NULL));
ALTER TABLE invoices ADD CONSTRAINT invoices_total_chk CHECK (total_bdt > 0);
ALTER TABLE payments ADD CONSTRAINT payments_method_chk CHECK (method IN ('ONLINE_SIMULATOR','COUNTER_CHALLAN'));
ALTER TABLE payments ADD CONSTRAINT payments_status_chk CHECK (status IN ('SUCCEEDED','FAILED'));
ALTER TABLE payments ADD CONSTRAINT payments_receipt_chk CHECK ((status = 'SUCCEEDED') = (receipt_no IS NOT NULL));
ALTER TABLE payment_sessions ADD CONSTRAINT payment_sessions_status_chk CHECK (status IN ('PENDING','COMPLETED','FAILED','EXPIRED'));
ALTER TABLE application_decisions ADD CONSTRAINT application_decisions_decision_chk CHECK (decision IN ('APPROVED','REJECTED'));
-- Rule 4(6): a rejection always carries reasons in writing.
ALTER TABLE application_decisions ADD CONSTRAINT application_decisions_reasons_chk CHECK (
  decision = 'APPROVED' OR (cardinality(reason_codes) > 0 AND length(trim(coalesce(reason_text, ''))) >= 10));
ALTER TABLE appeals ADD CONSTRAINT appeals_status_chk CHECK (status IN ('PENDING','ALLOWED','DISMISSED'));
ALTER TABLE appeals ADD CONSTRAINT appeals_decided_chk CHECK ((status = 'PENDING') = (decided_by_staff_id IS NULL));
ALTER TABLE registrations ADD CONSTRAINT registrations_status_chk CHECK (status IN ('ACTIVE','SUSPENDED','CANCELLED'));
ALTER TABLE registrations ADD CONSTRAINT registrations_plate_chk CHECK (plate_system_id ~ '^[A-Z]{2,8}-Z[0-9]{1,2}-[0-9]{4}$');
ALTER TABLE registrations ADD CONSTRAINT registrations_serial_chk CHECK (plate_serial BETWEEN 1 AND 9999);
ALTER TABLE qr_credentials ADD CONSTRAINT qr_credentials_status_chk CHECK (status IN ('ACTIVE','REVOKED'));

-- ─── One live record where only one may exist ───
CREATE UNIQUE INDEX invoices_live_uq ON invoices (application_id, purpose) WHERE status <> 'CANCELLED';
CREATE UNIQUE INDEX payments_one_success_uq ON payments (invoice_id) WHERE status = 'SUCCEEDED';
CREATE UNIQUE INDEX fitness_inspections_open_uq ON fitness_inspections (application_id) WHERE status = 'SCHEDULED';
CREATE UNIQUE INDEX correction_requests_open_uq ON correction_requests (application_id) WHERE resolved_at IS NULL;
CREATE UNIQUE INDEX appeals_open_uq ON appeals (application_id) WHERE status = 'PENDING';
CREATE UNIQUE INDEX qr_credentials_active_uq ON qr_credentials (registration_id) WHERE status = 'ACTIVE';
CREATE UNIQUE INDEX registrations_vehicle_live_uq ON registrations (vehicle_id) WHERE status <> 'CANCELLED';

-- ─── A successful payment must match the invoice total exactly ───
CREATE OR REPLACE FUNCTION enforce_payment_amount() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE total integer;
BEGIN
  IF NEW.status <> 'SUCCEEDED' THEN RETURN NEW; END IF;
  SELECT total_bdt INTO total FROM invoices WHERE id = NEW.invoice_id;
  IF total IS NULL OR total <> NEW.amount_bdt THEN
    RAISE EXCEPTION 'PAYMENT_AMOUNT_MISMATCH' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payments_amount BEFORE INSERT ON payments FOR EACH ROW EXECUTE FUNCTION enforce_payment_amount();

-- ─── Separation of duties (database-level second line of defence) ───
-- The deciding officer must not be the officer who verified the file (started verification or recorded a check).
CREATE OR REPLACE FUNCTION enforce_decision_separation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM applications WHERE id = NEW.application_id AND verified_by_staff_id = NEW.decided_by_staff_id)
     OR EXISTS (SELECT 1 FROM verification_checks WHERE application_id = NEW.application_id AND staff_id = NEW.decided_by_staff_id) THEN
    RAISE EXCEPTION 'SEPARATION_OF_DUTIES' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER application_decisions_separation BEFORE INSERT ON application_decisions
  FOR EACH ROW EXECUTE FUNCTION enforce_decision_separation();

-- The appeal authority must not be the officer who made the rejection under appeal.
CREATE OR REPLACE FUNCTION enforce_appeal_separation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.decided_by_staff_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM application_decisions WHERE id = NEW.decision_id AND decided_by_staff_id = NEW.decided_by_staff_id) THEN
    RAISE EXCEPTION 'SEPARATION_OF_DUTIES' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER appeals_separation BEFORE INSERT OR UPDATE OF decided_by_staff_id ON appeals
  FOR EACH ROW EXECUTE FUNCTION enforce_appeal_separation();

-- The plate officer must not be the approving officer.
CREATE OR REPLACE FUNCTION enforce_issue_separation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM application_decisions WHERE application_id = NEW.application_id
             AND decision = 'APPROVED' AND decided_by_staff_id = NEW.issued_by_staff_id) THEN
    RAISE EXCEPTION 'SEPARATION_OF_DUTIES' USING ERRCODE = 'P0001';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM applications WHERE id = NEW.application_id AND status = 'APPROVED') THEN
    RAISE EXCEPTION 'APPLICATION_INVALID_STATE' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER registrations_separation BEFORE INSERT ON registrations
  FOR EACH ROW EXECUTE FUNCTION enforce_issue_separation();

-- An application can only become APPROVED with an approving decision row in the same transaction.
CREATE OR REPLACE FUNCTION enforce_approval_has_decision() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'APPROVED' AND OLD.status IS DISTINCT FROM 'APPROVED' AND NOT EXISTS (
    SELECT 1 FROM application_decisions WHERE application_id = NEW.id AND decision = 'APPROVED'
      AND decided_at >= now() - interval '1 minute') THEN
    RAISE EXCEPTION 'APPROVAL_DECISION_MISSING' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER applications_approval_decision BEFORE UPDATE OF status ON applications
  FOR EACH ROW EXECUTE FUNCTION enforce_approval_has_decision();

-- ─── Append-only records ───
CREATE TRIGGER verification_checks_append_only BEFORE UPDATE OR DELETE ON verification_checks
  FOR EACH ROW EXECUTE FUNCTION forbid_modification();
CREATE TRIGGER application_decisions_append_only BEFORE UPDATE OR DELETE ON application_decisions
  FOR EACH ROW EXECUTE FUNCTION forbid_modification();
CREATE TRIGGER payments_append_only BEFORE UPDATE OR DELETE ON payments
  FOR EACH ROW EXECUTE FUNCTION forbid_modification();
CREATE TRIGGER qr_scan_events_append_only BEFORE UPDATE OR DELETE ON qr_scan_events
  FOR EACH ROW EXECUTE FUNCTION forbid_modification();

-- ─── Multi-city isolation ───
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['verification_checks','correction_requests','fitness_inspections','serial_counters',
    'invoices','payments','payment_sessions','application_decisions','appeals','registrations','qr_credentials','qr_scan_events']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY city_isolation ON %I
      USING (city_id = nullif(current_setting('app.city_id', true), '')::uuid)
      WITH CHECK (city_id = nullif(current_setting('app.city_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;
