import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const registry = JSON.parse(fs.readFileSync(path.join(root, "tests", "fixtures", "v2-01-known-failures.json"), "utf8"));

test("known-failure registry covers every V2-01 oracle without inventing blocked policy", () => {
  assert.equal(registry.schemaVersion, "dsdst.known-business-oracles.v1");
  assert.deepEqual(registry.oracles.map(({ id }) => id).sort(), [
    "auth.session-revocation",
    "finance.currency-safe-money",
    "inventory.reservation-availability",
    "inventory.sale-pick-single-effect",
    "labels.concurrent-template-write",
    "returns.refund-is-not-physical-return",
    "sales.sale-time-bom-snapshot",
  ]);
  for (const oracle of registry.oracles) {
    assert.ok(oracle.exactOracle.includes("=="), `${oracle.id} must state an exact equality/status oracle`);
    if (oracle.classification === "DECISION_REQUIRED") assert.ok(oracle.blockedBy?.length > 0);
  }
  assert.equal(registry.oracles.filter(({ classification }) => classification === "KNOWN_BUSINESS_RED").length, 3);
});
