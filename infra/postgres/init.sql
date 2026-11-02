-- Local/CI database roles. Development passwords only; production credentials come from the secret store.
-- dscc_owner owns the schema and runs migrations/seed; dscc_app is the runtime role (RLS enforced, no DELETE).
CREATE ROLE dscc_owner LOGIN CREATEDB PASSWORD 'dscc_owner_dev';
CREATE ROLE dscc_app LOGIN PASSWORD 'dscc_app_dev';
CREATE DATABASE dscc_dev OWNER dscc_owner;
CREATE DATABASE dscc_test OWNER dscc_owner;
CREATE DATABASE dscc_e2e OWNER dscc_owner;
