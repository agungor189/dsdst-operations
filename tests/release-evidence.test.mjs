import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { validateReleaseEvidence, validateSchema } from "../scripts/validate-release-evidence.mjs";
import { fingerprintConfigurationPairs } from "../scripts/fingerprint-release-config.mjs";
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
  const captureId = "runtime-synthetic-fixture";
  const independentImages = [
    {container: "1", image: "a", digest: "b", revision: "1"},
    {container: "2", image: "c", digest: "d", revision: "2"},
    {container: "3", image: "e", digest: "f", revision: "3"},
    {container: "4", image: "8", digest: "9", revision: "4"},
    {container: "5", image: "8", digest: "9", revision: "4"},
  ];
  const records = [];
  for (const [index, s] of m.services.entries()) {
    const r = s.runtime;
    const identity = independentImages[index];
    const imageReference = `registry.invalid/${s.service_id === "warehouse-label-renderer" ? "label-printer" : s.service_id}:fixture`;
    const record = {
      service_id: s.service_id,
      compose_service: s.service_id,
      container_id: identity.container.repeat(64),
      declared_image_reference: imageReference,
      observed_image_reference: imageReference,
      image_id: "sha256:" + identity.image.repeat(64),
      image_digest: "sha256:" + identity.digest.repeat(64),
      source_repository: s.repository,
      revision: identity.revision.repeat(40),
    };
    records.push(record);
    r.commit = {value: record.revision, evidence_source: {
      kind: "runtime-oci-revision", capture_id: captureId, service_id: s.service_id,
      compose_service: record.compose_service, container_id: record.container_id,
      image_reference: record.observed_image_reference, image_id: record.image_id,
      image_digest: record.image_digest, source_repository: record.source_repository,
      revision: record.revision,
    }};
    r.image = {
      declared_reference: record.declared_image_reference,
      observed_reference: record.observed_image_reference,
      image_id: record.image_id,
      digest: record.image_digest,
      source_repository: record.source_repository,
      evidence_source: "runtime-provenance",
    };
    if (r.schema.kind !== "none") {r.schema.version = "1"; r.schema.evidence_source = "read-only schema query";}
    r.configuration.status = "VERIFIED";
    r.configuration.fingerprint = "sha256:" + "c".repeat(64);
    for (const volume of r.volumes.declared) volume.source_id = "sha256:" + createHash("sha256").update(volume.source_alias).digest("hex");
    r.volumes.observed = structuredClone(r.volumes.declared);
    r.networks.observed = structuredClone(r.networks.declared);
    r.ports.observed = r.ports.declared.map(p => p.exposure === "internal" ? {...p} : {...p, host_ip: "127.0.0.1", host_port: Number(p.host_port.match(/:-(\d+)/)[1])});
  }
  return {manifest: m, runtimeProvenance: {
    provenance_version: 1,
    capture_id: captureId,
    captured_at: m.captured_at,
    collector: "dsdst-read-only-runtime-collector-v1",
    services: records,
  }};
}

const validateVerified = ({manifest, runtimeProvenance}) => validateReleaseEvidence(manifest, {runtimeProvenance});

test("standard Draft 2020-12 validator accepts unknown and service-specific synthetic fixtures", () => {
  const fixture = verifiedFixture();
  validateSchema(baseManifest);
  validateSchema(fixture.manifest);
  validateVerified(fixture);
});

test("rejects one container identity reused by independent services", () => {
  const fixture = verifiedFixture();
  fixture.runtimeProvenance.services[1].container_id = fixture.runtimeProvenance.services[0].container_id;
  fixture.manifest.services[1].runtime.commit.evidence_source.container_id = fixture.runtimeProvenance.services[0].container_id;
  assert.throws(() => validateVerified(fixture), /container|service|provenance/i);
});

test("rejects one unrelated image reused by every service", () => {
  const fixture = verifiedFixture();
  for (const [index, service] of fixture.manifest.services.entries()) {
    const record = fixture.runtimeProvenance.services[index];
    record.declared_image_reference = record.observed_image_reference = "registry.invalid/unrelated:fixture";
    record.image_id = "sha256:" + "a".repeat(64);
    record.image_digest = "sha256:" + "b".repeat(64);
    service.runtime.image.declared_reference = service.runtime.image.observed_reference = record.observed_image_reference;
    service.runtime.image.image_id = record.image_id;
    service.runtime.image.digest = record.image_digest;
    Object.assign(service.runtime.commit.evidence_source, {
      image_reference: record.observed_image_reference,
      image_id: record.image_id,
      image_digest: record.image_digest,
    });
  }
  assert.throws(() => validateVerified(fixture), /image|service|provenance/i);
});

test("rejects manifest-defined configuration allowlist expansion", () => {
  const m = structuredClone(baseManifest);
  m.services[0].runtime.configuration.safe_keys.push("UNLISTED_RUNTIME_SETTING");
  assert.throws(() => validateReleaseEvidence(m), /configuration|allowlist|safe.keys/i);
});

test("rejects correct digest attributed to the wrong Compose service", () => {
  const fixture = verifiedFixture();
  fixture.runtimeProvenance.services[0].compose_service = "dsdst-warehouse";
  fixture.manifest.services[0].runtime.commit.evidence_source.compose_service = "dsdst-warehouse";
  assert.throws(() => validateVerified(fixture), /service|provenance/i);
});

test("rejects correct service with the wrong observed image", () => {
  const fixture = verifiedFixture();
  const service = fixture.manifest.services[0];
  const record = fixture.runtimeProvenance.services[0];
  record.observed_image_reference = "registry.invalid/unrelated:fixture";
  service.runtime.image.observed_reference = record.observed_image_reference;
  service.runtime.commit.evidence_source.image_reference = record.observed_image_reference;
  assert.throws(() => validateVerified(fixture), /image|reference/i);
});

test("rejects correct image with a mismatched OCI revision", () => {
  const fixture = verifiedFixture();
  fixture.runtimeProvenance.services[0].revision = "f".repeat(40);
  fixture.manifest.services[0].runtime.commit.evidence_source.revision = "f".repeat(40);
  assert.throws(() => validateVerified(fixture), /revision|provenance/i);
});

test("rejects renderer source provenance mismatch", () => {
  const fixture = verifiedFixture();
  const index = 4;
  fixture.runtimeProvenance.services[index].source_repository = "agungor189/not-label-printer";
  fixture.manifest.services[index].runtime.image.source_repository = "agungor189/not-label-printer";
  fixture.manifest.services[index].runtime.commit.evidence_source.source_repository = "agungor189/not-label-printer";
  assert.throws(() => validateVerified(fixture), /renderer|repository|source|provenance/i);
});

test("rejects renderer image digest mismatch with Label Printer", () => {
  const fixture = verifiedFixture();
  const index = 4;
  const digest = "sha256:" + "7".repeat(64);
  fixture.runtimeProvenance.services[index].image_digest = digest;
  fixture.manifest.services[index].runtime.image.digest = digest;
  fixture.manifest.services[index].runtime.commit.evidence_source.image_digest = digest;
  assert.throws(() => validateVerified(fixture), /renderer|label printer|image digest/i);
});

test("rejects Git HEAD sourced fake revision", () => {
  const fixture = verifiedFixture();
  fixture.manifest.services[0].runtime.commit.evidence_source.kind = "git-head";
  assert.throws(() => validateVerified(fixture), /runtime|provenance|kind/i);
});

test("rejects VERIFIED manifest without collector provenance", () => {
  const fixture = verifiedFixture();
  assert.throws(() => validateReleaseEvidence(fixture.manifest), /collector|runtime.provenance/i);
});

for (const [name, key] of [
  ["credential-shaped unknown key", "AKIA" + "A".repeat(16)],
  ["innocuous but unlisted key", "UNLISTED_FEATURE_FLAG"],
]) test(`rejects ${name} in safe_keys`, () => {
  const m = structuredClone(baseManifest);
  m.services[0].runtime.configuration.safe_keys.push(key);
  assert.throws(() => validateReleaseEvidence(m), /allowlist|safe.keys/i);
});

test("rejects a safe key set copied from another service", () => {
  const m = structuredClone(baseManifest);
  m.services[1].runtime.configuration.safe_keys = [...m.services[0].runtime.configuration.safe_keys];
  assert.throws(() => validateReleaseEvidence(m), /allowlist|safe.keys/i);
});

test("accepts every authoritative service-specific safe key set", () => {
  assert.doesNotThrow(() => validateReleaseEvidence(structuredClone(baseManifest)));
});

test("configuration fingerprint rejects an out-of-allowlist input without exposing its value", () => {
  const pairs = baseManifest.services[0].runtime.configuration.safe_keys.map((key) => [key, "safe-fixture"]);
  const secretMarker = "do-not-echo-this-fixture-value";
  pairs[0] = ["UNLISTED_AUTH_FIELD", secretMarker];
  assert.throws(
    () => fingerprintConfigurationPairs("dsdst-panel", pairs),
    (error) => /allowlist/i.test(error.message) && !error.message.includes(secretMarker),
  );
});

test("configuration fingerprint rejects a key allowlisted only for another service", () => {
  const pairs = baseManifest.services[1].runtime.configuration.safe_keys.map((key) => [key, "safe-fixture"]);
  pairs[0] = ["DB_PATH", "safe-fixture"];
  assert.throws(() => fingerprintConfigurationPairs("dsdst-warehouse", pairs), /allowlist/i);
});

test("configuration fingerprint accepts the complete service-specific allowlist", () => {
  const pairs = baseManifest.services[0].runtime.configuration.safe_keys.map((key) => [key, "safe-fixture"]);
  assert.match(fingerprintConfigurationPairs("dsdst-panel", pairs), /^sha256:[a-f0-9]{64}$/);
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
  const fixture=verifiedFixture(); mutate(fixture.manifest); assert.throws(() => validateVerified(fixture));
});

for (const [name, mutate] of [
  ["date-only timestamp", m => m.captured_at="2026-09-19"],
  ["lowercase config key", m => m.services[0].runtime.configuration.safe_keys=["node_env"]],
  ["numeric port outside range", m => m.services[0].runtime.ports.observed[0].host_port=99999],
]) test(`standard schema and CLI both reject ${name}`, () => {
  const fixture=verifiedFixture(); const m=fixture.manifest; mutate(m);
  assert.throws(() => validateSchema(m));
  assert.throws(() => validateVerified(fixture));
});
