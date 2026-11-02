-- Phase 1 security & integrity constraints that Prisma's schema language cannot express.

-- ─── Uniqueness that only applies to live records ───
-- A chassis/motor number may only belong to one non-withdrawn, non-rejected vehicle per city.
CREATE UNIQUE INDEX vehicles_city_chassis_live_uq ON vehicles (city_id, chassis_no)
  WHERE status NOT IN ('WITHDRAWN', 'REJECTED');
CREATE UNIQUE INDEX vehicles_city_motor_live_uq ON vehicles (city_id, motor_no)
  WHERE status NOT IN ('WITHDRAWN', 'REJECTED');

-- One live quota slot per (owner, vehicle): prevents double counting.
CREATE UNIQUE INDEX vehicle_quota_slots_live_uq ON vehicle_quota_slots (owner_identity_id, vehicle_id)
  WHERE state <> 'RELEASED';

-- One current document per (application, type).
CREATE UNIQUE INDEX application_documents_current_uq ON application_documents (application_id, doc_type)
  WHERE superseded_at IS NULL;

-- One open driver assignment per vehicle.
CREATE UNIQUE INDEX vehicle_driver_assignments_open_uq ON vehicle_driver_assignments (vehicle_id)
  WHERE valid_to IS NULL;

ALTER TABLE applications ADD CONSTRAINT applications_status_chk CHECK (status IN
  ('DRAFT','SUBMITTED','UNDER_VERIFICATION','CORRECTION_REQUESTED','APPROVED','REJECTED','WITHDRAWN'));
ALTER TABLE applications ADD CONSTRAINT applications_number_chk CHECK (
  (status = 'DRAFT' AND application_number IS NULL) OR
  (status <> 'DRAFT' AND application_number ~ '^[A-Z]{2,8}-[0-9]{4}-[0-9]{6}$'));
ALTER TABLE vehicle_quota_slots ADD CONSTRAINT vehicle_quota_slots_state_chk CHECK (state IN ('RESERVED','HELD','RELEASED'));
ALTER TABLE zones ADD CONSTRAINT zones_approval_chk CHECK (approval_status IN ('DRAFT','PROPOSED','APPROVED'));
ALTER TABLE zones ADD CONSTRAINT zones_code_chk CHECK (code ~ '^Z[0-9]{1,2}$');
ALTER TABLE files ADD CONSTRAINT files_scan_chk CHECK (scan_status IN ('CLEAN','INFECTED'));

-- ─── Five vehicles per NID (Rule 4(8)) — second line of defence ───
-- QuotaService locks the owner row and checks first; this trigger guarantees that no code path
-- (including future admin/bulk paths that forget the service) can create a sixth live slot.
CREATE OR REPLACE FUNCTION enforce_owner_vehicle_limit() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  live_slots integer;
  external_regs integer;
BEGIN
  IF NEW.state = 'RELEASED' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.state <> 'RELEASED' THEN
    RETURN NEW; -- RESERVED → HELD does not add a vehicle
  END IF;
  PERFORM 1 FROM owner_identities WHERE id = NEW.owner_identity_id FOR UPDATE;
  SELECT count(*) INTO live_slots FROM vehicle_quota_slots
    WHERE owner_identity_id = NEW.owner_identity_id AND state <> 'RELEASED' AND id <> NEW.id;
  SELECT count(*) INTO external_regs FROM external_city_registrations
    WHERE owner_identity_id = NEW.owner_identity_id AND status <> 'REJECTED';
  IF live_slots + external_regs + 1 > 5 THEN
    RAISE EXCEPTION 'OWNER_NID_VEHICLE_LIMIT_REACHED' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER vehicle_quota_slots_limit
  BEFORE INSERT OR UPDATE OF state ON vehicle_quota_slots
  FOR EACH ROW EXECUTE FUNCTION enforce_owner_vehicle_limit();

-- Declaring another-city vehicle also consumes the limit.
CREATE OR REPLACE FUNCTION enforce_owner_vehicle_limit_external() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  live_slots integer;
  external_regs integer;
BEGIN
  IF NEW.status = 'REJECTED' THEN
    RETURN NEW;
  END IF;
  PERFORM 1 FROM owner_identities WHERE id = NEW.owner_identity_id FOR UPDATE;
  SELECT count(*) INTO live_slots FROM vehicle_quota_slots
    WHERE owner_identity_id = NEW.owner_identity_id AND state <> 'RELEASED';
  SELECT count(*) INTO external_regs FROM external_city_registrations
    WHERE owner_identity_id = NEW.owner_identity_id AND status <> 'REJECTED' AND id <> NEW.id;
  IF live_slots + external_regs + 1 > 5 THEN
    RAISE EXCEPTION 'OWNER_NID_VEHICLE_LIMIT_REACHED' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER external_city_registrations_limit
  BEFORE INSERT ON external_city_registrations
  FOR EACH ROW EXECUTE FUNCTION enforce_owner_vehicle_limit_external();

-- ─── Append-only audit log ───
CREATE OR REPLACE FUNCTION forbid_modification() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'APPEND_ONLY_TABLE: % is append-only', TG_TABLE_NAME USING ERRCODE = 'P0001';
END $$;

CREATE TRIGGER audit_events_append_only
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION forbid_modification();
CREATE TRIGGER audit_events_no_truncate
  BEFORE TRUNCATE ON audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_modification();

CREATE TRIGGER application_revisions_append_only
  BEFORE UPDATE OR DELETE ON application_revisions
  FOR EACH ROW EXECUTE FUNCTION forbid_modification();
CREATE TRIGGER application_status_events_append_only
  BEFORE UPDATE OR DELETE ON application_status_events
  FOR EACH ROW EXECUTE FUNCTION forbid_modification();
CREATE TRIGGER zone_versions_append_only
  BEFORE UPDATE OR DELETE ON zone_versions
  FOR EACH ROW EXECUTE FUNCTION forbid_modification();

-- ─── Multi-city isolation: Row-Level Security ───
-- The application connects as a non-owner role; each request sets app.city_id inside its transaction.
-- National tables (owner_identities, owner_accounts, vehicle_quota_slots, external_city_registrations,
-- users, staff_accounts, roles, audit_events) are intentionally not city-filtered: the five-vehicle
-- limit spans all city corporations.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['zones','zone_versions','wards','applications','application_revisions',
    'application_status_events','application_documents','files','vehicles','drivers',
    'vehicle_driver_assignments','application_counters']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY city_isolation ON %I
      USING (city_id = nullif(current_setting('app.city_id', true), '')::uuid)
      WITH CHECK (city_id = nullif(current_setting('app.city_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;
