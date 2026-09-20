import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const panelRoot = path.resolve(process.env.PANEL_CONTEXT || path.join(root, "..", "ChatGPT", "panel-kit-yonetimi"));
const warehouseRoot = path.resolve(process.env.WAREHOUSE_CONTEXT || path.join(root, "..", "Dsdst-Warehouse"));

test("Panel owns the V2-07 receipt, reservation, FIFO, fulfillment, and dispatch facts", () => {
  const script = `
    import assert from "node:assert/strict";
    import Database from "better-sqlite3";
    import { pathToFileURL } from "node:url";
    const panelRoot = ${JSON.stringify(panelRoot)};
    const { initializeDatabase } = await import(pathToFileURL(panelRoot + "/server/db/initialize.ts"));
    const { CatalogService } = await import(pathToFileURL(panelRoot + "/server/modules/catalog/catalogService.ts"));
    const { ProcurementService } = await import(pathToFileURL(panelRoot + "/server/modules/procurement/procurementService.ts"));
    const { InventoryService, InventoryValidationError } = await import(pathToFileURL(panelRoot + "/server/modules/inventory/inventoryService.ts"));
    const { CommandExecutor } = await import(pathToFileURL(panelRoot + "/server/modules/commands/commandFoundation.ts"));
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    initializeDatabase(db);
    const catalog = new CatalogService(db);
    catalog.createProduct({ id: "dispatch-part", sku: "DISPATCH-PART", title: "Dispatch part", catalog_type: "product", base_uom_code: "piece" });
    catalog.createProduct({ id: "fifo-part", sku: "FIFO-PART", title: "FIFO part", catalog_type: "product", base_uom_code: "piece" });
    const procurement = new ProcurementService(db);
    procurement.registerSupplier({ id: "supplier", name: "Supplier", defaultCurrency: "TRY" });
    const inventory = new InventoryService(db);
    const command = new CommandExecutor(db);
    const execute = (operationId, commandType, payload, handler) => command.execute({
      operationId, commandType, payload,
      actor: { human: { id: "contract-owner", name: "Contract Owner" } },
      authorization: { decision: "ALLOW", capability: "inventory:write" },
    }, () => ({ statusCode: 200, body: handler() })).result.body;
    const costed = (productId, id, quantity) => {
      procurement.createPurchase({
        id: "purchase-" + id, supplierId: "supplier", acquisitionCostVatPolicy: "VAT_EXCLUDED_FROM_INVENTORY_COST",
        lines: [{ id: "line-" + id, productId, quantity: String(quantity), quoteBasis: "piece", supplierUnitPriceMinor: 100, currency: "TRY", vatMode: "EXCLUDED", vatRateBps: 0 }],
      });
      return procurement.finalizeAcquisitionCosts("purchase-" + id, { allocations: [] }).lots[0];
    };
    const receive = (lot, id, receivedAt, kind = "PICKING") => execute("receive-" + id, "inventory.receipt.approve.v1", { id, lot: lot.id }, () => inventory.receiveCostedLot({
      receiptId: "receipt-" + id, costSnapshotId: lot.id, receivedAt,
      location: { id: kind.toLowerCase() + "-" + id, kind }, operationId: "receive-" + id,
    }));

    const unreceived = costed("dispatch-part", "unreceived", 9);
    assert.equal(unreceived.state, "COSTED_PENDING_RECEIPT");
    assert.equal(inventory.getProductAvailability("dispatch-part").onHandBaseInt, 0);

    const dispatchCost = costed("dispatch-part", "dispatch", 4);
    const receipt = receive(dispatchCost, "dispatch", "2026-09-20T08:00:00.000Z");
    const receiptReplay = execute("receive-dispatch", "inventory.receipt.approve.v1", { id: "dispatch", lot: dispatchCost.id }, () => { throw new Error("receipt replay executed"); });
    assert.deepEqual(receiptReplay, receipt);
    assert.equal(db.prepare("SELECT COUNT(*) FROM inventory_ledger_events WHERE event_type='RECEIPT' AND product_id='dispatch-part'").pluck().get(), 1);
    assert.equal(db.prepare("SELECT landed_cost_try_minor FROM acquisition_lot_cost_snapshots WHERE id=?").pluck().get(dispatchCost.id), dispatchCost.landedCostTryMinor);

    inventory.reserveOrder({ reservationId: "dispatch-res", orderId: "dispatch-order", lines: [{ productId: "dispatch-part", quantityBaseInt: 3 }], operationId: "reserve-dispatch" });
    assert.deepEqual(inventory.getProductAvailability("dispatch-part"), { productId: "dispatch-part", baseUomCode: "piece", onHandBaseInt: 4, reservedBaseInt: 3, availableBaseInt: 1 });
    assert.throws(() => inventory.reserveOrder({ reservationId: "short", orderId: "short", lines: [{ productId: "dispatch-part", quantityBaseInt: 2 }], operationId: "short" }),
      (error) => error instanceof InventoryValidationError && error.code === "INSUFFICIENT_AVAILABLE_STOCK");
    assert.throws(() => inventory.reserveOrder({ reservationId: "fraction", orderId: "fraction", lines: [{ productId: "dispatch-part", quantityBaseInt: 0.5 }], operationId: "fraction" }),
      (error) => error instanceof InventoryValidationError && error.code === "INVALID_BASE_QUANTITY");
    inventory.markPicked({ reservationId: "dispatch-res", operationId: "pick" });
    inventory.markPacked({ reservationId: "dispatch-res", operationId: "pack" });
    assert.equal(inventory.getProductAvailability("dispatch-part").onHandBaseInt, 4);
    const dispatched = execute("dispatch-once", "inventory.reservation.dispatch.v1", { reservationId: "dispatch-res", shipmentId: "shipment" }, () => inventory.dispatchReservation({ reservationId: "dispatch-res", shipmentId: "shipment", dispatchedAt: "2026-09-20T12:00:00.000Z", operationId: "dispatch-once" }));
    const dispatchReplay = execute("dispatch-once", "inventory.reservation.dispatch.v1", { reservationId: "dispatch-res", shipmentId: "shipment" }, () => { throw new Error("dispatch replay executed"); });
    assert.deepEqual(dispatchReplay, dispatched);
    assert.equal(inventory.getProductAvailability("dispatch-part").onHandBaseInt, 1);
    assert.equal(db.prepare("SELECT COUNT(*) FROM inventory_ledger_events WHERE event_type='DISPATCH'").pluck().get(), 1);
    assert.equal(inventory.getProductReconciliation("dispatch-part").reconciled, true);

    inventory.reserveOrder({ reservationId: "cancel-res", orderId: "cancel-order", lines: [{ productId: "dispatch-part", quantityBaseInt: 1 }], operationId: "reserve-cancel" });
    inventory.releaseReservation({ reservationId: "cancel-res", reason: "ORDER_CANCELLED", operationId: "release-cancel" });
    assert.equal(inventory.getProductAvailability("dispatch-part").reservedBaseInt, 0);

    const older = receive(costed("fifo-part", "older", 3), "older", "2026-09-20T08:00:00.000Z", "RESERVE");
    const newer = receive(costed("fifo-part", "newer", 3), "newer", "2026-09-20T09:00:00.000Z", "PICKING");
    const first = inventory.reserveOrder({ reservationId: "fifo-1", orderId: "fifo-order-1", lines: [{ productId: "fifo-part", quantityBaseInt: 2 }], operationId: "fifo-1" });
    assert.deepEqual(first.allocations.map((row) => [row.lotId, row.quantityBaseInt]), [[older.lot.id, 2]]);
    const split = inventory.reserveOrder({ reservationId: "fifo-2", orderId: "fifo-order-2", lines: [{ productId: "fifo-part", quantityBaseInt: 2 }], operationId: "fifo-2" });
    assert.deepEqual(split.allocations.map((row) => [row.lotId, row.quantityBaseInt]), [[older.lot.id, 1], [newer.lot.id, 1]]);
    assert.equal(inventory.getFulfillmentState("fifo-1").requirements[0].state, "REPLENISH_SAME_LOT");
    assert.throws(() => inventory.markPicked({ reservationId: "fifo-1", operationId: "pick-fifo" }),
      (error) => error instanceof InventoryValidationError && error.code === "SAME_LOT_REPLENISHMENT_REQUIRED");
    inventory.reportStockDiscrepancy({ reservationId: "fifo-1", lotId: older.lot.id, locationId: "reserve-older", reason: "NOT_FOUND", operationId: "discrepancy" });
    assert.equal(inventory.getFulfillmentState("fifo-1").status, "STOCK_DISCREPANCY");
    assert.throws(() => inventory.reserveOrder({ reservationId: "no-fallback", orderId: "no-fallback", lines: [{ productId: "fifo-part", quantityBaseInt: 1 }], operationId: "no-fallback" }),
      (error) => error instanceof InventoryValidationError && error.code === "STOCK_DISCREPANCY");
    assert.throws(() => db.prepare("UPDATE products SET central_stock=99 WHERE id='dispatch-part'").run(), /projection/i);
    db.close();
  `;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
    cwd: panelRoot,
    encoding: "utf8",
    env: { ...process.env, NODE_ENV: "production" },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("Panel real sale lifecycle uses canonical reservations and legacy stock writes fail closed", () => {
  const server = fs.readFileSync(path.join(panelRoot, "server.ts"), "utf8");
  const migrations = fs.readFileSync(path.join(panelRoot, "server", "migrations", "runner.ts"), "utf8");
  const integration = fs.readFileSync(path.join(panelRoot, "server", "routes", "salesInventoryIntegration.test.ts"), "utf8");

  assert.match(server, /app\.post\("\/api\/sales", requireInventoryReserve/);
  assert.match(server, /inventoryService\.reserveOrder\(\{/);
  assert.match(server, /reservationByProduct\.set\(movement\.product_id, aggregated\)/);
  assert.match(server, /inventoryService\.releaseReservation\(\{/);
  assert.match(server, /DISPATCHED_NO_RESTOCK/);
  assert.match(server, /STOCK_ADJUSTMENT_REQUIRES_LOT_CORRECTION/);
  assert.doesNotMatch(server, /applySaleStockDeduction|restoreSaleStock|UPDATE products SET central_stock/);
  assert.match(migrations, /version: 70[\s\S]*guard_unrepresented_legacy_inventory/);
  assert.match(migrations, /INVENTORY_MIGRATION_REQUIRED/);
  assert.match(integration, /real \/api\/sales reserves aggregated BOM inventory/);
});

test("Warehouse exposes only the V2-07 Panel BFF contract and retains no inventory authority", () => {
  const server = fs.readFileSync(path.join(warehouseRoot, "server", "app.ts"), "utf8");
  const client = fs.readFileSync(path.join(warehouseRoot, "src", "lib", "api.ts"), "utf8");
  assert.match(server, /\/inventory\/reservations\/\$\{encodeURIComponent\(String\(req\.params\.id\)\)\}\/fulfillment/);
  assert.match(server, /\/inventory\/reservations\/\$\{encodeURIComponent\(String\(req\.params\.id\)\)\}\/dispatch/);
  assert.match(server, /idempotency_key: safeQueryText\(req\.body\?\.idempotency_key/);
  assert.match(client, /reportDiscrepancy/);
  assert.doesNotMatch(server, /better-sqlite3|UPDATE\s+products\s+SET\s+central_stock|inventory_ledger_events/i);
});
