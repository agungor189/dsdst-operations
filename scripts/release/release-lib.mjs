import {createHash} from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {createRuntimeCaptureId} from "../validate-release-evidence.mjs";

const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const RELEASE_ID = /^[a-z0-9][a-z0-9-]{7,79}$/;
const SENSITIVE_KEY = /(?:^|_)(?:secret|password|token|api_key|access_key|private_key|credential)(?:$|_)/i;
const REQUIRED_SERVICES = new Map([
  ["dsdst-panel", "P"],
  ["dsdst-warehouse", "W"],
  ["dsdst-kit-studio", "K"],
  ["dsdst-customer-hub", "HUB"],
  ["label-printer", "L"],
  ["warehouse-label-renderer", "L"],
]);
const COMPONENT_REPOSITORIES = Object.freeze({
  P: "agungor189/panel-kit-yonetimi",
  W: "agungor189/Dsdst-Warehouse",
  K: "agungor189/dsdst-kit-studio",
  L: "agungor189/Label-Printer",
  HUB: "agungor189/dsdst-customer-hub",
});
const ACCEPTED_V2_16 = Object.freeze({
  content: "3547b73951d0ac0781eedff538fa4bbb2e4fc204",
  closure: "e64142f18eb6a2c3fe7c0f084a393c0871c76ee6",
  repositories: Object.freeze({
    O: "3547b73951d0ac0781eedff538fa4bbb2e4fc204",
    P: "61ed1ad8fba25ed9d5c0b228308ff22da45febaf",
    W: "525e18c508c1191c0c4e4b725bda00defd930d2f",
    K: "0e0717c3f8d3f3f0af186b4c165524bc2e81724c",
    L: "add3987e0eb15e8742ecac490b5eb4e78b620ce5",
    HUB: "f030c29b6ee41765289993fda1e94d1e484b5cac",
  }),
});
const ACCEPTED_V2_17 = JSON.parse(fs.readFileSync(new URL("../../config/v2-17-source-set.json", import.meta.url), "utf8"));

const fail = (message) => {
  throw new Error(message);
};

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  return value;
}

function string(value, label) {
  if (typeof value !== "string" || value.length === 0) fail(`${label} must be a non-empty string`);
  return value;
}

function array(value, label) {
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  return value;
}

function exactKeys(value, allowed, label) {
  object(value, label);
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) fail(`${label} contains unsupported evidence field(s): ${unexpected.join(", ")}`);
}

function iso(value, label) {
  const parsed = Date.parse(string(value, label));
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) fail(`${label} must be an ISO-8601 UTC timestamp`);
  return parsed;
}

function sha(value, label) {
  if (!SHA.test(string(value, label))) fail(`${label} must be a full lowercase Git SHA`);
  return value;
}

function digest(value, label) {
  if (!DIGEST.test(string(value, label))) fail(`${label} must be an immutable SHA-256 digest`);
  return value;
}

function assertNoSensitiveKeys(value, location = "evidence") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSensitiveKeys(item, `${location}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(key) && key !== "secret_config_check") fail(`${location}.${key}: secret/sensitive fields are forbidden in release evidence`);
    assertNoSensitiveKeys(child, `${location}.${key}`);
  }
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortValue(value[key])]));
}

function canonical(value) {
  return JSON.stringify(sortValue(value));
}

function hash(value) {
  return `sha256:${createHash("sha256").update(typeof value === "string" ? value : canonical(value)).digest("hex")}`;
}

function revisionMap(sourceSet, label) {
  object(sourceSet, label);
  exactKeys(sourceSet, ["release", "repositories", "schemaVersion", "basedOn", "operations_content_revision", "operations_closure_revision"], label);
  const entries = array(sourceSet.repositories, `${label}.repositories`);
  const result = {};
  for (const [index, entry] of entries.entries()) {
    object(entry, `${label}.repositories[${index}]`);
    exactKeys(entry, ["id", "revision", "repository", "contextEnv", "role"], `${label}.repositories[${index}]`);
    const id = string(entry.id, `${label}.repositories[${index}].id`);
    if (Object.hasOwn(result, id)) fail(`${label} contains duplicate repository ${id}`);
    result[id] = sha(entry.revision, `${label}.${id}.revision`);
  }
  for (const id of Object.keys(ACCEPTED_V2_16.repositories)) {
    if (!result[id]) fail(`${label} is missing ${id}`);
  }
  if (Object.keys(result).length !== Object.keys(ACCEPTED_V2_16.repositories).length) fail(`${label} must contain the exact O/P/W/K/L/HUB source set`);
  return result;
}

function sameRevisionMap(actual, expected, label) {
  for (const [id, revision] of Object.entries(expected)) {
    if (actual[id] !== revision) fail(`${label} ${id} revision does not match the exact accepted source set`);
  }
}

function validateV216(plan) {
  const accepted = object(plan.accepted_v2_16_source_set, "accepted_v2_16_source_set");
  if (accepted.release !== "V2-16") fail("accepted source set must identify V2-16");
  if (accepted.operations_content_revision !== ACCEPTED_V2_16.content) fail("V2-16 accepted content revision mismatch");
  if (accepted.operations_closure_revision !== ACCEPTED_V2_16.closure) fail("V2-16 accepted closure revision mismatch");
  sameRevisionMap(revisionMap(accepted, "accepted_v2_16_source_set"), ACCEPTED_V2_16.repositories, "accepted V2-16 source set");
}

function validateRecovery(plan, at) {
  const recovery = object(plan.recovery_point, "recovery_point");
  exactKeys(recovery, ["recovery_point_id", "created_at", "status", "verification_state", "offsite_state", "restored_drill_state", "source_release", "source_repositories"], "recovery_point");
  string(recovery.recovery_point_id, "recovery_point.recovery_point_id");
  if (recovery.status !== "SUCCESS" || recovery.verification_state !== "VERIFIED" || recovery.offsite_state !== "PERSISTED" || recovery.restored_drill_state !== "VERIFIED") {
    fail("V2-16 recovery point must be SUCCESS, VERIFIED, offsite PERSISTED, and restore-drill VERIFIED");
  }
  if (recovery.source_release !== "V2-16") fail("recovery point must identify V2-16");
  const maximumAge = plan.recovery_max_age_seconds;
  if (!Number.isInteger(maximumAge) || maximumAge <= 0 || maximumAge > 3600) fail("recovery_max_age_seconds must be explicitly approved and cannot exceed the accepted V2-16 60-minute RPO");
  const createdAt = iso(recovery.created_at, "recovery_point.created_at");
  const checkedAt = iso(at, "recovery freshness check time");
  if (createdAt > checkedAt || checkedAt - createdAt > maximumAge * 1000) fail("V2-16 recovery point is stale; freshness gate failed");
  sameRevisionMap(revisionMap({repositories: recovery.source_repositories}, "recovery_point.source_repositories"), ACCEPTED_V2_16.repositories, "recovery point source set");
}

function validateServices(plan, sources) {
  const services = array(plan.services, "services");
  if (services.length !== REQUIRED_SERVICES.size) fail("services must contain the exact six critical runtime services");
  const byId = new Map();
  for (const service of services) {
    object(service, "service");
    exactKeys(service, ["service_id", "component", "repository", "source_revision", "image_reference", "image_digest", "image_id", "config_fingerprint"], "service");
    const expectedComponent = REQUIRED_SERVICES.get(service.service_id);
    if (!expectedComponent || byId.has(service.service_id)) fail(`unexpected or duplicate critical service ${service.service_id}`);
    if (service.component !== expectedComponent) fail(`${service.service_id} component mismatch`);
    if (service.source_revision !== sources[expectedComponent]) fail(`${service.service_id} source revision mismatch`);
    sha(service.source_revision, `${service.service_id}.source_revision`);
    const imageDigest = digest(service.image_digest, `${service.service_id}.image_digest`);
    digest(service.image_id, `${service.service_id}.image_id`);
    digest(service.config_fingerprint, `${service.service_id}.config_fingerprint`);
    const reference = string(service.image_reference, `${service.service_id}.image_reference`);
    if (!reference.endsWith(`@${imageDigest}`)) fail(`${service.service_id} image reference is not pinned to its immutable digest`);
    if (service.repository !== COMPONENT_REPOSITORIES[expectedComponent]) fail(`${service.service_id} source repository mismatch`);
    byId.set(service.service_id, service);
  }
  const label = byId.get("label-printer");
  const renderer = byId.get("warehouse-label-renderer");
  for (const field of ["repository", "source_revision", "image_reference", "image_digest", "image_id", "config_fingerprint"]) {
    if (label[field] !== renderer[field]) fail(`Label Printer and renderer ${field} provenance mismatch`);
  }
}

function validateTopology(plan) {
  const oldRuntime = object(plan.old_runtime, "old_runtime");
  const candidate = object(plan.candidate, "candidate");
  exactKeys(oldRuntime, ["project", "runtime_identity", "route_target", "volume_ids"], "old_runtime");
  exactKeys(candidate, ["project", "route_target", "host_bindings", "volume_ids"], "candidate");
  string(oldRuntime.project, "old_runtime.project");
  if (!/^runtime-[a-f0-9]{64}$/.test(string(oldRuntime.runtime_identity, "old_runtime.runtime_identity"))) fail("old runtime identity must be a PR01 collector capture identity");
  string(oldRuntime.route_target, "old_runtime.route_target");
  string(candidate.project, "candidate.project");
  if (candidate.project === oldRuntime.project) fail("candidate must use a separate Compose project");
  const oldVolumes = new Set(array(oldRuntime.volume_ids, "old_runtime.volume_ids").map((id) => string(id, "old volume identity")));
  const candidateVolumes = array(candidate.volume_ids, "candidate.volume_ids").map((id) => string(id, "candidate volume identity"));
  if (candidateVolumes.length === 0 || new Set(candidateVolumes).size !== candidateVolumes.length) fail("candidate volume identities must be present and unique");
  if (candidateVolumes.some((id) => oldVolumes.has(id))) fail("candidate cannot mount an old production volume");
  for (const binding of array(candidate.host_bindings, "candidate.host_bindings")) {
    if (!/^127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(string(binding, "candidate host binding"))) fail("candidate host bindings must remain on loopback 127.0.0.1");
    const port = Number(binding.split(":")[1]);
    if (port > 65535) fail("candidate host binding has an invalid port");
  }
  string(candidate.route_target, "candidate.route_target");
}

function validateRoute(plan) {
  const route = object(plan.route, "route");
  exactKeys(route, ["provider", "provenance_state", "route_id_hash", "current_target", "cutover_command", "rollback_command"], "route");
  if (route.provider !== "cloudflare" || route.provenance_state !== "VERIFIED") fail("Cloudflare route provenance must be VERIFIED");
  digest(route.route_id_hash, "route.route_id_hash");
  if (route.current_target !== plan.old_runtime.route_target) fail("Cloudflare route provenance does not identify the old runtime target");
  string(route.cutover_command, "route.cutover_command");
  string(route.rollback_command, "route.rollback_command");
}

function validatePlan(plan) {
  object(plan, "release plan");
  exactKeys(plan, ["release_id", "release", "prepared_at", "recovery_max_age_seconds", "source_set", "accepted_v2_16_source_set", "services", "recovery_point", "old_runtime", "candidate", "route", "rollback"], "release plan");
  assertNoSensitiveKeys(plan, "release plan");
  if (!RELEASE_ID.test(string(plan.release_id, "release_id"))) fail("invalid release_id");
  if (plan.release !== "V2-17") fail("release must be V2-17");
  iso(plan.prepared_at, "prepared_at");
  validateV216(plan);
  const sourceSet = object(plan.source_set, "source_set");
  if (sourceSet.release !== "V2-17") fail("source_set must identify V2-17");
  const sources = revisionMap(sourceSet, "source_set");
  sameRevisionMap(sources, revisionMap(ACCEPTED_V2_17, "config/v2-17-source-set.json"), "V2-17 source set");
  validateServices(plan, sources);
  validateRecovery(plan, plan.prepared_at);
  validateTopology(plan);
  validateRoute(plan);
  exactKeys(object(plan.rollback, "rollback"), ["retention_days"], "rollback");
  if (plan.rollback.retention_days !== 7) fail("rollback retention must be exactly 7 days");
  return plan;
}

function eventHash(event) {
  const {event_hash: ignored, ...body} = event;
  return hash(body);
}

function validateEventShape(event, index, previousHash) {
  object(event, `journal event ${index + 1}`);
  if (event.sequence !== index + 1) fail("release journal sequence is invalid");
  if (event.previous_hash !== previousHash) fail("release journal hash chain is invalid");
  iso(event.occurred_at, "event.occurred_at");
  string(event.type, "event.type");
  string(event.state, "event.state");
  object(event.payload, "event.payload");
  assertNoSensitiveKeys(event.payload, `event ${event.sequence}`);
  if (event.event_hash !== eventHash(event)) fail("release journal event hash is invalid; evidence may have been tampered with");
}

function derive(lines) {
  let previousHash = "GENESIS";
  let state = null;
  let plan = null;
  let planHash = null;
  let approval = null;
  let previousTime = -Infinity;
  const events = [];
  for (const [index, line] of lines.entries()) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      fail("release journal contains invalid JSON");
    }
    validateEventShape(event, index, previousHash);
    const eventTime = iso(event.occurred_at, "event.occurred_at");
    if (eventTime < previousTime) fail("release journal timestamps must be monotonic");
    if (index === 0) {
      if (event.type !== "PREPARE" || event.state !== "PREPARED") fail("release journal must start with PREPARE/PREPARED");
      plan = validatePlan(event.payload.plan);
      planHash = hash(plan);
      if (event.payload.plan_hash !== planHash) fail("release plan hash mismatch");
    } else {
      ({state, approval} = validateTransition({state, plan, planHash, approval, events, event}));
    }
    state = event.state;
    previousHash = event.event_hash;
    previousTime = eventTime;
    events.push(event);
  }
  return {state, plan, plan_hash: planHash, approval, events, last_hash: previousHash};
}

function allPass(items) {
  return items.length > 0 && items.every((item) => item?.status === "PASS");
}

function validateTransition(context) {
  const {state, plan, planHash, event} = context;
  const p = event.payload;
  let approval = context.approval;
  const legal = {
    PREPARED: ["APPROVE", "FAIL"],
    APPROVED: ["PREFLIGHT_PASS", "FAIL"],
    PREFLIGHT_PASSED: ["CANDIDATE_UP", "FAIL"],
    CANDIDATE_UP: ["VERIFY", "FAIL"],
    VERIFIED: ["CUTOVER", "FAIL"],
    CUTOVER: ["COMPLETE", "ROLLBACK", "FAIL"],
    FAILED: ["ROLLBACK"],
    COMPLETED: ["ROLLBACK"],
    ROLLED_BACK: [],
  };
  if (!legal[state]?.includes(event.type)) {
    if (state === "PREPARED") fail(`manual approval is required; illegal release transition from ${state}`);
    fail(`illegal release transition from ${state}; ${event.type} is blocked`);
  }
  const expectedStates = {
    APPROVE: "APPROVED", PREFLIGHT_PASS: "PREFLIGHT_PASSED", CANDIDATE_UP: "CANDIDATE_UP",
    VERIFY: "VERIFIED", CUTOVER: "CUTOVER", COMPLETE: "COMPLETED", FAIL: "FAILED", ROLLBACK: "ROLLED_BACK",
  };
  if (event.state !== expectedStates[event.type]) fail(`${event.type} must produce state ${expectedStates[event.type]}`);

  if (event.type === "APPROVE") {
    exactKeys(p, ["approved_by", "approval_id", "plan_hash", "manual"], "approval evidence");
    if (p.manual !== true || p.plan_hash !== planHash) fail("manual approval must bind the exact release plan hash");
    string(p.approved_by, "approval.approved_by");
    string(p.approval_id, "approval.approval_id");
    approval = p;
  } else if (event.type === "PREFLIGHT_PASS") {
    exactKeys(p, ["backup_id", "recovery_health", "source_set_check", "image_provenance_check", "secret_config_check", "migration"], "preflight evidence");
    validateRecovery(plan, event.occurred_at);
    if (!approval) fail("APPROVED state and manual approval are required");
    if (p.backup_id !== plan.recovery_point.recovery_point_id || p.recovery_health !== "PASS" || p.source_set_check !== "PASS" || p.image_provenance_check !== "PASS" || p.secret_config_check !== "PASS") {
      fail("release preflight checks did not all pass");
    }
    const migration = object(p.migration, "migration preflight");
    exactKeys(migration, ["status", "candidate_db_touched", "migrations"], "migration preflight");
    if (migration.status !== "PASS" || migration.candidate_db_touched !== false) fail("migration preflight must pass before the candidate DB is touched");
    array(migration.migrations, "migration.migrations").forEach((item) => string(item, "migration identifier"));
  } else if (event.type === "CANDIDATE_UP") {
    exactKeys(p, ["project", "runtime_identity", "volume_ids", "host_bindings", "write_freeze_started_at", "hydration", "runtime_provenance"], "candidate evidence");
    if (p.project !== plan.candidate.project) fail("candidate Compose project mismatch");
    string(p.runtime_identity, "candidate runtime identity");
    const candidateVolumes = array(p.volume_ids, "candidate volume_ids");
    const oldVolumes = new Set(plan.old_runtime.volume_ids);
    if (candidateVolumes.some((id) => oldVolumes.has(id))) fail("candidate cannot mount an old production volume");
    if (canonical(candidateVolumes) !== canonical(plan.candidate.volume_ids)) fail("candidate volume identities differ from the approved plan");
    if (canonical(p.host_bindings) !== canonical(plan.candidate.host_bindings)) fail("candidate host bindings differ from the approved plan");
    const freezeStartedAt = iso(p.write_freeze_started_at, "candidate write_freeze_started_at");
    if (freezeStartedAt > iso(event.occurred_at, "candidate event time")) fail("write freeze cannot begin after candidate-up evidence");
    const hydration = object(p.hydration, "candidate hydration evidence");
    exactKeys(hydration, ["status", "backup_id", "source_isolated_restore", "old_volume_mounted", "migrations_ran"], "candidate hydration evidence");
    if (hydration.status !== "PASS" || hydration.backup_id !== plan.recovery_point.recovery_point_id || hydration.source_isolated_restore !== true || hydration.old_volume_mounted !== false) {
      fail("candidate hydration must use the approved isolated recovery point without mounting old production volumes");
    }
    array(hydration.migrations_ran, "candidate hydration migrations_ran").forEach((migration) => string(migration, "executed migration identity"));
    const provenance = object(p.runtime_provenance, "candidate runtime provenance");
    exactKeys(provenance, ["collector", "capture_id", "captured_at", "services"], "candidate runtime provenance");
    iso(provenance.captured_at, "candidate runtime provenance captured_at");
    if (provenance.collector !== "dsdst-read-only-runtime-collector-v1" || provenance.capture_id !== p.runtime_identity || !/^runtime-[a-f0-9]{64}$/.test(provenance.capture_id)) fail("candidate runtime identity must be the read-only collector capture identity");
    const records = array(provenance.services, "candidate runtime provenance services");
    if (provenance.capture_id !== createRuntimeCaptureId(provenance.captured_at, records)) fail("candidate runtime collector capture identity does not bind the complete observation set");
    if (records.length !== REQUIRED_SERVICES.size) fail("candidate runtime provenance is missing critical services");
    const plannedById = new Map(plan.services.map((service) => [service.service_id, service]));
    const observedIds = new Set();
    const observedVolumeIds = new Set();
    const publishedBindings = [];
    const containerIds = new Set();
    let labelVolume = null;
    let rendererVolume = null;
    for (const record of records) {
      exactKeys(record, ["capture_id", "service_id", "container_id", "source_repository", "revision", "declared_image_reference", "image_digest", "image_id", "configuration", "volumes", "ports"], "candidate runtime service provenance");
      const planned = plannedById.get(record.service_id);
      if (!planned || observedIds.has(record.service_id)) fail("candidate runtime provenance contains an unexpected or duplicate service");
      observedIds.add(record.service_id);
      if (record.capture_id !== provenance.capture_id || !/^[a-f0-9]{64}$/.test(record.container_id) || containerIds.has(record.container_id)) fail("candidate runtime provenance has an invalid capture/container identity");
      containerIds.add(record.container_id);
      if (record.source_repository !== planned.repository || record.revision !== planned.source_revision ||
          record.declared_image_reference !== planned.image_reference || record.image_digest !== planned.image_digest ||
          record.image_id !== planned.image_id || record.configuration?.status !== "VERIFIED" ||
          record.configuration?.redacted !== true || record.configuration?.fingerprint !== planned.config_fingerprint) {
        fail(`candidate runtime provenance mismatch for ${record.service_id}`);
      }
      exactKeys(record.configuration, ["status", "redacted", "fingerprint"], `${record.service_id}.configuration`);
      for (const volume of array(record.volumes, `${record.service_id}.volumes`)) {
        exactKeys(volume, ["source_id"], `${record.service_id}.volume`);
        const sourceId = string(volume.source_id, `${record.service_id}.volume.source_id`);
        if (oldVolumes.has(sourceId)) fail("candidate runtime collector observed an old production volume");
        observedVolumeIds.add(sourceId);
        if (record.service_id === "label-printer") labelVolume = sourceId;
        if (record.service_id === "warehouse-label-renderer") rendererVolume = sourceId;
      }
      for (const port of array(record.ports, `${record.service_id}.ports`)) {
        if (port.exposure === "published") {
          exactKeys(port, ["exposure", "host_ip", "host_port"], `${record.service_id}.published port`);
          if (port.host_ip !== "127.0.0.1" || !Number.isInteger(port.host_port)) fail("candidate runtime collector observed a non-loopback host binding");
          publishedBindings.push(`${port.host_ip}:${port.host_port}`);
        } else if (port.exposure === "internal") {
          exactKeys(port, ["exposure"], `${record.service_id}.internal port`);
        } else fail("candidate runtime collector observed an invalid port exposure");
      }
    }
    if (labelVolume === null || labelVolume !== rendererVolume) fail("Label Printer and renderer must share only the candidate label volume");
    if (candidateVolumes.some((id) => !observedVolumeIds.has(id))) fail("candidate runtime collector did not observe every approved candidate volume identity");
    if (canonical(publishedBindings.sort()) !== canonical([...plan.candidate.host_bindings].sort())) fail("candidate runtime collector host bindings differ from the approved plan");
  } else if (event.type === "VERIFY") {
    exactKeys(p, ["critical_services", "smoke", "connectivity", "runtime_identity", "provenance_check"], "verification evidence");
    p.critical_services.forEach((item) => exactKeys(item, ["service_id", "status"], "critical service health evidence"));
    exactKeys(p.smoke, ["status", "mode"], "smoke evidence");
    exactKeys(p.connectivity, ["status", "checks"], "connectivity evidence");
    if (!allPass(array(p.critical_services, "critical_services")) || p.critical_services.length !== REQUIRED_SERVICES.size) fail("all critical service health checks must pass");
    const ids = new Set(p.critical_services.map((item) => item.service_id));
    if ([...REQUIRED_SERVICES.keys()].some((id) => !ids.has(id))) fail("critical service health evidence is incomplete");
    if (p.smoke?.status !== "PASS" || p.smoke?.mode !== "READ_ONLY") fail("read-only smoke must pass before cutover");
    if (p.connectivity?.status !== "PASS" || !Array.isArray(p.connectivity.checks) || p.connectivity.checks.length === 0) fail("critical cross-service connectivity checks must pass");
    if (p.provenance_check !== "PASS") fail("candidate runtime provenance must pass");
    string(p.runtime_identity, "verified runtime identity");
    const candidateEvent = context.events?.find?.((item) => item.type === "CANDIDATE_UP");
    if (!candidateEvent || p.runtime_identity !== candidateEvent.payload.runtime_identity) fail("verification runtime identity does not match the collected candidate runtime");
  } else if (event.type === "CUTOVER") {
    exactKeys(p, ["explicit", "approval_id", "route_provenance_state", "old_runtime_identity", "new_runtime_identity", "old_target", "new_target", "started_at", "completed_at", "old_stack_mode"], "cutover evidence");
    if (p.explicit !== true || p.approval_id !== approval?.approval_id) fail("cutover requires the exact explicit manual approval");
    if (p.route_provenance_state !== "VERIFIED") fail("Cloudflare route provenance must be verified before cutover");
    if (p.old_runtime_identity !== plan.old_runtime.runtime_identity) fail("cutover old runtime identity mismatch");
    const candidateEvent = context.events?.find?.((item) => item.type === "CANDIDATE_UP");
    if (candidateEvent && p.new_runtime_identity !== candidateEvent.payload.runtime_identity) fail("cutover new runtime identity mismatch");
    if (p.old_target !== plan.old_runtime.route_target || p.new_target !== plan.candidate.route_target) fail("cutover route targets differ from the approved plan");
    if (p.old_stack_mode !== "READ_ONLY_STOPPED") fail("old stack must become a read-only stopped rollback target");
    if (!candidateEvent || p.started_at !== candidateEvent.payload.write_freeze_started_at) fail("cutover duration must begin at the production write freeze");
    const duration = iso(p.completed_at, "cutover.completed_at") - iso(p.started_at, "cutover.started_at");
    if (duration < 0 || duration > 600_000) fail("cutover exceeded the hard 10 minute interruption maximum");
  } else if (event.type === "COMPLETE") {
    exactKeys(p, ["result"], "completion evidence");
    if (p.result !== "SUCCESS") fail("completed release result must be SUCCESS");
  } else if (event.type === "FAIL") {
    exactKeys(p, ["reason", "route_mutated"], "failure evidence");
    string(p.reason, "failure.reason");
    if (p.route_mutated !== false && state !== "CUTOVER") fail("pre-cutover failure must prove the route was not mutated");
  } else if (event.type === "ROLLBACK") {
    exactKeys(p, ["explicit", "reason", "route_provenance_state", "from_runtime_identity", "restored_runtime_identity", "restored_target", "database_restore_used", "started_at", "completed_at"], "rollback evidence");
    if (p.explicit !== true || p.route_provenance_state !== "VERIFIED") fail("rollback must be explicit and route provenance VERIFIED");
    string(p.reason, "rollback.reason");
    if (p.from_runtime_identity === p.restored_runtime_identity || p.restored_runtime_identity !== plan.old_runtime.runtime_identity) fail("rollback must restore the previous runtime identity");
    if (p.restored_target !== plan.old_runtime.route_target) fail("rollback must restore the previous route target");
    if (p.database_restore_used !== false) fail("automatic production database restore is forbidden during rollback");
    const duration = iso(p.completed_at, "rollback.completed_at") - iso(p.started_at, "rollback.started_at");
    if (duration < 0 || duration > 600_000) fail("rollback exceeded the hard 10 minute interruption maximum");
    const cutover = context.events?.find?.((item) => item.type === "CUTOVER");
    const retentionStart = cutover ? iso(cutover.payload.completed_at, "cutover.completed_at") : iso(plan.prepared_at, "prepared_at");
    if (iso(event.occurred_at, "rollback event time") > retentionStart + 7 * 24 * 60 * 60 * 1000) fail("seven-day rollback retention window has expired");
  }
  return {state: event.state, approval};
}

function eventState(currentState, type) {
  return ({
    APPROVE: "APPROVED", PREFLIGHT_PASS: "PREFLIGHT_PASSED", CANDIDATE_UP: "CANDIDATE_UP",
    VERIFY: "VERIFIED", CUTOVER: "CUTOVER", COMPLETE: "COMPLETED", FAIL: "FAILED", ROLLBACK: "ROLLED_BACK",
  })[type] || fail(`unknown release event type ${type}`);
}

function persistNewJournal(journalPath, event) {
  fs.mkdirSync(path.dirname(path.resolve(journalPath)), {recursive: true, mode: 0o750});
  const handle = fs.openSync(journalPath, "wx", 0o640);
  try {
    fs.writeFileSync(handle, `${JSON.stringify(event)}\n`);
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
}

export function prepareRelease(journalPath, inputPlan) {
  const plan = structuredClone(validatePlan(inputPlan));
  const planHash = hash(plan);
  const event = {
    sequence: 1,
    previous_hash: "GENESIS",
    type: "PREPARE",
    state: "PREPARED",
    occurred_at: plan.prepared_at,
    payload: {plan_hash: planHash, plan},
  };
  event.event_hash = eventHash(event);
  persistNewJournal(journalPath, event);
  return {state: event.state, plan_hash: planHash, event_hash: event.event_hash};
}

export function readReleaseJournal(journalPath) {
  if (!fs.existsSync(journalPath)) fail("release journal does not exist");
  const raw = fs.readFileSync(journalPath, "utf8");
  if (!raw.endsWith("\n")) fail("release journal has a partial final event");
  const lines = raw.split("\n").filter(Boolean);
  if (lines.length === 0) fail("release journal is empty");
  const derived = derive(lines);
  derived.events = derived.events.map((event) => structuredClone(event));
  return derived;
}

export function appendReleaseEvent(journalPath, input) {
  object(input, "release event input");
  const current = readReleaseJournal(journalPath);
  const occurredAt = string(input.occurred_at, "occurred_at");
  const payload = structuredClone(object(input.payload, "payload"));
  assertNoSensitiveKeys(payload, "payload");
  const event = {
    sequence: current.events.length + 1,
    previous_hash: current.last_hash,
    type: string(input.type, "type"),
    state: eventState(current.state, input.type),
    occurred_at: occurredAt,
    payload,
  };
  if (Date.parse(occurredAt) < Date.parse(current.events.at(-1).occurred_at)) fail("release journal timestamps must be monotonic");
  validateTransition({...current, planHash: current.plan_hash, event});
  event.event_hash = eventHash(event);
  const handle = fs.openSync(journalPath, "a", 0o640);
  try {
    fs.writeFileSync(handle, `${JSON.stringify(event)}\n`);
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
  return {state: event.state, event_hash: event.event_hash};
}

function findEvent(events, type) {
  return events.find((event) => event.type === type);
}

export function buildReleaseReport(journalPath) {
  const current = readReleaseJournal(journalPath);
  const {plan, events} = current;
  const approval = findEvent(events, "APPROVE")?.payload ?? null;
  const preflight = findEvent(events, "PREFLIGHT_PASS")?.payload ?? null;
  const candidate = findEvent(events, "CANDIDATE_UP")?.payload ?? null;
  const verification = findEvent(events, "VERIFY")?.payload ?? null;
  const cutoverEvent = findEvent(events, "CUTOVER");
  const rollbackEvent = findEvent(events, "ROLLBACK");
  const failure = findEvent(events, "FAIL")?.payload ?? null;
  const retentionStart = cutoverEvent ? iso(cutoverEvent.payload.completed_at, "cutover.completed_at") : iso(plan.prepared_at, "prepared_at");
  const availableUntil = new Date(retentionStart + 7 * 24 * 60 * 60 * 1000).toISOString();
  const cutover = cutoverEvent ? {
    old_runtime_identity: cutoverEvent.payload.old_runtime_identity,
    new_runtime_identity: cutoverEvent.payload.new_runtime_identity,
    started_at: cutoverEvent.payload.started_at,
    completed_at: cutoverEvent.payload.completed_at,
    duration_seconds: (Date.parse(cutoverEvent.payload.completed_at) - Date.parse(cutoverEvent.payload.started_at)) / 1000,
    target_seconds: 300,
    hard_max_seconds: 600,
    target_met: Date.parse(cutoverEvent.payload.completed_at) - Date.parse(cutoverEvent.payload.started_at) <= 300_000,
  } : null;
  return {
    evidence_version: "dsdst.runtime-release.v1",
    release_id: plan.release_id,
    release: plan.release,
    state: current.state,
    journal_head: current.last_hash,
    source_set: plan.source_set,
    images: plan.services.map(({service_id, source_revision, image_reference, image_digest, image_id, config_fingerprint}) => ({service_id, source_revision, image_reference, image_digest, image_id, config_fingerprint})),
    approval,
    backup_id: preflight?.backup_id ?? plan.recovery_point.recovery_point_id,
    migrations: candidate?.hydration?.migrations_ran ?? [],
    migration_preflight: preflight?.migration ?? null,
    checks: verification ? {health: verification.critical_services, smoke: verification.smoke, connectivity: verification.connectivity, provenance: verification.provenance_check} : null,
    cutover,
    rollback: {
      available_until: availableUntil,
      retention_days: 7,
      retained_volume_ids: plan.old_runtime.volume_ids,
      old_stack_mode: cutoverEvent ? cutoverEvent.payload.old_stack_mode : "PLANNED_READ_ONLY_STOPPED",
      used: Boolean(rollbackEvent),
      result: rollbackEvent?.payload ?? null,
      automatic_database_restore: false,
    },
    runtime: {
      previous_identity: plan.old_runtime.runtime_identity,
      candidate_identity: candidate?.runtime_identity ?? null,
      current_identity: rollbackEvent ? rollbackEvent.payload.restored_runtime_identity : cutoverEvent ? cutoverEvent.payload.new_runtime_identity : plan.old_runtime.runtime_identity,
    },
    failure,
  };
}

export const RELEASE_STATES = Object.freeze([
  "PREPARED", "APPROVED", "PREFLIGHT_PASSED", "CANDIDATE_UP", "VERIFIED", "CUTOVER", "COMPLETED", "FAILED", "ROLLED_BACK",
]);

export const ACCEPTED_V2_16_SOURCE_SET = ACCEPTED_V2_16;
