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
const SOURCE_SET_IDS = Object.freeze(["O", "P", "W", "K", "L", "HUB"]);
const ACCEPTED_V2_16_MANIFEST = JSON.parse(fs.readFileSync(new URL("../../config/v2-16-source-set.json", import.meta.url), "utf8"));
const ACCEPTED_V2_17 = JSON.parse(fs.readFileSync(new URL("../../config/v2-17-source-set.json", import.meta.url), "utf8"));
const ACCEPTED_V2_18 = JSON.parse(fs.readFileSync(new URL("../../config/v2-18-source-set.json", import.meta.url), "utf8"));

const manifestRevisions = (manifest) => Object.freeze(Object.fromEntries(manifest.repositories.map(({id, revision}) => [id, revision])));
const ACCEPTED_V2_16 = Object.freeze({
  content: manifestRevisions(ACCEPTED_V2_16_MANIFEST).O,
  closure: ACCEPTED_V2_17.basedOn.operationsClosureRevision,
  repositories: manifestRevisions(ACCEPTED_V2_16_MANIFEST),
});
const RELEASE_PROFILES = Object.freeze({
  "V2-17": Object.freeze({
    sourceSet: ACCEPTED_V2_17,
    acceptedField: "accepted_v2_16_source_set",
    acceptedRelease: "V2-16",
    acceptedSourceSet: ACCEPTED_V2_16_MANIFEST,
    acceptedClosure: ACCEPTED_V2_17.basedOn.operationsClosureRevision,
    recoverySourceSet: ACCEPTED_V2_16_MANIFEST,
  }),
  "V2-18": Object.freeze({
    sourceSet: ACCEPTED_V2_18,
    acceptedField: "accepted_v2_17_source_set",
    acceptedRelease: "V2-17",
    acceptedSourceSet: ACCEPTED_V2_17,
    acceptedClosure: ACCEPTED_V2_18.basedOn.operationsClosureRevision,
    recoverySourceSet: ACCEPTED_V2_18,
  }),
});

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
    if (SENSITIVE_KEY.test(key) && !["secret_config_check", "freeze_token"].includes(key)) fail(`${location}.${key}: secret/sensitive fields are forbidden in release evidence`);
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

export function createEvidenceDigest(value) {
  return hash(value);
}

export function createRouteOperationId(value) {
  const body = structuredClone(object(value, "route operation identity"));
  delete body.operation_id;
  return `routeop-${hash(body).slice("sha256:".length)}`;
}

function verifyBoundEvidence(value, label) {
  const evidence = object(value, label);
  const {evidence_digest: evidenceDigest, ...body} = evidence;
  digest(evidenceDigest, `${label}.evidence_digest`);
  if (evidenceDigest !== hash(body)) fail(`${label} is not bound to the adapter observation`);
  return evidence;
}

function validateChecks(value, label) {
  const checks = object(value, label);
  exactKeys(checks, ["critical_services", "smoke", "connectivity"], label);
  array(checks.critical_services, `${label}.critical_services`).forEach((item) => exactKeys(item, ["service_id", "status"], `${label}.critical service`));
  if (!allPass(checks.critical_services) || checks.critical_services.length !== REQUIRED_SERVICES.size) fail("all critical service health checks must pass");
  const ids = new Set(checks.critical_services.map((item) => item.service_id));
  if ([...REQUIRED_SERVICES.keys()].some((id) => !ids.has(id))) fail("critical service health evidence is incomplete");
  exactKeys(checks.smoke, ["status", "mode"], `${label}.smoke`);
  if (checks.smoke.status !== "PASS" || checks.smoke.mode !== "READ_ONLY") fail("read-only smoke must pass before cutover");
  exactKeys(checks.connectivity, ["status", "checks"], `${label}.connectivity`);
  if (checks.connectivity.status !== "PASS" || array(checks.connectivity.checks, `${label}.connectivity.checks`).length === 0) fail("critical cross-service connectivity checks must pass");
}

function validateRollbackSafety(value, cutoverWatermark) {
  const safety = object(value, "rollback data safety evidence");
  exactKeys(safety, ["mode", "status", "cutover_write_watermark", "candidate_write_watermark", "synchronization_id", "target_write_watermark", "preserves_candidate_writes"], "rollback data safety evidence");
  if (safety.status !== "VERIFIED" || safety.cutover_write_watermark !== cutoverWatermark) fail("rollback data safety proof is not bound to cutover");
  if (safety.mode === "ZERO_CANONICAL_WRITES") {
    if (safety.candidate_write_watermark !== safety.cutover_write_watermark || safety.synchronization_id !== null || safety.preserves_candidate_writes !== true) fail("zero-write rollback proof does not prove zero canonical candidate writes");
  } else if (safety.mode === "CURRENT_STATE_SYNC") {
    if (!safety.synchronization_id || safety.target_write_watermark !== safety.candidate_write_watermark || safety.preserves_candidate_writes !== true) fail("current-state rollback synchronization does not preserve all candidate-era writes");
  } else fail("rollback is blocked without zero-write or verified current-state synchronization proof");
  return safety;
}

function validateRouteObservation(value, intent, expectedTarget) {
  const observation = verifyBoundEvidence(value, "Cloudflare route observation");
  exactKeys(observation, ["operation_id", "provenance_state", "current_target", "observed_at", "operation_state", "operation_applied_at", "evidence_digest"], "Cloudflare route observation");
  if (observation.operation_id !== intent.operation_id || observation.provenance_state !== "VERIFIED" || !["NOT_APPLIED", "PENDING", "APPLIED", "FAILED"].includes(observation.operation_state) || observation.current_target !== expectedTarget || (observation.operation_state === "APPLIED") !== (observation.operation_applied_at !== null)) fail("Cloudflare route observation does not prove the operation target and terminal operation state");
  const observedAt = iso(observation.observed_at, "Cloudflare route observation time");
  if (observation.operation_applied_at !== null && iso(observation.operation_applied_at, "Cloudflare route operation applied_at") > observedAt) fail("route operation cannot be applied after its observation");
  return observation;
}

function validateAuthority(value, intent, oldAuthoritative, candidateAuthoritative) {
  const authority = verifyBoundEvidence(value, "runtime authority evidence");
  exactKeys(authority, ["operation_id", "old_runtime_identity", "candidate_runtime_identity", "old_authoritative", "candidate_authoritative", "evidence_digest"], "runtime authority evidence");
  if (authority.operation_id !== intent.operation_id || authority.old_runtime_identity !== intent.old_runtime_identity || authority.candidate_runtime_identity !== intent.new_runtime_identity || authority.old_authoritative !== oldAuthoritative || authority.candidate_authoritative !== candidateAuthoritative || authority.old_authoritative === authority.candidate_authoritative) fail("runtime authority evidence must prove exactly one authoritative writer");
  return authority;
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
  for (const id of SOURCE_SET_IDS) {
    if (!result[id]) fail(`${label} is missing ${id}`);
  }
  if (Object.keys(result).length !== SOURCE_SET_IDS.length) fail(`${label} must contain the exact O/P/W/K/L/HUB source set`);
  return result;
}

function sameRevisionMap(actual, expected, label) {
  for (const [id, revision] of Object.entries(expected)) {
    if (actual[id] !== revision) fail(`${label} ${id} revision does not match the exact accepted source set`);
  }
}

function releaseProfile(release) {
  const profile = RELEASE_PROFILES[release];
  if (!profile) fail(`unsupported release profile: ${release}`);
  return profile;
}

function validateAcceptedSourceSet(plan, profile) {
  const label = profile.acceptedField;
  const accepted = object(plan[label], label);
  const expected = manifestRevisions(profile.acceptedSourceSet);
  if (accepted.release !== profile.acceptedRelease) fail(`accepted source set must identify ${profile.acceptedRelease}`);
  if (accepted.operations_content_revision !== expected.O) fail(`${profile.acceptedRelease} accepted content revision mismatch`);
  if (accepted.operations_closure_revision !== profile.acceptedClosure) fail(`${profile.acceptedRelease} accepted closure revision mismatch`);
  sameRevisionMap(revisionMap(accepted, label), expected, `accepted ${profile.acceptedRelease} source set`);
}

function validateRecovery(plan, at) {
  const profile = releaseProfile(plan.release);
  const expectedRelease = profile.recoverySourceSet.release;
  const expectedRevisions = manifestRevisions(profile.recoverySourceSet);
  const recovery = object(plan.recovery_point, "recovery_point");
  exactKeys(recovery, ["recovery_point_id", "created_at", "status", "verification_state", "offsite_state", "restored_drill_state", "source_release", "source_repositories"], "recovery_point");
  string(recovery.recovery_point_id, "recovery_point.recovery_point_id");
  if (recovery.status !== "SUCCESS" || recovery.verification_state !== "VERIFIED" || recovery.offsite_state !== "PERSISTED" || recovery.restored_drill_state !== "VERIFIED") {
    fail(`${expectedRelease} recovery point must be SUCCESS, VERIFIED, offsite PERSISTED, and restore-drill VERIFIED`);
  }
  if (recovery.source_release !== expectedRelease) fail(`recovery point must identify ${expectedRelease}`);
  const maximumAge = plan.recovery_max_age_seconds;
  if (!Number.isInteger(maximumAge) || maximumAge <= 0 || maximumAge > 3600) fail(`recovery_max_age_seconds must be explicitly approved and cannot exceed the accepted ${expectedRelease} 60-minute RPO`);
  const createdAt = iso(recovery.created_at, "recovery_point.created_at");
  const checkedAt = iso(at, "recovery freshness check time");
  if (createdAt > checkedAt || checkedAt - createdAt > maximumAge * 1000) fail(`${expectedRelease} recovery point is stale; freshness gate failed`);
  sameRevisionMap(revisionMap({repositories: recovery.source_repositories}, "recovery_point.source_repositories"), expectedRevisions, "recovery point source set");
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
  assertNoSensitiveKeys(plan, "release plan");
  if (!RELEASE_ID.test(string(plan.release_id, "release_id"))) fail("invalid release_id");
  const profile = releaseProfile(string(plan.release, "release"));
  exactKeys(plan, ["release_id", "release", "prepared_at", "recovery_max_age_seconds", "source_set", profile.acceptedField, "services", "recovery_point", "old_runtime", "candidate", "route", "rollback"], "release plan");
  iso(plan.prepared_at, "prepared_at");
  validateAcceptedSourceSet(plan, profile);
  const sourceSet = object(plan.source_set, "source_set");
  if (sourceSet.release !== plan.release) fail(`source_set must identify ${plan.release}`);
  const sources = revisionMap(sourceSet, "source_set");
  sameRevisionMap(sources, revisionMap(profile.sourceSet, `config/${plan.release.toLowerCase()}-source-set.json`), `${plan.release} source set`);
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
    VERIFIED: ["FREEZE", "FINAL_CONVERGENCE", "ROUTE_INTENT", "CUTOVER", "CUTOVER_ABORTED", "ROUTE_UNCERTAIN", "FAIL"],
    CUTOVER: ["COMPLETE", "ROUTE_INTENT", "ROLLBACK", "ROLLBACK_ABORTED", "ROUTE_UNCERTAIN", "FAIL"],
    FAILED: ["ROUTE_INTENT", "ROLLBACK", "ROLLBACK_ABORTED", "ROUTE_UNCERTAIN"],
    COMPLETED: ["ROUTE_INTENT", "ROLLBACK", "ROLLBACK_ABORTED", "ROUTE_UNCERTAIN"],
    ROLLED_BACK: [],
  };
  if (!legal[state]?.includes(event.type)) {
    if (state === "PREPARED") fail(`manual approval is required; illegal release transition from ${state}`);
    fail(`illegal release transition from ${state}; ${event.type} is blocked`);
  }
  const expectedStates = {
    APPROVE: "APPROVED", PREFLIGHT_PASS: "PREFLIGHT_PASSED", CANDIDATE_UP: "CANDIDATE_UP",
    VERIFY: "VERIFIED", FREEZE: "VERIFIED", FINAL_CONVERGENCE: "VERIFIED", ROUTE_INTENT: state,
    CUTOVER: "CUTOVER", CUTOVER_ABORTED: "FAILED", COMPLETE: "COMPLETED", FAIL: "FAILED",
    ROLLBACK: "ROLLED_BACK", ROLLBACK_ABORTED: state, ROUTE_UNCERTAIN: "FAILED",
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
    exactKeys(p, ["project", "runtime_identity", "volume_ids", "host_bindings", "hydration", "runtime_provenance"], "candidate evidence");
    if (p.project !== plan.candidate.project) fail("candidate Compose project mismatch");
    string(p.runtime_identity, "candidate runtime identity");
    const candidateVolumes = array(p.volume_ids, "candidate volume_ids");
    const oldVolumes = new Set(plan.old_runtime.volume_ids);
    if (candidateVolumes.some((id) => oldVolumes.has(id))) fail("candidate cannot mount an old production volume");
    if (canonical(candidateVolumes) !== canonical(plan.candidate.volume_ids)) fail("candidate volume identities differ from the approved plan");
    if (canonical(p.host_bindings) !== canonical(plan.candidate.host_bindings)) fail("candidate host bindings differ from the approved plan");
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
  } else if (event.type === "FREEZE") {
    exactKeys(p, ["runtime_adapter", "adapter_evidence"], "write freeze evidence");
    if (p.runtime_adapter !== "dsdst-runtime-switch-v1") fail("write freeze must come from the approved runtime adapter");
    const evidence = verifyBoundEvidence(p.adapter_evidence, "runtime freeze adapter evidence");
    exactKeys(evidence, ["action", "freeze_token", "freeze_started_at", "runtime_identity", "source_data_watermark", "write_state", "evidence_digest"], "runtime freeze adapter evidence");
    if (evidence.action !== "freeze-writes" || evidence.write_state !== "FROZEN") fail("runtime adapter did not authoritatively freeze old production writes");
    if (!/^freeze-[a-z0-9-]{8,80}$/.test(string(evidence.freeze_token, "freeze token"))) fail("runtime adapter freeze token is invalid");
    if (evidence.runtime_identity !== plan.old_runtime.runtime_identity) fail("write freeze runtime identity mismatch");
    string(evidence.source_data_watermark, "source data watermark");
    const freezeAt = iso(evidence.freeze_started_at, "runtime freeze time");
    const recordedAt = iso(event.occurred_at, "write freeze recorded time");
    if (freezeAt > recordedAt || recordedAt - freezeAt > 60_000) fail("write freeze time is not an authoritative current adapter observation");
    if (context.events.some((item) => item.type === "FREEZE")) fail("write freeze can be recorded only once");
  } else if (event.type === "FINAL_CONVERGENCE") {
    exactKeys(p, ["freeze_token", "final_snapshot", "candidate_hydration", "final_candidate"], "final convergence evidence");
    const freeze = context.events.find((item) => item.type === "FREEZE")?.payload.adapter_evidence;
    if (!freeze || p.freeze_token !== freeze.freeze_token) fail("final convergence must bind the authoritative runtime freeze token");
    const snapshot = object(p.final_snapshot, "final cutover snapshot");
    exactKeys(snapshot, ["snapshot_id", "created_at", "source_data_watermark", "status", "components", "manifest_hash"], "final cutover snapshot");
    string(snapshot.snapshot_id, "final snapshot id");
    if (snapshot.status !== "VERIFIED" || snapshot.source_data_watermark !== freeze.source_data_watermark) fail("final snapshot must contain the frozen-current production watermark");
    if (iso(snapshot.created_at, "final snapshot created_at") < iso(freeze.freeze_started_at, "freeze time")) fail("final snapshot predates the authoritative write freeze");
    const required = new Set(["P_DB", "P_UPLOADS", "K_DB", "K_UPLOADS", "L_STATE", "HUB_DB", "HUB_ATTACHMENTS"]);
    const components = array(snapshot.components, "final snapshot components");
    for (const component of components) {
      exactKeys(component, ["authority", "kind", "capture_method", "content_hash"], "final snapshot component");
      if (!required.delete(component.authority)) fail("final snapshot contains an unexpected or duplicate mutable authority");
      if (!["sqlite", "files"].includes(component.kind)) fail("final snapshot component kind is invalid");
      if (component.kind === "sqlite" && !["online-sqlite-backup", "stopped-consistent-copy"].includes(component.capture_method)) fail("live writable SQLite databases must use online backup or safe stopped-state copy semantics");
      if (component.kind === "files" && !["frozen-filesystem-snapshot", "stopped-consistent-copy"].includes(component.capture_method)) fail("mutable file state must use frozen or stopped consistent snapshot semantics");
      digest(component.content_hash, "final snapshot component hash");
    }
    if (required.size > 0) fail(`final snapshot is missing mutable authoritative state: ${[...required].join(", ")}`);
    const manifestBody = {snapshot_id: snapshot.snapshot_id, created_at: snapshot.created_at, source_data_watermark: snapshot.source_data_watermark, status: snapshot.status, components};
    if (snapshot.manifest_hash !== hash(manifestBody)) fail("final snapshot manifest hash verification failed");
    const hydration = object(p.candidate_hydration, "final candidate hydration");
    exactKeys(hydration, ["status", "snapshot_id", "old_volume_mounted", "completed_at", "migrations_ran"], "final candidate hydration");
    if (hydration.status !== "PASS" || hydration.snapshot_id !== snapshot.snapshot_id || hydration.old_volume_mounted !== false) fail("candidate must be hydrated only from the final frozen-current snapshot");
    if (iso(hydration.completed_at, "final hydration completed_at") < iso(snapshot.created_at, "final snapshot created_at")) fail("final hydration cannot precede the final snapshot");
    const migrations = array(hydration.migrations_ran, "post-final-hydration migrations");
    migrations.forEach((item) => string(item, "post-final-hydration migration identity"));
    const candidate = object(p.final_candidate, "final candidate verification");
    exactKeys(candidate, ["runtime_identity", "runtime_provenance", "schema_provenance", "data_verification", "checks", "candidate_authoritative"], "final candidate verification");
    if (candidate.candidate_authoritative !== false) fail("candidate must remain non-authoritative until explicit route cutover");
    if (!/^runtime-[a-f0-9]{64}$/.test(string(candidate.runtime_identity, "final candidate runtime identity"))) fail("final candidate runtime identity is invalid");
    const provenance = object(candidate.runtime_provenance, "final candidate runtime provenance");
    exactKeys(provenance, ["collector", "capture_id", "captured_at", "services"], "final candidate runtime provenance");
    if (provenance.collector !== "dsdst-read-only-runtime-collector-v1" || provenance.capture_id !== candidate.runtime_identity || provenance.capture_id !== createRuntimeCaptureId(provenance.captured_at, provenance.services)) fail("final candidate runtime provenance is not collector-bound");
    if (iso(provenance.captured_at, "final candidate provenance captured_at") < iso(hydration.completed_at, "final hydration completed_at")) fail("final candidate provenance must be recollected after hydration and migration");
    if (array(provenance.services, "final candidate provenance services").length !== REQUIRED_SERVICES.size) fail("final candidate runtime provenance is incomplete");
    const planned = new Map(plan.services.map((service) => [service.service_id, service]));
    const observed = new Set();
    const oldVolumes = new Set(plan.old_runtime.volume_ids);
    for (const record of provenance.services) {
      const expected = planned.get(record.service_id);
      if (!expected || observed.has(record.service_id) || record.capture_id !== provenance.capture_id || record.source_repository !== expected.repository || record.revision !== expected.source_revision || record.declared_image_reference !== expected.image_reference || record.image_digest !== expected.image_digest || record.image_id !== expected.image_id || record.configuration?.status !== "VERIFIED" || record.configuration?.redacted !== true || record.configuration?.fingerprint !== expected.config_fingerprint) fail(`final candidate provenance mismatch for ${record.service_id}`);
      observed.add(record.service_id);
      for (const volume of array(record.volumes, `final ${record.service_id}.volumes`)) {
        if (oldVolumes.has(volume.source_id) || !plan.candidate.volume_ids.includes(volume.source_id)) fail("final candidate provenance observed an old or unapproved volume");
      }
      for (const port of array(record.ports, `final ${record.service_id}.ports`)) {
        if (port.exposure === "published" && port.host_ip !== "127.0.0.1") fail("final candidate provenance observed a non-loopback host binding");
      }
    }
    const schema = object(candidate.schema_provenance, "final candidate schema provenance");
    exactKeys(schema, ["status", "fingerprint", "migrations"], "final candidate schema provenance");
    if (schema.status !== "VERIFIED" || canonical(schema.migrations) !== canonical(migrations)) fail("final schema provenance must bind the migrations run after final hydration");
    digest(schema.fingerprint, "final schema fingerprint");
    exactKeys(candidate.data_verification, ["status", "source_data_watermark"], "final candidate data verification");
    if (candidate.data_verification.status !== "PASS" || candidate.data_verification.source_data_watermark !== snapshot.source_data_watermark) fail("final candidate data verification does not contain the newest frozen production state");
    validateChecks(candidate.checks, "final candidate checks");
    if (iso(event.occurred_at, "final convergence event time") < iso(provenance.captured_at, "final provenance time")) fail("final convergence cannot be recorded before final provenance collection");
    if (context.events.some((item) => item.type === "FINAL_CONVERGENCE")) fail("final convergence can be recorded only once");
  } else if (event.type === "ROUTE_INTENT") {
    exactKeys(p, ["release_id", "operation_id", "action", "expected_target", "desired_target", "old_runtime_identity", "new_runtime_identity", "freeze_token", "final_snapshot_id", "started_at", "deadline_at", "candidate_write_watermark", "rollback_safety"], "route mutation intent");
    if (p.release_id !== plan.release_id || !/^routeop-[a-f0-9]{64}$/.test(string(p.operation_id, "route operation id")) || p.operation_id !== createRouteOperationId(p)) fail("route operation id must stably bind the complete durable intent");
    const freeze = context.events.find((item) => item.type === "FREEZE")?.payload.adapter_evidence;
    const convergence = context.events.find((item) => item.type === "FINAL_CONVERGENCE")?.payload;
    const cutover = context.events.find((item) => item.type === "CUTOVER");
    if (!freeze || !convergence || p.old_runtime_identity !== plan.old_runtime.runtime_identity || p.new_runtime_identity !== convergence.final_candidate.runtime_identity || p.freeze_token !== freeze.freeze_token || p.final_snapshot_id !== convergence.final_snapshot.snapshot_id) fail("route intent runtime/freeze/final-snapshot references are not exact");
    const startedAt = iso(p.started_at, "route intent started_at");
    const deadlineAt = iso(p.deadline_at, "route intent deadline_at");
    if (deadlineAt <= startedAt || deadlineAt - startedAt > 600_000 || iso(event.occurred_at, "route intent recorded_at") > deadlineAt) fail("route intent deadline must be durable before mutation and within ten minutes");
    const priorIntent = [...context.events].reverse().find((item) => item.type === "ROUTE_INTENT");
    if (priorIntent) {
      const closed = context.events.some((item) => ["CUTOVER", "ROLLBACK", "CUTOVER_ABORTED", "ROLLBACK_ABORTED", "ROUTE_UNCERTAIN"].includes(item.type) && item.payload.operation_id === priorIntent.payload.operation_id);
      if (!closed) fail("an unresolved route intent must be reconciled; a second mutation intent is forbidden");
      if (priorIntent.payload.action === p.action) fail("route operation identity is single-use after a terminal outcome");
    }
    if (p.action === "CUTOVER") {
      if (state !== "VERIFIED" || cutover || p.expected_target !== plan.old_runtime.route_target || p.desired_target !== plan.candidate.route_target || p.candidate_write_watermark !== convergence.final_snapshot.source_data_watermark || p.rollback_safety !== null) fail("cutover intent does not bind the verified old-to-candidate transition");
    } else if (p.action === "ROLLBACK") {
      if (!cutover || !["CUTOVER", "COMPLETED", "FAILED"].includes(state) || p.expected_target !== plan.candidate.route_target || p.desired_target !== plan.old_runtime.route_target) fail("rollback intent does not bind the candidate-to-old transition");
      validateRollbackSafety(p.rollback_safety, cutover.payload.candidate_write_watermark);
      if (p.candidate_write_watermark !== p.rollback_safety.candidate_write_watermark) fail("rollback intent candidate watermark mismatch");
    } else fail("route intent action must be CUTOVER or ROLLBACK");
  } else if (event.type === "CUTOVER") {
    exactKeys(p, ["operation_id", "explicit", "approval_id", "route_provenance_state", "route_observation", "authority_evidence", "old_runtime_identity", "new_runtime_identity", "old_target", "new_target", "started_at", "completed_at", "old_stack_mode", "freeze_token", "final_snapshot_id", "candidate_write_watermark"], "cutover evidence");
    if (p.explicit !== true || p.approval_id !== approval?.approval_id) fail("cutover requires the exact explicit manual approval");
    if (p.route_provenance_state !== "VERIFIED") fail("Cloudflare route provenance must be verified before cutover");
    if (p.old_runtime_identity !== plan.old_runtime.runtime_identity) fail("cutover old runtime identity mismatch");
    const freeze = context.events?.find?.((item) => item.type === "FREEZE")?.payload.adapter_evidence;
    const convergence = context.events?.find?.((item) => item.type === "FINAL_CONVERGENCE")?.payload;
    const intent = [...context.events].reverse().find((item) => item.type === "ROUTE_INTENT" && item.payload.action === "CUTOVER")?.payload;
    if (!intent || p.operation_id !== intent.operation_id) fail("cutover requires its exact durable route intent");
    const observation = validateRouteObservation(p.route_observation, intent, intent.desired_target);
    if (observation.operation_applied_at === null || iso(observation.operation_applied_at, "cutover applied_at") > iso(intent.deadline_at, "cutover deadline")) fail("cutover success requires adapter-recorded application within the durable deadline");
    validateAuthority(p.authority_evidence, intent, false, true);
    if (!freeze || !convergence) fail("cutover is blocked until authoritative freeze and final convergence complete");
    if (p.new_runtime_identity !== convergence.final_candidate.runtime_identity) fail("cutover new runtime identity mismatch");
    if (p.old_target !== plan.old_runtime.route_target || p.new_target !== plan.candidate.route_target) fail("cutover route targets differ from the approved plan");
    if (p.old_stack_mode !== "RETAINED_READ_ONLY_NOT_DATA_SAFE") fail("old stack must be retained read-only without being falsely classified as data-safe");
    if (p.freeze_token !== freeze.freeze_token || p.started_at !== freeze.freeze_started_at) fail("cutover duration must begin at the authoritative runtime write freeze");
    if (p.final_snapshot_id !== convergence.final_snapshot.snapshot_id) fail("cutover must bind the final frozen-current snapshot");
    if (p.candidate_write_watermark !== convergence.final_snapshot.source_data_watermark) fail("candidate cutover watermark must equal the final frozen-current source watermark");
    if (p.completed_at !== observation.operation_applied_at || p.started_at !== intent.started_at) fail("cutover timestamps must come from the durable intent and adapter-recorded route application");
    const duration = iso(p.completed_at, "cutover.completed_at") - iso(p.started_at, "cutover.started_at");
    if (duration < 0 || duration > 600_000) fail("cutover exceeded the hard 10 minute interruption maximum");
  } else if (event.type === "CUTOVER_ABORTED") {
    exactKeys(p, ["operation_id", "action", "reason", "route_observation", "authority_evidence", "candidate_authoritative", "old_writes_resumed"], "cutover abort evidence");
    const intent = [...context.events].reverse().find((item) => item.type === "ROUTE_INTENT" && item.payload.operation_id === p.operation_id)?.payload;
    if (!intent || intent.action !== "CUTOVER" || p.action !== "CUTOVER" || p.old_writes_resumed !== true || p.candidate_authoritative !== false) fail("cutover abort must bind the open cutover intent and restore old authority");
    validateRouteObservation(p.route_observation, intent, intent.expected_target);
    if (p.route_observation.operation_applied_at !== null || !["NOT_APPLIED", "FAILED"].includes(p.route_observation.operation_state)) fail("unchanged cutover route requires a terminal not-applied/failed operation observation");
    validateAuthority(p.authority_evidence, intent, true, false);
    string(p.reason, "cutover abort reason");
  } else if (event.type === "ROLLBACK_ABORTED") {
    exactKeys(p, ["operation_id", "action", "reason", "route_observation", "authority_evidence", "candidate_authoritative"], "rollback abort evidence");
    const intent = [...context.events].reverse().find((item) => item.type === "ROUTE_INTENT" && item.payload.operation_id === p.operation_id)?.payload;
    if (!intent || intent.action !== "ROLLBACK" || p.action !== "ROLLBACK" || p.candidate_authoritative !== true) fail("rollback abort must bind the open rollback intent and retain candidate authority");
    validateRouteObservation(p.route_observation, intent, intent.expected_target);
    if (p.route_observation.operation_applied_at !== null || !["NOT_APPLIED", "FAILED"].includes(p.route_observation.operation_state)) fail("unchanged rollback route requires a terminal not-applied/failed operation observation");
    validateAuthority(p.authority_evidence, intent, false, true);
    string(p.reason, "rollback abort reason");
  } else if (event.type === "ROUTE_UNCERTAIN") {
    exactKeys(p, ["operation_id", "action", "condition", "reason", "observed_target", "route_observation", "authority_evidence", "writers_fenced"], "uncertain route evidence");
    const intent = [...context.events].reverse().find((item) => item.type === "ROUTE_INTENT" && item.payload.operation_id === p.operation_id)?.payload;
    const targetConflict = p.route_observation?.operation_state === "PENDING" || (p.condition === "UNEXPECTED_TARGET" ? [intent?.expected_target, intent?.desired_target].includes(p.observed_target) : p.condition === "DESIRED_BEFORE_MUTATION" ? p.observed_target !== intent?.desired_target || p.route_observation?.operation_applied_at !== null : p.condition === "APPLIED_BUT_REVERTED" ? p.observed_target !== intent?.expected_target || p.route_observation?.operation_applied_at === null : true);
    if (!intent || p.action !== intent.action || targetConflict || p.writers_fenced !== true) fail("uncertain route must bind the open operation, describe the observed conflict, and fence all writers");
    validateRouteObservation(p.route_observation, intent, p.observed_target);
    const authority = verifyBoundEvidence(p.authority_evidence, "fenced runtime authority evidence");
    exactKeys(authority, ["operation_id", "old_runtime_identity", "candidate_runtime_identity", "old_authoritative", "candidate_authoritative", "evidence_digest"], "fenced runtime authority evidence");
    if (authority.operation_id !== intent.operation_id || authority.old_authoritative !== false || authority.candidate_authoritative !== false) fail("unexpected route target must fence both writers");
    string(p.reason, "route uncertainty reason");
  } else if (event.type === "COMPLETE") {
    exactKeys(p, ["result", "runtime_adapter", "adapter_evidence"], "completion evidence");
    if (p.result !== "SUCCESS") fail("completed release result must be SUCCESS");
    if (p.runtime_adapter !== "dsdst-runtime-switch-v1") fail("post-cutover write watermark must come from the approved runtime adapter");
    const evidence = verifyBoundEvidence(p.adapter_evidence, "post-cutover runtime adapter evidence");
    exactKeys(evidence, ["action", "runtime_identity", "candidate_write_watermark", "observed_at", "status", "evidence_digest"], "post-cutover runtime adapter evidence");
    const cutover = context.events?.find?.((item) => item.type === "CUTOVER");
    if (!cutover || evidence.action !== "observe-candidate-write-watermark" || evidence.runtime_identity !== cutover.payload.new_runtime_identity || evidence.status !== "VERIFIED" || iso(evidence.observed_at, "candidate write watermark observed_at") < iso(cutover.payload.completed_at, "cutover completed_at")) fail("candidate write watermark after cutover is not authoritative");
    string(evidence.candidate_write_watermark, "candidate write watermark after cutover");
  } else if (event.type === "FAIL") {
    const freeze = context.events?.find?.((item) => item.type === "FREEZE")?.payload.adapter_evidence;
    exactKeys(p, freeze && state === "VERIFIED" ? ["reason", "route_mutated", "candidate_authoritative", "old_writes_resumed", "freeze_token", "old_runtime_identity", "route_target", "resume_evidence"] : ["reason", "route_mutated"], "failure evidence");
    string(p.reason, "failure.reason");
    if (p.route_mutated !== false && state !== "CUTOVER") fail("pre-cutover failure must prove the route was not mutated");
    if (freeze && state === "VERIFIED") {
      if (p.route_mutated !== false || p.candidate_authoritative !== false || p.old_writes_resumed !== true || p.freeze_token !== freeze.freeze_token || p.old_runtime_identity !== plan.old_runtime.runtime_identity || p.route_target !== plan.old_runtime.route_target) fail("failure after freeze must resume the old writer, keep candidate non-authoritative, and leave route unchanged");
      const resume = verifyBoundEvidence(p.resume_evidence, "runtime resume adapter evidence");
      exactKeys(resume, ["action", "freeze_token", "runtime_identity", "write_state", "evidence_digest"], "runtime resume adapter evidence");
      if (resume.action !== "resume-old-writes" || resume.freeze_token !== freeze.freeze_token || resume.runtime_identity !== plan.old_runtime.runtime_identity || resume.write_state !== "ENABLED") fail("runtime adapter did not prove old production writes resumed");
    }
  } else if (event.type === "ROLLBACK") {
    exactKeys(p, ["operation_id", "explicit", "reason", "route_provenance_state", "route_observation", "authority_evidence", "from_runtime_identity", "restored_runtime_identity", "restored_target", "database_restore_used", "started_at", "completed_at", "rollback_safety"], "rollback evidence");
    if (p.explicit !== true || p.route_provenance_state !== "VERIFIED") fail("rollback must be explicit and route provenance VERIFIED");
    string(p.reason, "rollback.reason");
    if (p.from_runtime_identity === p.restored_runtime_identity || p.restored_runtime_identity !== plan.old_runtime.runtime_identity) fail("rollback must restore the previous runtime identity");
    if (p.restored_target !== plan.old_runtime.route_target) fail("rollback must restore the previous route target");
    if (p.database_restore_used !== false) fail("automatic production database restore is forbidden during rollback");
    const cutover = context.events?.find?.((item) => item.type === "CUTOVER");
    if (!cutover) fail("rollback requires a recorded cutover");
    validateRollbackSafety(p.rollback_safety, cutover.payload.candidate_write_watermark);
    const intent = [...context.events].reverse().find((item) => item.type === "ROUTE_INTENT" && item.payload.action === "ROLLBACK")?.payload;
    if (!intent || p.operation_id !== intent.operation_id || canonical(p.rollback_safety) !== canonical(intent.rollback_safety)) fail("rollback requires its exact durable route intent and safety proof");
    const observation = validateRouteObservation(p.route_observation, intent, intent.desired_target);
    if (observation.operation_applied_at === null || iso(observation.operation_applied_at, "rollback applied_at") > iso(intent.deadline_at, "rollback deadline")) fail("rollback success requires adapter-recorded application within the durable deadline");
    validateAuthority(p.authority_evidence, intent, true, false);
    if (p.started_at !== intent.started_at || p.completed_at !== observation.operation_applied_at) fail("rollback timestamps must come from the durable intent and adapter-recorded route application");
    const duration = iso(p.completed_at, "rollback.completed_at") - iso(p.started_at, "rollback.started_at");
    if (duration < 0 || duration > 600_000) fail("rollback exceeded the hard 10 minute interruption maximum");
    const retentionStart = cutover ? iso(cutover.payload.completed_at, "cutover.completed_at") : iso(plan.prepared_at, "prepared_at");
    if (iso(p.completed_at, "rollback applied time") > retentionStart + 7 * 24 * 60 * 60 * 1000) fail("seven-day rollback retention window had expired when the route operation was applied");
  }
  return {state: event.state, approval};
}

function eventState(currentState, type) {
  return ({
    APPROVE: "APPROVED", PREFLIGHT_PASS: "PREFLIGHT_PASSED", CANDIDATE_UP: "CANDIDATE_UP",
    VERIFY: "VERIFIED", FREEZE: "VERIFIED", FINAL_CONVERGENCE: "VERIFIED", ROUTE_INTENT: currentState,
    CUTOVER: "CUTOVER", CUTOVER_ABORTED: "FAILED", COMPLETE: "COMPLETED", FAIL: "FAILED",
    ROLLBACK: "ROLLED_BACK", ROLLBACK_ABORTED: currentState, ROUTE_UNCERTAIN: "FAILED",
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
  const freeze = findEvent(events, "FREEZE")?.payload.adapter_evidence ?? null;
  const convergence = findEvent(events, "FINAL_CONVERGENCE")?.payload ?? null;
  const cutoverEvent = findEvent(events, "CUTOVER");
  const rollbackEvent = findEvent(events, "ROLLBACK");
  const routeUncertain = findEvent(events, "ROUTE_UNCERTAIN");
  const completion = findEvent(events, "COMPLETE")?.payload.adapter_evidence ?? null;
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
    evidence_version: "dsdst.runtime-release.v2",
    release_id: plan.release_id,
    release: plan.release,
    state: current.state,
    journal_head: current.last_hash,
    source_set: plan.source_set,
    images: plan.services.map(({service_id, source_revision, image_reference, image_digest, image_id, config_fingerprint}) => ({service_id, source_revision, image_reference, image_digest, image_id, config_fingerprint})),
    approval,
    backup_id: preflight?.backup_id ?? plan.recovery_point.recovery_point_id,
    migrations: convergence?.candidate_hydration?.migrations_ran ?? candidate?.hydration?.migrations_ran ?? [],
    migration_preflight: preflight?.migration ?? null,
    checks: verification ? {health: verification.critical_services, smoke: verification.smoke, connectivity: verification.connectivity, provenance: verification.provenance_check} : null,
    write_freeze: freeze ? {
      freeze_token: freeze.freeze_token,
      started_at: freeze.freeze_started_at,
      runtime_identity: freeze.runtime_identity,
      source_data_watermark: freeze.source_data_watermark,
    } : null,
    final_convergence: convergence ? {
      snapshot_id: convergence.final_snapshot.snapshot_id,
      snapshot_hashes: convergence.final_snapshot.components.map(({authority, content_hash}) => ({authority, content_hash})),
      source_data_watermark: convergence.final_snapshot.source_data_watermark,
      hydration_snapshot_id: convergence.candidate_hydration.snapshot_id,
      migrations: convergence.candidate_hydration.migrations_ran,
      candidate_runtime_identity: convergence.final_candidate.runtime_identity,
      schema_provenance: convergence.final_candidate.schema_provenance,
      data_verification: convergence.final_candidate.data_verification,
      checks: convergence.final_candidate.checks,
    } : null,
    route_operations: events.filter((entry) => ["ROUTE_INTENT", "CUTOVER", "ROLLBACK", "CUTOVER_ABORTED", "ROLLBACK_ABORTED", "ROUTE_UNCERTAIN"].includes(entry.type)).map(({type, state, occurred_at, payload}) => ({type, state, occurred_at, operation_id: payload.operation_id, action: payload.action ?? (type === "CUTOVER" ? "CUTOVER" : type === "ROLLBACK" ? "ROLLBACK" : null), expected_target: payload.expected_target ?? null, desired_target: payload.desired_target ?? null, observed_target: payload.route_observation?.current_target ?? payload.observed_target ?? null})),
    cutover,
    candidate_write_watermark_after_cutover: completion ? {watermark: completion.candidate_write_watermark, observed_at: completion.observed_at, runtime_identity: completion.runtime_identity} : rollbackEvent ? {watermark: rollbackEvent.payload.rollback_safety.candidate_write_watermark, observed_at: rollbackEvent.payload.started_at, runtime_identity: rollbackEvent.payload.from_runtime_identity} : null,
    rollback: {
      available_until: availableUntil,
      retention_days: 7,
      retained_volume_ids: plan.old_runtime.volume_ids,
      old_stack_mode: cutoverEvent ? cutoverEvent.payload.old_stack_mode : "PLANNED_RETAINED_READ_ONLY_NOT_DATA_SAFE",
      used: Boolean(rollbackEvent),
      result: rollbackEvent?.payload ?? null,
      automatic_database_restore: false,
    },
    runtime: {
      previous_identity: plan.old_runtime.runtime_identity,
      candidate_identity: convergence?.final_candidate?.runtime_identity ?? candidate?.runtime_identity ?? null,
      current_identity: routeUncertain ? null : rollbackEvent ? rollbackEvent.payload.restored_runtime_identity : cutoverEvent ? cutoverEvent.payload.new_runtime_identity : plan.old_runtime.runtime_identity,
    },
    failure,
  };
}

export const RELEASE_STATES = Object.freeze([
  "PREPARED", "APPROVED", "PREFLIGHT_PASSED", "CANDIDATE_UP", "VERIFIED", "CUTOVER", "COMPLETED", "FAILED", "ROLLED_BACK",
]);

export const ACCEPTED_V2_16_SOURCE_SET = ACCEPTED_V2_16;
