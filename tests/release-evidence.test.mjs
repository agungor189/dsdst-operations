import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { validateReleaseEvidence } from "../scripts/validate-release-evidence.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (relativePath) => JSON.parse(readFileSync(path.join(root, relativePath), "utf8"));
const baseManifest = readJson("evidence/release-evidence.redacted.json");
const cases = readJson("tests/fixtures/release-evidence/cases.json");
const schema = readJson("schemas/release-evidence.schema.json");

const serviceById = (manifest, serviceId) => {
  const service = manifest.services.find((entry) => entry.service_id === serviceId);
  assert.ok(service, `fixture service not found: ${serviceId}`);
  return service;
};

const applyOperation = (manifest, operation) => {
  const target = operation.service ? serviceById(manifest, operation.service) : manifest;
  const segments = operation.path.split(".");
  const key = segments.pop();
  const owner = segments.reduce((value, segment) => value[segment], target);
  if (operation.op === "delete") delete owner[key];
  else if (operation.op === "set") owner[key] = operation.value;
  else assert.fail(`unsupported fixture operation: ${operation.op}`);
};

test("redacted NOT VERIFIED release evidence is structurally valid", () => {
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(schema.$id, "https://dsdst.local/schemas/release-evidence.schema.json");
  assert.doesNotThrow(() => validateReleaseEvidence(structuredClone(baseManifest)));
});

for (const fixture of cases.invalid_cases) {
  test(`rejects ${fixture.name}`, () => {
    const manifest = structuredClone(baseManifest);
    fixture.operations.forEach((operation) => applyOperation(manifest, operation));
    assert.throws(() => validateReleaseEvidence(manifest), new RegExp(fixture.error, "i"));
  });
}
