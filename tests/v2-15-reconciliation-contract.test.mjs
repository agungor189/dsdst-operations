import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const panel = path.resolve(process.env.PANEL_CONTEXT || path.join(root, "..", "ChatGPT", "panel-kit-yonetimi"));
const warehouse = path.resolve(process.env.WAREHOUSE_CONTEXT || path.join(root, "..", "Dsdst-Warehouse"));
const read = (base, ...segments) => fs.readFileSync(path.join(base, ...segments), "utf8");

test("P v87 is a forward-only control-plane migration and never repairs business data", () => {
  const migration = read(panel, "server", "migrations", "runner.ts");
  const schema = read(panel, "server", "db", "reconciliationSchema.ts");
  assert.match(migration, /version:\s*87[\s\S]*add_reconciliation_and_repair_control_plane/);
  assert.match(migration, /CURRENT_SCHEMA_VERSION = 87/);
  for (const table of ["reconciliation_runs", "reconciliation_findings", "reconciliation_blocks", "reconciliation_repair_proposals", "reconciliation_history"])
    assert.match(schema, new RegExp(`CREATE TABLE ${table}`));
  assert.doesNotMatch(migration.slice(migration.indexOf("version: 87"), migration.indexOf("export const CURRENT_SCHEMA_VERSION")), /UPDATE\s+(products|inventory_|sales|sale_|return_|shipment_|printing_)/i);
  assert.match(schema, /reconciliation history is immutable/);
  assert.match(schema, /reconciliation repair evidence is immutable/);
});

test("P performs deterministic dedupe, exact scoped blocks and safe projection-only auto repair", () => {
  const service = read(panel, "server", "modules", "reconciliation", "reconciliationService.ts");
  for (const code of ["INVENTORY_LEDGER_MISMATCH", "INVENTORY_RESERVED_MISMATCH", "SALE_FINANCIAL_TOTAL_MISMATCH", "SOLD_KIT_FROZEN_VERSION_MISMATCH",
    "RETURN_QUANTITY_BOUND_EXCEEDED", "REFUND_MONEY_BOUND_EXCEEDED", "CHANNEL_CANONICAL_LINK_MISMATCH", "CHANNEL_OUTBOUND_PROJECTION_MISMATCH", "SHIPMENT_DISPATCH_CHAIN_MISMATCH", "PRINT_CHAIN_MISMATCH"])
    assert.match(service, new RegExp(code));
  assert.match(service, /createHash\("sha256"\)/);
  assert.match(service, /occurrences=occurrences\+1/);
  assert.match(service, /new Map\(collected\.map/);
  assert.match(service, /profile_piece_reservations/);
  assert.match(service, /kerf_total_mm/);
  assert.match(service, /geliver_offer_selections/);
  assert.match(service, /geliver_booking_facts/);
  assert.match(service, /geliver_tracking_observations/);
  assert.match(service, /affectedType:"SKU"/);
  assert.match(service, /affectedType:"ORDER"/);
  assert.match(service, /kind:\s*"CENTRAL_STOCK"/);
  assert.match(service, /Only registered disposable projections may be auto-repaired/);
  assert.doesNotMatch(service, /UPDATE\s+inventory_ledger_events|UPDATE\s+sale_financial_snapshots|DELETE\s+FROM\s+(inventory_|sale_|return_|shipment_|printing_)/i);
});

test("daily 03:00 and manual Panel paths are authenticated, audited and admin-gated", () => {
  const scheduler = read(panel, "server", "modules", "reconciliation", "reconciliationScheduler.ts");
  const routes = read(panel, "server", "routes", "reconciliationV1Routes.ts");
  const permissions = read(panel, "server", "modules", "auth", "permissions.ts");
  const ui = read(panel, "src", "components", "ReconciliationCenter.tsx");
  assert.match(scheduler, /Europe\/Istanbul/);
  assert.match(scheduler, /RECONCILIATION_TIME_ZONE/);
  assert.match(scheduler, /hour:\s*3/);
  assert.match(routes, /reconciliation:run/);
  assert.match(routes, /data:repair:approve/);
  assert.match(routes, /data:repair:apply/);
  assert.match(routes, /repair-proposals\/:id\/execute/);
  assert.match(routes, /CommandExecutor/);
  assert.match(routes, /context\.addOutbox/);
  assert.match(permissions, /"data:repair:approve"/);
  assert.match(ui, /Şimdi kontrol et/);
  assert.match(ui, /Beklenen/);
  assert.match(ui, /Gerçek/);
  assert.match(ui, /Onayla/);
  assert.match(ui, /Reddet/);
  assert.match(ui, /Doğrula \/ Engeli kaldır/);
  assert.match(ui, /Yetkili komutu uygula/);
});

test("critical scope guards and the bounded repair executor use domain services rather than generic SQL", () => {
  const guard = read(panel, "server", "modules", "reconciliation", "reconciliationGuard.ts");
  const repair = read(panel, "server", "modules", "reconciliation", "reconciliationRepairExecutor.ts");
  const inventory = read(panel, "server", "modules", "inventory", "inventoryService.ts");
  const shipping = read(panel, "server", "modules", "shipping", "shipmentService.ts");
  const geliver = read(panel, "server", "modules", "shipping", "geliverFlowService.ts");
  const returns = read(panel, "server", "modules", "returns", "returnsService.ts");
  assert.match(guard, /affected_type=\?/);
  for (const source of [inventory, shipping, geliver, returns]) assert.match(source, /ReconciliationScopeGuard/);
  assert.match(repair, /REGISTERED_RECONCILIATION_REPAIR_COMMANDS/);
  assert.match(repair, /inventory\.release-reservation\.v1/);
  assert.match(repair, /new InventoryService/);
  assert.match(repair, /markRepairApplied/);
  assert.doesNotMatch(repair, /UPDATE\s+inventory_lots|DELETE\s+FROM/i);
});

test("W exposes only read-only inventory SKU findings and no repair mutation", () => {
  const panelWarehouse = read(panel, "server", "routes", "warehouseRoutes.ts");
  const bff = read(warehouse, "server", "app.ts");
  const page = read(warehouse, "src", "pages", "ReconciliationPage.tsx");
  assert.match(panelWarehouse, /listFindings\(\{ status: "OPEN", domain: "INVENTORY", affectedType: "SKU" \}\)/);
  assert.match(bff, /app\.get\("\/api\/reconciliation"/);
  assert.doesNotMatch(bff, /app\.(post|put|patch|delete)\("\/api\/reconciliation"/);
  assert.match(page, /Yalnız stok ve depo kapsamındaki açık SKU bulguları/);
  assert.match(page, /Onarım ve onay işlemleri Panel'den yürütülür/);
});
