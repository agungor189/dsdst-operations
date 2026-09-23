#!/usr/bin/env node

import {createHash} from "node:crypto";
import {spawnSync} from "node:child_process";
import {
  appendReleaseEvent,
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
  const event = events.find((entry) => entry.type === "CANDIDATE_UP");
  if (!event) throw new Error("candidate runtime identity is unavailable");
  return event.payload.runtime_identity;
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
    const candidateEvent = current.events.find((event) => event.type === "CANDIDATE_UP");
    const startedAt = candidateEvent?.payload.write_freeze_started_at;
    if (!startedAt || Date.now() - Date.parse(startedAt) >= 600_000) throw new Error("hard 10 minute interruption maximum reached before cutover; abort candidate and restore old writes");
    const guard = run(runtimeAdapter, [
      "prepare-cutover",
      "--old-runtime-identity", current.plan.old_runtime.runtime_identity,
      "--new-runtime-identity", newIdentity,
    ]);
    if (guard.old_stack_mode !== "READ_ONLY_STOPPED" || guard.new_runtime_health !== "PASS") throw new Error("runtime cutover guard did not make the old stack read-only/stopped and verify the candidate");
    const routeEvidence = run(cloudflareAdapter, [
      "cutover",
      "--expected-old-target", current.plan.old_runtime.route_target,
      "--new-target", current.plan.candidate.route_target,
    ], adapterEnvironment);
    if (routeEvidence.provenance_state !== "VERIFIED" || routeEvidence.previous_target !== current.plan.old_runtime.route_target || routeEvidence.current_target !== current.plan.candidate.route_target) {
      throw new Error("Cloudflare cutover result provenance is incomplete or contradictory");
    }
    const completedAt = new Date().toISOString();
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
      old_stack_mode: guard.old_stack_mode,
    }});
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (action === "abort") {
    if (!new Set(["CANDIDATE_UP", "VERIFIED"]).has(current.state)) throw new Error(`abort requires CANDIDATE_UP or VERIFIED state; current state is ${current.state}`);
    const runtimeAdapter = executable("DSDST_RUNTIME_SWITCH_ADAPTER");
    const guard = run(runtimeAdapter, [
      "abort-candidate",
      "--candidate-runtime-identity", candidateIdentity(current.events),
      "--restore-old-runtime-identity", current.plan.old_runtime.runtime_identity,
    ]);
    if (guard.old_runtime_identity !== current.plan.old_runtime.runtime_identity || guard.old_writes !== "ENABLED" || guard.candidate_writes !== "DISABLED") {
      throw new Error("runtime abort guard did not restore the previous runtime writer and disable candidate writes");
    }
    const routeEvidence = run(cloudflareAdapter, ["verify", "--expected-target", current.plan.old_runtime.route_target], adapterEnvironment);
    if (routeEvidence.provenance_state !== "VERIFIED" || routeEvidence.current_target !== current.plan.old_runtime.route_target) throw new Error("abort cannot prove the Cloudflare route remained on the previous target");
    const result = appendReleaseEvent(journalPath, {type: "FAIL", occurred_at: new Date().toISOString(), payload: {
      reason: process.env.DSDST_RELEASE_FAILURE_REASON || "candidate release aborted before cutover",
      route_mutated: false,
    }});
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
    }});
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    throw new Error("Usage: cloudflare-route.mjs <plan|verify|cutover|abort|rollback> <release-journal>");
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
