import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  appendReleaseEvent,
  buildReleaseReport,
  createEvidenceDigest,
  createRouteOperationId,
  prepareRelease,
  readReleaseJournal,
} from "../scripts/release/release-lib.mjs";
import {createRuntimeCaptureId} from "../scripts/validate-release-evidence.mjs";
import {reconcileRouteOperation} from "../scripts/release/route-reconcile.mjs";

const OLD_RUNTIME = `runtime-${"a".repeat(64)}`;

const SOURCE_REVISIONS = {
  O: "05494350af247e3bb31cc87bfdbe0dcfe303348f",
  P: "61ed1ad8fba25ed9d5c0b228308ff22da45febaf",
  W: "525e18c508c1191c0c4e4b725bda00defd930d2f",
  K: "0e0717c3f8d3f3f0af186b4c165524bc2e81724c",
  L: "add3987e0eb15e8742ecac490b5eb4e78b620ce5",
  HUB: "f030c29b6ee41765289993fda1e94d1e484b5cac",
};

const SERVICE_COMPONENTS = {
  "dsdst-panel": "P",
  "dsdst-warehouse": "W",
  "dsdst-kit-studio": "K",
  "dsdst-customer-hub": "HUB",
  "label-printer": "L",
  "warehouse-label-renderer": "L",
};

const tempDirectories = [];
test.after(() => {
  for (const directory of tempDirectories) fs.rmSync(directory, {recursive: true, force: true});
});

function tempJournal() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dsdst-v2-17-"));
  tempDirectories.push(directory);
  return path.join(directory, "release.ndjson");
}

function v218LegacyOldRuntime() {
  const volumes = {
    panel: `sha256:${"7".repeat(64)}`,
    kit: `sha256:${"8".repeat(64)}`,
    hub: `sha256:${"9".repeat(64)}`,
    label: `sha256:${"a".repeat(64)}`,
  };

  const services = [
    {
      service_id: "dsdst-panel",
      container_id: "1".repeat(64),
      image_id: `sha256:${"b".repeat(64)}`,
      mounts: [{target: "/data", mode: "rw", type: "volume", source_id: volumes.panel}],
    },
    {
      service_id: "dsdst-warehouse",
      container_id: "2".repeat(64),
      image_id: `sha256:${"c".repeat(64)}`,
      mounts: [],
    },
    {
      service_id: "dsdst-kit-studio",
      container_id: "3".repeat(64),
      image_id: `sha256:${"d".repeat(64)}`,
      mounts: [{target: "/data", mode: "rw", type: "volume", source_id: volumes.kit}],
    },
    {
      service_id: "dsdst-customer-hub",
      container_id: "4".repeat(64),
      image_id: `sha256:${"e".repeat(64)}`,
      mounts: [{target: "/data", mode: "rw", type: "volume", source_id: volumes.hub}],
    },
    {
      service_id: "label-printer",
      container_id: "5".repeat(64),
      image_id: `sha256:${"f".repeat(64)}`,
      mounts: [{target: "/app/data", mode: "rw", type: "volume", source_id: volumes.label}],
    },
    {
      service_id: "warehouse-label-renderer",
      container_id: "6".repeat(64),
      image_id: `sha256:${"f".repeat(64)}`,
      mounts: [{target: "/app/data", mode: "ro", type: "volume", source_id: volumes.label}],
    },
  ];

  const body = {
    kind: "legacy-bootstrap-runtime",
    bootstrap_id: "bootstrap-v2-18-fixture",
    captured_at: "2026-09-23T11:55:00.000Z",
    source_provenance_state: "UNVERIFIED_LEGACY",
    source_revision_claimed: false,
    services,
  };

  const evidence_digest = createEvidenceDigest(body);

  return {
    project: "dsdst-production",
    runtime_identity: `legacy-runtime-${evidence_digest.slice("sha256:".length)}`,
    route_target: "http://127.0.0.1:3000",
    volume_ids: Object.values(volumes),
    identity_evidence: {...body, evidence_digest},
  };
}

function releasePlan(overrides = {}) {
  const preparedAt = "2026-09-23T12:00:00.000Z";
  const imageDigits = ["1", "2", "3", "4", "5", "5"];
  const idDigits = ["7", "8", "9", "a", "b", "b"];
  const configDigits = ["2", "3", "4", "5", "6", "6"];
  const services = Object.entries(SERVICE_COMPONENTS).map(([service_id, component], index) => ({
    service_id,
    component,
    repository: component === "HUB" ? "agungor189/dsdst-customer-hub" : component === "P" ? "agungor189/panel-kit-yonetimi" : component === "W" ? "agungor189/Dsdst-Warehouse" : component === "K" ? "agungor189/dsdst-kit-studio" : "agungor189/Label-Printer",
    source_revision: SOURCE_REVISIONS[component],
    image_reference: `registry.invalid/${service_id}@sha256:${imageDigits[index].repeat(64)}`,
    image_digest: `sha256:${imageDigits[index].repeat(64)}`,
    image_id: `sha256:${idDigits[index].repeat(64)}`,
    config_fingerprint: `sha256:${configDigits[index].repeat(64)}`,
  }));
  services.at(-1).image_reference = services.at(-2).image_reference;
  services.at(-1).image_digest = services.at(-2).image_digest;
  services.at(-1).image_id = services.at(-2).image_id;
  services.at(-1).config_fingerprint = services.at(-2).config_fingerprint;
  return {
    release_id: "v2-17-20260923t120000z",
    release: "V2-17",
    prepared_at: preparedAt,
    recovery_max_age_seconds: 3600,
    source_set: {
      release: "V2-17",
      repositories: Object.entries(SOURCE_REVISIONS).map(([id, revision]) => ({id, revision})),
    },
    accepted_v2_16_source_set: {
      release: "V2-16",
      operations_content_revision: "3547b73951d0ac0781eedff538fa4bbb2e4fc204",
      operations_closure_revision: "e64142f18eb6a2c3fe7c0f084a393c0871c76ee6",
      repositories: Object.entries({...SOURCE_REVISIONS, O: "3547b73951d0ac0781eedff538fa4bbb2e4fc204"}).map(([id, revision]) => ({id, revision})),
    },
    services,
    recovery_point: {
      recovery_point_id: "rp-v2-16-fixture",
      created_at: "2026-09-23T11:30:00.000Z",
      status: "SUCCESS",
      verification_state: "VERIFIED",
      offsite_state: "PERSISTED",
      restored_drill_state: "VERIFIED",
      source_release: "V2-16",
      source_repositories: Object.entries({...SOURCE_REVISIONS, O: "3547b73951d0ac0781eedff538fa4bbb2e4fc204"}).map(([id, revision]) => ({id, revision})),
    },
    old_runtime: {
      project: "dsdst-production",
      runtime_identity: OLD_RUNTIME,
      route_target: "http://127.0.0.1:3000",
      volume_ids: ["old-panel", "old-kit", "old-label", "old-hub"],
    },
    candidate: {
      project: "dsdst-candidate-v2-17-20260923t120000z",
      route_target: "http://127.0.0.1:13000",
      host_bindings: ["127.0.0.1:13000", "127.0.0.1:13006", "127.0.0.1:13012", "127.0.0.1:13100", "127.0.0.1:13013"],
      volume_ids: ["candidate-panel", "candidate-kit", "candidate-label", "candidate-hub"],
    },
    route: {
      provider: "cloudflare",
      provenance_state: "VERIFIED",
      route_id_hash: `sha256:${"e".repeat(64)}`,
      current_target: "http://127.0.0.1:3000",
      cutover_command: "scripts/release/cloudflare-route.sh cutover <release-journal> <route-evidence>",
      rollback_command: "scripts/release/cloudflare-route.sh rollback <release-journal> <route-evidence>",
    },
    rollback: {retention_days: 7},
    ...overrides,
  };
}

function v218ReleasePlan(overrides = {}) {
  const plan = releasePlan();
  const v217 = JSON.parse(fs.readFileSync(new URL("../config/v2-17-source-set.json", import.meta.url), "utf8"));
  const v218 = JSON.parse(fs.readFileSync(new URL("../config/v2-18-source-set.json", import.meta.url), "utf8"));
  const v217Revisions = Object.fromEntries(v217.repositories.map(({id, revision}) => [id, revision]));
  const v218Revisions = Object.fromEntries(v218.repositories.map(({id, revision}) => [id, revision]));
  plan.release_id = "v2-18-20260923t120000z";
  plan.release = "V2-18";
  plan.source_set = {release: "V2-18", repositories: v218.repositories.map(({id, revision}) => ({id, revision}))};
  delete plan.accepted_v2_16_source_set;
  plan.accepted_v2_17_source_set = {
    release: "V2-17",
    operations_content_revision: v217Revisions.O,
    operations_closure_revision: v218.basedOn.operationsClosureRevision,
    repositories: v217.repositories.map(({id, revision}) => ({id, revision})),
  };
  for (const service of plan.services) service.source_revision = v218Revisions[service.component];
  plan.recovery_point = {
    ...plan.recovery_point,
    recovery_point_id: "rp-v2-18-fixture",
    source_release: "V2-18",
    source_repositories: v218.repositories.map(({id, revision}) => ({id, revision})),
  };
  plan.candidate.project = "dsdst-candidate-v2-18-20260923t120000z";
  plan.old_runtime = v218LegacyOldRuntime();
  return {...plan, ...overrides};
}

function append(journal, type, payload, occurredAt) {
  return appendReleaseEvent(journal, {type, occurred_at: occurredAt, payload});
}

function approvalPayload(planHash) {
  return {approved_by: "operator-17", approval_id: "approval-17", plan_hash: planHash, manual: true};
}

function preflightPayload(plan = releasePlan()) {
  return {
    backup_id: plan.recovery_point.recovery_point_id,
    recovery_health: "PASS",
    source_set_check: "PASS",
    image_provenance_check: "PASS",
    secret_config_check: "PASS",
    migration: {status: "PASS", candidate_db_touched: false, migrations: ["panel:81->81", "kit:10->10", "hub:5->5"]},
  };
}

function candidatePayload(plan = releasePlan()) {
  const volumeByService = {
    "dsdst-panel": ["candidate-panel"],
    "dsdst-warehouse": [],
    "dsdst-kit-studio": ["candidate-kit"],
    "dsdst-customer-hub": ["candidate-hub"],
    "label-printer": ["candidate-label"],
    "warehouse-label-renderer": ["candidate-label"],
  };
  const capturedAt = "2026-09-23T12:03:00.000Z";
  const records = plan.services.map((service, index) => ({
    capture_id: "runtime-pending",
    service_id: service.service_id,
    container_id: String(index + 1).repeat(64),
    source_repository: service.repository,
    revision: service.source_revision,
    declared_image_reference: service.image_reference,
    image_digest: service.image_digest,
    image_id: service.image_id,
    configuration: {status: "VERIFIED", redacted: true, fingerprint: service.config_fingerprint},
    volumes: volumeByService[service.service_id].map((source_id) => ({source_id})),
    ports: service.service_id === "warehouse-label-renderer" ? [{exposure: "internal"}] : [{
      exposure: "published",
      host_ip: "127.0.0.1",
      host_port: Number(plan.candidate.host_bindings[index > 4 ? 4 : index].split(":")[1]),
    }],
  }));
  const captureId = createRuntimeCaptureId(capturedAt, records);
  records.forEach((record) => { record.capture_id = captureId; });
  return {
    project: plan.candidate.project,
    runtime_identity: captureId,
    volume_ids: ["candidate-panel", "candidate-kit", "candidate-label", "candidate-hub"],
    host_bindings: ["127.0.0.1:13000", "127.0.0.1:13006", "127.0.0.1:13012", "127.0.0.1:13100", "127.0.0.1:13013"],
    hydration: {
      status: "PASS",
      backup_id: plan.recovery_point.recovery_point_id,
      source_isolated_restore: true,
      old_volume_mounted: false,
      migrations_ran: ["panel:81->81", "kit:10->10", "hub:5->5"],
    },
    runtime_provenance: {
      collector: "dsdst-read-only-runtime-collector-v1",
      capture_id: captureId,
      captured_at: capturedAt,
      services: records,
    },
  };
}

function verificationPayload(overrides = {}, plan = releasePlan()) {
  const runtimeIdentity = candidatePayload(plan).runtime_identity;
  return {
    critical_services: Object.keys(SERVICE_COMPONENTS).map((service_id) => ({service_id, status: "PASS"})),
    smoke: {status: "PASS", mode: "READ_ONLY"},
    connectivity: {status: "PASS", checks: ["W->P", "K->P", "L->P", "P->renderer", "Hub->P"]},
    runtime_identity: runtimeIdentity,
    provenance_check: "PASS",
    ...overrides,
  };
}

function advanceToVerified(journal, plan = releasePlan()) {
  const prepared = prepareRelease(journal, plan);
  append(journal, "APPROVE", approvalPayload(prepared.plan_hash), "2026-09-23T12:01:00.000Z");
  append(journal, "PREFLIGHT_PASS", preflightPayload(plan), "2026-09-23T12:02:00.000Z");
  append(journal, "CANDIDATE_UP", candidatePayload(plan), "2026-09-23T12:03:00.000Z");
  append(journal, "VERIFY", verificationPayload({}, plan), "2026-09-23T12:04:00.000Z");
}

function freezePayload(overrides = {}, plan = releasePlan()) {
  const body = {
    action: "freeze-writes",
    freeze_token: "freeze-runtime-0001",
    freeze_started_at: "2026-09-23T12:05:00.000Z",
    runtime_identity: plan.old_runtime.runtime_identity,
    source_data_watermark: "canonical-write-1042",
    write_state: "FROZEN",
    ...overrides,
  };
  return {runtime_adapter: "dsdst-runtime-switch-v1", adapter_evidence: {...body, evidence_digest: createEvidenceDigest(body)}};
}

function finalConvergencePayload(overrides = {}, plan = releasePlan()) {
  const components = [
    ["P_DB", "sqlite", "online-sqlite-backup", "1"],
    ["P_UPLOADS", "files", "frozen-filesystem-snapshot", "2"],
    ["K_DB", "sqlite", "online-sqlite-backup", "3"],
    ["K_UPLOADS", "files", "frozen-filesystem-snapshot", "4"],
    ["L_STATE", "files", "frozen-filesystem-snapshot", "5"],
    ["HUB_DB", "sqlite", "online-sqlite-backup", "6"],
    ["HUB_ATTACHMENTS", "files", "frozen-filesystem-snapshot", "7"],
  ].map(([authority, kind, capture_method, digit]) => ({authority, kind, capture_method, content_hash: `sha256:${digit.repeat(64)}`}));
  const snapshotBody = {snapshot_id: "cutover-snapshot-1042", created_at: "2026-09-23T12:05:20.000Z", source_data_watermark: "canonical-write-1042", status: "VERIFIED", components};
  const initial = candidatePayload(plan).runtime_provenance;
  const capturedAt = "2026-09-23T12:06:30.000Z";
  const records = structuredClone(initial.services);
  records.forEach((record) => { record.capture_id = "runtime-pending"; });
  const runtimeIdentity = createRuntimeCaptureId(capturedAt, records);
  records.forEach((record) => { record.capture_id = runtimeIdentity; });
  const migrations = ["panel:81->81", "kit:10->10", "hub:5->5"];
  return {
    freeze_token: "freeze-runtime-0001",
    final_snapshot: {...snapshotBody, manifest_hash: createEvidenceDigest(snapshotBody)},
    candidate_hydration: {status: "PASS", snapshot_id: "cutover-snapshot-1042", old_volume_mounted: false, completed_at: "2026-09-23T12:06:00.000Z", migrations_ran: migrations},
    final_candidate: {
      runtime_identity: runtimeIdentity,
      candidate_authoritative: false,
      runtime_provenance: {collector: "dsdst-read-only-runtime-collector-v1", capture_id: runtimeIdentity, captured_at: capturedAt, services: records},
      schema_provenance: {status: "VERIFIED", fingerprint: `sha256:${"8".repeat(64)}`, migrations},
      data_verification: {status: "PASS", source_data_watermark: "canonical-write-1042"},
      checks: {critical_services: Object.keys(SERVICE_COMPONENTS).map((service_id) => ({service_id, status: "PASS"})), smoke: {status: "PASS", mode: "READ_ONLY"}, connectivity: {status: "PASS", checks: ["W->P", "K->P", "L->P", "Hub->P"]}},
    },
    ...overrides,
  };
}

function advanceToConverged(journal, plan = releasePlan()) {
  advanceToVerified(journal, plan);
  append(journal, "FREEZE", freezePayload({}, plan), "2026-09-23T12:05:10.000Z");
  append(journal, "FINAL_CONVERGENCE", finalConvergencePayload({}, plan), "2026-09-23T12:06:40.000Z");
}

function routeIntentPayload(action, overrides = {}, plan = releasePlan()) {
  const rollback = action === "ROLLBACK";
  const body = {
    release_id: plan.release_id,
    action,
    expected_target: rollback ? plan.candidate.route_target : plan.old_runtime.route_target,
    desired_target: rollback ? plan.old_runtime.route_target : plan.candidate.route_target,
    old_runtime_identity: plan.old_runtime.runtime_identity,
    new_runtime_identity: finalConvergencePayload({}, plan).final_candidate.runtime_identity,
    freeze_token: "freeze-runtime-0001",
    final_snapshot_id: "cutover-snapshot-1042",
    started_at: rollback ? "2026-09-23T12:08:00.000Z" : "2026-09-23T12:05:00.000Z",
    deadline_at: rollback ? "2026-09-23T12:18:00.000Z" : "2026-09-23T12:15:00.000Z",
    candidate_write_watermark: "canonical-write-1042",
    rollback_safety: rollback ? zeroWriteSafety() : null,
    ...overrides,
  };
  return {...body, operation_id: createRouteOperationId(body)};
}

function routeObservation(intent, target, observedAt) {
  const body = {operation_id: intent.operation_id, provenance_state: "VERIFIED", current_target: target, observed_at: observedAt, operation_state: target === intent.desired_target ? "APPLIED" : "NOT_APPLIED", operation_applied_at: target === intent.desired_target ? observedAt : null};
  return {...body, evidence_digest: createEvidenceDigest(body)};
}

function authorityEvidence(intent, oldAuthoritative, candidateAuthoritative, plan = releasePlan()) {
  const body = {operation_id: intent.operation_id, old_runtime_identity: plan.old_runtime.runtime_identity, candidate_runtime_identity: finalConvergencePayload({}, plan).final_candidate.runtime_identity, old_authoritative: oldAuthoritative, candidate_authoritative: candidateAuthoritative};
  return {...body, evidence_digest: createEvidenceDigest(body)};
}

function cutoverPayload(intent, overrides = {}, plan = releasePlan()) {
  return {
    operation_id: intent.operation_id, explicit: true, approval_id: "approval-17", route_provenance_state: "VERIFIED",
    route_observation: routeObservation(intent, intent.desired_target, "2026-09-23T12:07:00.000Z"),
    authority_evidence: authorityEvidence(intent, false, true, plan),
    old_runtime_identity: plan.old_runtime.runtime_identity, new_runtime_identity: finalConvergencePayload({}, plan).final_candidate.runtime_identity,
    old_target: plan.old_runtime.route_target, new_target: plan.candidate.route_target,
    started_at: "2026-09-23T12:05:00.000Z", completed_at: "2026-09-23T12:07:00.000Z",
    old_stack_mode: "RETAINED_READ_ONLY_NOT_DATA_SAFE", freeze_token: "freeze-runtime-0001",
    final_snapshot_id: "cutover-snapshot-1042", candidate_write_watermark: "canonical-write-1042",
    ...overrides,
  };
}

function appendCutover(journal, plan = releasePlan()) {
  const intent = routeIntentPayload("CUTOVER", {}, plan);
  append(journal, "ROUTE_INTENT", intent, "2026-09-23T12:06:45.000Z");
  append(journal, "CUTOVER", cutoverPayload(intent, {}, plan), "2026-09-23T12:07:00.000Z");
  return intent;
}

function rollbackPayload(intent, overrides = {}, plan = releasePlan()) {
  return {
    operation_id: intent.operation_id, explicit: true, reason: "post-cutover health regression", route_provenance_state: "VERIFIED",
    route_observation: routeObservation(intent, intent.desired_target, "2026-09-23T12:10:00.000Z"),
    authority_evidence: authorityEvidence(intent, true, false, plan),
    from_runtime_identity: finalConvergencePayload({}, plan).final_candidate.runtime_identity, restored_runtime_identity: plan.old_runtime.runtime_identity,
    restored_target: plan.old_runtime.route_target, database_restore_used: false,
    started_at: intent.started_at, completed_at: "2026-09-23T12:10:00.000Z",
    rollback_safety: intent.rollback_safety,
    ...overrides,
  };
}

function zeroWriteSafety(overrides = {}) {
  return {mode: "ZERO_CANONICAL_WRITES", status: "VERIFIED", cutover_write_watermark: "canonical-write-1042", candidate_write_watermark: "canonical-write-1042", synchronization_id: null, target_write_watermark: "canonical-write-1042", preserves_candidate_writes: true, ...overrides};
}

function completionPayload(plan = releasePlan()) {
  const body = {action: "observe-candidate-write-watermark", runtime_identity: finalConvergencePayload({}, plan).final_candidate.runtime_identity, candidate_write_watermark: "canonical-write-1042", observed_at: "2026-09-23T12:07:30.000Z", status: "VERIFIED"};
  return {result: "SUCCESS", runtime_adapter: "dsdst-runtime-switch-v1", adapter_evidence: {...body, evidence_digest: createEvidenceDigest(body)}};
}

test("1. no approval blocks preflight and candidate release", () => {
  const journal = tempJournal();
  prepareRelease(journal, releasePlan());
  assert.throws(() => append(journal, "PREFLIGHT_PASS", preflightPayload(), "2026-09-23T12:02:00.000Z"), /APPROVED|approval/i);
});

test("2. stale or absent V2-16 recovery point is blocked", () => {
  assert.throws(() => prepareRelease(tempJournal(), releasePlan({recovery_point: undefined})), /recovery/i);
  const stale = releasePlan();
  stale.recovery_point.created_at = "2026-09-23T10:00:00.000Z";
  assert.throws(() => prepareRelease(tempJournal(), stale), /stale|fresh/i);
});

test("3. source or immutable image mismatch is blocked", () => {
  const mismatch = releasePlan();
  mismatch.services[0].source_revision = "f".repeat(40);
  assert.throws(() => prepareRelease(tempJournal(), mismatch), /source|revision/i);
  const mutable = releasePlan();
  mutable.services[0].image_reference = "registry.invalid/dsdst-panel:latest";
  assert.throws(() => prepareRelease(tempJournal(), mutable), /immutable|digest/i);
});

test("4. migration preflight failure is blocked before candidate DB touch", () => {
  const journal = tempJournal();
  const prepared = prepareRelease(journal, releasePlan());
  append(journal, "APPROVE", approvalPayload(prepared.plan_hash), "2026-09-23T12:01:00.000Z");
  const failed = preflightPayload();
  failed.migration.status = "FAIL";
  assert.throws(() => append(journal, "PREFLIGHT_PASS", failed, "2026-09-23T12:02:00.000Z"), /migration|preflight/i);
});

test("5. unhealthy critical candidate cannot cut over", () => {
  const journal = tempJournal();
  const prepared = prepareRelease(journal, releasePlan());
  append(journal, "APPROVE", approvalPayload(prepared.plan_hash), "2026-09-23T12:01:00.000Z");
  append(journal, "PREFLIGHT_PASS", preflightPayload(), "2026-09-23T12:02:00.000Z");
  append(journal, "CANDIDATE_UP", candidatePayload(), "2026-09-23T12:03:00.000Z");
  const verification = verificationPayload();
  verification.critical_services[0].status = "FAIL";
  assert.throws(() => append(journal, "VERIFY", verification, "2026-09-23T12:04:00.000Z"), /health|critical/i);
  assert.equal(readReleaseJournal(journal).state, "CANDIDATE_UP");
});

test("6. candidate cannot mount old production volumes", () => {
  const plan = releasePlan();
  plan.candidate.volume_ids[0] = plan.old_runtime.volume_ids[0];
  assert.throws(() => prepareRelease(tempJournal(), plan), /volume|production/i);
});

test("7. read-only smoke failure blocks verification and cutover", () => {
  const journal = tempJournal();
  const prepared = prepareRelease(journal, releasePlan());
  append(journal, "APPROVE", approvalPayload(prepared.plan_hash), "2026-09-23T12:01:00.000Z");
  append(journal, "PREFLIGHT_PASS", preflightPayload(), "2026-09-23T12:02:00.000Z");
  append(journal, "CANDIDATE_UP", candidatePayload(), "2026-09-23T12:03:00.000Z");
  assert.throws(() => append(journal, "VERIFY", verificationPayload({smoke: {status: "FAIL", mode: "READ_ONLY"}}), "2026-09-23T12:04:00.000Z"), /smoke/i);
});

test("8. successful release evidence is complete", () => {
  const journal = tempJournal();
  advanceToConverged(journal);
  appendCutover(journal);
  append(journal, "COMPLETE", completionPayload(), "2026-09-23T12:07:30.000Z");
  const report = buildReleaseReport(journal);
  assert.equal(report.state, "COMPLETED");
  assert.equal(report.approval.approved_by, "operator-17");
  assert.equal(report.backup_id, "rp-v2-16-fixture");
  assert.deepEqual(report.migrations, ["panel:81->81", "kit:10->10", "hub:5->5"]);
  assert.equal(report.cutover.duration_seconds, 120);
  assert.equal(report.final_convergence.snapshot_id, "cutover-snapshot-1042");
  assert.equal(report.write_freeze.source_data_watermark, "canonical-write-1042");
  assert.equal(report.candidate_write_watermark_after_cutover.watermark, "canonical-write-1042");
  assert.deepEqual(report.route_operations.map(({type}) => type), ["ROUTE_INTENT", "CUTOVER"]);
  assert.equal(report.rollback.used, false);
  assert.ok(report.source_set.repositories.length === 6 && report.images.length === 6);
});

test("9. rollback returns route to the previous runtime identity", () => {
  const journal = tempJournal();
  advanceToConverged(journal);
  appendCutover(journal);
  append(journal, "COMPLETE", completionPayload(), "2026-09-23T12:07:30.000Z");
  const rollbackIntent = routeIntentPayload("ROLLBACK");
  append(journal, "ROUTE_INTENT", rollbackIntent, "2026-09-23T12:08:00.000Z");
  append(journal, "ROLLBACK", rollbackPayload(rollbackIntent), "2026-09-23T12:10:00.000Z");
  assert.equal(buildReleaseReport(journal).runtime.current_identity, OLD_RUNTIME);
});

test("10. rollback evidence is complete and forbids automatic DB restore", () => {
  const journal = tempJournal();
  advanceToConverged(journal);
  appendCutover(journal);
  const rollbackIntent = routeIntentPayload("ROLLBACK");
  append(journal, "ROUTE_INTENT", rollbackIntent, "2026-09-23T12:08:00.000Z");
  assert.throws(() => append(journal, "ROLLBACK", rollbackPayload(rollbackIntent, {reason: "fixture", database_restore_used: true}), "2026-09-23T12:10:00.000Z"), /database restore|automatic/i);
});

test("11. rollback retention metadata is exactly seven days", () => {
  const journal = tempJournal();
  prepareRelease(journal, releasePlan());
  const report = buildReleaseReport(journal);
  assert.equal(report.rollback.retention_days, 7);
  assert.equal(report.rollback.available_until, "2026-09-30T12:00:00.000Z");
});

test("12. all published host bindings remain on 127.0.0.1", () => {
  const plan = releasePlan();
  plan.candidate.host_bindings[0] = "0.0.0.0:13000";
  assert.throws(() => prepareRelease(tempJournal(), plan), /127\.0\.0\.1|loopback|binding/i);
});

test("13. secrets are excluded from append-only evidence", () => {
  const journal = tempJournal();
  const plan = releasePlan();
  plan.route.api_token = "must-not-enter-evidence";
  assert.throws(() => prepareRelease(journal, plan), /secret|sensitive|token/i);
  assert.equal(fs.existsSync(journal), false);
});

test("14. exact source-set closure is enforced", () => {
  const plan = releasePlan();
  plan.accepted_v2_16_source_set.operations_closure_revision = "f".repeat(40);
  assert.throws(() => prepareRelease(tempJournal(), plan), /V2-16|closure|accepted/i);
});

test("14a. exact V2-18 plan runs prepare through cutover and rollback with V2-18 recovery provenance", () => {
  const plan = v218ReleasePlan();
  const journal = tempJournal();
  advanceToConverged(journal, plan);
  appendCutover(journal, plan);
  append(journal, "COMPLETE", completionPayload(plan), "2026-09-23T12:07:30.000Z");
  const rollbackIntent = routeIntentPayload("ROLLBACK", {}, plan);
  append(journal, "ROUTE_INTENT", rollbackIntent, "2026-09-23T12:08:00.000Z");
  append(journal, "ROLLBACK", rollbackPayload(rollbackIntent, {}, plan), "2026-09-23T12:10:00.000Z");
  const report = buildReleaseReport(journal);
  assert.equal(report.release, "V2-18");
  assert.equal(report.backup_id, "rp-v2-18-fixture");
  assert.equal(report.state, "ROLLED_BACK");
  assert.equal(report.runtime.current_identity, plan.old_runtime.runtime_identity);
});

test("14b. V2-18 rejects the wrong prior closure, source set, or recovery release", () => {
  const wrongClosure = v218ReleasePlan();
  wrongClosure.accepted_v2_17_source_set.operations_closure_revision = "f".repeat(40);
  assert.throws(() => prepareRelease(tempJournal(), wrongClosure), /V2-17|closure|accepted/i);

  const wrongSource = v218ReleasePlan();
  wrongSource.source_set.repositories.find(({id}) => id === "P").revision = "f".repeat(40);
  assert.throws(() => prepareRelease(tempJournal(), wrongSource), /V2-18|source set|revision/i);

  const wrongRecovery = v218ReleasePlan();
  wrongRecovery.recovery_point.source_release = "V2-16";
  assert.throws(() => prepareRelease(tempJournal(), wrongRecovery), /V2-18|recovery point/i);
});

test("15. 59-minute recovery point with newer writes cannot be the cutover data source", () => {
  const plan = releasePlan();
  plan.recovery_point.created_at = "2026-09-23T11:03:00.000Z";
  const journal = tempJournal();
  const prepared = prepareRelease(journal, plan);
  append(journal, "APPROVE", approvalPayload(prepared.plan_hash), "2026-09-23T12:01:00.000Z");
  append(journal, "PREFLIGHT_PASS", preflightPayload(), "2026-09-23T12:02:00.000Z");
  append(journal, "CANDIDATE_UP", candidatePayload(), "2026-09-23T12:03:00.000Z");
  append(journal, "VERIFY", verificationPayload(), "2026-09-23T12:04:00.000Z");
  const intent = routeIntentPayload("CUTOVER");
  assert.throws(() => append(journal, "CUTOVER", cutoverPayload(intent), "2026-09-23T12:07:00.000Z"), /intent|freeze|final convergence|blocked/i);
});

test("16. final snapshot and hydrated candidate must contain the newest frozen production write", () => {
  const journal = tempJournal();
  advanceToVerified(journal);
  append(journal, "FREEZE", freezePayload(), "2026-09-23T12:05:10.000Z");
  const stale = finalConvergencePayload();
  stale.final_snapshot.source_data_watermark = "canonical-write-1041";
  assert.throws(() => append(journal, "FINAL_CONVERGENCE", stale, "2026-09-23T12:06:40.000Z"), /frozen-current|watermark|newest/i);
});

test("17. fake or manually substituted freeze timestamp is rejected", () => {
  const journal = tempJournal();
  advanceToVerified(journal);
  const freeze = freezePayload();
  freeze.adapter_evidence.freeze_started_at = "2026-09-23T12:04:30.000Z";
  assert.throws(() => append(journal, "FREEZE", freeze, "2026-09-23T12:05:10.000Z"), /adapter observation|bound|freeze time/i);
});

test("18. failure after freeze and before route resumes the old writer", () => {
  const journal = tempJournal();
  advanceToVerified(journal);
  append(journal, "FREEZE", freezePayload(), "2026-09-23T12:05:10.000Z");
  assert.throws(() => append(journal, "FAIL", {reason: "snapshot failed", route_mutated: false}, "2026-09-23T12:05:30.000Z"), /resume|old writer|unsupported/i);
  const resumeBody = {action: "resume-old-writes", freeze_token: "freeze-runtime-0001", runtime_identity: OLD_RUNTIME, write_state: "ENABLED"};
  append(journal, "FAIL", {
    reason: "snapshot failed", route_mutated: false, candidate_authoritative: false, old_writes_resumed: true,
    freeze_token: "freeze-runtime-0001", old_runtime_identity: OLD_RUNTIME, route_target: "http://127.0.0.1:3000",
    resume_evidence: {...resumeBody, evidence_digest: createEvidenceDigest(resumeBody)},
  }, "2026-09-23T12:05:30.000Z");
  assert.equal(readReleaseJournal(journal).state, "FAILED");
});

test("19. route cannot move before final hydration migration provenance and smoke", () => {
  const journal = tempJournal();
  advanceToVerified(journal);
  append(journal, "FREEZE", freezePayload(), "2026-09-23T12:05:10.000Z");
  const intent = routeIntentPayload("CUTOVER");
  assert.throws(() => append(journal, "CUTOVER", cutoverPayload(intent), "2026-09-23T12:07:00.000Z"), /intent|final convergence|blocked/i);
  const failedSmoke = finalConvergencePayload();
  failedSmoke.final_candidate.checks.smoke.status = "FAIL";
  assert.throws(() => append(journal, "FINAL_CONVERGENCE", failedSmoke, "2026-09-23T12:06:40.000Z"), /smoke/i);
});

test("20. rollback after candidate writes without synchronization proof is blocked", () => {
  const journal = tempJournal();
  advanceToConverged(journal);
  appendCutover(journal);
  const invalid = routeIntentPayload("ROLLBACK", {candidate_write_watermark: "canonical-write-1043", rollback_safety: zeroWriteSafety({candidate_write_watermark: "canonical-write-1043"})});
  assert.throws(() => append(journal, "ROUTE_INTENT", invalid, "2026-09-23T12:08:00.000Z"), /zero canonical|synchronization|proof/i);
});

test("21. verified current-state synchronization preserves the newest candidate write", () => {
  const journal = tempJournal();
  advanceToConverged(journal);
  appendCutover(journal);
  const sync = {mode: "CURRENT_STATE_SYNC", status: "VERIFIED", cutover_write_watermark: "canonical-write-1042", candidate_write_watermark: "canonical-write-1043", synchronization_id: "rollback-sync-1043", target_write_watermark: "canonical-write-1043", preserves_candidate_writes: true};
  const rollbackIntent = routeIntentPayload("ROLLBACK", {candidate_write_watermark: "canonical-write-1043", rollback_safety: sync, started_at: "2026-09-23T12:08:00.000Z", deadline_at: "2026-09-23T12:18:00.000Z"});
  append(journal, "ROUTE_INTENT", rollbackIntent, "2026-09-23T12:08:00.000Z");
  append(journal, "ROLLBACK", rollbackPayload(rollbackIntent, {reason: "fixture", completed_at: "2026-09-23T12:09:00.000Z", route_observation: routeObservation(rollbackIntent, rollbackIntent.desired_target, "2026-09-23T12:09:00.000Z")}), "2026-09-23T12:09:00.000Z");
  assert.equal(buildReleaseReport(journal).rollback.result.rollback_safety.target_write_watermark, "canonical-write-1043");
});

test("22. hard ten-minute clock starts at actual runtime freeze", () => {
  const journal = tempJournal();
  advanceToConverged(journal);
  const intent = routeIntentPayload("CUTOVER");
  append(journal, "ROUTE_INTENT", intent, "2026-09-23T12:06:45.000Z");
  assert.throws(() => append(journal, "CUTOVER", cutoverPayload(intent, {completed_at: "2026-09-23T12:15:00.001Z", route_observation: routeObservation(intent, intent.desired_target, "2026-09-23T12:15:00.001Z")}), "2026-09-23T12:15:00.001Z"), /10 minute|deadline|exceeded/i);
});

test("23. final convergence rejects raw live writable SQLite copies", () => {
  const journal = tempJournal();
  advanceToVerified(journal);
  append(journal, "FREEZE", freezePayload(), "2026-09-23T12:05:10.000Z");
  const unsafe = finalConvergencePayload();
  unsafe.final_snapshot.components[0].capture_method = "raw-copy";
  assert.throws(() => append(journal, "FINAL_CONVERGENCE", unsafe, "2026-09-23T12:06:40.000Z"), /SQLite|online backup|stopped/i);
});

test("24. route changed but adapter errored is reconciled as cutover success", () => {
  const intent = routeIntentPayload("CUTOVER");
  let route = intent.expected_target;
  let mutations = 0;
  let recorded = 0;
  reconcileRouteOperation({
    intent, retry: false, observe: () => ({current_target: route, operation_state: route === intent.desired_target ? "APPLIED" : "NOT_APPLIED", operation_applied_at: route === intent.desired_target ? "2026-09-23T12:07:00.000Z" : null}),
    mutate: () => { mutations += 1; route = intent.desired_target; throw new Error("timeout after external success"); },
    onDesired: () => { recorded += 1; }, onExpected: () => assert.fail("must not abort changed route"), onUnexpected: () => assert.fail("unexpected target"),
  });
  assert.equal(mutations, 1);
  assert.equal(recorded, 1);
});

test("25. route changed then controller crash before append is recoverable", () => {
  const intent = routeIntentPayload("CUTOVER");
  let route = intent.expected_target;
  let mutations = 0;
  assert.throws(() => reconcileRouteOperation({
    intent, retry: false, observe: () => ({current_target: route, operation_state: route === intent.desired_target ? "APPLIED" : "NOT_APPLIED", operation_applied_at: route === intent.desired_target ? "2026-09-23T12:07:00.000Z" : null}),
    mutate: () => { mutations += 1; route = intent.desired_target; },
    onDesired: () => { throw new Error("journal append failed"); }, onExpected: () => assert.fail(), onUnexpected: () => assert.fail(),
  }), /journal append failed/);
  let recovered = false;
  reconcileRouteOperation({
    intent, retry: true, observe: () => ({current_target: route, operation_state: "APPLIED", operation_applied_at: "2026-09-23T12:07:00.000Z"}), mutate: () => { mutations += 1; },
    onDesired: () => { recovered = true; }, onExpected: () => assert.fail(), onUnexpected: () => assert.fail(),
  });
  assert.equal(recovered, true);
  assert.equal(mutations, 1);
});

test("26. retry reconciles desired route without duplicate mutation", () => {
  const intent = routeIntentPayload("CUTOVER");
  let mutations = 0;
  reconcileRouteOperation({intent, retry: true, observe: () => ({current_target: intent.desired_target, operation_state: "APPLIED", operation_applied_at: "2026-09-23T12:07:00.000Z"}), mutate: () => { mutations += 1; }, onDesired: () => {}, onExpected: () => assert.fail(), onUnexpected: () => assert.fail()});
  assert.equal(mutations, 0);
});

test("27. unchanged cutover route safely aborts and resumes only old authority", () => {
  const journal = tempJournal();
  advanceToConverged(journal);
  const intent = routeIntentPayload("CUTOVER");
  append(journal, "ROUTE_INTENT", intent, "2026-09-23T12:06:45.000Z");
  const observation = routeObservation(intent, intent.expected_target, "2026-09-23T12:07:00.000Z");
  let expected = false;
  reconcileRouteOperation({intent, retry: true, observe: () => observation, mutate: () => assert.fail(), onDesired: () => assert.fail(), onExpected: () => { expected = true; }, onUnexpected: () => assert.fail()});
  assert.equal(expected, true);
  append(journal, "CUTOVER_ABORTED", {operation_id: intent.operation_id, action: "CUTOVER", reason: "verified unchanged", route_observation: observation, authority_evidence: authorityEvidence(intent, true, false), candidate_authoritative: false, old_writes_resumed: true}, "2026-09-23T12:07:00.000Z");
  assert.equal(readReleaseJournal(journal).state, "FAILED");
});

test("28. unexpected third route target fails closed with both writers fenced", () => {
  const journal = tempJournal();
  advanceToConverged(journal);
  const intent = routeIntentPayload("CUTOVER");
  append(journal, "ROUTE_INTENT", intent, "2026-09-23T12:06:45.000Z");
  const third = "http://127.0.0.1:19999";
  const observation = routeObservation(intent, third, "2026-09-23T12:07:00.000Z");
  let unexpected = false;
  reconcileRouteOperation({intent, retry: false, observe: () => observation, mutate: () => assert.fail(), onDesired: () => assert.fail(), onExpected: () => assert.fail(), onUnexpected: () => { unexpected = true; }});
  assert.equal(unexpected, true);
  append(journal, "ROUTE_UNCERTAIN", {operation_id: intent.operation_id, action: "CUTOVER", condition: "UNEXPECTED_TARGET", reason: "third target", observed_target: third, route_observation: observation, authority_evidence: authorityEvidence(intent, false, false), writers_fenced: true}, "2026-09-23T12:07:00.000Z");
  assert.equal(readReleaseJournal(journal).state, "FAILED");
});

test("29. rollback route changed but journal append failed remains recoverable", () => {
  const intent = routeIntentPayload("ROLLBACK");
  let route = intent.expected_target;
  let mutations = 0;
  assert.throws(() => reconcileRouteOperation({intent, retry: false, observe: () => ({current_target: route, operation_state: route === intent.desired_target ? "APPLIED" : "NOT_APPLIED", operation_applied_at: route === intent.desired_target ? "2026-09-23T12:09:00.000Z" : null}), mutate: () => { mutations += 1; route = intent.desired_target; }, onDesired: () => { throw new Error("rollback append failed"); }, onExpected: () => assert.fail(), onUnexpected: () => assert.fail()}), /rollback append failed/);
  assert.equal(route, intent.desired_target);
  assert.equal(mutations, 1);
});

test("30. rollback retry reconciles old route without another mutation", () => {
  const intent = routeIntentPayload("ROLLBACK");
  let mutations = 0;
  let recorded = false;
  reconcileRouteOperation({intent, retry: true, observe: () => ({current_target: intent.desired_target, operation_state: "APPLIED", operation_applied_at: "2026-09-23T12:09:00.000Z"}), mutate: () => { mutations += 1; }, onDesired: () => { recorded = true; }, onExpected: () => assert.fail(), onUnexpected: () => assert.fail()});
  assert.equal(recorded, true);
  assert.equal(mutations, 0);
});

test("31. route operation id is stable and binds the complete intent", () => {
  const first = routeIntentPayload("CUTOVER");
  const second = routeIntentPayload("CUTOVER");
  assert.equal(first.operation_id, second.operation_id);
  const changed = {...first, desired_target: "http://127.0.0.1:13001"};
  delete changed.operation_id;
  assert.notEqual(first.operation_id, createRouteOperationId(changed));
});

test("32. desired target present before a new operation is not fabricated as success", () => {
  const intent = routeIntentPayload("CUTOVER");
  let desired = false;
  let condition = null;
  reconcileRouteOperation({intent, retry: false, observe: () => ({current_target: intent.desired_target, operation_state: "NOT_APPLIED", operation_applied_at: null}), mutate: () => assert.fail(), onDesired: () => { desired = true; }, onExpected: () => assert.fail(), onUnexpected: (observation, error, value) => { condition = value; }});
  assert.equal(desired, false);
  assert.equal(condition, "DESIRED_BEFORE_MUTATION");
});

test("33. pending timeout result remains unresolved until later reconciliation", () => {
  const intent = routeIntentPayload("CUTOVER");
  let mutations = 0;
  assert.throws(() => reconcileRouteOperation({intent, retry: true, observe: () => ({current_target: intent.expected_target, operation_state: "PENDING", operation_applied_at: null}), mutate: () => { mutations += 1; }, onDesired: () => assert.fail(), onExpected: () => assert.fail(), onUnexpected: () => assert.fail()}), /pending|retry reconciliation/i);
  assert.equal(mutations, 0);
});

test("append-only journal detects tampering and illegal transitions", () => {
  const journal = tempJournal();
  prepareRelease(journal, releasePlan());
  fs.appendFileSync(journal, "{\"sequence\":999}\n");
  assert.throws(() => readReleaseJournal(journal), /journal|hash|event|sequence/i);
});

test("production and candidate Compose declarations hard-bind published ports to loopback", () => {
  const production = fs.readFileSync(new URL("../compose.prod.yml", import.meta.url), "utf8");
  const candidate = fs.readFileSync(new URL("../compose.release-candidate.yml", import.meta.url), "utf8");
  assert.doesNotMatch(production, /BIND_ADDRESS|0\.0\.0\.0/);
  assert.equal((production.match(/127\.0\.0\.1:\$\{/g) || []).length, 5);
  assert.equal((candidate.match(/127\.0\.0\.1:\$\{/g) || []).length, 5);
  assert.doesNotMatch(candidate, /\$\{(?:PANEL|KIT_STUDIO|LABEL_PRINTER|CUSTOMER_HUB)_DATA_DIR/);
  assert.match(
    candidate,
    /source:\s*candidate_label_data[\s\S]{0,160}target:\s*\/app\/data[\s\S]{0,120}read_only:\s*true/,
  );
  assert.match(candidate, /RELEASE_CANDIDATE_PROJECT[^\n]*-internal[\s\S]*internal: true/);
});

test("legacy in-place deploy path fails before invoking Docker", () => {
  const script = fs.readFileSync(new URL("../scripts/deploy.sh", import.meta.url), "utf8");
  assert.match(script, /Refusing blind in-place deployment/);
  assert.doesNotMatch(script, /docker compose|\sup\s+-d|\spull\s/);
});

test("candidate state requires collector-bound provenance", () => {
  const journal = tempJournal();
  const prepared = prepareRelease(journal, releasePlan());
  append(journal, "APPROVE", approvalPayload(prepared.plan_hash), "2026-09-23T12:01:00.000Z");
  append(journal, "PREFLIGHT_PASS", preflightPayload(), "2026-09-23T12:02:00.000Z");
  const candidate = candidatePayload();
  delete candidate.runtime_provenance;
  assert.throws(() => append(journal, "CANDIDATE_UP", candidate, "2026-09-23T12:03:00.000Z"), /collector|provenance/i);
});

test("14c. V2-18 legacy runtime bridge rejects missing or tampered identity evidence", () => {
  const missing = v218ReleasePlan();
  delete missing.old_runtime.identity_evidence;
  assert.throws(
    () => prepareRelease(tempJournal(), missing),
    /legacy old runtime identity evidence|object/i
  );

  const tampered = v218ReleasePlan();
  tampered.old_runtime.identity_evidence.source_provenance_state = "VERIFIED";
  assert.throws(
    () => prepareRelease(tempJournal(), tampered),
    /bound|UNVERIFIED_LEGACY/i
  );

  const wrongVolume = v218ReleasePlan();
  wrongVolume.old_runtime.volume_ids[0] = `sha256:${"0".repeat(64)}`;
  assert.throws(
    () => prepareRelease(tempJournal(), wrongVolume),
    /volume identities|bootstrap evidence/i
  );
});
