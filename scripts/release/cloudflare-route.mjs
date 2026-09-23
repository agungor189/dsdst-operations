#!/usr/bin/env node

import {createHash} from "node:crypto";
import {spawnSync} from "node:child_process";
import {
  appendReleaseEvent,
  createEvidenceDigest,
  createRouteOperationId,
  readReleaseJournal,
} from "./release-lib.mjs";
import {reconcileRouteOperation} from "./route-reconcile.mjs";

const [action, journalPath] = process.argv.slice(2);

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function executable(name) {
  const value = process.env[name];
  if (!value || !value.startsWith("/")) throw new Error(`${name} must be an absolute executable path`);
  return value;
}

function run(executablePath, args, extraEnvironment = {}) {
  const result = spawnSync(executablePath, args, {
    encoding: "utf8",
    env: {...process.env, ...extraEnvironment},
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
  });
  if (result.status !== 0) throw new Error(`release adapter failed closed (${executablePath}, exit ${result.status ?? "unknown"})`);
  let output;
  try {
    output = JSON.parse(result.stdout);
  } catch {
    throw new Error(`release adapter returned invalid JSON (${executablePath})`);
  }
  return output;
}

function candidateIdentity(events) {
  const event = events.find((entry) => entry.type === "FINAL_CONVERGENCE");
  if (!event) throw new Error("candidate runtime identity is unavailable");
  return event.payload.final_candidate.runtime_identity;
}

function event(events, type) {
  return events.find((entry) => entry.type === type);
}

function rollbackSafetyEligible(safety, cutoverWatermark) {
  if (!safety || safety.status !== "VERIFIED" || safety.cutover_write_watermark !== cutoverWatermark || safety.preserves_candidate_writes !== true) return false;
  if (safety.mode === "ZERO_CANONICAL_WRITES") return safety.candidate_write_watermark === cutoverWatermark && safety.synchronization_id === null;
  if (safety.mode === "CURRENT_STATE_SYNC") return Boolean(safety.synchronization_id) && safety.target_write_watermark === safety.candidate_write_watermark;
  return false;
}

const ROUTE_OUTCOMES = new Set(["CUTOVER", "ROLLBACK", "CUTOVER_ABORTED", "ROLLBACK_ABORTED", "ROUTE_UNCERTAIN"]);

function unresolvedIntent(events, action) {
  const intentEvent = [...events].reverse().find((entry) => entry.type === "ROUTE_INTENT" && entry.payload.action === action);
  if (!intentEvent) return null;
  return events.some((entry) => ROUTE_OUTCOMES.has(entry.type) && entry.payload.operation_id === intentEvent.payload.operation_id) ? null : intentEvent.payload;
}

function observedRoute(adapter, environment, intent) {
  const raw = run(adapter, ["observe", "--operation-id", intent.operation_id], environment);
  const body = {operation_id: raw.operation_id, provenance_state: raw.provenance_state, current_target: raw.current_target, observed_at: raw.observed_at, operation_state: raw.operation_state, operation_applied_at: raw.operation_applied_at ?? null};
  const observedAt = Date.parse(body.observed_at);
  const appliedAt = body.operation_applied_at === null ? null : Date.parse(body.operation_applied_at);
  if (body.operation_id !== intent.operation_id || body.provenance_state !== "VERIFIED" || !["NOT_APPLIED", "PENDING", "APPLIED", "FAILED"].includes(body.operation_state) || !body.current_target || !Number.isFinite(observedAt) || new Date(observedAt).toISOString() !== body.observed_at || (body.operation_applied_at !== null && (!Number.isFinite(appliedAt) || new Date(appliedAt).toISOString() !== body.operation_applied_at || appliedAt > observedAt)) || (body.operation_state === "APPLIED") !== (body.operation_applied_at !== null)) throw new Error("Cloudflare route observation is incomplete, unbound, or invalid");
  return {...body, evidence_digest: createEvidenceDigest(body)};
}

function runtimeAuthority(adapter, intent, authoritative) {
  const raw = run(adapter, [
    authoritative === "NONE" ? "fence-all-writes" : "set-route-authority",
    "--operation-id", intent.operation_id,
    "--old-runtime-identity", intent.old_runtime_identity,
    "--candidate-runtime-identity", intent.new_runtime_identity,
    "--authoritative-runtime", authoritative,
  ]);
  const body = {
    operation_id: intent.operation_id,
    old_runtime_identity: raw.old_runtime_identity,
    candidate_runtime_identity: raw.candidate_runtime_identity,
    old_authoritative: raw.old_authoritative,
    candidate_authoritative: raw.candidate_authoritative,
  };
  const expectedOld = authoritative === "OLD";
  const expectedCandidate = authoritative === "CANDIDATE";
  if (body.old_runtime_identity !== intent.old_runtime_identity || body.candidate_runtime_identity !== intent.new_runtime_identity || body.old_authoritative !== expectedOld || body.candidate_authoritative !== expectedCandidate) throw new Error("runtime adapter did not prove the requested single-writer authority state");
  return {...body, evidence_digest: createEvidenceDigest(body)};
}

function appendIntent(journalPath, body) {
  const intent = {...body, operation_id: createRouteOperationId(body)};
  appendReleaseEvent(journalPath, {type: "ROUTE_INTENT", occurred_at: new Date().toISOString(), payload: intent});
  return intent;
}

try {
  const current = readReleaseJournal(journalPath);
  const route = current.plan.route;
  if (action === "plan") {
    process.stdout.write(`${JSON.stringify({
      route_provider: "cloudflare",
      route_id_hash: route.route_id_hash,
      current_state: current.state,
      cutover: "CLOUDFLARE_ROUTE_ID=... CLOUDFLARE_ROUTE_ADAPTER=/absolute/adapter DSDST_RUNTIME_SWITCH_ADAPTER=/absolute/adapter node scripts/release/cloudflare-route.mjs cutover <journal>",
      abort: "CLOUDFLARE_ROUTE_ID=... CLOUDFLARE_ROUTE_ADAPTER=/absolute/adapter DSDST_RUNTIME_SWITCH_ADAPTER=/absolute/adapter node scripts/release/cloudflare-route.mjs abort <journal>",
      rollback: "CLOUDFLARE_ROUTE_ID=... CLOUDFLARE_ROUTE_ADAPTER=/absolute/adapter DSDST_RUNTIME_SWITCH_ADAPTER=/absolute/adapter node scripts/release/cloudflare-route.mjs rollback <journal>",
      complete: "CLOUDFLARE_ROUTE_ID=... CLOUDFLARE_ROUTE_ADAPTER=/absolute/adapter DSDST_RUNTIME_SWITCH_ADAPTER=/absolute/adapter node scripts/release/cloudflare-route.mjs complete <journal>",
    }, null, 2)}\n`);
    process.exit(0);
  }

  const routeId = process.env.CLOUDFLARE_ROUTE_ID;
  if (!routeId || sha256(routeId) !== route.route_id_hash) throw new Error("Cloudflare route provenance cannot be verified against the approved route identity");
  const cloudflareAdapter = executable("CLOUDFLARE_ROUTE_ADAPTER");
  const adapterEnvironment = {DSDST_CLOUDFLARE_ROUTE_ID: routeId};

  if (action === "verify") {
    const evidence = run(cloudflareAdapter, ["verify", "--expected-target", route.current_target], adapterEnvironment);
    if (evidence.provenance_state !== "VERIFIED" || evidence.current_target !== route.current_target) throw new Error("Cloudflare route provenance verification failed");
    process.stdout.write(`${JSON.stringify({route_id_hash: route.route_id_hash, ...evidence}, null, 2)}\n`);
  } else if (action === "cutover") {
    if (current.state !== "VERIFIED") throw new Error(`cutover requires VERIFIED state; current state is ${current.state}`);
    const runtimeAdapter = executable("DSDST_RUNTIME_SWITCH_ADAPTER");
    const newIdentity = candidateIdentity(current.events);
    const freeze = event(current.events, "FREEZE")?.payload.adapter_evidence;
    const convergence = event(current.events, "FINAL_CONVERGENCE")?.payload;
    if (!freeze || !convergence) throw new Error("cutover requires authoritative write freeze and final convergence evidence");
    const startedAt = freeze.freeze_started_at;
    const deadlineAt = new Date(Date.parse(startedAt) + 600_000).toISOString();
    let intent = unresolvedIntent(current.events, "CUTOVER");
    const retry = Boolean(intent);
    if (!intent) {
      if (!startedAt || Date.now() > Date.parse(deadlineAt)) throw new Error("hard 10 minute interruption maximum reached before cutover; abort candidate and restore old writes");
      const guard = run(runtimeAdapter, [
        "confirm-cutover-ready",
        "--old-runtime-identity", current.plan.old_runtime.runtime_identity,
        "--new-runtime-identity", newIdentity,
        "--freeze-token", freeze.freeze_token,
        "--final-snapshot-id", convergence.final_snapshot.snapshot_id,
      ]);
      if (guard.old_write_state !== "FROZEN" || guard.freeze_token !== freeze.freeze_token || guard.new_runtime_health !== "PASS" || guard.candidate_write_watermark !== convergence.final_snapshot.source_data_watermark) throw new Error("runtime cutover guard did not prove frozen old writes and the final-current healthy candidate");
      intent = appendIntent(journalPath, {
        release_id: current.plan.release_id,
        action: "CUTOVER",
        expected_target: current.plan.old_runtime.route_target,
        desired_target: current.plan.candidate.route_target,
        old_runtime_identity: current.plan.old_runtime.runtime_identity,
        new_runtime_identity: newIdentity,
        freeze_token: freeze.freeze_token,
        final_snapshot_id: convergence.final_snapshot.snapshot_id,
        started_at: startedAt,
        deadline_at: deadlineAt,
        candidate_write_watermark: guard.candidate_write_watermark,
        rollback_safety: null,
      });
    }
    const approval = current.events.find((event) => event.type === "APPROVE")?.payload;
    const result = reconcileRouteOperation({
      intent,
      retry,
      observe: (operation) => observedRoute(cloudflareAdapter, adapterEnvironment, operation),
      mutate: (operation) => run(cloudflareAdapter, ["apply", "--operation-id", operation.operation_id, "--action", "CUTOVER", "--expected-target", operation.expected_target, "--desired-target", operation.desired_target, "--hard-deadline-at", operation.deadline_at], adapterEnvironment),
      onDesired: (observation) => {
        const authority = runtimeAuthority(runtimeAdapter, intent, "CANDIDATE");
        return appendReleaseEvent(journalPath, {type: "CUTOVER", occurred_at: observation.observed_at, payload: {
          operation_id: intent.operation_id, explicit: true, approval_id: approval?.approval_id, route_provenance_state: "VERIFIED",
          route_observation: observation, authority_evidence: authority,
          old_runtime_identity: intent.old_runtime_identity, new_runtime_identity: intent.new_runtime_identity,
          old_target: intent.expected_target, new_target: intent.desired_target,
          started_at: intent.started_at, completed_at: observation.operation_applied_at,
          old_stack_mode: "RETAINED_READ_ONLY_NOT_DATA_SAFE", freeze_token: intent.freeze_token,
          final_snapshot_id: intent.final_snapshot_id, candidate_write_watermark: intent.candidate_write_watermark,
        }});
      },
      onExpected: (observation, mutationError) => {
        const authority = runtimeAuthority(runtimeAdapter, intent, "OLD");
        return appendReleaseEvent(journalPath, {type: "CUTOVER_ABORTED", occurred_at: observation.observed_at, payload: {
          operation_id: intent.operation_id, action: "CUTOVER", reason: mutationError ? "route mutation failed and verified route remained old" : "reconciled unresolved cutover intent with route still old",
          route_observation: observation, authority_evidence: authority, candidate_authoritative: false, old_writes_resumed: true,
        }});
      },
      onUnexpected: (observation, ignoredError, condition) => {
        const authority = runtimeAuthority(runtimeAdapter, intent, "NONE");
        return appendReleaseEvent(journalPath, {type: "ROUTE_UNCERTAIN", occurred_at: observation.observed_at, payload: {
          operation_id: intent.operation_id, action: "CUTOVER", condition, reason: condition === "DESIRED_BEFORE_MUTATION" ? "Cloudflare route was already at the desired target before this durable operation could mutate it" : condition === "APPLIED_BUT_REVERTED" ? "Cloudflare reports the operation applied but the route no longer has the desired target" : "Cloudflare route is neither the expected nor desired target", observed_target: observation.current_target,
          route_observation: observation, authority_evidence: authority, writers_fenced: true,
        }});
      },
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (action === "complete") {
    if (current.state !== "CUTOVER") throw new Error(`completion requires CUTOVER state; current state is ${current.state}`);
    const runtimeAdapter = executable("DSDST_RUNTIME_SWITCH_ADAPTER");
    const newIdentity = candidateIdentity(current.events);
    const observed = run(runtimeAdapter, ["observe-candidate-write-watermark", "--runtime-identity", newIdentity]);
    const body = {action: "observe-candidate-write-watermark", runtime_identity: observed.runtime_identity, candidate_write_watermark: observed.candidate_write_watermark, observed_at: observed.observed_at, status: observed.status};
    const routeEvidence = run(cloudflareAdapter, ["verify", "--expected-target", current.plan.candidate.route_target], adapterEnvironment);
    if (routeEvidence.provenance_state !== "VERIFIED" || routeEvidence.current_target !== current.plan.candidate.route_target) throw new Error("completion cannot prove Cloudflare still routes to the candidate");
    const result = appendReleaseEvent(journalPath, {type: "COMPLETE", occurred_at: body.observed_at, payload: {result: "SUCCESS", runtime_adapter: "dsdst-runtime-switch-v1", adapter_evidence: {...body, evidence_digest: createEvidenceDigest(body)}}});
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (action === "abort") {
    if (!new Set(["CANDIDATE_UP", "VERIFIED"]).has(current.state)) throw new Error(`abort requires CANDIDATE_UP or VERIFIED state; current state is ${current.state}`);
    const runtimeAdapter = executable("DSDST_RUNTIME_SWITCH_ADAPTER");
    const freeze = event(current.events, "FREEZE")?.payload.adapter_evidence;
    const args = freeze ? ["resume-old-writes", "--freeze-token", freeze.freeze_token, "--runtime-identity", current.plan.old_runtime.runtime_identity] : ["abort-candidate", "--candidate-runtime-identity", event(current.events, "CANDIDATE_UP").payload.runtime_identity, "--restore-old-runtime-identity", current.plan.old_runtime.runtime_identity];
    const guard = run(runtimeAdapter, args);
    if (guard.old_runtime_identity !== current.plan.old_runtime.runtime_identity || guard.old_writes !== "ENABLED" || guard.candidate_writes !== "DISABLED") {
      throw new Error("runtime abort guard did not restore the previous runtime writer and disable candidate writes");
    }
    const routeEvidence = run(cloudflareAdapter, ["verify", "--expected-target", current.plan.old_runtime.route_target], adapterEnvironment);
    if (routeEvidence.provenance_state !== "VERIFIED" || routeEvidence.current_target !== current.plan.old_runtime.route_target) throw new Error("abort cannot prove the Cloudflare route remained on the previous target");
    const payload = {
      reason: process.env.DSDST_RELEASE_FAILURE_REASON || "candidate release aborted before cutover",
      route_mutated: false,
    };
    if (freeze) {
      const resumeEvidence = {action: "resume-old-writes", freeze_token: freeze.freeze_token, runtime_identity: current.plan.old_runtime.runtime_identity, write_state: "ENABLED"};
      Object.assign(payload, {
      candidate_authoritative: false,
      old_writes_resumed: true,
      freeze_token: freeze.freeze_token,
      old_runtime_identity: current.plan.old_runtime.runtime_identity,
      route_target: current.plan.old_runtime.route_target,
      resume_evidence: {...resumeEvidence, evidence_digest: sha256(JSON.stringify(resumeEvidence))},
      });
    }
    const result = appendReleaseEvent(journalPath, {type: "FAIL", occurred_at: new Date().toISOString(), payload});
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (action === "rollback") {
    if (!new Set(["CUTOVER", "COMPLETED", "FAILED"]).has(current.state)) throw new Error(`rollback requires CUTOVER, COMPLETED, or FAILED-after-cutover state; current state is ${current.state}`);
    const runtimeAdapter = executable("DSDST_RUNTIME_SWITCH_ADAPTER");
    const newIdentity = candidateIdentity(current.events);
    const cutover = event(current.events, "CUTOVER");
    let intent = unresolvedIntent(current.events, "ROLLBACK");
    const retry = Boolean(intent);
    if (!intent) {
      const startedAt = new Date().toISOString();
      const guard = run(runtimeAdapter, [
        "prepare-rollback",
        "--from-runtime-identity", newIdentity,
        "--restore-runtime-identity", current.plan.old_runtime.runtime_identity,
        "--no-database-restore",
      ]);
      if (guard.restored_runtime_identity !== current.plan.old_runtime.runtime_identity || guard.health !== "PASS" || guard.database_restore_used !== false) throw new Error("runtime rollback guard did not verify the previous runtime without a database restore");
      if (!rollbackSafetyEligible(guard.rollback_safety, cutover?.payload.candidate_write_watermark)) throw new Error("rollback blocked: no verified zero-write or current-state synchronization proof preserves candidate-era writes");
      intent = appendIntent(journalPath, {
        release_id: current.plan.release_id,
        action: "ROLLBACK",
        expected_target: current.plan.candidate.route_target,
        desired_target: current.plan.old_runtime.route_target,
        old_runtime_identity: current.plan.old_runtime.runtime_identity,
        new_runtime_identity: newIdentity,
        freeze_token: event(current.events, "FREEZE").payload.adapter_evidence.freeze_token,
        final_snapshot_id: event(current.events, "FINAL_CONVERGENCE").payload.final_snapshot.snapshot_id,
        started_at: startedAt,
        deadline_at: new Date(Date.parse(startedAt) + 600_000).toISOString(),
        candidate_write_watermark: guard.rollback_safety.candidate_write_watermark,
        rollback_safety: guard.rollback_safety,
      });
    }
    const result = reconcileRouteOperation({
      intent,
      retry,
      observe: (operation) => observedRoute(cloudflareAdapter, adapterEnvironment, operation),
      mutate: (operation) => run(cloudflareAdapter, ["apply", "--operation-id", operation.operation_id, "--action", "ROLLBACK", "--expected-target", operation.expected_target, "--desired-target", operation.desired_target, "--hard-deadline-at", operation.deadline_at], adapterEnvironment),
      onDesired: (observation) => {
        const authority = runtimeAuthority(runtimeAdapter, intent, "OLD");
        return appendReleaseEvent(journalPath, {type: "ROLLBACK", occurred_at: observation.observed_at, payload: {
          operation_id: intent.operation_id, explicit: true, reason: process.env.DSDST_ROLLBACK_REASON || "operator-requested rollback", route_provenance_state: "VERIFIED",
          route_observation: observation, authority_evidence: authority,
          from_runtime_identity: intent.new_runtime_identity, restored_runtime_identity: intent.old_runtime_identity,
          restored_target: intent.desired_target, database_restore_used: false,
          started_at: intent.started_at, completed_at: observation.operation_applied_at, rollback_safety: intent.rollback_safety,
        }});
      },
      onExpected: (observation, mutationError) => {
        const authority = runtimeAuthority(runtimeAdapter, intent, "CANDIDATE");
        return appendReleaseEvent(journalPath, {type: "ROLLBACK_ABORTED", occurred_at: observation.observed_at, payload: {
          operation_id: intent.operation_id, action: "ROLLBACK", reason: mutationError ? "rollback route mutation failed and candidate route was retained" : "reconciled unresolved rollback intent with candidate route retained",
          route_observation: observation, authority_evidence: authority, candidate_authoritative: true,
        }});
      },
      onUnexpected: (observation, ignoredError, condition) => {
        const authority = runtimeAuthority(runtimeAdapter, intent, "NONE");
        return appendReleaseEvent(journalPath, {type: "ROUTE_UNCERTAIN", occurred_at: observation.observed_at, payload: {
          operation_id: intent.operation_id, action: "ROLLBACK", condition, reason: condition === "DESIRED_BEFORE_MUTATION" ? "Cloudflare route was already at the desired target before this durable operation could mutate it" : condition === "APPLIED_BUT_REVERTED" ? "Cloudflare reports the operation applied but the route no longer has the desired target" : "Cloudflare route is neither the expected nor desired target", observed_target: observation.current_target,
          route_observation: observation, authority_evidence: authority, writers_fenced: true,
        }});
      },
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    throw new Error("Usage: cloudflare-route.mjs <plan|verify|cutover|complete|abort|rollback> <release-journal>");
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
