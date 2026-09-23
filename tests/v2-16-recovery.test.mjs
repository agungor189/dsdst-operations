import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import {
  FORMAT_VERSION,
  TOOL_VERSION,
  applyOffsiteResult,
  buildRecoveryManifest,
  calculateRecoveryHealth,
  createDrillEvidence,
  planRetention,
  restoreRecoveryPoint,
  validateRestoreTarget,
  verifyRecoveryPoint,
} from "../scripts/recovery/recovery-lib.mjs";
import { onlineBackup } from "../scripts/recovery/sqlite-online-backup.mjs";

const tempDirs = [];
test.after(() => {
  for (const directory of tempDirs) fs.rmSync(directory, { recursive: true, force: true });
});

function temporaryDirectory() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dsdst-v2-16-"));
  tempDirs.push(directory);
  return directory;
}

function createDatabase(filePath, schemaVersion, rows = 1) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const db = new DatabaseSync(filePath);
  db.exec("PRAGMA journal_mode=WAL; CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, name TEXT NOT NULL); CREATE TABLE records(id INTEGER PRIMARY KEY, value TEXT NOT NULL);");
  db.prepare("INSERT INTO schema_migrations(version, name) VALUES (?, ?)").run(schemaVersion, `v${schemaVersion}`);
  const insert = db.prepare("INSERT INTO records(value) VALUES (?)");
  for (let index = 0; index < rows; index += 1) insert.run(`row-${index}`);
  db.close();
}

function createArchive(filePath, entries) {
  const source = temporaryDirectory();
  for (const [relativePath, contents] of Object.entries(entries)) {
    const target = path.join(source, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  execFileSync("tar", ["-czf", filePath, "-C", source, "."]);
}

function runtimeService(serviceId, revision, schemaKind, schemaVersion) {
  return {
    service_id: serviceId,
    declared_image_reference: `registry.invalid/${serviceId}:fixture`,
    revision,
    image_digest: `sha256:${"a".repeat(64)}`,
    image_id: `sha256:${"b".repeat(64)}`,
    container_id: "c".repeat(64),
    schema: { kind: schemaKind, version: String(schemaVersion), evidence_source: "runtime-collector" },
    configuration: { status: "VERIFIED", fingerprint: `sha256:${"d".repeat(64)}`, redacted: true, safe_keys: [] },
  };
}

function createRecoveryFixture({ createdAt = "2026-09-23T10:00:00.000Z" } = {}) {
  const point = temporaryDirectory();
  const revisions = {
    O: "0".repeat(40), P: "1".repeat(40), W: "2".repeat(40), K: "3".repeat(40), L: "4".repeat(40), HUB: "5".repeat(40),
  };
  createDatabase(path.join(point, "payload/panel/database.sqlite"), 67, 4);
  createDatabase(path.join(point, "payload/kit/database.sqlite"), 10, 3);
  createDatabase(path.join(point, "payload/customer-hub/database.sqlite"), 5, 2);
  createArchive(path.join(point, "payload/panel/uploads.tar.gz"), { "products/a.txt": "panel" });
  createArchive(path.join(point, "payload/kit/uploads.tar.gz"), { "designs/a.txt": "kit" });
  createArchive(path.join(point, "payload/label/state.tar.gz"), { "app-state.json": JSON.stringify({ version: 3, revision: 9, templates: [] }) });
  createArchive(path.join(point, "payload/customer-hub/attachments.tar.gz"), { "2026/a.txt": "hub" });
  fs.mkdirSync(path.join(point, "provenance"), { recursive: true });
  fs.writeFileSync(path.join(point, "provenance/source-set.json"), JSON.stringify({
    schemaVersion: "dsdst.test-source-set.v1",
    release: "V2-16",
    repositories: Object.entries(revisions).map(([id, revision]) => ({ id, repository: `example/${id}`, revision })),
  }));
  fs.writeFileSync(path.join(point, "provenance/source-set-observation.json"), JSON.stringify({
    schemaVersion: "dsdst.test-source-set.v1",
    repositories: Object.entries(revisions).map(([id, revision]) => ({ id, repository: `example/${id}`, revision, role: "release-source" })),
  }));
  fs.writeFileSync(path.join(point, "provenance/runtime.json"), JSON.stringify({
    provenance_version: 1,
    capture_id: `sha256:${"e".repeat(64)}`,
    captured_at: createdAt,
    services: [
      runtimeService("dsdst-panel", revisions.P, "sqlite", 67),
      runtimeService("dsdst-warehouse", revisions.W, "none", "NOT APPLICABLE"),
      runtimeService("dsdst-kit-studio", revisions.K, "sqlite", 10),
      runtimeService("label-printer", revisions.L, "json-state", 3),
      runtimeService("warehouse-label-renderer", revisions.L, "json-state", 3),
      runtimeService("dsdst-customer-hub", revisions.HUB, "sqlite", 5),
    ],
  }));
  const manifest = buildRecoveryManifest(point, {
    recoveryPointId: "rp-20260923T100000Z-fixture",
    createdAt,
    completedAt: "2026-09-23T10:02:00.000Z",
    offsiteEnabled: false,
  });
  return { point, manifest };
}

test("P and K online SQLite snapshots are consistent while a WAL writer is live", async () => {
  for (const component of ["panel", "kit"]) {
    const directory = temporaryDirectory();
    const livePath = path.join(directory, `${component}.sqlite`);
    const snapshotPath = path.join(directory, `${component}-snapshot.sqlite`);
    createDatabase(livePath, component === "panel" ? 67 : 10, 50);
    const writer = new DatabaseSync(livePath);
    writer.exec("PRAGMA journal_mode=WAL; BEGIN IMMEDIATE; INSERT INTO records(value) VALUES ('uncommitted')");
    await onlineBackup(livePath, snapshotPath);
    writer.exec("ROLLBACK");
    writer.close();
    const snapshot = new DatabaseSync(snapshotPath, { readOnly: true });
    assert.equal(snapshot.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
    assert.equal(snapshot.prepare("SELECT COUNT(*) AS count FROM records").get().count, 50);
    snapshot.close();
  }
});

test("a verified recovery point contains complete P/K/L/Hub state, hashes, schemas, and exact provenance", () => {
  const { point, manifest } = createRecoveryFixture();
  const ajv = new Ajv2020({ strict: true });
  addFormats(ajv);
  const validate = ajv.compile(JSON.parse(fs.readFileSync(new URL("../schemas/recovery-point.schema.json", import.meta.url), "utf8")));
  assert.equal(validate(manifest), true, JSON.stringify(validate.errors));
  assert.equal(manifest.format_version, FORMAT_VERSION);
  assert.equal(manifest.tool.version, TOOL_VERSION);
  assert.equal(manifest.verification.state, "VERIFIED");
  assert.equal(manifest.status, "INCOMPLETE");
  assert.equal(manifest.offsite.state, "DISABLED");
  assert.deepEqual(Object.keys(manifest.components).sort(), [
    "customer_hub_attachments", "customer_hub_database", "kit_database", "kit_uploads",
    "label_state", "panel_database", "panel_uploads", "runtime_provenance", "source_set", "source_set_observation",
  ]);
  for (const component of Object.values(manifest.components)) {
    assert.match(component.sha256, /^[a-f0-9]{64}$/);
    assert.ok(component.size_bytes > 0);
  }
  assert.equal(manifest.components.panel_database.schema_version, "67");
  assert.equal(manifest.components.kit_database.schema_version, "10");
  assert.equal(manifest.components.label_state.schema_version, "3");
  assert.equal(verifyRecoveryPoint(point).verification.state, "VERIFIED");
});

test("corruption and missing required components are rejected closed", () => {
  const corrupted = createRecoveryFixture();
  fs.appendFileSync(path.join(corrupted.point, "payload/kit/database.sqlite"), "corrupt");
  assert.throws(() => verifyRecoveryPoint(corrupted.point), /hash mismatch/i);

  const missing = createRecoveryFixture();
  fs.rmSync(path.join(missing.point, "payload/label/state.tar.gz"));
  assert.throws(() => verifyRecoveryPoint(missing.point), /missing component/i);
});

test("offsite persistence failure is distinct and cannot produce SUCCESS", () => {
  const { manifest } = createRecoveryFixture();
  const failed = applyOffsiteResult(manifest, { enabled: true, state: "FAILED", error: "rclone unavailable" });
  assert.equal(failed.verification.state, "VERIFIED");
  assert.equal(failed.offsite.state, "FAILED");
  assert.equal(failed.status, "FAILED");
  const persisted = applyOffsiteResult(manifest, {
    enabled: true,
    state: "PERSISTED",
    persistedAt: "2026-09-23T10:04:00.000Z",
    payload: { path: "r2:recovery/rp.enc", sha256: "f".repeat(64), sizeBytes: 123 },
  });
  assert.equal(persisted.status, "SUCCESS");
});

test("recovery sets are explicitly complete snapshots and offsite uploads are encrypted", () => {
  const backupScript = fs.readFileSync(new URL("../scripts/backup.sh", import.meta.url), "utf8");
  const snapshotScript = fs.readFileSync(new URL("../scripts/recovery/create-snapshot.sh", import.meta.url), "utf8");
  const offsiteScript = fs.readFileSync(new URL("../scripts/recovery/offsite-upload.sh", import.meta.url), "utf8");
  assert.doesNotMatch(backupScript + snapshotScript, /incremental/i);
  assert.match(snapshotScript, /sqlite-online-backup\.mjs[\s\S]*panel-data/);
  assert.match(snapshotScript, /sqlite-online-backup\.mjs[\s\S]*kit-data/);
  assert.match(offsiteScript, /openssl enc -aes-256-cbc -pbkdf2/);
  assert.match(offsiteScript, /rclone copyto "\$PAYLOAD"/);
  assert.doesNotMatch(offsiteScript, /rclone copyto "\$POINT/);
});

test("GFS retention keeps 48h hourly, 30d daily, 12w weekly, 12m monthly and the last known-good", () => {
  const now = new Date("2026-09-23T12:30:00.000Z");
  const points = [];
  for (let hours = 0; hours < 24 * 400; hours += 1) {
    const createdAt = new Date(now.getTime() - hours * 3_600_000).toISOString();
    points.push({ id: `rp-${hours}`, created_at: createdAt, status: "SUCCESS", verification: { state: "VERIFIED" } });
  }
  const plan = planRetention(points, now);
  assert.ok(plan.keep.includes("rp-0"));
  assert.ok(plan.keep.includes("rp-47"));
  assert.ok(!plan.keep.includes("rp-49"));
  assert.ok(plan.reasons.hourly.length <= 49);
  assert.ok(plan.reasons.daily.length <= 30);
  assert.ok(plan.reasons.weekly.length <= 12);
  assert.ok(plan.reasons.monthly.length <= 12);
  assert.ok(plan.keep.length >= 12);

  const onlyGood = [{ id: "last-good", created_at: "2020-01-01T00:00:00.000Z", status: "SUCCESS", verification: { state: "VERIFIED" } }];
  assert.deepEqual(planRetention(onlyGood, now).delete, []);
});

test("restore rejects production paths and restores readable P/K/L state only into isolation", () => {
  const { point } = createRecoveryFixture();
  const root = temporaryDirectory();
  const production = path.join(root, "production");
  const isolated = path.join(root, "isolated", "run-1");
  fs.mkdirSync(production, { recursive: true });
  assert.throws(() => validateRestoreTarget(production, [production]), /production/i);
  assert.throws(() => validateRestoreTarget(path.join(production, "child"), [production]), /production/i);
  const result = restoreRecoveryPoint(point, isolated, { productionPaths: [production] });
  assert.equal(result.state, "VERIFIED");
  const panel = new DatabaseSync(path.join(isolated, "panel/data/dsdst_panel.db"), { readOnly: true });
  const kit = new DatabaseSync(path.join(isolated, "kit/data/dsdst-kit-studio.db"), { readOnly: true });
  assert.equal(panel.prepare("SELECT COUNT(*) AS count FROM records").get().count, 4);
  assert.equal(kit.prepare("SELECT COUNT(*) AS count FROM records").get().count, 3);
  panel.close();
  kit.close();
  const label = JSON.parse(fs.readFileSync(path.join(isolated, "label/data/app-state.json"), "utf8"));
  assert.equal(label.version, 3);
});

test("provenance or schema incompatibility is rejected", () => {
  const sourceMismatch = createRecoveryFixture();
  const runtimePath = path.join(sourceMismatch.point, "provenance/runtime.json");
  const runtime = JSON.parse(fs.readFileSync(runtimePath, "utf8"));
  runtime.services.find((service) => service.service_id === "dsdst-kit-studio").revision = "9".repeat(40);
  fs.writeFileSync(runtimePath, JSON.stringify(runtime));
  assert.throws(() => buildRecoveryManifest(sourceMismatch.point, {
    recoveryPointId: "rp-mismatch", createdAt: "2026-09-23T10:00:00.000Z", completedAt: "2026-09-23T10:02:00.000Z", offsiteEnabled: false,
  }), /revision mismatch/i);

  const schemaMismatch = createRecoveryFixture();
  const schemaRuntimePath = path.join(schemaMismatch.point, "provenance/runtime.json");
  const schemaRuntime = JSON.parse(fs.readFileSync(schemaRuntimePath, "utf8"));
  schemaRuntime.services.find((service) => service.service_id === "dsdst-panel").schema.version = "66";
  fs.writeFileSync(schemaRuntimePath, JSON.stringify(schemaRuntime));
  assert.throws(() => buildRecoveryManifest(schemaMismatch.point, {
    recoveryPointId: "rp-schema-mismatch", createdAt: "2026-09-23T10:00:00.000Z", completedAt: "2026-09-23T10:02:00.000Z", offsiteEnabled: false,
  }), /schema mismatch/i);
});

test("RPO older than 60 minutes is unhealthy", () => {
  const now = new Date("2026-09-23T12:00:00.000Z");
  assert.equal(calculateRecoveryHealth([{ status: "SUCCESS", created_at: "2026-09-23T11:01:00.000Z" }], now).healthy, true);
  const stale = calculateRecoveryHealth([{ status: "SUCCESS", created_at: "2026-09-23T10:59:59.000Z" }], now);
  assert.equal(stale.healthy, false);
  assert.equal(stale.reason, "RPO_EXCEEDED");
});

test("drill evidence records duration, source set, RPO freshness, and result outside protected databases", () => {
  const { manifest } = createRecoveryFixture();
  const evidence = createDrillEvidence(manifest, {
    drillType: "monthly-isolated",
    startedAt: "2026-09-23T10:10:00.000Z",
    completedAt: "2026-09-23T10:37:30.000Z",
    result: "SUCCESS",
    evidencePath: "/operations-backups/evidence/drills/drill-1.json",
  });
  assert.equal(evidence.duration_seconds, 1650);
  assert.equal(evidence.rto_met, true);
  assert.equal(evidence.rpo_met, true);
  assert.equal(evidence.result, "SUCCESS");
  assert.equal(evidence.recovery_point_id, manifest.recovery_point_id);
  assert.equal(evidence.restored_source_set.length, 6);
  assert.equal(evidence.evidence_location, "OUTSIDE_PROTECTED_DATABASES");
});

test("full drills lock every restorable service image to the recorded registry digest", () => {
  const { point } = createRecoveryFixture();
  const output = execFileSync(process.execPath, [
    new URL("../scripts/recovery/recovery-cli.mjs", import.meta.url).pathname,
    "image-env",
    point,
  ], { encoding: "utf8" });
  for (const key of ["PANEL_IMAGE", "WAREHOUSE_IMAGE", "KIT_STUDIO_IMAGE", "CUSTOMER_HUB_IMAGE", "LABEL_PRINTER_IMAGE"]) {
    assert.match(output, new RegExp(`^${key}=registry\\.invalid/.+@sha256:${"a".repeat(64)}$`, "m"));
  }
});

test("V2-16 source-set contract closes the supplied O/P/W/K/L bases", () => {
  const sourceSet = JSON.parse(fs.readFileSync(new URL("../config/v2-16-source-set.json", import.meta.url), "utf8"));
  const revisions = Object.fromEntries(sourceSet.repositories.map(({ id, revision }) => [id, revision]));
  assert.equal(sourceSet.release, "V2-16");
  assert.deepEqual(Object.fromEntries(["O", "P", "W", "K", "L"].map((id) => [id, revisions[id]])), {
    O: "db02c99a87f0d241fefd1be8fa33d21b082deda6",
    P: "61ed1ad8fba25ed9d5c0b228308ff22da45febaf",
    W: "525e18c508c1191c0c4e4b725bda00defd930d2f",
    K: "0e0717c3f8d3f3f0af186b4c165524bc2e81724c",
    L: "add3987e0eb15e8742ecac490b5eb4e78b620ce5",
  });
  assert.equal(revisions.HUB, "f030c29b6ee41765289993fda1e94d1e484b5cac");
});

test("source-set verification permits only the O closure controller to descend from pinned O content", () => {
  const root = new URL("..", import.meta.url).pathname;
  const head = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const parent = execFileSync("git", ["-C", root, "rev-parse", "HEAD^"], { encoding: "utf8" }).trim();
  const directory = temporaryDirectory();
  const manifestPath = path.join(directory, "source-set.json");
  const entries = ["O", "P", "W", "K", "L", "HUB"].map((id) => ({
    id,
    repository: "agungor189/dsdst-operations",
    contextEnv: `${id}_V216_TEST_CONTEXT`,
    revision: id === "O" ? parent : head,
  }));
  fs.writeFileSync(manifestPath, JSON.stringify({ schemaVersion: "dsdst.test-source-set.v1", release: "V2-16", repositories: entries }));
  const environment = { ...process.env, EXPECTED_SOURCE_SET_RELEASE: "V2-16", SOURCE_SET_MANIFEST: manifestPath };
  for (const id of ["O", "P", "W", "K", "L", "HUB"]) environment[`${id}_V216_TEST_CONTEXT`] = root;
  const output = execFileSync(process.execPath, [
    path.join(root, "scripts/verify-source-set.mjs"),
    "--allow-dirty",
    "--allow-operations-descendant",
  ], { encoding: "utf8", env: environment });
  const observed = JSON.parse(output).repositories.find((entry) => entry.id === "O");
  assert.equal(observed.revision, parent);
  assert.equal(observed.controller_revision, head);
});
