import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const panelRoot = path.resolve(process.env.PANEL_CONTEXT || path.join(root, "..", "ChatGPT", "panel-kit-yonetimi"));
const warehouseRoot = path.resolve(process.env.WAREHOUSE_CONTEXT || path.join(root, "..", "Dsdst-Warehouse"));
const topology = JSON.parse(fs.readFileSync(path.join(root, "config", "v2-08-warehouse-topology.json"), "utf8"));
const settings = JSON.parse(fs.readFileSync(path.join(root, "config", "v2-08-warehouse-settings.json"), "utf8"));

test("V2-08 current topology is configuration-owned and expands to 14x4x6x3", () => {
  assert.equal(topology.racks.length, 14);
  assert.equal(topology.racks.reduce((sum, rack) => sum + rack.levelCount * rack.positionCount * rack.depths.length, 0), 1008);
  for (const rack of topology.racks) {
    assert.equal(rack.levelCount, 4);
    assert.equal(rack.positionCount, 6);
    assert.deepEqual(rack.depths.map((depth) => depth.code), ["FRONT", "REAR_1", "REAR_2"]);
    assert.deepEqual(rack.levels.map((level) => level.role), ["MIXED", "MIXED", "MIXED", "RESERVE"]);
  }
  const c2 = topology.racks.find((rack) => rack.code === "C2");
  assert.equal(c2.lastResort, true);
  assert.equal(c2.placementPriority, 900);
});

test("V2-08 replenishment thresholds are explicit persisted configuration", () => {
  assert.equal(settings.schemaVersion, "dsdst.warehouse-execution-settings.v1");
  assert.equal(settings.watchThresholdPct, 20);
  assert.equal(settings.prepareThresholdPct, 10);
  assert.equal(settings.prepareThresholdPct <= settings.watchThresholdPct, true);
  assert.equal(settings.heavyPackageThresholdGrams, 20_000);
});

test("Panel accepts both the current topology and a future custom six-position rack without code changes", () => {
  const script = `
    import assert from "node:assert/strict";
    import Database from "better-sqlite3";
    const { initializeDatabase } = await import(${JSON.stringify(pathToFileURL(path.join(panelRoot, "server/db/initialize.ts")).href)});
    const { WarehouseExecutionService } = await import(${JSON.stringify(pathToFileURL(path.join(panelRoot, "server/modules/warehouse/warehouseExecutionService.ts")).href)});
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    initializeDatabase(db);
    const service = new WarehouseExecutionService(db);
    assert.equal(service.configureTopology(${JSON.stringify(topology)}).summary.slotCount, 1008);
    const custom = { id: "future-2x6", name: "Future rack", codeTemplate: "{rack}-{level}-{position}-{depth}", racks: [{ code: "FUTURE", levelCount: 2, positionCount: 6, role: "PICKING", allowMixedSku: false, allowMixedLot: false, placementPriority: 10, depths: [{ code: "FRONT", isFront: true, priority: 0 }] }] };
    assert.equal(service.configureTopology(custom).summary.slotCount, 12);
    db.close();
  `;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], { cwd: panelRoot, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("Panel is the only warehouse authority and Warehouse remains an execution BFF/UI", () => {
  const panelService = fs.readFileSync(path.join(panelRoot, "server", "modules", "warehouse", "warehouseExecutionService.ts"), "utf8");
  const panelRoutes = fs.readFileSync(path.join(panelRoot, "server", "routes", "warehouseRoutes.ts"), "utf8");
  const migration = fs.readFileSync(path.join(panelRoot, "server", "migrations", "runner.ts"), "utf8");
  const warehouseServer = fs.readFileSync(path.join(warehouseRoot, "server", "app.ts"), "utf8");
  const warehouseClient = fs.readFileSync(path.join(warehouseRoot, "src", "lib", "api.ts"), "utf8");
  const warehousePages = fs.readFileSync(path.join(warehouseRoot, "src", "pages", "WarehouseAdminPages.tsx"), "utf8");

  assert.match(migration, /version:\s*71[\s\S]*add_authoritative_warehouse_execution_contract/);
  assert.match(migration, /version:\s*72[\s\S]*persist_warehouse_execution_thresholds/);
  assert.match(panelRoutes, /CommandExecutor/);
  assert.match(panelRoutes, /warehouse\.goods-receipt\.accept\.v1/);
  assert.match(panelRoutes, /warehouse\.package\.move\.v1/);
  assert.match(panelRoutes, /warehouse\.replenishment\.prepare\.v1/);
  assert.match(panelRoutes, /warehouse\.stock-count\.approve\.v1/);
  assert.match(panelRoutes, /V2_WAREHOUSE_EXECUTION_REQUIRED/);
  assert.match(panelService, /MOVE_CHANGED_ON_HAND/);
  assert.match(panelService, /EXPECTED_SAME_LOT_RESERVE_NOT_FOUND/);
  assert.match(panelService, /PARTIAL_RECEIPT_DISABLED/);
  assert.match(panelService, /new InventoryService\(this\.db\)\.receiveCostedLot/);
  assert.doesNotMatch(panelService, /["']C2["']/);

  assert.match(warehouseServer, /\/api\/execution\/packages\/\:id\/move/);
  assert.match(warehouseServer, /forward\(req, res, "POST", `\/execution\/packages\/\$\{encodeURIComponent/);
  assert.match(warehouseClient, /warehouseExecutionApi/);
  assert.match(warehouseClient, /prepareReplenishment/);
  assert.match(warehousePages, /export function InboundPage\(\)[\s\S]*warehouseExecutionApi\.receiveGoods/);
  assert.match(warehousePages, /export function LabelingPage\(\)[\s\S]*warehouseExecutionApi\.identifyPackage/);
  assert.doesNotMatch(warehouseServer, /better-sqlite3|inventory_ledger_events|UPDATE\s+inventory_lots/i);
});
