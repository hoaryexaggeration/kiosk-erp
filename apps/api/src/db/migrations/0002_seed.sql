-- 0002_seed.sql — reference data (idempotent)

INSERT INTO permissions (code, description) VALUES
  ('pos.sale.create',        'Create a sale / tender'),
  ('pos.discount.apply',     'Apply line or order discount within cap'),
  ('pos.price.override',     'Override a line price'),
  ('pos.void',               'Void a sale before finalisation'),
  ('pos.refund',             'Refund / process a return'),
  ('inventory.receive',      'Receive stock / GRN'),
  ('inventory.adjust',       'Adjust stock via a movement with reason'),
  ('inventory.transfer',     'Transfer stock between locations'),
  ('ar.credit.override',     'Override offline credit policy'),
  ('ar.receipt.create',      'Record a debtor receipt'),
  ('ap.bill.create',         'Capture a supplier bill'),
  ('ap.payment.create',      'Create a supplier payment'),
  ('cash.shift.open',        'Open a cash shift'),
  ('cash.shift.close',       'Close a cash shift (variance sign-off)'),
  ('catalog.manage',         'Manage products, prices and promotions'),
  ('reports.view',           'View operational and financial reports'),
  ('admin.user.manage',      'Manage users, roles and permissions'),
  ('admin.device.manage',    'Enroll/revoke devices'),
  ('accounting.journal.reverse', 'Reverse a posted journal (restricted)'),
  ('license.manage',         'Export/import license packages and device transfers')
ON CONFLICT (code) DO NOTHING;

INSERT INTO license_plans
  (id, name, edition, perpetual_core, maintenance_days, connected_services, device_quota, branch_quota, entitlement_ids)
VALUES
  ('perpetual_core_single', 'Perpetual Offline Core (single till)', 'core', true, 0, false, 1, 1,
     ARRAY['core.pos','core.catalog','core.inventory','core.ar','core.ap','core.reports']),
  ('core_maintenance_1y',   'Core + Annual Maintenance',           'core', true, 365, false, 1, 1,
     ARRAY['core.pos','core.catalog','core.inventory','core.ar','core.ap','core.reports','support.upgrades']),
  ('core_connected_multi',  'Core + Connected Services (multi-till)', 'connected', true, 365, true, 5, 3,
     ARRAY['core.pos','core.catalog','core.inventory','core.ar','core.ap','core.reports','support.upgrades','cloud.dashboard','cloud.backup','cloud.multibranch'])
ON CONFLICT (id) DO NOTHING;
