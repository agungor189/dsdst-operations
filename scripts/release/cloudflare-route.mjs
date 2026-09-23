#!/usr/bin/env node

import {createHash} from "node:crypto";
import {spawnSync} from "node:child_process";
import {
  appendReleaseEvent,
  createEvidenceDigest,
  readReleaseJournal,
} from "./release-lib.mjs";

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
    if (!startedAt || Date.now() - Date.parse(startedAt) > 600_000) throw new Error("hard 10 minute interruption maximum reached before cutover; abort candidate and restore old writes");
    const guard = run(runtimeAdapter, [
      "confirm-cutover-ready",
      "--old-runtime-identity", current.plan.old_runtime.runtime_identity,
      "--new-runtime-identity", newIdentity,
      "--freeze-token", freeze.freeze_token,
      "--final-snapshot-id", convergence.final_snapshot.snapshot_id,
    ]);
    if (guard.old_write_state !== "FROZEN" || guard.freeze_token !== freeze.freeze_token || guard.new_runtime_health !== "PASS" || guard.candidate_write_watermark !== convergence.final_snapshot.source_data_watermark) throw new Error("runtime cutover guard did not prove frozen old writes and the final-current healthy candidate");
    const deadlineAt = new Date(Date.parse(startedAt) + 600_000).toISOString();
    const routeEvidence = run(cloudflareAdapter, [
      "cutover",
      "--expected-old-target", current.plan.old_runtime.route_target,
      "--new-target", current.plan.candidate.route_target,
      "--hard-deadline-at", deadlineAt,
    ], adapterEnvironment);
    const routeCompletedAt = Date.parse(routeEvidence.completed_at);
    if (!Number.isFinite(routeCompletedAt) || new Date(routeCompletedAt).toISOString() !== routeEvidence.completed_at || routeEvidence.provenance_state !== "VERIFIED" || routeEvidence.previous_target !== current.plan.old_runtime.route_target || routeEvidence.current_target !== current.plan.candidate.route_target || routeEvidence.deadline_enforced !== true || routeCompletedAt > Date.parse(deadlineAt)) {
      throw new Error("Cloudflare cutover result provenance is incomplete or contradictory");
    }
    const completedAt = routeEvidence.completed_at;
    const approval = current.events.find((event) => event.type === "APPROVE")?.payload;
    const result = appendReleaseEvent(journalPath, {type: "CUTOVER", occurred_at: completedAt, payload: {
      explicit: true,
      approval_id: approval?.approval_id,
      route_provenance_state: "VERIFIED",
      old_runtime_identity: current.plan.old_runtime.runtime_identity,
      new_runtime_identity: newIdentity,
      old_target: routeEvidence.previous_target,
      new_target: routeEvidence.current_target,
      started_at: startedAt,
      completed_at: completedAt,
      old_stack_mode: "RETAINED_READ_ONLY_NOT_DATA_SAFE",
      freeze_token: freeze.freeze_token,
      final_snapshot_id: convergence.final_snapshot.snapshot_id,
      candidate_write_watermark: guard.candidate_write_watermark,
    }});
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
    const startedAt = new Date().toISOString();
    const guard = run(runtimeAdapter, [
      "prepare-rollback",
      "--from-runtime-identity", newIdentity,
      "--restore-runtime-identity", current.plan.old_runtime.runtime_identity,
      "--no-database-restore",
    ]);
    if (guard.restored_runtime_identity !== current.plan.old_runtime.runtime_identity || guard.health !== "PASS" || guard.database_restore_used !== false) {
      throw new Error("runtime rollback guard did not verify the previous runtime without a database restore");
    }
    const cutover = event(current.events, "CUTOVER");
    if (!rollbackSafetyEligible(guard.rollback_safety, cutover?.payload.candidate_write_watermark)) throw new Error("rollback blocked: no verified zero-write or current-state synchronization proof preserves candidate-era writes");
    const routeEvidence = run(cloudflareAdapter, [
      "rollback",
      "--expected-current-target", current.plan.candidate.route_target,
      "--restore-target", current.plan.old_runtime.route_target,
    ], adapterEnvironment);
    if (routeEvidence.provenance_state !== "VERIFIED" || routeEvidence.current_target !== current.plan.old_runtime.route_target) throw new Error("Cloudflare rollback result provenance is incomplete or contradictory");
    const completedAt = new Date().toISOString();
    const result = appendReleaseEvent(journalPath, {type: "ROLLBACK", occurred_at: completedAt, payload: {
      explicit: true,
      reason: process.env.DSDST_ROLLBACK_REASON || "operator-requested rollback",
      route_provenance_state: "VERIFIED",
      from_runtime_identity: newIdentity,
      restored_runtime_identity: guard.restored_runtime_identity,
      restored_target: routeEvidence.current_target,
      database_restore_used: false,
      started_at: startedAt,
      completed_at: completedAt,
      rollback_safety: guard.rollback_safety,
    }});
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    throw new Error("Usage: cloudflare-route.mjs <plan|verify|cutover|complete|abort|rollback> <release-journal>");
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
