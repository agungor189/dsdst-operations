#!/usr/bin/env node

import {spawnSync} from "node:child_process";
import {
  appendReleaseEvent,
  createEvidenceDigest,
  readReleaseJournal,
} from "./release-lib.mjs";

const [journalPath] = process.argv.slice(2);

function executable(name) {
  const value = process.env[name];
  if (!value || !value.startsWith("/")) throw new Error(`${name} must be an absolute executable path`);
  return value;
}

function run(executablePath, args, extraEnvironment = {}) {
  const result = spawnSync(executablePath, args, {encoding: "utf8", env: {...process.env, ...extraEnvironment}, shell: false, stdio: ["ignore", "pipe", "pipe"]});
  if (result.status !== 0) throw new Error(`final convergence adapter failed closed (${executablePath}, exit ${result.status ?? "unknown"})`);
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`final convergence adapter returned invalid JSON (${executablePath})`);
  }
}

function nowAfter(value) {
  const parsed = Date.parse(value);
  const now = Date.now();
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value || parsed > now + 5_000) throw new Error("adapter observation time is invalid or ahead of the controller clock");
  return new Date(Math.max(now, parsed)).toISOString();
}

let freeze = null;
try {
  const current = readReleaseJournal(journalPath);
  if (current.state !== "VERIFIED") throw new Error(`final convergence requires VERIFIED state; current state is ${current.state}`);
  const runtimeAdapter = executable("DSDST_RUNTIME_SWITCH_ADAPTER");
  const snapshotAdapter = executable("DSDST_FINAL_SNAPSHOT_ADAPTER");
  const hydrationAdapter = executable("DSDST_FINAL_HYDRATION_ADAPTER");

  const observed = run(runtimeAdapter, ["freeze-writes", "--runtime-identity", current.plan.old_runtime.runtime_identity]);
  const freezeBody = {
    action: "freeze-writes",
    freeze_token: observed.freeze_token,
    freeze_started_at: observed.freeze_started_at,
    runtime_identity: observed.runtime_identity,
    source_data_watermark: observed.source_data_watermark,
    write_state: observed.write_state,
  };
  freeze = {...freezeBody, evidence_digest: createEvidenceDigest(freezeBody)};
  appendReleaseEvent(journalPath, {type: "FREEZE", occurred_at: nowAfter(freeze.freeze_started_at), payload: {runtime_adapter: "dsdst-runtime-switch-v1", adapter_evidence: freeze}});

  const snapshot = run(snapshotAdapter, [
    "create-final-cutover-snapshot",
    "--freeze-token", freeze.freeze_token,
    "--source-data-watermark", freeze.source_data_watermark,
    "--no-raw-live-sqlite-copy",
  ]);
  const hydrated = run(hydrationAdapter, [
    "hydrate-final-snapshot",
    "--snapshot-id", snapshot.snapshot_id,
    "--candidate-project", current.plan.candidate.project,
    "--no-old-production-volumes",
    "--run-migrations",
    "--recollect-runtime-schema-provenance",
    "--health-smoke-read-only",
  ]);
  const result = appendReleaseEvent(journalPath, {type: "FINAL_CONVERGENCE", occurred_at: nowAfter(hydrated.final_candidate?.runtime_provenance?.captured_at), payload: {
    freeze_token: freeze.freeze_token,
    final_snapshot: snapshot,
    candidate_hydration: hydrated.candidate_hydration,
    final_candidate: hydrated.final_candidate,
  }});
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  if (freeze) {
    try {
      const current = readReleaseJournal(journalPath);
      const runtimeAdapter = executable("DSDST_RUNTIME_SWITCH_ADAPTER");
      const routeAdapter = executable("CLOUDFLARE_ROUTE_ADAPTER");
      const routeId = process.env.CLOUDFLARE_ROUTE_ID;
      if (!routeId || createEvidenceDigest(routeId) !== current.plan.route.route_id_hash) throw new Error("Cloudflare route provenance cannot be verified during pre-cutover abort");
      const resumed = run(runtimeAdapter, ["resume-old-writes", "--freeze-token", freeze.freeze_token, "--runtime-identity", current.plan.old_runtime.runtime_identity]);
      const route = run(routeAdapter, ["verify", "--expected-target", current.plan.old_runtime.route_target], {DSDST_CLOUDFLARE_ROUTE_ID: routeId});
      if (resumed.old_runtime_identity !== current.plan.old_runtime.runtime_identity || resumed.old_writes !== "ENABLED" || resumed.candidate_writes !== "DISABLED" || route.provenance_state !== "VERIFIED" || route.current_target !== current.plan.old_runtime.route_target) throw new Error("automatic pre-cutover abort could not prove old writes resumed and route remained old");
      const resumeBody = {action: "resume-old-writes", freeze_token: freeze.freeze_token, runtime_identity: current.plan.old_runtime.runtime_identity, write_state: "ENABLED"};
      appendReleaseEvent(journalPath, {type: "FAIL", occurred_at: new Date().toISOString(), payload: {
        reason: `final convergence failed closed: ${error.message}`,
        route_mutated: false,
        candidate_authoritative: false,
        old_writes_resumed: true,
        freeze_token: freeze.freeze_token,
        old_runtime_identity: current.plan.old_runtime.runtime_identity,
        route_target: current.plan.old_runtime.route_target,
        resume_evidence: {...resumeBody, evidence_digest: createEvidenceDigest(resumeBody)},
      }});
    } catch (abortError) {
      console.error(`${error.message}; ${abortError.message}`);
      process.exitCode = 1;
      process.exit();
    }
  }
  console.error(error.message);
  process.exitCode = 1;
}
