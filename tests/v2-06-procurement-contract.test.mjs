import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const panelRoot = path.resolve(process.env.PANEL_CONTEXT || path.join(root, "..", "ChatGPT", "panel-kit-yonetimi"));

test("Panel alone owns immutable V2-06 purchase, FX, payment, and planned-lot cost facts without posting stock", () => {
  const script = `
    import assert from "node:assert/strict";
    import Database from "better-sqlite3";
    import { pathToFileURL } from "node:url";
    const panelRoot = ${JSON.stringify(panelRoot)};
    const { initializeDatabase } = await import(pathToFileURL(panelRoot + "/server/db/initialize.ts"));
    const { CatalogService } = await import(pathToFileURL(panelRoot + "/server/modules/catalog/catalogService.ts"));
    const { ExchangeRateService } = await import(pathToFileURL(panelRoot + "/server/modules/finance/exchangeRates.ts"));
    const { ProcurementService } = await import(pathToFileURL(panelRoot + "/server/modules/procurement/procurementService.ts"));
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    initializeDatabase(db);
    const catalog = new CatalogService(db);
    catalog.createProduct({ id: "contract-part", sku: "CONTRACT-PART", title: "Contract part", catalog_type: "product", base_uom_code: "piece" });
    db.prepare("INSERT INTO cash_accounts (id,name,currency) VALUES ('contract-usd','Contract USD','USD')").run();
    const procurement = new ProcurementService(db);
    const fx = new ExchangeRateService(db);
    procurement.registerSupplier({ id: "contract-supplier", name: "Contract supplier", defaultCurrency: "USD" });
    const stockBefore = db.prepare("SELECT central_stock FROM products WHERE id='contract-part'").pluck().get();
    const movementsBefore = db.prepare("SELECT COUNT(*) FROM stock_movements").pluck().get();
    const purchase = (id, lineId) => ({
      id, supplierId: "contract-supplier", invoiceNumber: "INV-" + id, invoiceDate: "2026-09-20",
      lines: [{ id: lineId, productId: "contract-part", quantity: "1", quoteBasis: "piece", supplierUnitPriceMinor: 1000, currency: "USD", vatMode: "EXCLUDED", vatRateBps: 2000 }],
    });
    fx.recordCurrentUsdTry({ rate: "40", source: "CONTRACT", changedAt: "2026-09-20T09:00:00.000Z", actorId: "contract-finance" });
    procurement.createPurchase(purchase("contract-a", "contract-line-a"));
    const lotA = procurement.finalizeAcquisitionCosts("contract-a", { allocations: [] });
    fx.recordCurrentUsdTry({ rate: "45", source: "CONTRACT", changedAt: "2026-09-20T10:00:00.000Z", actorId: "contract-finance" });
    procurement.createPurchase(purchase("contract-b", "contract-line-b"));
    const lotB = procurement.finalizeAcquisitionCosts("contract-b", { allocations: [] });
    assert.equal(lotA.lots[0].landedCostTryMinor, 40000);
    assert.equal(lotB.lots[0].landedCostTryMinor, 45000);
    assert.equal(procurement.getPurchase("contract-a").lots[0].landedCostTryMinor, 40000);
    const paid = procurement.recordPayment("contract-a", { id: "contract-payment", cashAccountId: "contract-usd", amountMinor: 500, currency: "USD", paidAt: "2026-09-20T12:00:00.000Z", reference: "BANK-CONTRACT" });
    assert.equal(paid.paymentStatus, "PARTIAL");
    assert.equal(paid.outstandingMinor, paid.totalGrossMinor - 500);
    assert.equal(db.prepare("SELECT COUNT(*) FROM procurement_cash_postings WHERE purchase_id='contract-a'").pluck().get(), 1);
    assert.equal(db.prepare("SELECT central_stock FROM products WHERE id='contract-part'").pluck().get(), stockBefore);
    assert.equal(db.prepare("SELECT COUNT(*) FROM stock_movements").pluck().get(), movementsBefore);
    assert.equal(db.prepare("SELECT state FROM acquisition_lot_cost_snapshots WHERE purchase_order_id='contract-a'").pluck().get(), "COSTED_PENDING_RECEIPT");
    assert.throws(() => db.prepare("UPDATE acquisition_lot_cost_snapshots SET landed_cost_try_minor=1 WHERE purchase_order_id='contract-a'").run(), /immutable/i);
    db.close();
  `;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
    cwd: panelRoot,
    encoding: "utf8",
    env: { ...process.env, NODE_ENV: "production" },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
