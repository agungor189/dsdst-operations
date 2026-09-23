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
  finalizeRecoveryPoint,
  planRetention,
  promoteFinalRecoveryManifest,
  retentionOffsiteConfigFingerprint,
  retentionOffsiteLocation,
  restoreRecoveryPoint,
  signRecoveryManifest,
  stageFinalRecoveryManifest,
  validateRestoreTarget,
  verifyRecoveryPoint,
} from "../scripts/recovery/recovery-lib.mjs";
import { onlineBackup } from "../scripts/recovery/sqlite-online-backup.mjs";

const tempDirs = [];
const MANIFEST_KEY = "fixture-manifest-authentication-key-material-32-bytes-minimum";
const MANIFEST_KEY_ID = "fixture-v1";
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

function createRecoveryFixture({ createdAt = "2026-09-23T10:00:00.000Z", sourceSet = null } = {}) {
  const point = path.join(temporaryDirectory(), "rp-20260923T100000Z-fixture");
  const selectedSourceSet = sourceSet || JSON.parse(fs.readFileSync(new URL("../config/v2-16-source-set.json", import.meta.url), "utf8"));
  const revisions = Object.fromEntries(selectedSourceSet.repositories.map(({ id, revision }) => [id, revision]));
  createDatabase(path.join(point, "payload/panel/database.sqlite"), 67, 4);
  createDatabase(path.join(point, "payload/kit/database.sqlite"), 10, 3);
  createDatabase(path.join(point, "payload/customer-hub/database.sqlite"), 5, 2);
  createArchive(path.join(point, "payload/panel/uploads.tar.gz"), { "products/a.txt": "panel" });
  createArchive(path.join(point, "payload/kit/uploads.tar.gz"), { "designs/a.txt": "kit" });
  createArchive(path.join(point, "payload/label/state.tar.gz"), { "app-state.json": JSON.stringify({ version: 3, revision: 9, templates: [] }) });
  createArchive(path.join(point, "payload/customer-hub/attachments.tar.gz"), { "2026/a.txt": "hub" });
  fs.mkdirSync(path.join(point, "provenance"), { recursive: true });
  fs.writeFileSync(path.join(point, "provenance/source-set.json"), JSON.stringify(selectedSourceSet));
  fs.writeFileSync(path.join(point, "provenance/source-set-observation.json"), JSON.stringify({
    schemaVersion: "dsdst.test-source-set.v1",
    repositories: selectedSourceSet.repositories.map(({ id, repository, revision, role }) => ({ id, repository, revision, role: role || "release-source" })),
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
    manifestKey: MANIFEST_KEY,
    manifestKeyId: MANIFEST_KEY_ID,
  });
  return { point, manifest };
}

function finalizeRecoveryFixture(fixture) {
  const candidatePath = path.join(fixture.point, ".manifest.final.json");
  stageFinalRecoveryManifest(fixture.point, candidatePath, {
    manifestKey: MANIFEST_KEY,
    manifestKeyId: MANIFEST_KEY_ID,
    persistedAt: "2026-09-23T10:04:00.000Z",
    remoteRoot: "fixture-r2:production/recovery-points/rp-20260923T100000Z-fixture",
    configFingerprint: `sha256:${"9".repeat(64)}`,
    payload: {
      path: "fixture-r2:production/recovery-points/rp-20260923T100000Z-fixture/payload.tar.gz.enc",
      sha256: "f".repeat(64),
      sizeBytes: 123,
    },
    integrityEvidence: {
      path: "fixture-r2:production/recovery-points/rp-20260923T100000Z-fixture/manifest.json.enc",
      remoteHashVerified: true,
    },
  });
  promoteFinalRecoveryManifest(fixture.point, candidatePath, { manifestKey: MANIFEST_KEY });
  return finalizeRecoveryPoint(fixture.point, candidatePath, { manifestKey: MANIFEST_KEY });
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
  assert.equal(manifest.integrity.algorithm, "HMAC-SHA256");
  assert.equal(manifest.integrity.key_id, MANIFEST_KEY_ID);
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
  assert.equal(verifyRecoveryPoint(point, { manifestKey: MANIFEST_KEY }).verification.state, "VERIFIED");
});

test("exact V2-18 source-set recovery points build and verify while unsupported or altered sets fail closed", () => {
  const v218 = JSON.parse(fs.readFileSync(new URL("../config/v2-18-source-set.json", import.meta.url), "utf8"));
  const recoveryCli = new URL("../scripts/recovery/recovery-cli.mjs", import.meta.url).pathname;
  const v216Path = new URL("../config/v2-16-source-set.json", import.meta.url).pathname;
  const v218Path = new URL("../config/v2-18-source-set.json", import.meta.url).pathname;
  assert.equal(execFileSync(process.execPath, [recoveryCli, "source-set-release", v216Path], {encoding: "utf8"}).trim(), "V2-16");
  assert.equal(execFileSync(process.execPath, [recoveryCli, "source-set-release", v218Path], {encoding: "utf8"}).trim(), "V2-18");
  assert.match(fs.readFileSync(new URL("../scripts/backup.sh", import.meta.url), "utf8"), /SOURCE_SET_RELEASE=.*source-set-release/);
  const fixture = createRecoveryFixture({ sourceSet: v218 });
  assert.equal(fixture.manifest.provenance.source_set.release, "V2-18");
  assert.equal(verifyRecoveryPoint(fixture.point, { manifestKey: MANIFEST_KEY }).provenance.source_set.release, "V2-18");

  const altered = structuredClone(v218);
  altered.repositories.find(({ id }) => id === "P").revision = "f".repeat(40);
  assert.throws(() => createRecoveryFixture({ sourceSet: altered }), /exact|source-set|revision|V2-18/i);

  const unsupported = structuredClone(v218);
  unsupported.release = "V2-19";
  assert.throws(() => createRecoveryFixture({ sourceSet: unsupported }), /unsupported|source-set|V2-19/i);
});

test("corruption and missing required components are rejected closed", () => {
  const corrupted = createRecoveryFixture();
  fs.appendFileSync(path.join(corrupted.point, "payload/kit/database.sqlite"), "corrupt");
  assert.throws(() => verifyRecoveryPoint(corrupted.point, { manifestKey: MANIFEST_KEY }), /hash mismatch/i);

  const missing = createRecoveryFixture();
  fs.rmSync(path.join(missing.point, "payload/label/state.tar.gz"));
  assert.throws(() => verifyRecoveryPoint(missing.point, { manifestKey: MANIFEST_KEY }), /missing component/i);
});

test("offsite persistence never produces SUCCESS before atomic final verification", () => {
  const { manifest } = createRecoveryFixture();
  const failed = applyOffsiteResult(manifest, { enabled: true, state: "FAILED", error: "rclone unavailable" });
  assert.equal(failed.verification.state, "VERIFIED");
  assert.equal(failed.offsite.state, "FAILED");
  assert.equal(failed.status, "FAILED");
  const persisted = applyOffsiteResult(manifest, {
    enabled: true,
    state: "PERSISTED",
    persistedAt: "2026-09-23T10:04:00.000Z",
    remoteRoot: "r2:recovery/rp",
    payload: { path: "r2:recovery/rp/payload.tar.gz.enc", sha256: "f".repeat(64), sizeBytes: 123 },
    integrityEvidence: { path: "r2:recovery/rp/manifest.json.enc", remoteHashVerified: true },
  });
  assert.equal(persisted.status, "INCOMPLETE");
});

test("crash or failed final verification leaves the canonical recovery point INCOMPLETE", () => {
  const fixture = createRecoveryFixture();
  const candidatePath = path.join(fixture.point, ".manifest.final.json");
  stageFinalRecoveryManifest(fixture.point, candidatePath, {
    manifestKey: MANIFEST_KEY,
    manifestKeyId: MANIFEST_KEY_ID,
    persistedAt: "2026-09-23T10:04:00.000Z",
    remoteRoot: "r2:production/recovery-points/rp-20260923T100000Z-fixture",
    configFingerprint: `sha256:${"8".repeat(64)}`,
    payload: { path: "r2:production/recovery-points/rp-20260923T100000Z-fixture/payload.tar.gz.enc", sha256: "f".repeat(64), sizeBytes: 123 },
    integrityEvidence: { path: "r2:production/recovery-points/rp-20260923T100000Z-fixture/manifest.json.enc", remoteHashVerified: true },
  });
  assert.equal(JSON.parse(fs.readFileSync(path.join(fixture.point, "manifest.json"), "utf8")).status, "INCOMPLETE");
  assert.equal(JSON.parse(fs.readFileSync(candidatePath, "utf8")).status, "INCOMPLETE");
  promoteFinalRecoveryManifest(fixture.point, candidatePath, { manifestKey: MANIFEST_KEY });
  assert.equal(JSON.parse(fs.readFileSync(candidatePath, "utf8")).status, "SUCCESS");
  fs.appendFileSync(path.join(fixture.point, "payload/panel/uploads.tar.gz"), "changed-after-upload");
  assert.throws(() => finalizeRecoveryPoint(fixture.point, candidatePath, { manifestKey: MANIFEST_KEY }), /hash mismatch/i);
  assert.equal(JSON.parse(fs.readFileSync(path.join(fixture.point, "manifest.json"), "utf8")).status, "INCOMPLETE");
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
  assert.match(offsiteScript, /stage-offsite-final/);
  assert.match(offsiteScript, /promote-offsite-final/);
  assert.match(offsiteScript, /finalize/);
  assert.doesNotMatch(offsiteScript, /rclone copyto "\$POINT/);
});

test("GFS retention keeps 48h hourly, 30d daily, 12w weekly, 12m monthly and the last known-good", () => {
  const now = new Date("2026-09-23T12:30:00.000Z");
  const points = [];
  for (let hours = 0; hours < 24 * 400; hours += 1) {
    const createdAt = new Date(now.getTime() - hours * 3_600_000).toISOString();
    points.push({ id: `rp-${hours}`, created_at: createdAt, status: "SUCCESS", verification: { state: "VERIFIED" }, offsite: { state: "PERSISTED" } });
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

  const onlyGood = [{ id: "last-good", created_at: "2020-01-01T00:00:00.000Z", status: "SUCCESS", verification: { state: "VERIFIED" }, offsite: { state: "PERSISTED" } }];
  assert.deepEqual(planRetention(onlyGood, now).delete, []);
});

test("retention uses only the point's authenticated exact offsite location", () => {
  const fixture = createRecoveryFixture();
  finalizeRecoveryFixture(fixture);
  assert.equal(
    retentionOffsiteLocation(fixture.point, { manifestKey: MANIFEST_KEY }),
    "fixture-r2:production/recovery-points/rp-20260923T100000Z-fixture",
  );
  assert.equal(retentionOffsiteConfigFingerprint(fixture.point, { manifestKey: MANIFEST_KEY }), `sha256:${"9".repeat(64)}`);
  const manifest = JSON.parse(fs.readFileSync(path.join(fixture.point, "manifest.json"), "utf8"));
  manifest.offsite.location = "changed-r2:other/location";
  fs.writeFileSync(path.join(fixture.point, "manifest.json"), JSON.stringify(manifest));
  assert.throws(() => retentionOffsiteLocation(fixture.point, { manifestKey: MANIFEST_KEY }), /integrity/i);
  const retentionScript = fs.readFileSync(new URL("../scripts/recovery/apply-retention.sh", import.meta.url), "utf8");
  assert.match(retentionScript, /retention-offsite-location/);
  assert.match(retentionScript, /retention-offsite-config-fingerprint/);
  assert.doesNotMatch(retentionScript, /RECOVERY_OFFSITE_RCLONE_REMOTE|CLOUD_BACKUP_RCLONE_REMOTE|RECOVERY_OFFSITE_PREFIX/);
});

test("restore defaults to accepted SUCCESS/VERIFIED/PERSISTED points and local-only recovery is explicit", () => {
  const fixture = createRecoveryFixture();
  const { point } = fixture;
  const root = temporaryDirectory();
  const production = path.join(root, "production");
  const isolated = path.join(root, "isolated", "run-1");
  fs.mkdirSync(production, { recursive: true });
  assert.throws(() => validateRestoreTarget(production, [production]), /production/i);
  assert.throws(() => validateRestoreTarget(path.join(production, "child"), [production]), /production/i);
  assert.throws(() => restoreRecoveryPoint(point, isolated, { productionPaths: [production], manifestKey: MANIFEST_KEY }), /accepted|SUCCESS|offsite/i);
  const failedFixture = createRecoveryFixture();
  const failedManifest = signRecoveryManifest(applyOffsiteResult(failedFixture.manifest, {
    enabled: true, state: "FAILED", error: "remote unavailable",
  }), { manifestKey: MANIFEST_KEY, manifestKeyId: MANIFEST_KEY_ID });
  fs.writeFileSync(path.join(failedFixture.point, "manifest.json"), `${JSON.stringify(failedManifest)}\n`);
  assert.throws(() => restoreRecoveryPoint(failedFixture.point, path.join(root, "isolated", "failed"), {
    productionPaths: [production], manifestKey: MANIFEST_KEY,
  }), /accepted|SUCCESS|offsite/i);
  const localOnly = path.join(root, "isolated", "local-only");
  assert.equal(restoreRecoveryPoint(point, localOnly, {
    productionPaths: [production], manifestKey: MANIFEST_KEY, allowLocalOnly: true,
  }).state, "VERIFIED_LOCAL_ONLY");
  finalizeRecoveryFixture(fixture);
  const result = restoreRecoveryPoint(point, isolated, { productionPaths: [production], manifestKey: MANIFEST_KEY });
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

test("manifest tampering is rejected by verification, restore, and offsite fetch", () => {
  const fixture = createRecoveryFixture();
  finalizeRecoveryFixture(fixture);
  const manifestPath = path.join(fixture.point, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  manifest.completed_at = "2026-09-23T10:03:00.000Z";
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  assert.throws(() => verifyRecoveryPoint(fixture.point, { manifestKey: MANIFEST_KEY }), /integrity/i);
  assert.throws(() => restoreRecoveryPoint(fixture.point, path.join(temporaryDirectory(), "restore"), { manifestKey: MANIFEST_KEY }), /integrity/i);
  const fetchScript = fs.readFileSync(new URL("../scripts/fetch-offsite-recovery.sh", import.meta.url), "utf8");
  assert.match(fetchScript, /verify-manifest-file/);
  assert.match(fetchScript, /RECOVERY_MANIFEST_HMAC_KEY/);
});

test("provenance or schema incompatibility is rejected", () => {
  const sourceMismatch = createRecoveryFixture();
  const runtimePath = path.join(sourceMismatch.point, "provenance/runtime.json");
  const runtime = JSON.parse(fs.readFileSync(runtimePath, "utf8"));
  runtime.services.find((service) => service.service_id === "dsdst-kit-studio").revision = "9".repeat(40);
  fs.writeFileSync(runtimePath, JSON.stringify(runtime));
  assert.throws(() => buildRecoveryManifest(sourceMismatch.point, {
    recoveryPointId: "rp-mismatch", createdAt: "2026-09-23T10:00:00.000Z", completedAt: "2026-09-23T10:02:00.000Z", offsiteEnabled: false,
    manifestKey: MANIFEST_KEY, manifestKeyId: MANIFEST_KEY_ID,
  }), /revision mismatch/i);

  const schemaMismatch = createRecoveryFixture();
  const schemaRuntimePath = path.join(schemaMismatch.point, "provenance/runtime.json");
  const schemaRuntime = JSON.parse(fs.readFileSync(schemaRuntimePath, "utf8"));
  schemaRuntime.services.find((service) => service.service_id === "dsdst-panel").schema.version = "66";
  fs.writeFileSync(schemaRuntimePath, JSON.stringify(schemaRuntime));
  assert.throws(() => buildRecoveryManifest(schemaMismatch.point, {
    recoveryPointId: "rp-schema-mismatch", createdAt: "2026-09-23T10:00:00.000Z", completedAt: "2026-09-23T10:02:00.000Z", offsiteEnabled: false,
    manifestKey: MANIFEST_KEY, manifestKeyId: MANIFEST_KEY_ID,
  }), /schema mismatch/i);
});

test("RPO older than 60 minutes is unhealthy", () => {
  const now = new Date("2026-09-23T12:00:00.000Z");
  const accepted = { status: "SUCCESS", verification: { state: "VERIFIED" }, offsite: { state: "PERSISTED" } };
  assert.equal(calculateRecoveryHealth([{ ...accepted, created_at: "2026-09-23T11:01:00.000Z" }], now).healthy, true);
  const stale = calculateRecoveryHealth([{ ...accepted, created_at: "2026-09-23T10:59:59.000Z" }], now);
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
  assert.deepEqual(evidence.target_misses, []);
});

test("drill evidence fails closed and records explicit RPO/RTO target misses", () => {
  const { manifest } = createRecoveryFixture();
  const stale = createDrillEvidence(manifest, {
    drillType: "monthly-isolated",
    startedAt: "2026-09-23T12:10:01.000Z",
    completedAt: "2026-09-23T13:10:02.000Z",
    result: "SUCCESS",
    evidencePath: "/operations-backups/evidence/drills/drill-target-miss.json",
  });
  assert.equal(stale.rpo_met, false);
  assert.equal(stale.rto_met, false);
  assert.equal(stale.result, "FAILED");
  assert.deepEqual(stale.target_misses.map((miss) => miss.target).sort(), ["RPO", "RTO"]);
});

test("drill evidence cannot report SUCCESS after restore, health, or smoke failure", () => {
  const { manifest } = createRecoveryFixture();
  for (const failureStage of ["RESTORE", "HEALTH", "SMOKE"]) {
    const evidence = createDrillEvidence(manifest, {
      drillType: "monthly-service-level",
      startedAt: "2026-09-23T10:10:00.000Z",
      completedAt: "2026-09-23T10:20:00.000Z",
      result: "SUCCESS",
      failureStage,
      error: `${failureStage} failed`,
      evidencePath: `/operations-backups/evidence/drills/${failureStage}.json`,
    });
    assert.equal(evidence.result, "FAILED");
    assert.ok(evidence.target_misses.some((miss) => miss.target === failureStage));
  }
});

test("monthly drill always boots the isolated stack, checks health, runs read-only smoke, and tears down", () => {
  const drillScript = fs.readFileSync(new URL("../scripts/restore-drill.sh", import.meta.url), "utf8");
  const recoveryCompose = fs.readFileSync(new URL("../compose.recovery.yml", import.meta.url), "utf8");
  assert.match(drillScript, /docker compose[\s\S]*up -d --no-build --wait/);
  assert.match(drillScript, /run_read_only_smoke/);
  assert.match(drillScript, /down --volumes --remove-orphans/);
  assert.match(recoveryCompose, /ports: !reset \[\]/g);
  assert.match(recoveryCompose, /internal: true/g);
  assert.match(recoveryCompose, /WAREHOUSE_PRINT_DRY_RUN: "true"/);
  assert.match(recoveryCompose, /MOCK_ADAPTERS_ENABLED: "true"/);
});

test("full drills lock every restorable service image to the recorded registry digest", () => {
  const fixture = createRecoveryFixture();
  finalizeRecoveryFixture(fixture);
  const { point } = fixture;
  const output = execFileSync(process.execPath, [
    new URL("../scripts/recovery/recovery-cli.mjs", import.meta.url).pathname,
    "image-env",
    point,
  ], { encoding: "utf8", env: { ...process.env, RECOVERY_MANIFEST_HMAC_KEY: MANIFEST_KEY } });
  for (const key of ["PANEL_IMAGE", "WAREHOUSE_IMAGE", "KIT_STUDIO_IMAGE", "CUSTOMER_HUB_IMAGE", "LABEL_PRINTER_IMAGE"]) {
    assert.match(output, new RegExp(`^${key}=registry\\.invalid/.+@sha256:${"a".repeat(64)}$`, "m"));
  }
});

test("V2-16 source-set pins the implementation content commit over the supplied O/P/W/K/L bases", () => {
  const sourceSet = JSON.parse(fs.readFileSync(new URL("../config/v2-16-source-set.json", import.meta.url), "utf8"));
  const revisions = Object.fromEntries(sourceSet.repositories.map(({ id, revision }) => [id, revision]));
  assert.equal(sourceSet.release, "V2-16");
  assert.deepEqual(Object.fromEntries(["O", "P", "W", "K", "L"].map((id) => [id, revisions[id]])), {
    O: "3547b73951d0ac0781eedff538fa4bbb2e4fc204",
    P: "61ed1ad8fba25ed9d5c0b228308ff22da45febaf",
    W: "525e18c508c1191c0c4e4b725bda00defd930d2f",
    K: "0e0717c3f8d3f3f0af186b4c165524bc2e81724c",
    L: "add3987e0eb15e8742ecac490b5eb4e78b620ce5",
  });
  assert.equal(revisions.HUB, "f030c29b6ee41765289993fda1e94d1e484b5cac");
  assert.deepEqual(sourceSet.basedOn, {
    release: "V2-15",
    sourceSet: "config/v2-15-source-set.json",
    operationsClosureRevision: "db02c99a87f0d241fefd1be8fa33d21b082deda6",
  });
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
