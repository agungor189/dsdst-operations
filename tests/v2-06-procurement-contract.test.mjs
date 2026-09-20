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
    db.prepare("INSERT INTO cash_accounts (id,name,currency,opening_balance) VALUES ('contract-usd','Contract USD','USD',100)").run();
    const procurement = new ProcurementService(db);
    const fx = new ExchangeRateService(db);
    procurement.registerSupplier({ id: "contract-supplier", name: "Contract supplier", defaultCurrency: "USD" });
    const stockBefore = db.prepare("SELECT central_stock FROM products WHERE id='contract-part'").pluck().get();
    const movementsBefore = db.prepare("SELECT COUNT(*) FROM stock_movements").pluck().get();
    const purchase = (id, lineId) => ({
      id, supplierId: "contract-supplier", acquisitionCostVatPolicy: "VAT_EXCLUDED_FROM_INVENTORY_COST", invoiceNumber: "INV-" + id, invoiceDate: "2026-09-20",
      lines: [{ id: lineId, productId: "contract-part", quantity: "1", quoteBasis: "piece", supplierUnitPriceMinor: 1000, currency: "USD", vatMode: "EXCLUDED", vatRateBps: 2000 }],
    });
    fx.recordCurrentUsdTry({ rate: "40", source: "CONTRACT", changedAt: "2026-09-20T09:00:00.000Z", actorId: "contract-finance" });
    const purchaseAInput = purchase("contract-a", "contract-line-a");
    purchaseAInput.acquisitionCosts = [
      { id: "contract-freight", category: "FREIGHT", amountMinor: 100, currency: "USD", vatMode: "EXCLUDED", vatRateBps: 0 },
      { id: "contract-customs", category: "CUSTOMS", amountMinor: 500, currency: "TRY", vatMode: "EXCLUDED", vatRateBps: 0 },
    ];
    const purchaseA = procurement.createPurchase(purchaseAInput);
    assert.equal(purchaseA.totalGrossMinor, 1200);
    assert.deepEqual(purchaseA.acquisitionCosts.map((cost) => cost.currency), ["TRY", "USD"]);
    const lotA = procurement.finalizeAcquisitionCosts("contract-a", { allocations: [
      { componentId: "contract-freight", mode: "ACCEPT_SUGGESTION" },
      { componentId: "contract-customs", mode: "ACCEPT_SUGGESTION" },
    ] });
    fx.recordCurrentUsdTry({ rate: "45", source: "CONTRACT", changedAt: "2026-09-20T10:00:00.000Z", actorId: "contract-finance" });
    procurement.createPurchase(purchase("contract-b", "contract-line-b"));
    const lotB = procurement.finalizeAcquisitionCosts("contract-b", { allocations: [] });
    assert.equal(lotA.lots[0].landedCostTryMinor, 44500);
    assert.equal(lotA.lots[0].vatPolicy, "VAT_EXCLUDED_FROM_INVENTORY_COST");
    assert.equal(lotB.lots[0].landedCostTryMinor, 45000);
    assert.equal(procurement.getPurchase("contract-a").lots[0].landedCostTryMinor, 44500);
    const paid = procurement.recordPayment("contract-a", { id: "contract-payment", cashAccountId: "contract-usd", amountMinor: 500, currency: "USD", paidAt: "2026-09-20T12:00:00.000Z", reference: "BANK-CONTRACT" });
    assert.equal(paid.paymentStatus, "PARTIAL");
    assert.equal(paid.outstandingMinor, paid.totalGrossMinor - 500);
    assert.equal(db.prepare("SELECT COUNT(*) FROM procurement_cash_postings WHERE purchase_id='contract-a'").pluck().get(), 1);
    assert.equal(db.prepare("SELECT COUNT(*) FROM cash_transactions WHERE source_type='procurement_purchase_payment' AND source_id='contract-payment'").pluck().get(), 1);
    assert.equal(db.prepare("SELECT opening_balance - (SELECT SUM(amount) FROM cash_transactions WHERE account_id='contract-usd' AND type='OUT' AND is_deleted=0) FROM cash_accounts WHERE id='contract-usd'").pluck().get(), 95);

    const vatIncluded = purchase("contract-vat", "contract-line-vat");
    vatIncluded.acquisitionCostVatPolicy = "VAT_INCLUDED_IN_INVENTORY_COST";
    vatIncluded.lines[0] = { ...vatIncluded.lines[0], currency: "TRY", supplierUnitPriceMinor: 12000, vatMode: "INCLUDED" };
    vatIncluded.acquisitionCosts = [{ id: "contract-vat-freight", category: "FREIGHT", amountMinor: 1200, currency: "TRY", vatMode: "INCLUDED", vatRateBps: 2000 }];
    procurement.createPurchase(vatIncluded);
    const vatLot = procurement.finalizeAcquisitionCosts("contract-vat", { allocations: [{ componentId: "contract-vat-freight", mode: "ACCEPT_SUGGESTION" }] });
    assert.equal(vatLot.lots[0].landedCostTryMinor, 13200);
    assert.equal(vatLot.lots[0].vatTryMinor, 2200);
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
