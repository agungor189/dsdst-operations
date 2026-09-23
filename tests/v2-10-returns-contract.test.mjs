import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const panelRoot = path.resolve(process.env.PANEL_CONTEXT || path.join(root, "..", "ChatGPT", "panel-kit-yonetimi"));
const warehouseRoot = path.resolve(process.env.WAREHOUSE_CONTEXT || path.join(root, "..", "Dsdst-Warehouse"));
const read = (base, ...segments) => fs.readFileSync(path.join(base, ...segments), "utf8");

test("Panel owns append-only V2-10 return, receipt, loss, refund, and settlement facts", () => {
  const schema = read(panelRoot, "server", "db", "returnsSchema.ts");
  const packageOriginSchema = read(panelRoot, "server", "db", "warehousePackageOriginSchema.ts");
  const migration = read(panelRoot, "server", "migrations", "runner.ts");
  const service = read(panelRoot, "server", "modules", "returns", "returnsService.ts");
  const warehouse = read(panelRoot, "server", "modules", "warehouse", "warehouseExecutionService.ts");
  const routes = read(panelRoot, "server", "routes", "returnsV1Routes.ts");
  const warehouseRoutes = read(panelRoot, "server", "routes", "warehouseRoutes.ts");

  assert.match(migration, /version:\s*75[\s\S]*add_returns_refunds_financial_reversals/);
  assert.match(migration, /version:\s*76[\s\S]*generalize_warehouse_package_return_origin/);
  for (const table of [
    "return_requests", "return_request_lines", "return_financial_reversal_allocations", "return_cogs_reversal_allocations",
    "return_receipts", "return_receipt_lines", "return_receipt_inventory_allocations", "return_loss_facts",
    "refund_approvals", "refund_payments", "refund_cash_postings", "refund_settlement_postings",
    "customer_shipping_refund_facts", "marketplace_commission_reversal_facts",
  ]) {
    assert.match(schema, new RegExp(`CREATE TABLE ${table}`));
  }
  assert.match(schema, /CREATE TRIGGER trg_\$\{table\}_immutable_update/);
  assert.match(schema, /CREATE TRIGGER trg_\$\{table\}_immutable_delete/);
  assert.match(schema, /CHECK\(gross_before_discount_minor - discount_minor = gross_minor\)/);
  assert.match(schema, /CHECK\(net_minor \+ vat_minor = gross_minor\)/);
  assert.match(schema, /PENDING_SETTLEMENT/);
  assert.match(routes, /CommandExecutor/);
  assert.match(routes, /returns\.request\.create\.v1/);
  assert.match(routes, /returns\.refund\.approve-and-pay\.v1/);
  assert.match(warehouseRoutes, /returns\.receipt\.inspect\.v1/);
  assert.match(service, /RETURN_QUANTITY_EXCEEDED/);
  assert.match(service, /REFUND_AMOUNT_EXCEEDED/);
  assert.match(service, /original_cogs_allocation_id/);
  assert.match(service, /acquisition_cost_snapshot_id/);
  assert.match(service, /MARKETPLACE_REFUND_CASH_FORBIDDEN/);
  assert.match(service, /source_type,source_id[\s\S]*v2_return_refund_projection/);
  assert.match(service, /warehouse\.registerReturnPackage/);
  assert.doesNotMatch(service, /INSERT INTO inventory_lot_location_balances/);
  assert.match(packageOriginSchema, /origin_type[\s\S]*GOODS_RECEIPT[\s\S]*RETURN_RECEIPT/);
  assert.match(packageOriginSchema, /return_receipt_inventory_allocation_id\s+TEXT UNIQUE/);
  assert.match(packageOriginSchema, /origin_inventory_lot_id/);
  assert.match(warehouse, /registerReturnPackage/);
  assert.match(warehouse, /validatedDestination\(packageId/);
  assert.match(warehouse, /validatedQuarantineDestination\(packageId/);
  assert.match(warehouse, /packageId, packageCode, "RETURN_RECEIPT"/);
  assert.doesNotMatch(service, /category\s*=\s*["']ADVERTISING|purchase_cost\s*\*/i);
});

test("Panel closes legacy post-dispatch return shortcuts and exposes the canonical Sale Detail workflow", () => {
  const server = read(panelRoot, "server.ts");
  const panel = read(panelRoot, "src", "components", "sales", "SaleReturnsPanel.tsx");
  assert.match(server, /RETURN_WORKFLOW_REQUIRED/);
  assert.match(server, /POST_DISPATCH_RETURN_REQUIRED/);
  assert.match(panel, /CUSTOMER_CHANGED_MIND/);
  assert.match(panel, /MISSING_PART/);
  assert.match(panel, /customerShippingRefund/);
  assert.match(panel, /refundMode === "MARKETPLACE_SETTLEMENT"/);
  assert.match(panel, /RETURN_LOSS/);
  assert.match(panel, /remainingMinor/);
});

test("Warehouse remains an execution BFF/UI and submits physical dispositions only to Panel", () => {
  const server = read(warehouseRoot, "server", "app.ts");
  const client = read(warehouseRoot, "src", "lib", "api.ts");
  const page = read(warehouseRoot, "src", "pages", "ReturnAcceptancePage.tsx");
  assert.match(server, /\/api\/returns\/\:id\/receipts/);
  assert.match(server, /forward\(req, res, "POST", `\/returns\/\$\{encodeURIComponent/);
  assert.match(client, /returnsApi/);
  assert.match(page, /SELLABLE/);
  assert.match(page, /DAMAGED/);
  assert.match(page, /MISSING_NOT_RECEIVED/);
  assert.match(page, /returnsApi\.receive/);
  assert.doesNotMatch(server, /better-sqlite3|UPDATE\s+inventory_lots|INSERT\s+INTO\s+return_/i);
  assert.doesNotMatch(page, /localStorage|indexedDB|central_stock/);
});
