-- DSCC decisions of 2026-11-02 (Ripon):
--   1. Plate system ID has a six-digit serial: DSCC-Z1-000001.
--   2. A fitness certificate is needed before the application is submitted; without one the
--      applicant waits until the inspection is done and the certificate issued.
--   3. Fees are refunded when a rejection becomes final.

-- ─── 1. Six-digit plate serials (NOT VALID: rows issued under the old 4-digit rule stay readable) ───
ALTER TABLE registrations DROP CONSTRAINT registrations_serial_chk;
ALTER TABLE registrations ADD CONSTRAINT registrations_serial_chk CHECK (plate_serial BETWEEN 1 AND 999999) NOT VALID;
ALTER TABLE registrations DROP CONSTRAINT registrations_plate_chk;
ALTER TABLE registrations ADD CONSTRAINT registrations_plate_chk CHECK (plate_system_id ~ '^[A-Z]{2,8}-Z[0-9]{1,2}-[0-9]{6}$') NOT VALID;

-- ─── 2. Fitness inspection requested from a draft, bound to chassis and motor numbers ───
ALTER TABLE fitness_inspections
  ALTER COLUMN vehicle_id DROP NOT NULL,
  ALTER COLUMN scheduled_for DROP NOT NULL,
  ALTER COLUMN location DROP NOT NULL,
  ALTER COLUMN scheduled_by_staff_id DROP NOT NULL,
  ADD COLUMN chassis_no TEXT,
  ADD COLUMN motor_no TEXT,
  ADD COLUMN seat_type TEXT,
  ADD COLUMN model_id UUID,
  ADD COLUMN invoice_id UUID,
  ADD COLUMN requested_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
UPDATE fitness_inspections f
   SET chassis_no = v.chassis_no, motor_no = v.motor_no, seat_type = v.seat_type, model_id = v.model_id, requested_at = f.created_at
  FROM vehicles v WHERE v.id = f.vehicle_id;
ALTER TABLE fitness_inspections
  ALTER COLUMN chassis_no SET NOT NULL,
  ALTER COLUMN motor_no SET NOT NULL,
  ALTER COLUMN seat_type SET NOT NULL,
  ALTER COLUMN model_id SET NOT NULL;
CREATE UNIQUE INDEX "fitness_inspections_invoice_id_key" ON "fitness_inspections"("invoice_id");
CREATE INDEX fitness_inspections_chassis_idx ON fitness_inspections (chassis_no);

ALTER TABLE fitness_inspections DROP CONSTRAINT fitness_inspections_status_chk;
ALTER TABLE fitness_inspections ADD CONSTRAINT fitness_inspections_status_chk
  CHECK (status IN ('REQUESTED','SCHEDULED','PASSED','FAILED','CANCELLED'));
ALTER TABLE fitness_inspections DROP CONSTRAINT fitness_inspections_result_chk;
ALTER TABLE fitness_inspections ADD CONSTRAINT fitness_inspections_result_chk CHECK (
  status IN ('REQUESTED','SCHEDULED','CANCELLED') OR (inspector_staff_id IS NOT NULL AND inspected_at IS NOT NULL AND checklist IS NOT NULL));
-- Anything past REQUESTED has an appointment.
ALTER TABLE fitness_inspections ADD CONSTRAINT fitness_inspections_scheduled_chk CHECK (
  status IN ('REQUESTED','CANCELLED') OR (scheduled_for IS NOT NULL AND location IS NOT NULL AND scheduled_by_staff_id IS NOT NULL));
-- At most one open request or appointment per application.
DROP INDEX fitness_inspections_open_uq;
CREATE UNIQUE INDEX fitness_inspections_open_uq ON fitness_inspections (application_id) WHERE status IN ('REQUESTED','SCHEDULED');

-- ─── Invoices: separate fitness invoices (one per inspection request) and refunds ───
ALTER TABLE invoices ADD CONSTRAINT invoices_purpose_chk CHECK (purpose IN ('NEW_REGISTRATION','FITNESS'));
ALTER TABLE invoices DROP CONSTRAINT invoices_status_chk;
ALTER TABLE invoices ADD CONSTRAINT invoices_status_chk CHECK (status IN ('UNPAID','PAID','CANCELLED','REFUNDED'));
ALTER TABLE invoices DROP CONSTRAINT invoices_paid_chk;
ALTER TABLE invoices ADD CONSTRAINT invoices_paid_chk CHECK ((status IN ('PAID','REFUNDED')) = (paid_at IS NOT NULL));
-- One live registration invoice per application; fitness invoices are tied to their inspection instead.
DROP INDEX invoices_live_uq;
CREATE UNIQUE INDEX invoices_live_uq ON invoices (application_id) WHERE status <> 'CANCELLED' AND purpose = 'NEW_REGISTRATION';

-- ─── 3. Refunds ───
CREATE TABLE "refunds" (
    "id" UUID NOT NULL,
    "city_id" UUID NOT NULL,
    "application_id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "payment_id" UUID NOT NULL,
    "method" TEXT NOT NULL,
    "amount_bdt" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "provider_ref" TEXT,
    "completed_by_staff_id" UUID,
    "completed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "refunds_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "refunds_payment_id_key" ON "refunds"("payment_id");
CREATE INDEX "refunds_city_id_status_created_at_idx" ON "refunds"("city_id", "status", "created_at");
CREATE INDEX "refunds_application_id_idx" ON "refunds"("application_id");
ALTER TABLE refunds ADD CONSTRAINT refunds_payment_fkey FOREIGN KEY (payment_id) REFERENCES payments(id) ON DELETE RESTRICT;
ALTER TABLE refunds ADD CONSTRAINT refunds_invoice_fkey FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE RESTRICT;
ALTER TABLE refunds ADD CONSTRAINT refunds_method_chk CHECK (method IN ('ONLINE_SIMULATOR','COUNTER_CHALLAN'));
ALTER TABLE refunds ADD CONSTRAINT refunds_status_chk CHECK (status IN ('PENDING','COMPLETED'));
ALTER TABLE refunds ADD CONSTRAINT refunds_amount_chk CHECK (amount_bdt > 0);
ALTER TABLE refunds ADD CONSTRAINT refunds_completed_chk CHECK ((status = 'COMPLETED') = (completed_at IS NOT NULL AND provider_ref IS NOT NULL));

-- A refund returns exactly what was paid, only for a successful payment.
CREATE OR REPLACE FUNCTION enforce_refund_amount() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE paid integer;
BEGIN
  SELECT amount_bdt INTO paid FROM payments WHERE id = NEW.payment_id AND status = 'SUCCEEDED' AND invoice_id = NEW.invoice_id;
  IF paid IS NULL OR paid <> NEW.amount_bdt THEN
    RAISE EXCEPTION 'REFUND_AMOUNT_MISMATCH' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER refunds_amount BEFORE INSERT ON refunds FOR EACH ROW EXECUTE FUNCTION enforce_refund_amount();

-- A completed refund cannot be changed or reopened.
CREATE OR REPLACE FUNCTION forbid_refund_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.status = 'COMPLETED' OR NEW.amount_bdt <> OLD.amount_bdt OR NEW.payment_id <> OLD.payment_id THEN
    RAISE EXCEPTION 'APPEND_ONLY_TABLE: refunds is append-only once completed' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER refunds_guard BEFORE UPDATE OR DELETE ON refunds FOR EACH ROW EXECUTE FUNCTION forbid_refund_change();

ALTER TABLE refunds ENABLE ROW LEVEL SECURITY;
CREATE POLICY city_isolation ON refunds
  USING (city_id = nullif(current_setting('app.city_id', true), '')::uuid)
  WITH CHECK (city_id = nullif(current_setting('app.city_id', true), '')::uuid);
