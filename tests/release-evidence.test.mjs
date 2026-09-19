import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { validateReleaseEvidence, validateSchema } from "../scripts/validate-release-evidence.mjs";
import { createHash } from "node:crypto";

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

test("rejects Git HEAD as runtime evidence", () => {
  const manifest = structuredClone(baseManifest);
  manifest.services[0].runtime.commit = {value: "a".repeat(40), evidence_source: "git rev-parse HEAD"};
  assert.throws(() => validateReleaseEvidence(manifest), /runtime.*(evidence|provenance)/i);
});

for (const [field, value] of [["host_port", 9999], ["host_port", 99999], ["host_ip", "0.0.0.0"]]) {
  test(`rejects incorrect observed ${field}=${value}`, () => {
    const manifest = structuredClone(baseManifest);
    const ports = manifest.services[0].runtime.ports;
    ports.observed = [{...ports.declared[0], host_ip: "127.0.0.1", host_port: 3000, [field]: value}];
    assert.throws(() => validateReleaseEvidence(manifest), /port|binding/i);
  });
}

test("rejects alias-only observed volume without actual source identity", () => {
  const manifest = structuredClone(baseManifest);
  for (const service of manifest.services) service.runtime.volumes.observed = structuredClone(service.runtime.volumes.declared);
  assert.throws(() => validateReleaseEvidence(manifest), /volume|source/i);
});

// Entirely synthetic runtime evidence: never collected from a live host.
function verifiedFixture() {
  const m = structuredClone(baseManifest);
  m.evidence_status = "VERIFIED";
  m.runtime_access = "READ-ONLY AUTHORIZED";
  m.captured_at = "2026-09-19T20:00:00Z";
  for (const s of m.services) {
    const r = s.runtime;
    r.commit = {value: "a".repeat(40), evidence_source: {kind: "runtime-oci-revision", container_id: "d".repeat(64), image_digest: "sha256:" + "b".repeat(64), revision: "a".repeat(40)}};
    r.image = {reference: "registry.invalid/synthetic:fixture", digest: "sha256:" + "b".repeat(64), evidence_source: "docker image inspect"};
    if (r.schema.kind !== "none") {r.schema.version = "1"; r.schema.evidence_source = "read-only schema query";}
    r.configuration.status = "VERIFIED";
    r.configuration.fingerprint = "sha256:" + "c".repeat(64);
    for (const volume of r.volumes.declared) volume.source_id = "sha256:" + createHash("sha256").update(volume.source_alias).digest("hex");
    r.volumes.observed = structuredClone(r.volumes.declared);
    r.networks.observed = structuredClone(r.networks.declared);
    r.ports.observed = r.ports.declared.map(p => p.exposure === "internal" ? {...p} : {...p, host_ip: "127.0.0.1", host_port: Number(p.host_port.match(/:-(\d+)/)[1])});
  }
  return m;
}

test("standard Draft 2020-12 validator accepts unknown and synthetic verified fixtures", () => {
  validateSchema(baseManifest);
  validateSchema(verifiedFixture());
  validateReleaseEvidence(verifiedFixture());
});

const adversarial = [
  ["secret-like free-text evidence", m => m.services[0].runtime.image.evidence_source = "PASSWORD=synthetic-test-value"],
  ["Git HEAD in VERIFIED", m => m.services[0].runtime.commit.evidence_source = "git rev-parse HEAD"],
  ["Git HEAD disguised as source kind", m => m.services[0].runtime.commit.evidence_source.kind = "git-head"],
  ["missing runtime proof", m => m.services[0].runtime.commit.evidence_source = "NOT VERIFIED"],
  ["digest unrelated to runtime", m => m.services[0].runtime.commit.evidence_source.image_digest = "sha256:" + "f".repeat(64)],
  ["wrong revision", m => m.services[0].runtime.commit.evidence_source.revision = "f".repeat(40)],
  ["unauthorized runtime capture", m => m.runtime_access = "NOT AUTHORIZED"],
  ["different renderer volume source", m => {const r=m.services[4].runtime; r.volumes.declared[0].source_id = r.volumes.observed[0].source_id = "sha256:" + "f".repeat(64);}],
  ["wrong observed volume", m => m.services[0].runtime.volumes.observed[0].source_id = "sha256:" + "f".repeat(64)],
  ["renderer writable state", m => m.services[4].runtime.volumes.observed[0].mode = "rw"],
  ["renderer edge network", m => m.services[4].runtime.networks.observed.push("edge")],
  ["missing service", m => m.services.pop()],
  ["wrong service identity", m => m.services[0].component = "W"],
  ["wrong declared port", m => m.services[0].runtime.ports.declared[0].host_port = 9999],
  ["wrong VERIFIED binding", m => m.services[0].runtime.ports.observed[0].host_ip = "0.0.0.0"],
  ["unresolved observed port", m => m.services[0].runtime.ports.observed = structuredClone(m.services[0].runtime.ports.declared)],
];
for (const [name, mutate] of adversarial) test(`rejects ${name}`, () => {
  const m=verifiedFixture(); mutate(m); assert.throws(() => validateReleaseEvidence(m));
});

for (const [name, mutate] of [
  ["date-only timestamp", m => m.captured_at="2026-09-19"],
  ["lowercase config key", m => m.services[0].runtime.configuration.safe_keys=["node_env"]],
  ["numeric port outside range", m => m.services[0].runtime.ports.observed[0].host_port=99999],
]) test(`standard schema and CLI both reject ${name}`, () => {
  const m=verifiedFixture(); mutate(m);
  assert.throws(() => validateSchema(m));
  assert.throws(() => validateReleaseEvidence(m));
});
