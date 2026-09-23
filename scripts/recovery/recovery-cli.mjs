#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

import {
  FORMAT_VERSION,
  TOOL_VERSION,
  applyOffsiteResult,
  assertAcceptedManifest,
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
  verifyManifestIntegrity,
  verifyRecoveryPoint,
} from "./recovery-lib.mjs";

function writeJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function readManifest(pointPath) {
  return JSON.parse(fs.readFileSync(path.join(pointPath, "manifest.json"), "utf8"));
}

function writeManifest(pointPath, manifest) {
  const target = path.join(pointPath, "manifest.json");
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o640, flag: "wx" });
  fs.renameSync(temporary, target);
}

function makeWritable(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) makeWritable(candidate);
    fs.chmodSync(candidate, entry.isDirectory() ? 0o750 : 0o640);
  }
  fs.chmodSync(directory, 0o750);
}

function recoveryPoints(backupRoot) {
  const root = path.join(backupRoot, "recovery-points");
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.endsWith(".partial"))
    .flatMap((entry) => {
      const pointPath = path.join(root, entry.name);
      const manifestPath = path.join(pointPath, "manifest.json");
      if (!fs.existsSync(manifestPath)) return [];
      try {
        const manifest = verifyRecoveryPoint(pointPath);
        return [{ id: entry.name, ...manifest }];
      } catch {
        return [];
      }
    });
}

function immutableImageReference(service) {
  const reference = service?.declared_image_reference;
  const digest = service?.image_digest;
  if (typeof reference !== "string" || !/^sha256:[a-f0-9]{64}$/.test(digest || "")) {
    throw new Error(`Immutable image reference is unavailable for ${service?.service_id || "unknown service"}`);
  }
  const withoutDigest = reference.split("@")[0];
  const slash = withoutDigest.lastIndexOf("/");
  const colon = withoutDigest.lastIndexOf(":");
  const repository = colon > slash ? withoutDigest.slice(0, colon) : withoutDigest;
  return `${repository}@${digest}`;
}

const [command, ...args] = process.argv.slice(2);

try {
  if (command === "build") {
    const [pointPath, recoveryPointId, createdAt, completedAt, offsiteEnabled = "false"] = args;
    writeJson(buildRecoveryManifest(path.resolve(pointPath), {
      recoveryPointId,
      createdAt,
      completedAt,
      offsiteEnabled: offsiteEnabled === "true",
    }));
  } else if (command === "verify") {
    const requireAccepted = args.includes("--require-accepted");
    const pointPath = args.find((value) => value !== "--require-accepted");
    writeJson(verifyRecoveryPoint(path.resolve(pointPath), { requireAccepted }));
  } else if (command === "verify-manifest-file") {
    const [manifestPath, expectedRecoveryPointId, expectedRemoteRoot] = args;
    const manifest = verifyManifestIntegrity(JSON.parse(fs.readFileSync(path.resolve(manifestPath), "utf8")));
    assertAcceptedManifest(manifest);
    if (expectedRecoveryPointId && manifest.recovery_point_id !== expectedRecoveryPointId) throw new Error("Fetched manifest recovery-point ID mismatch");
    if (expectedRemoteRoot && manifest.offsite.location !== expectedRemoteRoot) throw new Error("Fetched manifest offsite location mismatch");
    writeJson(manifest);
  } else if (command === "restore") {
    const allowLocalOnly = args.includes("--allow-local-only");
    const values = args.filter((value) => value !== "--allow-local-only");
    const [pointPath, targetPath, ...productionPaths] = values;
    writeJson(restoreRecoveryPoint(path.resolve(pointPath), path.resolve(targetPath), {
      productionPaths: productionPaths.map((value) => path.resolve(value)),
      allowLocalOnly,
    }));
  } else if (command === "stage-offsite-final") {
    const [pointPath, candidatePath, remoteRoot, configFingerprint, payloadPath, sha256, sizeBytes, persistedAt, integrityPath] = args;
    writeJson(stageFinalRecoveryManifest(path.resolve(pointPath), path.resolve(candidatePath), {
      persistedAt,
      remoteRoot,
      configFingerprint,
      payload: { path: payloadPath, sha256, sizeBytes: Number(sizeBytes) },
      integrityEvidence: { path: integrityPath, remoteHashVerified: true },
    }));
  } else if (command === "promote-offsite-final") {
    const [pointPath, candidatePath] = args;
    writeJson(promoteFinalRecoveryManifest(path.resolve(pointPath), path.resolve(candidatePath)));
  } else if (command === "finalize") {
    const [pointPath, candidatePath] = args;
    writeJson(finalizeRecoveryPoint(path.resolve(pointPath), path.resolve(candidatePath)));
  } else if (command === "offsite-failed") {
    const [pointPath, error] = args;
    const current = verifyRecoveryPoint(path.resolve(pointPath));
    const manifest = signRecoveryManifest(applyOffsiteResult(current, { enabled: true, state: "FAILED", error }));
    writeManifest(pointPath, manifest);
    writeJson(manifest);
    process.exitCode = 1;
  } else if (command === "record-failure") {
    const [pointPath, recoveryPointId, createdAt, completedAt, phase, error = ""] = args;
    fs.mkdirSync(pointPath, { recursive: true });
    const manifest = signRecoveryManifest({
      format_version: FORMAT_VERSION,
      recovery_point_id: recoveryPointId,
      immutable: true,
      created_at: new Date(createdAt).toISOString(),
      completed_at: new Date(completedAt).toISOString(),
      tool: { name: "dsdst-operations-recovery", version: TOOL_VERSION, backup_type: "complete-online-snapshot" },
      status: "FAILED",
      components: {},
      verification: { state: "FAILED", phase, error: String(error).slice(0, 1000) },
      offsite: { enabled: false, state: "NOT_ATTEMPTED" },
    });
    writeManifest(pointPath, manifest);
    writeJson(manifest);
  } else if (command === "health") {
    const [backupRoot, now] = args;
    const health = calculateRecoveryHealth(recoveryPoints(path.resolve(backupRoot)), now ? new Date(now) : new Date());
    writeJson(health);
    if (!health.healthy) process.exitCode = 1;
  } else if (command === "point-health") {
    const [pointPath, now] = args;
    const manifest = verifyRecoveryPoint(path.resolve(pointPath), { requireAccepted: true });
    const health = calculateRecoveryHealth([{ id: manifest.recovery_point_id, ...manifest }], now ? new Date(now) : new Date());
    writeJson(health);
    if (!health.healthy) process.exitCode = 1;
  } else if (command === "latest-success") {
    const [backupRoot] = args;
    const latest = recoveryPoints(path.resolve(backupRoot))
      .filter((point) => point.status === "SUCCESS" && point.verification?.state === "VERIFIED" && point.offsite?.state === "PERSISTED")
      .sort((left, right) => new Date(right.created_at) - new Date(left.created_at))[0];
    if (!latest) throw new Error("No successful recovery point is available");
    process.stdout.write(`${path.join(path.resolve(backupRoot), "recovery-points", latest.id)}\n`);
  } else if (command === "image-env") {
    const manifest = verifyRecoveryPoint(path.resolve(args[0]), { requireAccepted: true });
    const byService = new Map(manifest.provenance?.runtime?.services?.map((service) => [service.service_id, service]) || []);
    const mapping = {
      PANEL_IMAGE: "dsdst-panel",
      WAREHOUSE_IMAGE: "dsdst-warehouse",
      KIT_STUDIO_IMAGE: "dsdst-kit-studio",
      CUSTOMER_HUB_IMAGE: "dsdst-customer-hub",
      LABEL_PRINTER_IMAGE: "label-printer",
    };
    for (const [environmentKey, serviceId] of Object.entries(mapping)) {
      process.stdout.write(`${environmentKey}=${immutableImageReference(byService.get(serviceId))}\n`);
    }
  } else if (command === "retention-plan") {
    const [backupRoot, now] = args;
    writeJson(planRetention(recoveryPoints(path.resolve(backupRoot)), now ? new Date(now) : new Date()));
  } else if (command === "retention-offsite-location") {
    process.stdout.write(`${retentionOffsiteLocation(path.resolve(args[0]))}\n`);
  } else if (command === "retention-offsite-config-fingerprint") {
    process.stdout.write(`${retentionOffsiteConfigFingerprint(path.resolve(args[0]))}\n`);
  } else if (command === "retention-delete") {
    const [backupRoot, recoveryPointId, confirmedOffsiteLocation, confirmedConfigFingerprint] = args;
    if (!/^rp-[a-zA-Z0-9._-]+$/.test(recoveryPointId)) throw new Error("Invalid recovery-point ID");
    const root = path.resolve(backupRoot);
    const plan = planRetention(recoveryPoints(root), new Date());
    if (!plan.delete.includes(recoveryPointId)) throw new Error("Recovery point is not eligible for retention deletion");
    const target = path.join(root, "recovery-points", recoveryPointId);
    const manifest = verifyRecoveryPoint(target, { requireAccepted: true });
    const recordedOffsiteLocation = retentionOffsiteLocation(target);
    if (!confirmedOffsiteLocation || confirmedOffsiteLocation !== recordedOffsiteLocation) {
      throw new Error("Exact recorded offsite location deletion was not confirmed");
    }
    if (!confirmedConfigFingerprint || confirmedConfigFingerprint !== manifest.offsite.config_fingerprint) {
      throw new Error("Recorded offsite configuration fingerprint deletion was not confirmed");
    }
    const evidenceDirectory = path.join(root, "evidence", "recovery-points");
    fs.mkdirSync(evidenceDirectory, { recursive: true });
    fs.writeFileSync(path.join(evidenceDirectory, `${recoveryPointId}.json`), `${JSON.stringify({
      recovery_point_id: recoveryPointId,
      created_at: manifest.created_at,
      status: manifest.status,
      verification: manifest.verification,
      offsite: manifest.offsite,
      offsite_deleted_location: recordedOffsiteLocation,
      retention_deleted_at: new Date().toISOString(),
    }, null, 2)}\n`);
    makeWritable(target);
    fs.rmSync(target, { recursive: true, force: false });
    writeJson({ deleted: recoveryPointId });
  } else if (command === "drill-evidence") {
    const [pointPath, evidencePath, drillType, startedAt, completedAt, result, error = "", failureStage = ""] = args;
    const manifest = verifyManifestIntegrity(readManifest(path.resolve(pointPath)));
    assertAcceptedManifest(manifest);
    const evidence = createDrillEvidence(manifest, {
      drillType,
      startedAt,
      completedAt,
      result,
      error: error || undefined,
      failureStage: failureStage || undefined,
      evidencePath,
    });
    fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
    fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o640 });
    writeJson(evidence);
    if (evidence.result !== "SUCCESS") process.exitCode = 1;
  } else {
    throw new Error("Usage: recovery-cli.mjs <build|verify|verify-manifest-file|restore|stage-offsite-final|promote-offsite-final|finalize|offsite-failed|record-failure|health|point-health|latest-success|image-env|retention-plan|retention-offsite-location|retention-offsite-config-fingerprint|retention-delete|drill-evidence> ...");
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
