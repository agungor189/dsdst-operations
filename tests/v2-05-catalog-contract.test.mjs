import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const panelRoot = path.resolve(process.env.PANEL_CONTEXT || path.join(root, "..", "ChatGPT", "panel-kit-yonetimi"));
const kitRoot = path.resolve(process.env.KIT_STUDIO_CONTEXT || path.join(root, "..", "kit-studio"));

test("Panel create/update snapshots and complementary UOM semantics flow read-only to K", () => {
  const script = `
    import assert from "node:assert/strict";
    import Database from "better-sqlite3";
    import { pathToFileURL } from "node:url";
    const panelRoot = ${JSON.stringify(panelRoot)};
    const kitRoot = ${JSON.stringify(kitRoot)};
    const { initializeDatabase } = await import(pathToFileURL(panelRoot + "/server/db/initialize.ts"));
    const { CatalogService } = await import(pathToFileURL(panelRoot + "/server/modules/catalog/catalogService.ts"));
    const { openDatabase } = await import(pathToFileURL(kitRoot + "/server/db/index.ts"));
    const { syncPanelConnectors } = await import(pathToFileURL(kitRoot + "/server/services/panelClient.ts"));
    const { quoteCatalogSelection } = await import(pathToFileURL(kitRoot + "/server/services/variantService.ts"));
    const panel = new Database(":memory:");
    initializeDatabase(panel);
    const catalog = new CatalogService(panel);
    const created = catalog.createProduct({ id: "e2e-complement", sku: "E2E-BOX", title: "E2E box", catalog_type: "complementary", base_uom_code: "box" });
    for (const code of ["piece", "meter", "square_meter", "kg", "roll", "package"]) {
      catalog.createProduct({ id: "e2e-" + code, sku: "E2E-" + code, title: "E2E " + code, catalog_type: "complementary", base_uom_code: code,
        material_behavior: code === "square_meter" ? "continuous_cut" : undefined });
    }
    const firstSnapshot = panel.prepare("SELECT snapshot_json FROM catalog_product_versions WHERE product_id=? AND catalog_version=1").pluck().get(created.id);
    process.env.PANEL_API_URL = "https://panel.contract.test";
    process.env.PANEL_API_KEY = "contract-key";
    process.env.NODE_ENV = "production";
    const kit = openDatabase(":memory:");
    const fetchCatalog = async () => new Response(JSON.stringify({ success: true, contract: "dsdst.catalog-product.v1", data: catalog.listProducts() }), { status: 200, headers: { "content-type": "application/json" } });
    await syncPanelConnectors(kit, fetchCatalog);
    assert.deepEqual(kit.prepare("SELECT name,base_uom_code,unit_type,catalog_version_ref,cost_status,sale_price_status FROM complementary_products WHERE id=?").get(created.id), {
      name: "E2E box", base_uom_code: "box", unit_type: "box", catalog_version_ref: "catalog-product:e2e-complement:v1", cost_status: "UNKNOWN", sale_price_status: "UNKNOWN"
    });
    assert.deepEqual(kit.prepare("SELECT base_uom_code,unit_type FROM complementary_products WHERE id LIKE 'e2e-%' ORDER BY base_uom_code").all(), [
      { base_uom_code: "box", unit_type: "box" }, { base_uom_code: "kg", unit_type: "kg" },
      { base_uom_code: "meter", unit_type: "meter" }, { base_uom_code: "package", unit_type: "package" },
      { base_uom_code: "piece", unit_type: "piece" }, { base_uom_code: "roll", unit_type: "roll" },
      { base_uom_code: "square_meter", unit_type: "square_meter" },
    ]);
    assert.equal(kit.prepare("SELECT material_behavior FROM complementary_products WHERE id='e2e-square_meter'").pluck().get(), "continuous_cut");
    assert.throws(() => quoteCatalogSelection(kit, { connectors: [], cuts: [], complementary_items: [{ product_id: created.id, quantity: 1 }] }), /CATALOG_ECONOMICS_UNKNOWN/);
    kit.prepare("UPDATE complementary_products SET purchase_unit_price_cents=100,sale_unit_price_cents=150,cost_status='KNOWN',sale_price_status='KNOWN' WHERE id LIKE 'e2e-%'").run();
    for (const code of ["piece", "roll", "package", "box"]) {
      const id = code === "box" ? created.id : "e2e-" + code;
      assert.throws(() => quoteCatalogSelection(kit, { connectors: [], cuts: [], complementary_items: [{ product_id: id, quantity: 1.5 }] }), /DISCRETE_QUANTITY_MUST_BE_INTEGER/);
    }
    for (const code of ["meter", "square_meter", "kg"]) {
      const quote = quoteCatalogSelection(kit, { connectors: [], cuts: [], complementary_items: [{ product_id: "e2e-" + code, quantity: 1.125 }] });
      assert.equal(quote.complementary_cost_cents, 113);
    }
    const updated = catalog.updateProduct(created.id, 1, { ...created, title: "E2E box v2" });
    assert.equal(updated.catalog_version, 2);
    assert.equal(panel.prepare("SELECT snapshot_json FROM catalog_product_versions WHERE product_id=? AND catalog_version=1").pluck().get(created.id), firstSnapshot);
    assert.equal(panel.prepare("SELECT COUNT(*) FROM catalog_product_versions WHERE product_id=?").pluck().get(created.id), 2);
    await syncPanelConnectors(kit, fetchCatalog);
    assert.deepEqual(kit.prepare("SELECT name,catalog_version_ref FROM complementary_products WHERE id=?").get(created.id), { name: "E2E box v2", catalog_version_ref: "catalog-product:e2e-complement:v2" });
    kit.close(); panel.close();
  `;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
    cwd: panelRoot,
    encoding: "utf8",
    env: { ...process.env, NODE_ENV: "production" },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
