-- 0001_init.sql — Kiosk ERP canonical schema (cloud control plane)
-- Money is stored as integer MINOR units (KES cents) in *_minor columns.
-- Quantities use numeric(18,3). IDs are client-or-server generated UUIDv4 (ADR 0006).
-- Multitenant tables are scoped by tenant_id (and branch_id where applicable).

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- Tenancy, identity, access
-- ---------------------------------------------------------------------------
CREATE TABLE tenants (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  currency      text NOT NULL DEFAULT 'KES',
  timezone      text NOT NULL DEFAULT 'Africa/Nairobi',
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE branches (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  code          text NOT NULL,
  name          text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code)
);

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  email         text NOT NULL,
  display_name  text NOT NULL,
  password_hash text NOT NULL,
  pin_hash      text,
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, email)
);

CREATE TABLE roles (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  code          text NOT NULL,
  name          text NOT NULL,
  UNIQUE (tenant_id, code)
);

CREATE TABLE permissions (
  code          text PRIMARY KEY,
  description   text NOT NULL
);

CREATE TABLE role_permissions (
  role_id         uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_code text NOT NULL REFERENCES permissions(code),
  PRIMARY KEY (role_id, permission_code)
);

CREATE TABLE user_roles (
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id       uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, role_id)
);

CREATE TABLE devices (
  id                        uuid PRIMARY KEY,
  tenant_id                 uuid NOT NULL REFERENCES tenants(id),
  branch_id                 uuid NOT NULL REFERENCES branches(id),
  name                      text NOT NULL,
  platform                  text NOT NULL DEFAULT 'android',
  app_version               text,
  schema_version            integer NOT NULL DEFAULT 1,
  is_offline_authoritative  boolean NOT NULL DEFAULT false,
  public_key_fingerprint    text,
  enrolled_at               timestamptz NOT NULL DEFAULT now(),
  last_seen_at              timestamptz,
  revoked_at                timestamptz
);
CREATE INDEX devices_tenant_idx ON devices(tenant_id);

-- Refresh tokens: opaque, hashed, rotating, family-based reuse detection (ADR 0002).
CREATE TABLE refresh_tokens (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id     uuid REFERENCES devices(id),
  family_id     uuid NOT NULL,
  token_hash    text NOT NULL UNIQUE,
  issued_at     timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz,
  replaced_by   uuid,
  reused        boolean NOT NULL DEFAULT false
);
CREATE INDEX refresh_tokens_family_idx ON refresh_tokens(family_id);

-- ---------------------------------------------------------------------------
-- Configuration & numbering
-- ---------------------------------------------------------------------------
CREATE TABLE numbering_series (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  branch_id     uuid REFERENCES branches(id),
  name          text NOT NULL,
  prefix        text NOT NULL,
  next_value    bigint NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, branch_id, name)
);

CREATE TABLE config_versions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  version       integer NOT NULL,
  payload       jsonb NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, version)
);

CREATE TABLE tax_categories (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  name          text NOT NULL,
  rate_bp       integer NOT NULL DEFAULT 0,
  inclusive     boolean NOT NULL DEFAULT false,
  UNIQUE (tenant_id, name)
);

-- ---------------------------------------------------------------------------
-- Catalogue
-- ---------------------------------------------------------------------------
CREATE TABLE categories (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  name          text NOT NULL,
  parent_id     uuid REFERENCES categories(id)
);

CREATE TABLE products (
  id                uuid PRIMARY KEY,
  tenant_id         uuid NOT NULL REFERENCES tenants(id),
  sku               text NOT NULL,
  name              text NOT NULL,
  description       text,
  category_id       uuid REFERENCES categories(id),
  tax_category_id   uuid REFERENCES tax_categories(id),
  unit              text NOT NULL DEFAULT 'ea',
  is_stock_tracked  boolean NOT NULL DEFAULT true,
  is_active         boolean NOT NULL DEFAULT true,
  price_minor       bigint NOT NULL DEFAULT 0,
  cost_minor        bigint NOT NULL DEFAULT 0,
  version           integer NOT NULL DEFAULT 1,
  deleted_at        timestamptz,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, sku)
);
CREATE INDEX products_tenant_idx ON products(tenant_id) WHERE deleted_at IS NULL;

CREATE TABLE barcodes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  product_id    uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  barcode       text NOT NULL,
  UNIQUE (tenant_id, barcode)
);

-- ---------------------------------------------------------------------------
-- Customers & suppliers
-- ---------------------------------------------------------------------------
CREATE TABLE customers (
  id                  uuid PRIMARY KEY,
  tenant_id           uuid NOT NULL REFERENCES tenants(id),
  name                text NOT NULL,
  phone               text,
  email               text,
  credit_limit_minor  bigint NOT NULL DEFAULT 0,
  price_list          text,
  is_active           boolean NOT NULL DEFAULT true,
  version             integer NOT NULL DEFAULT 1,
  deleted_at          timestamptz,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE suppliers (
  id            uuid PRIMARY KEY,
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  name          text NOT NULL,
  phone         text,
  email         text,
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Inventory (append-only ledger + derived projection)
-- ---------------------------------------------------------------------------
CREATE TABLE stock_locations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  branch_id     uuid NOT NULL REFERENCES branches(id),
  name          text NOT NULL,
  kind          text NOT NULL DEFAULT 'store'
);

CREATE TABLE inventory_movements (
  id              uuid PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  branch_id       uuid NOT NULL REFERENCES branches(id),
  location_id     uuid NOT NULL REFERENCES stock_locations(id),
  product_id      uuid NOT NULL REFERENCES products(id),
  quantity_delta  numeric(18,3) NOT NULL,
  unit            text NOT NULL DEFAULT 'ea',
  reason          text NOT NULL,
  source_type     text NOT NULL,
  source_id       uuid,
  actor_id        uuid,
  device_id       uuid,
  command_id      uuid,
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX inventory_movements_product_idx ON inventory_movements(tenant_id, product_id);
-- Idempotency: one movement per (command, source line) is enforced by the command layer;
-- this unique guards against duplicate command application at the ledger level.
CREATE UNIQUE INDEX inventory_movements_command_uidx
  ON inventory_movements(tenant_id, command_id, product_id, source_id)
  WHERE command_id IS NOT NULL;

CREATE TABLE stock_balances (
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  branch_id     uuid NOT NULL REFERENCES branches(id),
  location_id   uuid NOT NULL REFERENCES stock_locations(id),
  product_id    uuid NOT NULL REFERENCES products(id),
  quantity      numeric(18,3) NOT NULL DEFAULT 0,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, branch_id, location_id, product_id)
);

-- ---------------------------------------------------------------------------
-- Sales / POS
-- ---------------------------------------------------------------------------
CREATE TABLE cash_sessions (
  id                  uuid PRIMARY KEY,
  tenant_id           uuid NOT NULL REFERENCES tenants(id),
  branch_id           uuid NOT NULL REFERENCES branches(id),
  device_id           uuid REFERENCES devices(id),
  opened_by           uuid REFERENCES users(id),
  state               text NOT NULL DEFAULT 'open',
  opening_float_minor bigint NOT NULL DEFAULT 0,
  counted_minor       bigint,
  expected_minor      bigint,
  variance_minor      bigint,
  opened_at           timestamptz NOT NULL DEFAULT now(),
  closed_at           timestamptz
);

CREATE TABLE cash_movements (
  id              uuid PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  cash_session_id uuid NOT NULL REFERENCES cash_sessions(id),
  kind            text NOT NULL,   -- in | out | safe_drop | paid_out | sale | refund
  amount_minor    bigint NOT NULL,
  reason          text,
  actor_id        uuid,
  command_id      uuid,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX cash_movements_command_uidx ON cash_movements(tenant_id, command_id) WHERE command_id IS NOT NULL;

CREATE TABLE sales (
  id                uuid PRIMARY KEY,
  tenant_id         uuid NOT NULL REFERENCES tenants(id),
  branch_id         uuid NOT NULL REFERENCES branches(id),
  device_id         uuid REFERENCES devices(id),
  cash_session_id   uuid REFERENCES cash_sessions(id),
  customer_id       uuid REFERENCES customers(id),
  actor_id          uuid,
  local_number      text,
  canonical_number  text,
  state             text NOT NULL DEFAULT 'pending_sync',
  currency          text NOT NULL DEFAULT 'KES',
  subtotal_minor    bigint NOT NULL DEFAULT 0,
  discount_minor    bigint NOT NULL DEFAULT 0,
  tax_total_minor   bigint NOT NULL DEFAULT 0,
  total_minor       bigint NOT NULL DEFAULT 0,
  cost_total_minor  bigint NOT NULL DEFAULT 0,
  price_snapshot_version integer,
  conflict_reason   text,
  command_id        uuid,
  client_created_at timestamptz,
  server_created_at timestamptz NOT NULL DEFAULT now(),
  version           integer NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX sales_command_uidx ON sales(tenant_id, command_id) WHERE command_id IS NOT NULL;
CREATE INDEX sales_tenant_created_idx ON sales(tenant_id, server_created_at);

CREATE TABLE sale_lines (
  id                uuid PRIMARY KEY,
  sale_id           uuid NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  tenant_id         uuid NOT NULL REFERENCES tenants(id),
  product_id        uuid REFERENCES products(id),
  sku_snapshot      text NOT NULL,
  name_snapshot     text NOT NULL,
  unit              text NOT NULL DEFAULT 'ea',
  quantity          numeric(18,3) NOT NULL,
  unit_price_minor  bigint NOT NULL,
  discount_bp       integer NOT NULL DEFAULT 0,
  discount_minor    bigint NOT NULL DEFAULT 0,
  tax_rate_bp       integer NOT NULL DEFAULT 0,
  tax_inclusive     boolean NOT NULL DEFAULT false,
  net_minor         bigint NOT NULL DEFAULT 0,
  tax_minor         bigint NOT NULL DEFAULT 0,
  line_total_minor  bigint NOT NULL DEFAULT 0,
  cost_minor        bigint NOT NULL DEFAULT 0,
  tax_snapshot_version integer
);
CREATE INDEX sale_lines_sale_idx ON sale_lines(sale_id);

-- Tenders: `recorded` vs `verified` is explicit (architecture §2, §11).
CREATE TABLE tenders (
  id                  uuid PRIMARY KEY,
  sale_id             uuid NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  tenant_id           uuid NOT NULL REFERENCES tenants(id),
  method              text NOT NULL,      -- cash | card | mpesa | bank | voucher | credit
  amount_minor        bigint NOT NULL,
  status              text NOT NULL,      -- recorded | pending | verified | failed | unverified_reference
  external_reference  text,
  verified            boolean NOT NULL DEFAULT false,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tenders_sale_idx ON tenders(sale_id);

-- ---------------------------------------------------------------------------
-- Accounting (append-only journal; balances derived)
-- ---------------------------------------------------------------------------
CREATE TABLE chart_of_accounts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  code          text NOT NULL,
  name          text NOT NULL,
  type          text NOT NULL,   -- asset | liability | equity | revenue | expense
  is_control    boolean NOT NULL DEFAULT false,
  UNIQUE (tenant_id, code)
);

CREATE TABLE journals (
  id            uuid PRIMARY KEY,
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  source_type   text NOT NULL,
  source_id     uuid NOT NULL,
  memo          text,
  rule_version  integer NOT NULL DEFAULT 1,
  posted_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX journals_source_uidx ON journals(tenant_id, source_type, source_id);

CREATE TABLE journal_lines (
  id            uuid PRIMARY KEY,
  journal_id    uuid NOT NULL REFERENCES journals(id) ON DELETE CASCADE,
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  account_id    uuid NOT NULL REFERENCES chart_of_accounts(id),
  debit_minor   bigint NOT NULL DEFAULT 0,
  credit_minor  bigint NOT NULL DEFAULT 0,
  currency      text NOT NULL DEFAULT 'KES',
  memo          text,
  CHECK (debit_minor >= 0 AND credit_minor >= 0),
  CHECK (NOT (debit_minor > 0 AND credit_minor > 0))
);
CREATE INDEX journal_lines_journal_idx ON journal_lines(journal_id);

-- Customer AR subledger entries (balance derived from these, never a mutable field).
CREATE TABLE customer_ledger_entries (
  id            uuid PRIMARY KEY,
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  customer_id   uuid NOT NULL REFERENCES customers(id),
  source_type   text NOT NULL,
  source_id     uuid NOT NULL,
  debit_minor   bigint NOT NULL DEFAULT 0,
  credit_minor  bigint NOT NULL DEFAULT 0,
  occurred_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX customer_ledger_source_uidx ON customer_ledger_entries(tenant_id, source_type, source_id, customer_id);

-- ---------------------------------------------------------------------------
-- Sync & integration
-- ---------------------------------------------------------------------------
CREATE TABLE processed_commands (
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  command_id      uuid NOT NULL,
  aggregate_type  text NOT NULL,
  aggregate_id    uuid,
  status          text NOT NULL,     -- accepted | rejected | conflict | review_required
  result          jsonb NOT NULL,
  processed_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, command_id)
);

CREATE TABLE server_events (
  seq             bigserial PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  branch_id       uuid,
  event_type      text NOT NULL,
  aggregate_type  text,
  aggregate_id    uuid,
  payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX server_events_tenant_seq_idx ON server_events(tenant_id, seq);

CREATE TABLE conflict_cases (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  command_id      uuid,
  aggregate_type  text,
  aggregate_id    uuid,
  code            text NOT NULL,
  detail          jsonb NOT NULL DEFAULT '{}'::jsonb,
  state           text NOT NULL DEFAULT 'open',   -- open | resolved
  resolved_by     uuid,
  resolution      jsonb,
  resolved_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX conflict_cases_tenant_state_idx ON conflict_cases(tenant_id, state);

-- Server transactional outbox: written in the SAME transaction as the business effect.
CREATE TABLE outbox_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  event_type    text NOT NULL,
  payload       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  published_at  timestamptz
);
CREATE INDEX outbox_events_unpublished_idx ON outbox_events(created_at) WHERE published_at IS NULL;

CREATE TABLE audit_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  branch_id       uuid,
  actor_id        uuid,
  device_id       uuid,
  action          text NOT NULL,
  aggregate_type  text,
  aggregate_id    uuid,
  reason          text,
  before_summary  jsonb,
  after_summary   jsonb,
  correlation_id  text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_events_tenant_idx ON audit_events(tenant_id, created_at);

-- ---------------------------------------------------------------------------
-- Licensing (commercial entitlements are SEPARATE from retail payment records)
-- ---------------------------------------------------------------------------
CREATE TABLE license_plans (
  id                    text PRIMARY KEY,
  name                  text NOT NULL,
  edition               text NOT NULL,
  perpetual_core        boolean NOT NULL DEFAULT true,
  maintenance_days      integer NOT NULL DEFAULT 0,
  connected_services    boolean NOT NULL DEFAULT false,
  device_quota          integer NOT NULL DEFAULT 1,
  branch_quota          integer NOT NULL DEFAULT 1,
  entitlement_ids       text[] NOT NULL DEFAULT '{}'
);

CREATE TABLE licenses (
  id                            uuid PRIMARY KEY,
  tenant_id                     uuid NOT NULL REFERENCES tenants(id),
  plan_id                       text NOT NULL REFERENCES license_plans(id),
  package_serial                text,
  revision                      integer NOT NULL DEFAULT 1,
  state                         text NOT NULL DEFAULT 'active',
  maintenance_expires_at        timestamptz,
  connected_services_expires_at timestamptz,
  device_key_fingerprints       text[] NOT NULL DEFAULT '{}',
  created_at                    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE license_entitlements (
  license_id      uuid NOT NULL REFERENCES licenses(id) ON DELETE CASCADE,
  entitlement_id  text NOT NULL,
  PRIMARY KEY (license_id, entitlement_id)
);

CREATE TABLE license_requests (
  id                      uuid PRIMARY KEY,
  tenant_id               uuid NOT NULL REFERENCES tenants(id),
  license_id              uuid REFERENCES licenses(id),
  nonce                   text NOT NULL,
  requested_plan_id       text REFERENCES license_plans(id),
  requested_term_days     integer,
  public_key_fingerprint  text,
  state                   text NOT NULL DEFAULT 'exported',
  created_at              timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE license_packages (
  id            uuid PRIMARY KEY,
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  license_id    uuid NOT NULL REFERENCES licenses(id),
  request_id    uuid REFERENCES license_requests(id),
  serial        text NOT NULL,
  revision      integer NOT NULL,
  kid           text NOT NULL,
  payload       jsonb NOT NULL,
  jws           text NOT NULL,
  issued_at     timestamptz NOT NULL DEFAULT now(),
  acked_at      timestamptz
);
CREATE UNIQUE INDEX license_packages_serial_rev_uidx ON license_packages(license_id, serial, revision);

-- License billing payments — deliberately NOT linked to sales/tenders.
CREATE TABLE license_payments (
  id            uuid PRIMARY KEY,
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  license_id    uuid REFERENCES licenses(id),
  amount_minor  bigint NOT NULL,
  currency      text NOT NULL DEFAULT 'KES',
  method        text NOT NULL,
  provider_ref  text,
  state         text NOT NULL DEFAULT 'pending',   -- pending | verified | failed | refunded
  verified_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE license_audit_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid REFERENCES tenants(id),
  action        text NOT NULL,
  detail        jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor         text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Public verification keys only. Private keys live in KMS/HSM (or a dev file), never here.
CREATE TABLE signing_keys (
  kid           text PRIMARY KEY,
  public_jwk    jsonb NOT NULL,
  algorithm     text NOT NULL DEFAULT 'ES256',
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);
