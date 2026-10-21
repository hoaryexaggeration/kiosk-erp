import { Generated } from 'kysely';

/**
 * Hand-maintained Kysely type map for the canonical schema (ADR 0001).
 * Money columns end in `_minor` and are parsed to JS numbers (see db.service.ts).
 * `numeric` quantities are parsed to JS numbers for these magnitudes (a shop's quantities
 * never approach 2^53); adjust to strings if quantities grow to need arbitrary precision.
 */

type Json = unknown;

export interface TenantsTable {
  id: Generated<string>;
  name: string;
  currency: Generated<string>;
  timezone: Generated<string>;
  created_at: Generated<Date>;
}
export interface BranchesTable {
  id: Generated<string>;
  tenant_id: string;
  code: string;
  name: string;
  created_at: Generated<Date>;
}
export interface UsersTable {
  id: Generated<string>;
  tenant_id: string;
  email: string;
  display_name: string;
  password_hash: string;
  pin_hash: string | null;
  is_active: Generated<boolean>;
  created_at: Generated<Date>;
}
export interface RolesTable {
  id: Generated<string>;
  tenant_id: string;
  code: string;
  name: string;
}
export interface PermissionsTable {
  code: string;
  description: string;
}
export interface RolePermissionsTable {
  role_id: string;
  permission_code: string;
}
export interface UserRolesTable {
  user_id: string;
  role_id: string;
}
export interface DevicesTable {
  id: string;
  tenant_id: string;
  branch_id: string;
  name: string;
  platform: Generated<string>;
  app_version: string | null;
  schema_version: Generated<number>;
  is_offline_authoritative: Generated<boolean>;
  public_key_fingerprint: string | null;
  enrolled_at: Generated<Date>;
  last_seen_at: Date | null;
  revoked_at: Date | null;
}
export interface RefreshTokensTable {
  id: Generated<string>;
  user_id: string;
  device_id: string | null;
  family_id: string;
  token_hash: string;
  issued_at: Generated<Date>;
  expires_at: Date;
  revoked_at: Date | null;
  replaced_by: string | null;
  reused: Generated<boolean>;
}
export interface NumberingSeriesTable {
  id: Generated<string>;
  tenant_id: string;
  branch_id: string | null;
  name: string;
  prefix: string;
  next_value: Generated<number>;
}
export interface ConfigVersionsTable {
  id: Generated<string>;
  tenant_id: string;
  version: number;
  payload: Json;
  created_at: Generated<Date>;
}
export interface TaxCategoriesTable {
  id: Generated<string>;
  tenant_id: string;
  name: string;
  rate_bp: Generated<number>;
  inclusive: Generated<boolean>;
}
export interface CategoriesTable {
  id: Generated<string>;
  tenant_id: string;
  name: string;
  parent_id: string | null;
}
/**
 * The vocabulary a tenant's stock is expressed in (item 4.6). `kind` decides what the ledger will
 * accept: `count` quantities stay whole, `weight`/`volume` may be fractional.
 */
export interface UnitsOfMeasureTable {
  id: Generated<string>;
  tenant_id: string;
  code: string;
  name: string;
  kind: Generated<string>;
  created_at: Generated<Date>;
}
/**
 * `1 <unit> = <factor> <product's base unit>` — a fact about one product (item 4.6). The base unit
 * itself has no row: it is implicitly factor 1, and a conversion to it needs no lookup beyond this.
 */
export interface UnitConversionsTable {
  id: Generated<string>;
  tenant_id: string;
  product_id: string;
  unit: string;
  /** `numeric(18,6)` — read with `Number(...)`, exactly like every other numeric column here. */
  factor: number;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}
export interface BrandsTable {
  id: Generated<string>;
  tenant_id: string;
  name: string;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}
export interface ProductsTable {
  id: string;
  tenant_id: string;
  sku: string;
  name: string;
  description: string | null;
  category_id: string | null;
  tax_category_id: string | null;
  brand_id: string | null;
  unit: Generated<string>;
  is_stock_tracked: Generated<boolean>;
  is_active: Generated<boolean>;
  price_minor: Generated<number>;
  cost_minor: Generated<number>;
  /** Low-stock threshold in base units; null = no alert configured (item 4.9). */
  reorder_point: number | null;
  /** Moves only when the BASE price moves — the version a sale snapshot attaches (item 4.11). */
  price_version: Generated<number>;
  version: Generated<number>;
  deleted_at: Date | null;
  updated_at: Generated<Date>;
  created_at: Generated<Date>;
}
export interface BarcodesTable {
  id: Generated<string>;
  tenant_id: string;
  product_id: string;
  barcode: string;
}
export interface CustomersTable {
  id: string;
  tenant_id: string;
  name: string;
  phone: string | null;
  email: string | null;
  credit_limit_minor: Generated<number>;
  price_list: string | null;
  is_active: Generated<boolean>;
  version: Generated<number>;
  deleted_at: Date | null;
  updated_at: Generated<Date>;
  created_at: Generated<Date>;
}
export interface SuppliersTable {
  id: string;
  tenant_id: string;
  name: string;
  phone: string | null;
  email: string | null;
  is_active: Generated<boolean>;
  created_at: Generated<Date>;
}
export interface StockLocationsTable {
  id: Generated<string>;
  tenant_id: string;
  branch_id: string;
  name: string;
  kind: Generated<string>;
}
export interface InventoryMovementsTable {
  id: string;
  tenant_id: string;
  branch_id: string;
  location_id: string;
  product_id: string;
  quantity_delta: number;
  unit: Generated<string>;
  reason: string;
  source_type: string;
  source_id: string | null;
  actor_id: string | null;
  device_id: string | null;
  command_id: string | null;
  approved_by: string | null;
  approval_note: string | null;
  /** Derived FIFO cost of an outbound movement (ADR 0009); null for inbound. */
  cogs_minor: number | null;
  /**
   * The unit/quantity a movement was WRITTEN in when that differed from the base unit (item 4.6) —
   * NULL in the overwhelmingly common case, and never one without the other.
   */
  entered_unit: string | null;
  entered_quantity: number | null;
  occurred_at: Generated<Date>;
  created_at: Generated<Date>;
}
export interface PromotionsTable {
  id: Generated<string>;
  tenant_id: string;
  name: string;
  kind: string;
  value: number;
  product_id: string | null;
  category_id: string | null;
  starts_at: Date | null;
  ends_at: Date | null;
  is_active: Generated<boolean>;
  created_at: Generated<Date>;
}
/** A dated, optionally branch-scoped price list row (item 4.11). `branch_id` null = every branch. */
export interface ProductPriceOverridesTable {
  id: Generated<string>;
  tenant_id: string;
  product_id: string;
  branch_id: string | null;
  price_minor: number;
  valid_from: Date;
  valid_to: Date | null;
  created_by: string;
  created_at: Generated<Date>;
}
/** Append-only record of every price write (item 4.11, §3.C "price change history"). */
export interface PriceChangeHistoryTable {
  id: Generated<string>;
  tenant_id: string;
  product_id: string;
  branch_id: string | null;
  old_price_minor: number | null;
  new_price_minor: number;
  source: string;
  actor_id: string | null;
  changed_at: Generated<Date>;
}
export interface StockBalancesTable {
  tenant_id: string;
  branch_id: string;
  location_id: string;
  product_id: string;
  quantity: Generated<number>;
  updated_at: Generated<Date>;
}
/** A receipt tranche consumed oldest-first (FIFO). */
export interface InventoryValuationLayersTable {
  id: string;
  tenant_id: string;
  branch_id: string;
  location_id: string;
  product_id: string;
  source_movement_id: string | null;
  unit_cost_minor: number;
  quantity_received: number;
  quantity_remaining: number;
  received_at: Generated<Date>;
  created_at: Generated<Date>;
}
/** Which layers paid for an outbound movement, and how much. */
export interface InventoryCostAllocationsTable {
  id: string;
  tenant_id: string;
  movement_id: string;
  layer_id: string;
  quantity: number;
  unit_cost_minor: number;
  amount_minor: number;
  created_at: Generated<Date>;
}
/**
 * A cross-branch stock transfer (item 4.7, ADR 0008): written by the source branch when it
 * dispatches and by the destination branch when it receives, and never by anyone else.
 */
export interface StockTransfersTable {
  id: string;
  tenant_id: string;
  reference: string;
  from_branch_id: string;
  to_branch_id: string;
  status: 'dispatched' | 'received' | 'discrepancy';
  note: string | null;
  dispatched_by: string | null;
  dispatched_at: Generated<Date>;
  received_by: string | null;
  received_at: Date | null;
  approved_by: string | null;
  approval_note: string | null;
  line_count: number;
  created_at: Generated<Date>;
}
export interface StockTransferLinesTable {
  id: string;
  tenant_id: string;
  transfer_id: string;
  product_id: string;
  unit: string;
  entered_unit: string | null;
  entered_quantity: number | null;
  quantity_dispatched: number;
  /** NULL until the destination counts it; 0 means "none of this line arrived". */
  quantity_received: number | null;
  unit_cost_minor: number;
}
export interface CashSessionsTable {
  id: string;
  tenant_id: string;
  branch_id: string;
  device_id: string | null;
  opened_by: string | null;
  state: Generated<string>;
  opening_float_minor: Generated<number>;
  counted_minor: number | null;
  expected_minor: number | null;
  variance_minor: number | null;
  opened_at: Generated<Date>;
  closed_at: Date | null;
}
export interface CashMovementsTable {
  id: string;
  tenant_id: string;
  cash_session_id: string;
  kind: string;
  amount_minor: number;
  reason: string | null;
  actor_id: string | null;
  command_id: string | null;
  created_at: Generated<Date>;
}
export interface SalesTable {
  id: string;
  tenant_id: string;
  branch_id: string;
  device_id: string | null;
  cash_session_id: string | null;
  customer_id: string | null;
  actor_id: string | null;
  local_number: string | null;
  canonical_number: string | null;
  state: Generated<string>;
  currency: Generated<string>;
  subtotal_minor: Generated<number>;
  discount_minor: Generated<number>;
  tax_total_minor: Generated<number>;
  total_minor: Generated<number>;
  cost_total_minor: Generated<number>;
  price_snapshot_version: number | null;
  conflict_reason: string | null;
  command_id: string | null;
  client_created_at: Date | null;
  server_created_at: Generated<Date>;
  version: Generated<number>;
}
export interface SaleLinesTable {
  id: string;
  sale_id: string;
  tenant_id: string;
  product_id: string | null;
  sku_snapshot: string;
  name_snapshot: string;
  unit: Generated<string>;
  quantity: number;
  unit_price_minor: number;
  discount_bp: Generated<number>;
  discount_minor: Generated<number>;
  tax_rate_bp: Generated<number>;
  tax_inclusive: Generated<boolean>;
  net_minor: Generated<number>;
  tax_minor: Generated<number>;
  line_total_minor: Generated<number>;
  cost_minor: Generated<number>;
  tax_snapshot_version: number | null;
}
export interface TendersTable {
  id: string;
  sale_id: string;
  tenant_id: string;
  method: string;
  amount_minor: number;
  status: string;
  external_reference: string | null;
  verified: Generated<boolean>;
  created_at: Generated<Date>;
}
export interface ChartOfAccountsTable {
  id: Generated<string>;
  tenant_id: string;
  code: string;
  name: string;
  type: string;
  is_control: Generated<boolean>;
}
export interface JournalsTable {
  id: string;
  tenant_id: string;
  source_type: string;
  source_id: string;
  memo: string | null;
  rule_version: Generated<number>;
  posted_at: Generated<Date>;
}
export interface JournalLinesTable {
  id: string;
  journal_id: string;
  tenant_id: string;
  account_id: string;
  debit_minor: Generated<number>;
  credit_minor: Generated<number>;
  currency: Generated<string>;
  memo: string | null;
}
export interface CustomerLedgerEntriesTable {
  id: string;
  tenant_id: string;
  customer_id: string;
  source_type: string;
  source_id: string;
  debit_minor: Generated<number>;
  credit_minor: Generated<number>;
  occurred_at: Generated<Date>;
}
export interface ProcessedCommandsTable {
  tenant_id: string;
  command_id: string;
  aggregate_type: string;
  aggregate_id: string | null;
  status: string;
  result: Json;
  processed_at: Generated<Date>;
}
export interface ServerEventsTable {
  seq: Generated<number>;
  tenant_id: string;
  branch_id: string | null;
  event_type: string;
  aggregate_type: string | null;
  aggregate_id: string | null;
  payload: Generated<Json>;
  created_at: Generated<Date>;
}
export interface ConflictCasesTable {
  id: Generated<string>;
  tenant_id: string;
  command_id: string | null;
  aggregate_type: string | null;
  aggregate_id: string | null;
  code: string;
  detail: Generated<Json>;
  state: Generated<string>;
  resolved_by: string | null;
  resolution: Json | null;
  resolved_at: Date | null;
  created_at: Generated<Date>;
}
export interface OutboxEventsTable {
  id: Generated<string>;
  tenant_id: string;
  event_type: string;
  payload: Generated<Json>;
  created_at: Generated<Date>;
  published_at: Date | null;
}
export interface AuditEventsTable {
  id: Generated<string>;
  tenant_id: string;
  branch_id: string | null;
  actor_id: string | null;
  device_id: string | null;
  action: string;
  aggregate_type: string | null;
  aggregate_id: string | null;
  reason: string | null;
  before_summary: Json | null;
  after_summary: Json | null;
  correlation_id: string | null;
  created_at: Generated<Date>;
}
export interface LicensePlansTable {
  id: string;
  name: string;
  edition: string;
  perpetual_core: Generated<boolean>;
  maintenance_days: Generated<number>;
  connected_services: Generated<boolean>;
  device_quota: Generated<number>;
  branch_quota: Generated<number>;
  entitlement_ids: Generated<string[]>;
}
export interface LicensesTable {
  id: string;
  tenant_id: string;
  plan_id: string;
  package_serial: string | null;
  revision: Generated<number>;
  state: Generated<string>;
  maintenance_expires_at: Date | null;
  connected_services_expires_at: Date | null;
  device_key_fingerprints: Generated<string[]>;
  created_at: Generated<Date>;
}
export interface LicenseEntitlementsTable {
  license_id: string;
  entitlement_id: string;
}
export interface LicenseRequestsTable {
  id: string;
  tenant_id: string;
  license_id: string | null;
  nonce: string;
  requested_plan_id: string | null;
  requested_term_days: number | null;
  public_key_fingerprint: string | null;
  state: Generated<string>;
  created_at: Generated<Date>;
}
export interface LicensePackagesTable {
  id: string;
  tenant_id: string;
  license_id: string;
  request_id: string | null;
  serial: string;
  revision: number;
  kid: string;
  payload: Json;
  jws: string;
  issued_at: Generated<Date>;
  acked_at: Date | null;
}
export interface LicensePaymentsTable {
  id: string;
  tenant_id: string;
  license_id: string | null;
  amount_minor: number;
  currency: Generated<string>;
  method: string;
  provider_ref: string | null;
  state: Generated<string>;
  verified_at: Date | null;
  created_at: Generated<Date>;
}
export interface LicenseAuditEventsTable {
  id: Generated<string>;
  tenant_id: string | null;
  action: string;
  detail: Generated<Json>;
  actor: string | null;
  created_at: Generated<Date>;
}
export interface SigningKeysTable {
  kid: string;
  public_jwk: Json;
  algorithm: Generated<string>;
  active: Generated<boolean>;
  created_at: Generated<Date>;
}

export interface Database {
  tenants: TenantsTable;
  branches: BranchesTable;
  users: UsersTable;
  roles: RolesTable;
  permissions: PermissionsTable;
  role_permissions: RolePermissionsTable;
  user_roles: UserRolesTable;
  devices: DevicesTable;
  refresh_tokens: RefreshTokensTable;
  numbering_series: NumberingSeriesTable;
  config_versions: ConfigVersionsTable;
  tax_categories: TaxCategoriesTable;
  categories: CategoriesTable;
  units_of_measure: UnitsOfMeasureTable;
  unit_conversions: UnitConversionsTable;
  brands: BrandsTable;
  products: ProductsTable;
  barcodes: BarcodesTable;
  customers: CustomersTable;
  suppliers: SuppliersTable;
  stock_locations: StockLocationsTable;
  inventory_movements: InventoryMovementsTable;
  promotions: PromotionsTable;
  product_price_overrides: ProductPriceOverridesTable;
  price_change_history: PriceChangeHistoryTable;
  stock_balances: StockBalancesTable;
  inventory_valuation_layers: InventoryValuationLayersTable;
  inventory_cost_allocations: InventoryCostAllocationsTable;
  stock_transfers: StockTransfersTable;
  stock_transfer_lines: StockTransferLinesTable;
  cash_sessions: CashSessionsTable;
  cash_movements: CashMovementsTable;
  sales: SalesTable;
  sale_lines: SaleLinesTable;
  tenders: TendersTable;
  chart_of_accounts: ChartOfAccountsTable;
  journals: JournalsTable;
  journal_lines: JournalLinesTable;
  customer_ledger_entries: CustomerLedgerEntriesTable;
  processed_commands: ProcessedCommandsTable;
  server_events: ServerEventsTable;
  conflict_cases: ConflictCasesTable;
  outbox_events: OutboxEventsTable;
  audit_events: AuditEventsTable;
  license_plans: LicensePlansTable;
  licenses: LicensesTable;
  license_entitlements: LicenseEntitlementsTable;
  license_requests: LicenseRequestsTable;
  license_packages: LicensePackagesTable;
  license_payments: LicensePaymentsTable;
  license_audit_events: LicenseAuditEventsTable;
  signing_keys: SigningKeysTable;
}
