#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

import {
  applyOffsiteResult,
  buildRecoveryManifest,
  calculateRecoveryHealth,
  createDrillEvidence,
  planRetention,
  restoreRecoveryPoint,
  verifyRecoveryPoint,
} from "./recovery-lib.mjs";

function writeJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function readManifest(pointPath) {
  return JSON.parse(fs.readFileSync(path.join(pointPath, "manifest.json"), "utf8"));
}

function writeManifest(pointPath, manifest) {
  fs.writeFileSync(path.join(pointPath, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o640 });
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
      const manifestPath = path.join(root, entry.name, "manifest.json");
      if (!fs.existsSync(manifestPath)) return [];
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
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
    writeJson(verifyRecoveryPoint(path.resolve(args[0])));
  } else if (command === "restore") {
    const [pointPath, targetPath, ...productionPaths] = args;
    writeJson(restoreRecoveryPoint(path.resolve(pointPath), path.resolve(targetPath), {
      productionPaths: productionPaths.map((value) => path.resolve(value)),
    }));
  } else if (command === "offsite-success") {
    const [pointPath, remotePath, sha256, sizeBytes, persistedAt] = args;
    const manifest = applyOffsiteResult(readManifest(pointPath), {
      enabled: true,
      state: "PERSISTED",
      persistedAt,
      payload: { path: remotePath, sha256, sizeBytes: Number(sizeBytes) },
    });
    writeManifest(pointPath, manifest);
    writeJson(manifest);
  } else if (command === "offsite-failed") {
    const [pointPath, error] = args;
    const manifest = applyOffsiteResult(readManifest(pointPath), { enabled: true, state: "FAILED", error });
    writeManifest(pointPath, manifest);
    writeJson(manifest);
    process.exitCode = 1;
  } else if (command === "record-failure") {
    const [pointPath, recoveryPointId, createdAt, completedAt, phase, error = ""] = args;
    fs.mkdirSync(pointPath, { recursive: true });
    const manifest = {
      format_version: "dsdst.recovery-point.v1",
      recovery_point_id: recoveryPointId,
      immutable: true,
      created_at: new Date(createdAt).toISOString(),
      completed_at: new Date(completedAt).toISOString(),
      tool: { name: "dsdst-operations-recovery", version: "v2.16.0", backup_type: "complete-online-snapshot" },
      status: "FAILED",
      components: {},
      verification: { state: "FAILED", phase, error: String(error).slice(0, 1000) },
      offsite: { enabled: false, state: "NOT_ATTEMPTED" },
    };
    writeManifest(pointPath, manifest);
    writeJson(manifest);
  } else if (command === "health") {
    const [backupRoot, now] = args;
    const health = calculateRecoveryHealth(recoveryPoints(path.resolve(backupRoot)), now ? new Date(now) : new Date());
    writeJson(health);
    if (!health.healthy) process.exitCode = 1;
  } else if (command === "latest-success") {
    const [backupRoot] = args;
    const latest = recoveryPoints(path.resolve(backupRoot))
      .filter((point) => point.status === "SUCCESS" && point.verification?.state === "VERIFIED")
      .sort((left, right) => new Date(right.created_at) - new Date(left.created_at))[0];
    if (!latest) throw new Error("No successful recovery point is available");
    process.stdout.write(`${path.join(path.resolve(backupRoot), "recovery-points", latest.id)}\n`);
  } else if (command === "image-env") {
    const manifest = readManifest(path.resolve(args[0]));
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
  } else if (command === "retention-delete") {
    const [backupRoot, recoveryPointId] = args;
    if (!/^rp-[a-zA-Z0-9._-]+$/.test(recoveryPointId)) throw new Error("Invalid recovery-point ID");
    const root = path.resolve(backupRoot);
    const plan = planRetention(recoveryPoints(root), new Date());
    if (!plan.delete.includes(recoveryPointId)) throw new Error("Recovery point is not eligible for retention deletion");
    const target = path.join(root, "recovery-points", recoveryPointId);
    const manifest = readManifest(target);
    const evidenceDirectory = path.join(root, "evidence", "recovery-points");
    fs.mkdirSync(evidenceDirectory, { recursive: true });
    fs.writeFileSync(path.join(evidenceDirectory, `${recoveryPointId}.json`), `${JSON.stringify({
      recovery_point_id: recoveryPointId,
      created_at: manifest.created_at,
      status: manifest.status,
      verification: manifest.verification,
      offsite: manifest.offsite,
      retention_deleted_at: new Date().toISOString(),
    }, null, 2)}\n`);
    makeWritable(target);
    fs.rmSync(target, { recursive: true, force: false });
    writeJson({ deleted: recoveryPointId });
  } else if (command === "drill-evidence") {
    const [pointPath, evidencePath, drillType, startedAt, completedAt, result, error = ""] = args;
    const evidence = createDrillEvidence(readManifest(pointPath), {
      drillType,
      startedAt,
      completedAt,
      result,
      error: error || undefined,
      evidencePath,
    });
    fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
    fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o640 });
    writeJson(evidence);
  } else {
    throw new Error("Usage: recovery-cli.mjs <build|verify|restore|offsite-success|offsite-failed|record-failure|health|latest-success|image-env|retention-plan|retention-delete|drill-evidence> ...");
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
