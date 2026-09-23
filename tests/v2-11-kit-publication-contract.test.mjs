import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const panelRoot = path.resolve(process.env.PANEL_CONTEXT || path.join(root, "..", "ChatGPT", "panel-kit-yonetimi"));
const kitRoot = path.resolve(process.env.KIT_STUDIO_CONTEXT || path.join(root, "..", "kit-studio"));
const read = (base, ...segments) => fs.readFileSync(path.join(base, ...segments), "utf8");

test("Panel v77 publication plus forward-only v78 remediation own canonical kit truth", () => {
  const migration = read(panelRoot, "server", "migrations", "runner.ts");
  const schema = read(panelRoot, "server", "db", "publishedKitSchema.ts");
  const remediation = read(panelRoot, "server", "db", "profileCutRemediationSchema.ts");
  const publication = read(panelRoot, "server", "modules", "kits", "publishedKitService.ts");
  const catalog = read(panelRoot, "server", "modules", "catalog", "catalogService.ts");
  const route = read(panelRoot, "server", "routes", "kitPublicationV1Routes.ts");
  const sales = read(panelRoot, "server", "modules", "sales", "salesFinancialService.ts");

  assert.match(migration, /version:\s*77[\s\S]*add_published_kits_and_profile_piece_inventory/);
  assert.match(migration, /version:\s*78[\s\S]*remediate_profile_cut_delivery_and_legacy_representation/);
  assert.match(migration, /CURRENT_SCHEMA_VERSION = 86/);
  for (const table of [
    "kit_publication_settings", "published_kits", "published_kit_versions",
    "published_kit_version_components", "published_kit_version_cuts",
    "published_kit_version_packages", "published_kit_version_package_items",
    "sale_kit_version_snapshots",
  ]) assert.match(schema, new RegExp(`CREATE TABLE ${table}`));
  assert.match(schema, /published kit versions are immutable/);
  assert.match(schema, /sale kit version snapshots are immutable/);
  assert.match(schema, /final_sale_price_minor\s+INTEGER NOT NULL CHECK\(final_sale_price_minor >= canonical_cost_minor\)/);
  for (const table of ["profile_cut_waste_facts", "profile_return_piece_restorations", "profile_piece_migration_blocks"]) {
    assert.match(remediation, new RegExp(`CREATE TABLE ${table}`));
  }
  assert.match(publication, /SUBSTITUTES_FORBIDDEN/);
  assert.match(publication, /COST_UNKNOWN/);
  assert.match(publication, /DUPLICATE_SKU/);
  assert.match(publication, /product_type='kit',is_sellable=1,visible_in_catalog=1/);
  assert.match(publication, /quantityBaseInt:\s*cutLengthMm/);
  assert.match(publication, /costQuantityBaseInt:\s*consumedLengthMm/);
  assert.match(publication, /UPDATE products SET purchase_cost=\?,sale_price=\?,price_locked=1/);
  assert.match(catalog, /KIT_PUBLICATION_REQUIRED/);
  assert.match(route, /CommandExecutor/);
  assert.match(route, /kit\.publication\.publish\.v1/);
  assert.match(route, /kits:approve/);
  assert.match(sales, /INSERT INTO sale_kit_version_snapshots/);
  assert.match(sales, /current:\s*kit\.current_version_id === kit\.published_kit_version_id/);
});

test("Panel profile-piece inventory is exact integer-mm, provenance preserving, atomic and idempotent", () => {
  const schema = read(panelRoot, "server", "db", "publishedKitSchema.ts");
  const inventory = read(panelRoot, "server", "modules", "inventory", "inventoryService.ts");
  const cuts = read(panelRoot, "server", "modules", "inventory", "profileCutInventoryService.ts");
  const server = read(panelRoot, "server.ts");
  const returns = read(panelRoot, "server", "modules", "returns", "returnsService.ts");
  const cogs = read(panelRoot, "server", "modules", "sales", "salesFinancialService.ts");

  for (const table of [
    "profile_inventory_pieces", "profile_piece_reservations", "profile_piece_reservation_cuts",
    "profile_cut_executions", "profile_cut_outputs",
  ]) assert.match(schema, new RegExp(`CREATE TABLE ${table}`));
  assert.match(schema, /consumed_length_mm\s+INTEGER NOT NULL CHECK\(consumed_length_mm = cut_length_total_mm \+ kerf_total_mm\)/);
  assert.match(schema, /consumed_cost_minor \+ remnant_cost_minor = original_cost_minor/);
  assert.match(schema, /consumed_length_mm \+ remnant_length_mm = original_length_mm/);
  assert.match(cuts, /BigInt\(total\)/);
  assert.match(cuts, /planned_remnant_length_mm\) > 0/);
  assert.match(cuts, /Requested cuts must be an exact whole-order multiple of the immutable published cut plan/);
  assert.match(cuts, /this\.db\.transaction\(\(\) =>/);
  assert.match(cuts, /executionResult\(reservationId, operationId\)/);
  assert.match(cuts, /PROFILE_CUT_KERF_WASTE/);
  assert.match(cuts, /output_kind='CUT'/);
  assert.match(cuts, /PROFILE_PIECE_MIGRATION_REQUIRED/);
  assert.match(cuts, /restoreReturnedPieces/);
  assert.match(inventory, /profileCutInventory\.persistPlan/);
  assert.match(inventory, /quantityBaseInt:\s*quantity\.deliverable/);
  assert.match(inventory, /reservedQuantityBaseInt:\s*quantity\.consumed/);
  assert.match(cogs, /dsdst\.profile-cut-cogs\.v1/);
  assert.match(returns, /restoreReturnedPieces/);
  assert.match(server, /profileCutPlans/);
  assert.match(server, /published_kit_version_cuts/);
});

test("Kit Studio remains a draft workspace and publishes through the versioned Panel contract", () => {
  const migration = read(kitRoot, "server", "db", "migrate.ts");
  const sql = read(kitRoot, "server", "db", "migrations", "010_kit_publication_workflow.sql");
  const routes = read(kitRoot, "server", "routes", "kits.ts");
  const client = read(kitRoot, "server", "services", "panelClient.ts");
  const proposal = read(kitRoot, "server", "services", "kitPublication.ts");
  const ui = read(kitRoot, "src", "App.tsx");

  assert.match(migration, /CURRENT_SCHEMA_VERSION = 10/);
  for (const table of ["kit_packaging_packages", "kit_packaging_items", "kit_publication_attempts"]) {
    assert.match(sql, new RegExp(`CREATE TABLE ${table}`));
  }
  assert.match(routes, /PANEL_PUBLICATION_REQUIRED/);
  assert.match(routes, /\/variants\/:id\/publication-preview/);
  assert.match(routes, /\/variants\/:id\/publish/);
  assert.match(routes, /OPERATION_ID_REQUIRED/);
  assert.match(routes, /\/variants\/:id\/new-version/);
  assert.match(client, /\/api\/kit-publications\/v1\/\$\{path\}/);
  assert.match(client, /previewKitPublication/);
  assert.match(client, /publishKitPublication/);
  assert.match(client, /"x-operation-id"/);
  assert.match(proposal, /authoredKitContentHash/);
  assert.doesNotMatch(proposal, /INSERT INTO products|INSERT INTO inventory_|UPDATE inventory_/i);
  assert.match(ui, /sum, cut\) => sum \+ cut\.quantity \* cut\.length_mm/);
  assert.doesNotMatch(ui, /sum, cut\) => sum \+ cut\.quantity \* \(cut\.length_mm \+ kerfMm\)/);
});

test("Kit Studio accepts mm, cm and m display input but only emits exact integer millimeters", () => {
  const units = read(kitRoot, "src", "lengthUnits.ts");
  const ui = read(kitRoot, "src", "App.tsx");
  const unitTests = read(kitRoot, "test", "lengthUnits.test.ts");

  assert.match(units, /DisplayLengthUnit = "mm" \| "cm" \| "m"/);
  assert.match(units, /mm:\s*1n/);
  assert.match(units, /cm:\s*10n/);
  assert.match(units, /m:\s*1000n/);
  assert.match(units, /numerator % denominator !== 0n/);
  assert.match(ui, /parseLengthToMm/);
  assert.match(ui, /formatLengthFromMm/);
  assert.match(ui, /raw_length_mm/);
  assert.match(ui, /length_mm/);
  assert.match(unitTests, /\["1800", "mm", 1800\]/);
  assert.match(unitTests, /\["180", "cm", 1800\]/);
  assert.match(unitTests, /\["1\.8", "m", 1800\]/);
  assert.match(unitTests, /\["33\.7", "cm", 337\]/);
  assert.match(unitTests, /parseLengthToMm\("33\.75", "cm"\), null/);
});
