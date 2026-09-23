import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const panelRoot = path.resolve(process.env.PANEL_CONTEXT || path.join(root, "..", "ChatGPT", "panel-kit-yonetimi"));
const warehouseRoot = path.resolve(process.env.WAREHOUSE_CONTEXT || path.join(root, "..", "Dsdst-Warehouse"));
const labelRoot = path.resolve(process.env.LABEL_PRINTER_CONTEXT || path.join(root, "..", "label-printer"));
const read = (base, ...segments) => fs.readFileSync(path.join(base, ...segments), "utf8");

test("P v85 owns immutable canonical print jobs, attempts, reprints and uncertainty-aware state", () => {
  const migration = read(panelRoot, "server", "migrations", "runner.ts");
  const schema = read(panelRoot, "server", "db", "printStateSchema.ts");
  assert.match(migration, /version:\s*85[\s\S]*add_canonical_print_state/);
  assert.match(migration, /CURRENT_SCHEMA_VERSION = 85/);
  assert.match(migration, /legacy print queues to be drained or explicitly cancelled/);
  for (const table of ["printing_jobs", "printing_attempts", "printing_reprints", "printing_events"])
    assert.match(schema, new RegExp(`CREATE TABLE ${table}`));
  for (const state of ["QUEUED", "RENDERED", "SUBMITTED", "ACKNOWLEDGED", "PRINTED_CONFIRMED", "DELIVERY_UNKNOWN", "FAILED", "CANCELLED"])
    assert.match(schema, new RegExp(`'${state}'`));
  for (const immutable of ["print job snapshot is immutable", "reprint history is immutable", "print event history is immutable"])
    assert.match(schema, new RegExp(immutable));
  assert.match(schema, /Xprinter XP-470B/);
  assert.match(schema, /printer_dpi INTEGER NOT NULL DEFAULT 203/);
  assert.doesNotMatch(schema, /'KIT'/);
});

test("P snapshots exact L versions and label payloads while SHIPPING preserves the native artifact", () => {
  const service = read(panelRoot, "server", "modules", "printing", "printingService.ts");
  const worker = read(panelRoot, "server", "services", "printQueueWorker.ts");
  assert.match(service, /GOODS_RECEIPT_PACKAGE[\s\S]*LOCATION[\s\S]*SHIPPING/);
  assert.match(service, /GOODS_RECEIPT_PACKAGE[\s\S]*\[100, 150\]/);
  assert.match(service, /LOCATION[\s\S]*\[100, 50\]/);
  assert.match(service, /\{SKU\}/);
  assert.match(service, /\{Lokasyon\}/);
  assert.match(service, /template_snapshot_json/);
  assert.match(service, /payload_snapshot_json/);
  assert.match(service, /SHIPPING_ARTIFACT_HASH_MISMATCH/);
  assert.match(service, /artifactReference/);
  assert.match(service, /artifactSha256/);
  assert.match(worker, /templateVersion:\s*job\.template_version/);
  assert.match(worker, /templateContentHash:\s*job\.template_content_hash/);
  assert.match(worker, /templateSnapshot:\s*JSON\.parse\(job\.template_snapshot_json\)/);
  assert.match(worker, /Provider-native label artifact hash mismatch/);
  assert.doesNotMatch(worker, /PRINTED_CONFIRMED/);
  assert.match(worker, /ACKNOWLEDGED[\s\S]*DELIVERY_UNKNOWN/);
});

test("reprints require permission, controlled reason and immutable linkage to the original", () => {
  const schema = read(panelRoot, "server", "db", "printStateSchema.ts");
  const service = read(panelRoot, "server", "modules", "printing", "printingService.ts");
  const routes = read(panelRoot, "server", "routes", "warehouseRoutes.ts");
  for (const reason of ["DAMAGED_OUTPUT", "LOST", "PRINTER_ERROR", "OTHER"]) assert.match(schema, new RegExp(`'${reason}'`));
  assert.match(schema, /reason<>'OTHER'[\s\S]*length\(trim\(explanation\)\)>0/);
  assert.match(service, /REPRINT_EXPLANATION_REQUIRED/);
  assert.match(service, /originalJobId/);
  assert.match(routes, /admin\/print-jobs\/:id\/reprint[\s\S]*warehouse:print_labels/);
  assert.match(routes, /admin\/print-jobs\/:id\/confirm[\s\S]*warehouse:print_labels/);
  assert.match(routes, /printing\.job\.reprint\.v1/);
});

test("L is the only editable template authority with CAS-safe immutable versions and locked media contracts", () => {
  const store = read(labelRoot, "template-store.mjs");
  const renderer = read(labelRoot, "warehouse-renderer.mjs");
  const panelRoutes = read(panelRoot, "server", "routes", "warehouseRoutes.ts");
  assert.match(store, /version:\s*3/);
  assert.match(store, /revision/);
  assert.match(store, /templateVersions/);
  assert.match(store, /TEMPLATE_REVISION_CONFLICT/);
  assert.match(store, /templateContentHash/);
  assert.match(store, /goods_receipt[\s\S]*width:\s*100, height:\s*150[\s\S]*\{SKU\}/);
  assert.match(store, /location[\s\S]*width:\s*100, height:\s*50[\s\S]*\{Lokasyon\}/);
  assert.match(renderer, /findTemplateVersion/);
  assert.match(renderer, /assertWarehouseTemplateContract/);
  assert.match(renderer, /format:\s*'CODE128'/);
  assert.match(renderer, /X-Label-Template-Version/);
  assert.match(renderer, /X-Label-Template-Content-Hash/);
  assert.match(panelRoutes, /LABEL_TEMPLATE_AUTHORITY_MOVED/);
  assert.doesNotMatch(panelRoutes, /adminService\.saveTemplate/);
  assert.doesNotMatch(renderer, /printing_jobs|printing_attempts|PRINTED_CONFIRMED/);
});

test("W is an operator-only W -> P -> L flow with preview, explicit Yazdır, status and reasoned reprint", () => {
  const bff = read(warehouseRoot, "server", "app.ts");
  const client = read(warehouseRoot, "src", "lib", "api.ts");
  const pages = read(warehouseRoot, "src", "pages", "WarehouseAdminPages.tsx");
  const shipping = read(warehouseRoot, "src", "pages", "ShipmentPage.tsx");
  assert.match(bff, /templates\/default\?purpose=/);
  assert.match(bff, /template_snapshot:\s*templateSnapshot/);
  assert.match(bff, /admin\/packages\/:id\/print-preview/);
  assert.match(bff, /admin\/print-jobs\/:id\/reprint/);
  assert.match(bff, /shipping\/v1\/shipments\/:id\/packages\/:packageId\/print/);
  assert.match(client, /getPackagePrintPreview/);
  assert.match(client, /queuePrint/);
  assert.match(client, /reprint/);
  assert.match(client, /confirmPrinted/);
  assert.doesNotMatch(client, /"product_package"|"kit"|"shipping"\s*\|/);
  assert.match(pages, /Etiketleme V2-14/);
  assert.match(pages, /Yazdır/);
  assert.match(pages, /DAMAGED_OUTPUT/);
  assert.match(pages, /PRINTER_ERROR/);
  assert.match(pages, /Durum geçmişi/);
  assert.doesNotMatch(pages.slice(pages.indexOf("export function LabelTemplatesPage")), /<textarea|JSON\.stringify/);
  assert.match(shipping, /queueNativeLabel/);
  assert.match(shipping, /Yazdır/);
});
