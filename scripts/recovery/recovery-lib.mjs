import { execFileSync } from "node:child_process";
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export const FORMAT_VERSION = "dsdst.recovery-point.v2";
export const TOOL_VERSION = "v2.18.0";

const RECOVERY_SOURCE_SETS = new Map([
  "V2-16",
  "V2-18",
].map((release) => [
  release,
  JSON.parse(fs.readFileSync(new URL(`../../config/${release.toLowerCase()}-source-set.json`, import.meta.url), "utf8")),
]));

const COMPONENTS = Object.freeze({
  panel_database: { path: "payload/panel/database.sqlite", kind: "sqlite", runtime: "dsdst-panel" },
  panel_uploads: { path: "payload/panel/uploads.tar.gz", kind: "archive" },
  kit_database: { path: "payload/kit/database.sqlite", kind: "sqlite", runtime: "dsdst-kit-studio" },
  kit_uploads: { path: "payload/kit/uploads.tar.gz", kind: "archive" },
  label_state: { path: "payload/label/state.tar.gz", kind: "json-state", runtime: "label-printer" },
  customer_hub_database: { path: "payload/customer-hub/database.sqlite", kind: "sqlite", runtime: "dsdst-customer-hub" },
  customer_hub_attachments: { path: "payload/customer-hub/attachments.tar.gz", kind: "archive" },
  source_set: { path: "provenance/source-set.json", kind: "provenance" },
  source_set_observation: { path: "provenance/source-set-observation.json", kind: "provenance" },
  runtime_provenance: { path: "provenance/runtime.json", kind: "provenance" },
});

const SOURCE_RUNTIME = Object.freeze({
  P: ["dsdst-panel"],
  W: ["dsdst-warehouse"],
  K: ["dsdst-kit-studio"],
  L: ["label-printer", "warehouse-label-renderer"],
});

function fail(message) {
  throw new Error(message);
}

function manifestKey(options = {}) {
  const value = options.manifestKey ?? process.env.RECOVERY_MANIFEST_HMAC_KEY;
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") < 32) {
    fail("RECOVERY_MANIFEST_HMAC_KEY must provide at least 32 bytes of external key material");
  }
  return Buffer.from(value, "utf8");
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
  }
  return value;
}

export function validateRecoverySourceSet(sourceSet) {
  if (sourceSet?.schemaVersion !== "dsdst.test-source-set.v1" || typeof sourceSet.release !== "string") {
    fail("Recovery source-set provenance is missing or unsupported");
  }
  const expected = RECOVERY_SOURCE_SETS.get(sourceSet.release);
  if (!expected) fail(`Unsupported recovery source-set release: ${sourceSet.release}`);
  if (JSON.stringify(canonicalValue(sourceSet)) !== JSON.stringify(canonicalValue(expected))) {
    fail(`Recovery source-set does not match the exact canonical ${sourceSet.release} source set`);
  }
  return sourceSet;
}

function manifestAuthenticationPayload(manifest) {
  const unsigned = structuredClone(manifest);
  delete unsigned.integrity;
  return JSON.stringify(canonicalValue(unsigned));
}

export function signRecoveryManifest(manifest, options = {}) {
  const signed = structuredClone(manifest);
  delete signed.integrity;
  const keyId = String(options.manifestKeyId ?? process.env.RECOVERY_MANIFEST_HMAC_KEY_ID ?? "external-v1");
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(keyId)) fail("Invalid recovery manifest key ID");
  signed.integrity = {
    algorithm: "HMAC-SHA256",
    key_id: keyId,
    value: createHmac("sha256", manifestKey(options)).update(manifestAuthenticationPayload(signed)).digest("hex"),
  };
  return signed;
}

export function verifyManifestIntegrity(manifest, options = {}) {
  if (manifest?.integrity?.algorithm !== "HMAC-SHA256" ||
      typeof manifest.integrity.key_id !== "string" ||
      !/^[a-f0-9]{64}$/.test(manifest.integrity.value || "")) {
    fail("Recovery manifest authenticated integrity evidence is missing or invalid");
  }
  const observed = createHmac("sha256", manifestKey(options))
    .update(manifestAuthenticationPayload(manifest))
    .digest();
  const expected = Buffer.from(manifest.integrity.value, "hex");
  if (expected.length !== observed.length || !timingSafeEqual(expected, observed)) {
    fail("Recovery manifest authenticated integrity verification failed");
  }
  return manifest;
}

function atomicWriteJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  const descriptor = fs.openSync(temporary, "wx", 0o640);
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.renameSync(temporary, filePath);
  const directory = fs.openSync(path.dirname(filePath), "r");
  try {
    fs.fsyncSync(directory);
  } finally {
    fs.closeSync(directory);
  }
}

function readJson(filePath, description) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    fail(`${description} is invalid: ${error.message}`);
  }
}

function sha256File(filePath) {
  const hash = createHash("sha256");
  const descriptor = fs.openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest("hex");
}

function sqliteObservation(filePath) {
  const db = new DatabaseSync(filePath, { readOnly: true });
  try {
    const integrity = db.prepare("PRAGMA integrity_check").all();
    if (integrity.length !== 1 || integrity[0].integrity_check !== "ok") {
      fail(`SQLite integrity failed for ${filePath}`);
    }
    const table = db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get();
    if (!table) fail(`SQLite schema_migrations is missing for ${filePath}`);
    const row = db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get();
    if (row?.version === null || row?.version === undefined) fail(`SQLite schema version is missing for ${filePath}`);
    return { integrity: "ok", schemaVersion: String(row.version) };
  } finally {
    db.close();
  }
}

function archiveEntries(filePath) {
  const output = execFileSync("tar", ["-tzf", filePath], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  const entries = output.split("\n").filter(Boolean);
  for (const entry of entries) {
    const normalized = path.posix.normalize(entry.replace(/^\.\//, ""));
    if (path.posix.isAbsolute(entry) || normalized === ".." || normalized.startsWith("../")) {
      fail(`Unsafe archive entry in ${filePath}: ${entry}`);
    }
  }
  const verbose = execFileSync("tar", ["-tvzf", filePath], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  for (const line of verbose.split("\n").filter(Boolean)) {
    if (!["-", "d"].includes(line[0])) fail(`Unsupported archive entry type in ${filePath}`);
  }
  return entries;
}

function labelStateObservation(filePath) {
  const entries = archiveEntries(filePath);
  const entry = entries.find((candidate) => candidate.replace(/^\.\//, "") === "app-state.json");
  if (!entry) fail("Label state archive is missing app-state.json");
  const raw = execFileSync("tar", ["-xOzf", filePath, entry], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  const state = JSON.parse(raw);
  if (![1, 2, 3].includes(Number(state?.version))) fail("Label state schema version is missing or unsupported");
  return { schemaVersion: String(state.version) };
}

function inspectComponents(pointPath) {
  const result = {};
  for (const [name, specification] of Object.entries(COMPONENTS)) {
    const filePath = path.join(pointPath, specification.path);
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) fail(`Missing component: ${name}`);
    const component = {
      path: specification.path,
      kind: specification.kind,
      required: true,
      sha256: sha256File(filePath),
      size_bytes: fs.statSync(filePath).size,
    };
    if (specification.kind === "sqlite") {
      const observation = sqliteObservation(filePath);
      component.integrity = observation.integrity;
      component.schema_version = observation.schemaVersion;
    } else if (specification.kind === "json-state") {
      component.schema_version = labelStateObservation(filePath).schemaVersion;
    } else if (specification.kind === "archive") {
      archiveEntries(filePath);
    }
    result[name] = component;
  }
  return result;
}

function validateProvenance(pointPath, components) {
  const sourceSet = readJson(path.join(pointPath, components.source_set.path), "Source-set provenance");
  const sourceObservation = readJson(path.join(pointPath, components.source_set_observation.path), "Source-set observation");
  const runtime = readJson(path.join(pointPath, components.runtime_provenance.path), "Runtime provenance");
  validateRecoverySourceSet(sourceSet);
  if (!Array.isArray(sourceSet.repositories)) fail("Source-set repositories are missing");
  const sourceById = new Map(sourceSet.repositories.map((entry) => [entry.id, entry]));
  for (const id of ["O", "P", "W", "K", "L"]) {
    const entry = sourceById.get(id);
    if (!entry || !/^[a-f0-9]{40}$/.test(entry.revision)) fail(`Exact source revision is missing for ${id}`);
  }
  const observedById = new Map((sourceObservation.repositories || []).map((entry) => [entry.id, entry]));
  for (const id of ["O", "P", "W", "K", "L"]) {
    if (observedById.get(id)?.revision !== sourceById.get(id).revision) fail(`Observed source-set revision mismatch for ${id}`);
  }
  if (sourceById.has("HUB") && observedById.get("HUB")?.revision !== sourceById.get("HUB").revision) {
    fail("Observed source-set revision mismatch for HUB");
  }
  if (!Array.isArray(runtime.services)) fail("Runtime services are missing");
  const runtimeById = new Map(runtime.services.map((service) => [service.service_id, service]));
  for (const [sourceId, serviceIds] of Object.entries(SOURCE_RUNTIME)) {
    for (const serviceId of serviceIds) {
      const service = runtimeById.get(serviceId);
      if (!service) fail(`Runtime provenance is missing ${serviceId}`);
      if (service.revision !== sourceById.get(sourceId).revision) fail(`Runtime/source revision mismatch for ${serviceId}`);
      if (!/^sha256:[a-f0-9]{64}$/.test(service.image_digest || "") || !/^sha256:[a-f0-9]{64}$/.test(service.image_id || "")) {
        fail(`Immutable runtime image provenance is missing for ${serviceId}`);
      }
      if (service.configuration?.status !== "VERIFIED" || service.configuration?.redacted !== true) {
        fail(`Redacted runtime configuration provenance is not verified for ${serviceId}`);
      }
    }
  }
  if (sourceById.has("HUB") && runtimeById.get("dsdst-customer-hub")?.revision !== sourceById.get("HUB").revision) {
    fail("Runtime/source revision mismatch for dsdst-customer-hub");
  }
  const schemaChecks = [
    ["panel_database", "dsdst-panel"],
    ["kit_database", "dsdst-kit-studio"],
    ["label_state", "label-printer"],
    ["customer_hub_database", "dsdst-customer-hub"],
  ];
  for (const [componentName, serviceId] of schemaChecks) {
    const service = runtimeById.get(serviceId);
    if (!service) fail(`Runtime provenance is missing ${serviceId}`);
    if (String(service.schema?.version) !== components[componentName].schema_version) {
      fail(`Schema mismatch for ${serviceId}`);
    }
  }
  return {
    source_set: {
      release: sourceSet.release,
      repositories: sourceSet.repositories.map(({ id, repository, revision, role }) => ({ id, repository, revision, ...(role ? { role } : {}) })),
      controller_revision: observedById.get("O")?.controller_revision || sourceById.get("O").revision,
    },
    runtime: {
      capture_id: runtime.capture_id,
      captured_at: runtime.captured_at,
      services: runtime.services.map((service) => ({
        service_id: service.service_id,
        revision: service.revision,
        image_digest: service.image_digest,
        image_id: service.image_id,
        ...(service.declared_image_reference ? { declared_image_reference: service.declared_image_reference } : {}),
        schema: service.schema,
        configuration_fingerprint: service.configuration.fingerprint,
      })),
    },
  };
}

export function buildRecoveryManifest(pointPath, options) {
  const recoveryPointId = String(options?.recoveryPointId || "");
  if (!/^rp-[a-zA-Z0-9._-]+$/.test(recoveryPointId)) fail("Invalid immutable recovery-point ID");
  const createdAt = new Date(options.createdAt);
  const completedAt = new Date(options.completedAt);
  if (Number.isNaN(createdAt.getTime()) || Number.isNaN(completedAt.getTime()) || completedAt < createdAt) {
    fail("Invalid recovery-point timestamps");
  }
  const components = inspectComponents(pointPath);
  const provenance = validateProvenance(pointPath, components);
  const checkedAt = completedAt.toISOString();
  const manifest = signRecoveryManifest({
    format_version: FORMAT_VERSION,
    recovery_point_id: recoveryPointId,
    immutable: true,
    created_at: createdAt.toISOString(),
    completed_at: completedAt.toISOString(),
    tool: { name: "dsdst-operations-recovery", version: TOOL_VERSION, backup_type: "complete-online-snapshot" },
    status: "INCOMPLETE",
    components,
    provenance,
    verification: { state: "VERIFIED", checked_at: checkedAt, checks: ["sha256", "size", "sqlite-integrity", "schema", "source-set", "runtime-provenance"] },
    offsite: { enabled: Boolean(options.offsiteEnabled), state: options.offsiteEnabled ? "PENDING" : "DISABLED" },
  }, options);
  atomicWriteJson(path.join(pointPath, "manifest.json"), manifest);
  return manifest;
}

export function applyOffsiteResult(manifest, result) {
  const next = structuredClone(manifest);
  delete next.integrity;
  next.offsite = {
    enabled: Boolean(result.enabled),
    state: result.state,
    ...(result.remoteRoot ? { location: result.remoteRoot } : {}),
    ...(result.configFingerprint ? { config_fingerprint: result.configFingerprint } : {}),
    ...(result.persistedAt ? { persisted_at: result.persistedAt } : {}),
    ...(result.payload ? {
      payload: {
        path: result.payload.path,
        sha256: result.payload.sha256,
        size_bytes: result.payload.sizeBytes,
      },
    } : {}),
    ...(result.integrityEvidence ? {
      integrity_evidence: {
        path: result.integrityEvidence.path,
        encrypted: true,
        remote_hash_verified: result.integrityEvidence.remoteHashVerified === true,
      },
    } : {}),
    ...(result.error ? { error: String(result.error).slice(0, 1000) } : {}),
  };
  next.status = next.offsite.state === "FAILED" ? "FAILED" : "INCOMPLETE";
  return next;
}

function assertPersistedOffsiteEvidence(manifest) {
  if (manifest.verification?.state !== "VERIFIED" || manifest.offsite?.state !== "PERSISTED") {
    fail("Recovery point is missing VERIFIED local or PERSISTED offsite state");
  }
  if (manifest.offsite.enabled !== true || typeof manifest.offsite.location !== "string" || manifest.offsite.location.length === 0) {
    fail("Accepted recovery point is missing its exact offsite location");
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(manifest.offsite.config_fingerprint || "")) {
    fail("Accepted recovery point is missing its redacted offsite configuration fingerprint");
  }
  const payload = manifest.offsite.payload;
  const evidence = manifest.offsite.integrity_evidence;
  if (!payload || !/^[a-f0-9]{64}$/.test(payload.sha256 || "") || payload.size_bytes <= 0 ||
      typeof payload.path !== "string" || !payload.path.startsWith(`${manifest.offsite.location}/`)) {
    fail("Accepted recovery point is missing verified encrypted payload evidence");
  }
  if (!evidence || evidence.encrypted !== true || evidence.remote_hash_verified !== true ||
      typeof evidence.path !== "string" || !evidence.path.startsWith(`${manifest.offsite.location}/`)) {
    fail("Accepted recovery point is missing verified encrypted manifest integrity evidence");
  }
}

export function assertAcceptedManifest(manifest) {
  if (manifest.status !== "SUCCESS") {
    fail("Recovery point is not accepted: status=SUCCESS, verification=VERIFIED, and offsite=PERSISTED are required");
  }
  assertPersistedOffsiteEvidence(manifest);
}

function verifyManifestAgainstPoint(pointPath, manifest, options = {}) {
  verifyManifestIntegrity(manifest, options);
  if (manifest.format_version !== FORMAT_VERSION) fail("Unsupported recovery manifest format");
  if (manifest.recovery_point_id !== path.basename(pointPath)) fail("Recovery manifest ID does not match its directory");
  if (manifest.verification?.state !== "VERIFIED") fail("Recovery point local verification is not VERIFIED");
  const observed = inspectComponents(pointPath);
  for (const name of Object.keys(COMPONENTS)) {
    const expected = manifest.components?.[name];
    if (!expected) fail(`Missing component in manifest: ${name}`);
    if (expected.path !== observed[name].path || expected.size_bytes !== observed[name].size_bytes || expected.sha256 !== observed[name].sha256) {
      fail(`Component hash mismatch: ${name}`);
    }
    if (expected.schema_version !== observed[name].schema_version) fail(`Component schema mismatch: ${name}`);
  }
  validateProvenance(pointPath, observed);
  if (options.requireAccepted) assertAcceptedManifest(manifest);
  return manifest;
}

export function verifyRecoveryPoint(pointPath, options = {}) {
  const manifestPath = path.resolve(options.manifestPath || path.join(pointPath, "manifest.json"));
  if (!fs.existsSync(manifestPath)) fail("Recovery manifest is missing");
  const manifest = readJson(manifestPath, "Recovery manifest");
  return verifyManifestAgainstPoint(pointPath, manifest, options);
}

export function stageFinalRecoveryManifest(pointPath, candidatePath, options = {}) {
  if (path.resolve(candidatePath) === path.resolve(pointPath, "manifest.json")) fail("Final manifest candidate must not replace the canonical manifest before finalization");
  const current = verifyRecoveryPoint(pointPath, options);
  if (current.status === "SUCCESS") fail("Recovery point is already SUCCESS");
  const next = applyOffsiteResult(current, {
    enabled: true,
    state: "PERSISTED",
    remoteRoot: options.remoteRoot,
    configFingerprint: options.configFingerprint,
    persistedAt: options.persistedAt,
    payload: options.payload,
    integrityEvidence: options.integrityEvidence,
  });
  const signed = signRecoveryManifest(next, options);
  verifyManifestAgainstPoint(pointPath, signed, options);
  assertPersistedOffsiteEvidence(signed);
  atomicWriteJson(candidatePath, signed);
  return signed;
}

export function promoteFinalRecoveryManifest(pointPath, candidatePath, options = {}) {
  if (path.resolve(candidatePath) === path.resolve(pointPath, "manifest.json")) fail("Final manifest candidate must remain separate until finalization");
  const current = verifyRecoveryPoint(pointPath, options);
  if (current.status === "SUCCESS") fail("Recovery point is already SUCCESS");
  const staged = readJson(candidatePath, "Staged offsite recovery manifest");
  if (staged.recovery_point_id !== current.recovery_point_id) fail("Staged recovery manifest ID mismatch");
  verifyManifestAgainstPoint(pointPath, staged, options);
  assertPersistedOffsiteEvidence(staged);
  staged.status = "SUCCESS";
  const signed = signRecoveryManifest(staged, options);
  verifyManifestAgainstPoint(pointPath, signed, { ...options, requireAccepted: true });
  atomicWriteJson(candidatePath, signed);
  return signed;
}

export function finalizeRecoveryPoint(pointPath, candidatePath, options = {}) {
  const canonicalPath = path.join(pointPath, "manifest.json");
  if (path.resolve(candidatePath) === path.resolve(canonicalPath)) fail("Final manifest candidate must be separate from the canonical manifest");
  const current = verifyRecoveryPoint(pointPath, options);
  if (current.status === "SUCCESS") fail("Recovery point is already SUCCESS");
  const candidate = readJson(candidatePath, "Final recovery manifest candidate");
  if (candidate.recovery_point_id !== current.recovery_point_id) fail("Final recovery manifest candidate ID mismatch");
  verifyManifestAgainstPoint(pointPath, candidate, { ...options, requireAccepted: true });
  fs.renameSync(candidatePath, canonicalPath);
  const directory = fs.openSync(pointPath, "r");
  try {
    fs.fsyncSync(directory);
  } finally {
    fs.closeSync(directory);
  }
  return candidate;
}

export function retentionOffsiteLocation(pointPath, options = {}) {
  const manifest = verifyRecoveryPoint(pointPath, { ...options, requireAccepted: true });
  return manifest.offsite.location;
}

export function retentionOffsiteConfigFingerprint(pointPath, options = {}) {
  const manifest = verifyRecoveryPoint(pointPath, { ...options, requireAccepted: true });
  return manifest.offsite.config_fingerprint;
}

function isInside(candidate, root) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

export function validateRestoreTarget(targetPath, productionPaths = []) {
  if (!path.isAbsolute(targetPath)) fail("Restore target must be absolute");
  const target = path.resolve(targetPath);
  const filesystemRoot = path.parse(target).root;
  if (target === filesystemRoot) fail("Restore target overlaps a production or protected path");
  const prohibited = [...productionPaths]
    .filter(Boolean)
    .map((candidate) => path.resolve(candidate));
  if (prohibited.some((candidate) => isInside(target, candidate))) fail("Restore target overlaps a production or protected path");
  if (fs.existsSync(target) && fs.readdirSync(target).length > 0) fail("Restore target must be absent or empty");
  return target;
}

function extractArchive(archivePath, targetPath) {
  archiveEntries(archivePath);
  fs.mkdirSync(targetPath, { recursive: true });
  execFileSync("tar", ["-xzf", archivePath, "-C", targetPath, "--no-same-owner", "--no-same-permissions"]);
}

export function restoreRecoveryPoint(pointPath, targetPath, options = {}) {
  const manifest = verifyRecoveryPoint(pointPath, {
    ...options,
    requireAccepted: options.allowLocalOnly !== true,
  });
  const target = validateRestoreTarget(targetPath, options.productionPaths || []);
  const staging = `${target}.partial-${randomUUID()}`;
  fs.mkdirSync(staging, { recursive: true, mode: 0o750 });
  try {
    const copies = [
      ["payload/panel/database.sqlite", "panel/data/dsdst_panel.db"],
      ["payload/kit/database.sqlite", "kit/data/dsdst-kit-studio.db"],
      ["payload/customer-hub/database.sqlite", "customer-hub/data/customer-hub.db"],
    ];
    for (const [source, destination] of copies) {
      const output = path.join(staging, destination);
      fs.mkdirSync(path.dirname(output), { recursive: true });
      fs.copyFileSync(path.join(pointPath, source), output);
    }
    extractArchive(path.join(pointPath, "payload/panel/uploads.tar.gz"), path.join(staging, "panel/uploads"));
    extractArchive(path.join(pointPath, "payload/kit/uploads.tar.gz"), path.join(staging, "kit/uploads"));
    extractArchive(path.join(pointPath, "payload/label/state.tar.gz"), path.join(staging, "label/data"));
    extractArchive(path.join(pointPath, "payload/customer-hub/attachments.tar.gz"), path.join(staging, "customer-hub/data/attachments"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (fs.existsSync(target)) fs.rmdirSync(target);
    fs.renameSync(staging, target);
    return {
      state: options.allowLocalOnly === true ? "VERIFIED_LOCAL_ONLY" : "VERIFIED",
      recoveryPointId: manifest.recovery_point_id,
      target,
    };
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

function utcDay(date) {
  return date.toISOString().slice(0, 10);
}

function utcWeek(date) {
  const value = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = value.getUTCDay() || 7;
  value.setUTCDate(value.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(value.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((value - yearStart) / 86400000) + 1) / 7);
  return `${value.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function utcMonth(date) {
  return date.toISOString().slice(0, 7);
}

export function planRetention(points, now = new Date()) {
  const valid = points
    .filter((point) => point?.verification?.state === "VERIFIED" && point.status === "SUCCESS" &&
      point.offsite?.state === "PERSISTED" && Number.isFinite(new Date(point.created_at).getTime()))
    .sort((left, right) => new Date(right.created_at) - new Date(left.created_at));
  const keep = new Set();
  const reasons = { hourly: [], daily: [], weekly: [], monthly: [], last_known_good: [] };
  const choose = (name, maxAgeMs, bucket, limit) => {
    const seen = new Set();
    for (const point of valid) {
      const age = now.getTime() - new Date(point.created_at).getTime();
      if (age < 0 || age > maxAgeMs) continue;
      const key = bucket(new Date(point.created_at));
      if (seen.has(key) || seen.size >= limit) continue;
      seen.add(key);
      keep.add(point.id);
      reasons[name].push(point.id);
    }
  };
  choose("hourly", 48 * 3600_000, (date) => date.toISOString().slice(0, 13), 49);
  choose("daily", 30 * 86400_000, utcDay, 30);
  choose("weekly", 12 * 7 * 86400_000, utcWeek, 12);
  choose("monthly", 366 * 86400_000, utcMonth, 12);
  if (valid[0] && !keep.has(valid[0].id)) {
    keep.add(valid[0].id);
    reasons.last_known_good.push(valid[0].id);
  }
  return {
    keep: [...keep],
    delete: valid.filter((point) => !keep.has(point.id)).map((point) => point.id),
    reasons,
  };
}

export function calculateRecoveryHealth(points, now = new Date()) {
  const latest = points
    .filter((point) => point.status === "SUCCESS" && point.verification?.state === "VERIFIED" && point.offsite?.state === "PERSISTED")
    .map((point) => ({ ...point, time: new Date(point.created_at).getTime() }))
    .filter((point) => Number.isFinite(point.time))
    .sort((left, right) => right.time - left.time)[0];
  if (!latest) return { healthy: false, reason: "NO_SUCCESSFUL_RECOVERY_POINT", age_minutes: null };
  const ageMinutes = (now.getTime() - latest.time) / 60000;
  return { healthy: ageMinutes <= 60, reason: ageMinutes <= 60 ? "HEALTHY" : "RPO_EXCEEDED", age_minutes: ageMinutes, recovery_point_id: latest.id || latest.recovery_point_id };
}

export function createDrillEvidence(manifest, input) {
  const startedAt = new Date(input.startedAt);
  const completedAt = new Date(input.completedAt);
  if (Number.isNaN(startedAt.getTime()) || Number.isNaN(completedAt.getTime()) || completedAt < startedAt) fail("Invalid drill timestamps");
  const durationSeconds = Math.round((completedAt - startedAt) / 1000);
  const freshnessMinutes = Math.max(0, (startedAt - new Date(manifest.created_at)) / 60000);
  const rtoMet = durationSeconds <= 3600;
  const rpoMet = freshnessMinutes <= 60;
  const targetMisses = [];
  if (!rpoMet) targetMisses.push({ target: "RPO", target_minutes: 60, observed_minutes: freshnessMinutes });
  if (!rtoMet) targetMisses.push({ target: "RTO", target_seconds: 3600, observed_seconds: durationSeconds });
  if (input.failureStage) {
    const target = String(input.failureStage).toUpperCase();
    if (!targetMisses.some((miss) => miss.target === target)) {
      targetMisses.push({ target, reason: String(input.error || "drill check failed").slice(0, 1000) });
    }
  }
  const result = input.result === "SUCCESS" && targetMisses.length === 0 ? "SUCCESS" : "FAILED";
  return {
    evidence_version: "dsdst.recovery-drill.v1",
    drill_id: input.drillId || `drill-${randomUUID()}`,
    drill_type: input.drillType,
    recovery_point_id: manifest.recovery_point_id,
    recovery_point_created_at: manifest.created_at,
    started_at: startedAt.toISOString(),
    completed_at: completedAt.toISOString(),
    duration_seconds: durationSeconds,
    rto_target_seconds: 3600,
    rto_met: rtoMet,
    rpo_freshness_minutes_at_start: freshnessMinutes,
    rpo_target_minutes: 60,
    rpo_met: rpoMet,
    restored_source_set: manifest.provenance.source_set.repositories,
    result,
    target_misses: targetMisses,
    ...(input.error ? { error: String(input.error).slice(0, 2000) } : {}),
    evidence_path: input.evidencePath,
    evidence_location: "OUTSIDE_PROTECTED_DATABASES",
  };
}
