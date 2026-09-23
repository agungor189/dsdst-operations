import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  appendReleaseEvent,
  buildReleaseReport,
  prepareRelease,
  readReleaseJournal,
} from "../scripts/release/release-lib.mjs";
import {createRuntimeCaptureId} from "../scripts/validate-release-evidence.mjs";

const OLD_RUNTIME = `runtime-${"a".repeat(64)}`;

const SOURCE_REVISIONS = {
  O: "dffac354318cb4ebd826bc282fc0788a4e5aad18",
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

function append(journal, type, payload, occurredAt) {
  return appendReleaseEvent(journal, {type, occurred_at: occurredAt, payload});
}

function approvalPayload(planHash) {
  return {approved_by: "operator-17", approval_id: "approval-17", plan_hash: planHash, manual: true};
}

function preflightPayload() {
  return {
    backup_id: "rp-v2-16-fixture",
    recovery_health: "PASS",
    source_set_check: "PASS",
    image_provenance_check: "PASS",
    secret_config_check: "PASS",
    migration: {status: "PASS", candidate_db_touched: false, migrations: ["panel:81->81", "kit:10->10", "hub:5->5"]},
  };
}

function candidatePayload() {
  const plan = releasePlan();
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
    project: "dsdst-candidate-v2-17-20260923t120000z",
    runtime_identity: captureId,
    volume_ids: ["candidate-panel", "candidate-kit", "candidate-label", "candidate-hub"],
    host_bindings: ["127.0.0.1:13000", "127.0.0.1:13006", "127.0.0.1:13012", "127.0.0.1:13100", "127.0.0.1:13013"],
    write_freeze_started_at: "2026-09-23T12:02:30.000Z",
    hydration: {
      status: "PASS",
      backup_id: "rp-v2-16-fixture",
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

function verificationPayload(overrides = {}) {
  const runtimeIdentity = candidatePayload().runtime_identity;
  return {
    critical_services: Object.keys(SERVICE_COMPONENTS).map((service_id) => ({service_id, status: "PASS"})),
    smoke: {status: "PASS", mode: "READ_ONLY"},
    connectivity: {status: "PASS", checks: ["W->P", "K->P", "L->P", "P->renderer", "Hub->P"]},
    runtime_identity: runtimeIdentity,
    provenance_check: "PASS",
    ...overrides,
  };
}

function advanceToVerified(journal) {
  const prepared = prepareRelease(journal, releasePlan());
  append(journal, "APPROVE", approvalPayload(prepared.plan_hash), "2026-09-23T12:01:00.000Z");
  append(journal, "PREFLIGHT_PASS", preflightPayload(), "2026-09-23T12:02:00.000Z");
  append(journal, "CANDIDATE_UP", candidatePayload(), "2026-09-23T12:03:00.000Z");
  append(journal, "VERIFY", verificationPayload(), "2026-09-23T12:04:00.000Z");
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
  advanceToVerified(journal);
  append(journal, "CUTOVER", {
    explicit: true,
    approval_id: "approval-17",
    route_provenance_state: "VERIFIED",
    old_runtime_identity: OLD_RUNTIME,
    new_runtime_identity: candidatePayload().runtime_identity,
    old_target: "http://127.0.0.1:3000",
    new_target: "http://127.0.0.1:13000",
    started_at: "2026-09-23T12:02:30.000Z",
    completed_at: "2026-09-23T12:07:00.000Z",
    old_stack_mode: "READ_ONLY_STOPPED",
  }, "2026-09-23T12:07:00.000Z");
  append(journal, "COMPLETE", {result: "SUCCESS"}, "2026-09-23T12:07:30.000Z");
  const report = buildReleaseReport(journal);
  assert.equal(report.state, "COMPLETED");
  assert.equal(report.approval.approved_by, "operator-17");
  assert.equal(report.backup_id, "rp-v2-16-fixture");
  assert.deepEqual(report.migrations, ["panel:81->81", "kit:10->10", "hub:5->5"]);
  assert.equal(report.cutover.duration_seconds, 270);
  assert.equal(report.rollback.used, false);
  assert.ok(report.source_set.repositories.length === 6 && report.images.length === 6);
});

test("9. rollback returns route to the previous runtime identity", () => {
  const journal = tempJournal();
  advanceToVerified(journal);
  append(journal, "CUTOVER", {
    explicit: true, approval_id: "approval-17", route_provenance_state: "VERIFIED",
    old_runtime_identity: OLD_RUNTIME, new_runtime_identity: candidatePayload().runtime_identity,
    old_target: "http://127.0.0.1:3000", new_target: "http://127.0.0.1:13000",
    started_at: "2026-09-23T12:02:30.000Z", completed_at: "2026-09-23T12:07:00.000Z",
    old_stack_mode: "READ_ONLY_STOPPED",
  }, "2026-09-23T12:07:00.000Z");
  append(journal, "COMPLETE", {result: "SUCCESS"}, "2026-09-23T12:07:30.000Z");
  append(journal, "ROLLBACK", {
    explicit: true, reason: "post-cutover health regression", route_provenance_state: "VERIFIED",
    from_runtime_identity: candidatePayload().runtime_identity, restored_runtime_identity: OLD_RUNTIME,
    restored_target: "http://127.0.0.1:3000", database_restore_used: false,
    started_at: "2026-09-23T12:08:00.000Z", completed_at: "2026-09-23T12:10:00.000Z",
  }, "2026-09-23T12:10:00.000Z");
  assert.equal(buildReleaseReport(journal).runtime.current_identity, OLD_RUNTIME);
});

test("10. rollback evidence is complete and forbids automatic DB restore", () => {
  const journal = tempJournal();
  advanceToVerified(journal);
  append(journal, "CUTOVER", {
    explicit: true, approval_id: "approval-17", route_provenance_state: "VERIFIED",
    old_runtime_identity: OLD_RUNTIME, new_runtime_identity: candidatePayload().runtime_identity,
    old_target: "http://127.0.0.1:3000", new_target: "http://127.0.0.1:13000",
    started_at: "2026-09-23T12:02:30.000Z", completed_at: "2026-09-23T12:07:00.000Z",
    old_stack_mode: "READ_ONLY_STOPPED",
  }, "2026-09-23T12:07:00.000Z");
  assert.throws(() => append(journal, "ROLLBACK", {
    explicit: true, reason: "fixture", route_provenance_state: "VERIFIED",
    from_runtime_identity: candidatePayload().runtime_identity, restored_runtime_identity: OLD_RUNTIME,
    restored_target: "http://127.0.0.1:3000", database_restore_used: true,
    started_at: "2026-09-23T12:08:00.000Z", completed_at: "2026-09-23T12:10:00.000Z",
  }, "2026-09-23T12:10:00.000Z"), /database restore|automatic/i);
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
  assert.match(candidate, /candidate_label_data:\/app\/data:ro/);
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
