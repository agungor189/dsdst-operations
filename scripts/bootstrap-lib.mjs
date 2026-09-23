import fs from 'node:fs';
import path from 'node:path';
import {createHash, createHmac, randomUUID, timingSafeEqual} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';

export const BOOTSTRAP_FORMAT = 'dsdst.legacy-bootstrap.v1';
export const BOOTSTRAP_TOOL_VERSION = 'v2.18.0';

const REQUIRED_SERVICES = [
  'dsdst-panel',
  'dsdst-warehouse',
  'dsdst-kit-studio',
  'dsdst-customer-hub',
  'label-printer',
  'warehouse-label-renderer',
];

const COMPONENTS = Object.freeze({
  panel_database: {path: 'payload/panel/database.sqlite', kind: 'sqlite'},
  panel_uploads: {path: 'payload/panel/uploads.tar.gz', kind: 'archive'},
  kit_database: {path: 'payload/kit/database.sqlite', kind: 'sqlite'},
  kit_uploads: {path: 'payload/kit/uploads.tar.gz', kind: 'archive'},
  label_state: {path: 'payload/label/state.tar.gz', kind: 'json-state'},
  customer_hub_database: {path: 'payload/customer-hub/database.sqlite', kind: 'sqlite'},
  customer_hub_attachments: {path: 'payload/customer-hub/attachments.tar.gz', kind: 'archive'},
  legacy_runtime: {path: 'provenance/legacy-runtime.json', kind: 'provenance'},
});

function fail(message) { throw new Error(message); }

function manifestKey(options = {}) {
  const value = options.manifestKey ?? process.env.RECOVERY_MANIFEST_HMAC_KEY;
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') < 32) {
    fail('RECOVERY_MANIFEST_HMAC_KEY must provide at least 32 bytes of external key material');
  }
  return Buffer.from(value, 'utf8');
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
  }
  return value;
}

function authenticationPayload(manifest) {
  const unsigned = structuredClone(manifest);
  delete unsigned.integrity;
  return JSON.stringify(canonicalValue(unsigned));
}

export function signBootstrapManifest(manifest, options = {}) {
  const signed = structuredClone(manifest);
  delete signed.integrity;
  const keyId = String(options.manifestKeyId ?? process.env.RECOVERY_MANIFEST_HMAC_KEY_ID ?? 'external-v1');
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(keyId)) fail('Invalid bootstrap manifest key ID');
  signed.integrity = {
    algorithm: 'HMAC-SHA256',
    key_id: keyId,
    value: createHmac('sha256', manifestKey(options)).update(authenticationPayload(signed)).digest('hex'),
  };
  return signed;
}

export function verifyBootstrapManifestIntegrity(manifest, options = {}) {
  if (manifest?.integrity?.algorithm !== 'HMAC-SHA256' ||
      typeof manifest.integrity.key_id !== 'string' ||
      !/^[a-f0-9]{64}$/.test(manifest.integrity.value || '')) {
    fail('Bootstrap manifest authenticated integrity evidence is missing or invalid');
  }
  const observed = createHmac('sha256', manifestKey(options)).update(authenticationPayload(manifest)).digest();
  const expected = Buffer.from(manifest.integrity.value, 'hex');
  if (expected.length !== observed.length || !timingSafeEqual(expected, observed)) {
    fail('Bootstrap manifest authenticated integrity verification failed');
  }
  return manifest;
}

function atomicWriteJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), {recursive: true});
  const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  const fd = fs.openSync(temporary, 'wx', 0o640);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temporary, filePath);
  const dir = fs.openSync(path.dirname(filePath), 'r');
  try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
}

function sha256File(filePath) {
  const hash = createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const bytes = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytes === 0) break;
      hash.update(buffer.subarray(0, bytes));
    }
  } finally { fs.closeSync(fd); }
  return hash.digest('hex');
}

function archiveEntries(filePath) {
  const list = execFileSync('tar', ['-tzf', filePath], {encoding: 'utf8', maxBuffer: 16 * 1024 * 1024});
  const entries = list.split('\n').filter(Boolean);
  for (const entry of entries) {
    const normalized = path.posix.normalize(entry.replace(/^\.\//, ''));
    if (path.posix.isAbsolute(entry) || normalized === '..' || normalized.startsWith('../')) {
      fail(`Unsafe archive entry in ${filePath}: ${entry}`);
    }
  }
  const verbose = execFileSync('tar', ['-tvzf', filePath], {encoding: 'utf8', maxBuffer: 16 * 1024 * 1024});
  for (const line of verbose.split('\n').filter(Boolean)) {
    if (!['-', 'd'].includes(line[0])) fail(`Unsupported archive entry type in ${filePath}`);
  }
  return entries;
}

function sqliteObservation(filePath) {
  const db = new DatabaseSync(filePath, {readOnly: true});
  try {
    const integrity = db.prepare('PRAGMA integrity_check').all();
    if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok') fail(`SQLite integrity failed for ${filePath}`);
    const table = db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get();
    if (!table) fail(`SQLite schema_migrations is missing for ${filePath}`);
    const row = db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get();
    if (row?.version === null || row?.version === undefined) fail(`SQLite schema version is missing for ${filePath}`);
    return {integrity: 'ok', schema_version: String(row.version)};
  } finally { db.close(); }
}

function labelObservation(filePath) {
  const entries = archiveEntries(filePath);
  const entry = entries.find((candidate) => candidate.replace(/^\.\//, '') === 'app-state.json');
  if (!entry) fail('Label state archive is missing app-state.json');
  const raw = execFileSync('tar', ['-xOzf', filePath, entry], {encoding: 'utf8', maxBuffer: 16 * 1024 * 1024});
  const state = JSON.parse(raw);
  if (![1, 2, 3].includes(Number(state?.version))) fail('Label state schema version is missing or unsupported');
  return {schema_version: String(state.version)};
}

function inspectComponents(pointPath) {
  const result = {};
  for (const [name, spec] of Object.entries(COMPONENTS)) {
    const filePath = path.join(pointPath, spec.path);
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) fail(`Missing bootstrap component: ${name}`);
    const component = {
      path: spec.path,
      kind: spec.kind,
      required: true,
      sha256: sha256File(filePath),
      size_bytes: fs.statSync(filePath).size,
    };
    if (spec.kind === 'sqlite') Object.assign(component, sqliteObservation(filePath));
    else if (spec.kind === 'archive') archiveEntries(filePath);
    else if (spec.kind === 'json-state') Object.assign(component, labelObservation(filePath));
    result[name] = component;
  }
  return result;
}

export function validateLegacyRuntimeEvidence(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Legacy runtime evidence must be an object');
  if (value.evidence_version !== 'dsdst.legacy-runtime.v1') fail('Legacy runtime evidence version is unsupported');
  if (value.source_provenance_state !== 'UNVERIFIED_LEGACY') fail('Legacy source provenance must remain UNVERIFIED_LEGACY');
  if (value.source_revision_claimed !== false) fail('Legacy runtime evidence must not claim a source revision');
  if (!Array.isArray(value.services) || value.services.length !== REQUIRED_SERVICES.length) fail('Legacy runtime evidence must contain six services');
  const ids = new Set();
  for (const service of value.services) {
    if (!REQUIRED_SERVICES.includes(service.service_id) || ids.has(service.service_id)) fail('Legacy runtime service set is invalid');
    ids.add(service.service_id);
    if (!/^[a-f0-9]{64}$/.test(service.container_id || '')) fail(`Legacy container identity is invalid for ${service.service_id}`);
    if (!/^sha256:[a-f0-9]{64}$/.test(service.image_id || '')) fail(`Legacy image ID is invalid for ${service.service_id}`);
    if (service.source_revision !== null || service.source_revision_verified !== false) fail('Legacy source revision must remain explicitly unverified');
    if (!Array.isArray(service.mounts)) fail(`Legacy mounts are missing for ${service.service_id}`);
    for (const mount of service.mounts) {
      if (!/^sha256:[a-f0-9]{64}$/.test(mount.source_id || '')) fail(`Legacy mount source identity is invalid for ${service.service_id}`);
      if (!['ro', 'rw'].includes(mount.mode)) fail(`Legacy mount mode is invalid for ${service.service_id}`);
      if (typeof mount.target !== 'string' || !mount.target.startsWith('/')) fail(`Legacy mount target is invalid for ${service.service_id}`);
    }
  }
  const label = value.services.find((service) => service.service_id === 'label-printer');
  const renderer = value.services.find((service) => service.service_id === 'warehouse-label-renderer');
  const labelState = label.mounts.find((mount) => mount.target === '/app/data');
  const rendererState = renderer.mounts.find((mount) => mount.target === '/app/data');
  if (!labelState || !rendererState || labelState.source_id !== rendererState.source_id) fail('Legacy Label Printer and renderer must share state source identity');
  return value;
}

export function buildBootstrapManifest(pointPath, options = {}) {
  const bootstrapId = String(options.bootstrapId || path.basename(pointPath));
  if (!/^bootstrap-[A-Za-z0-9._-]+$/.test(bootstrapId)) fail('Invalid bootstrap ID');
  if (path.basename(pointPath) !== bootstrapId) fail('Bootstrap directory name must match bootstrap ID');
  const createdAt = new Date(options.createdAt);
  const completedAt = new Date(options.completedAt);
  if (Number.isNaN(createdAt.getTime()) || Number.isNaN(completedAt.getTime()) || completedAt < createdAt) fail('Invalid bootstrap timestamps');
  const components = inspectComponents(pointPath);
  const legacy = JSON.parse(fs.readFileSync(path.join(pointPath, COMPONENTS.legacy_runtime.path), 'utf8'));
  validateLegacyRuntimeEvidence(legacy);
  const manifest = signBootstrapManifest({
    format_version: BOOTSTRAP_FORMAT,
    bootstrap_id: bootstrapId,
    immutable: true,
    created_at: createdAt.toISOString(),
    completed_at: completedAt.toISOString(),
    tool: {name: 'dsdst-v2-18-legacy-bootstrap', version: BOOTSTRAP_TOOL_VERSION},
    purpose: 'ONE_TIME_LEGACY_TO_V2_18_PREVERIFICATION',
    canonical_recovery_point: false,
    final_cutover_source: false,
    status: 'INCOMPLETE',
    source: {
      runtime_class: 'LEGACY_UNVERIFIABLE',
      source_provenance_state: 'UNVERIFIED_LEGACY',
      source_revision_claimed: false,
    },
    components,
    verification: {state: 'VERIFIED', checks: ['sha256', 'size', 'sqlite-integrity', 'schema', 'archive-safety', 'legacy-runtime-identity']},
    offsite: {enabled: true, state: 'PENDING'},
  }, options);
  atomicWriteJson(path.join(pointPath, 'manifest.json'), manifest);
  return manifest;
}

function verifyManifestAgainstPoint(pointPath, manifest, options = {}) {
  verifyBootstrapManifestIntegrity(manifest, options);
  if (manifest.format_version !== BOOTSTRAP_FORMAT) fail('Unsupported bootstrap manifest format');
  if (manifest.bootstrap_id !== path.basename(pointPath)) fail('Bootstrap manifest ID does not match its directory');
  if (manifest.canonical_recovery_point !== false || manifest.final_cutover_source !== false) fail('Bootstrap evidence cannot be treated as canonical recovery or final cutover state');
  if (manifest.source?.source_provenance_state !== 'UNVERIFIED_LEGACY' || manifest.source?.source_revision_claimed !== false) fail('Bootstrap source provenance was improperly upgraded');
  if (manifest.verification?.state !== 'VERIFIED') fail('Bootstrap local verification is not VERIFIED');
  const observed = inspectComponents(pointPath);
  for (const name of Object.keys(COMPONENTS)) {
    const expected = manifest.components?.[name];
    if (!expected || expected.path !== observed[name].path || expected.size_bytes !== observed[name].size_bytes || expected.sha256 !== observed[name].sha256) {
      fail(`Bootstrap component hash mismatch: ${name}`);
    }
    if (expected.schema_version !== observed[name].schema_version) fail(`Bootstrap component schema mismatch: ${name}`);
  }
  const legacy = JSON.parse(fs.readFileSync(path.join(pointPath, COMPONENTS.legacy_runtime.path), 'utf8'));
  validateLegacyRuntimeEvidence(legacy);
  if (options.requireAccepted) {
    if (manifest.status !== 'SUCCESS' || manifest.offsite?.state !== 'PERSISTED' || manifest.offsite?.encrypted !== true || manifest.offsite?.remote_hash_verified !== true) {
      fail('Bootstrap point is not accepted: SUCCESS + encrypted PERSISTED offsite evidence is required');
    }
  }
  return manifest;
}

export function verifyBootstrapPoint(pointPath, options = {}) {
  const manifestPath = path.join(pointPath, 'manifest.json');
  if (!fs.existsSync(manifestPath)) fail('Bootstrap manifest is missing');
  return verifyManifestAgainstPoint(pointPath, JSON.parse(fs.readFileSync(manifestPath, 'utf8')), options);
}

export function stageBootstrapOffsite(pointPath, candidatePath, input, options = {}) {
  const current = verifyBootstrapPoint(pointPath, options);
  if (current.status === 'SUCCESS') fail('Bootstrap point is already SUCCESS');
  const next = structuredClone(current);
  delete next.integrity;
  next.offsite = {
    enabled: true,
    state: 'PERSISTED',
    encrypted: true,
    remote_hash_verified: true,
    location: input.remoteRoot,
    config_fingerprint: input.configFingerprint,
    persisted_at: input.persistedAt,
    payload: {path: input.payloadPath, sha256: input.payloadSha256, size_bytes: Number(input.payloadSize)},
    manifest_path: input.manifestPath,
  };
  const signed = signBootstrapManifest(next, options);
  verifyManifestAgainstPoint(pointPath, signed, options);
  atomicWriteJson(candidatePath, signed);
  return signed;
}

export function promoteBootstrapSuccess(pointPath, candidatePath, options = {}) {
  const current = verifyBootstrapPoint(pointPath, options);
  if (current.status === 'SUCCESS') fail('Bootstrap point is already SUCCESS');
  const staged = JSON.parse(fs.readFileSync(candidatePath, 'utf8'));
  verifyManifestAgainstPoint(pointPath, staged, options);
  if (staged.offsite?.state !== 'PERSISTED') fail('Bootstrap offsite persistence is not complete');
  staged.status = 'SUCCESS';
  const signed = signBootstrapManifest(staged, options);
  verifyManifestAgainstPoint(pointPath, signed, {...options, requireAccepted: true});
  atomicWriteJson(candidatePath, signed);
  return signed;
}

export function finalizeBootstrapPoint(pointPath, candidatePath, options = {}) {
  const current = verifyBootstrapPoint(pointPath, options);
  if (current.status === 'SUCCESS') fail('Bootstrap point is already SUCCESS');
  const candidate = JSON.parse(fs.readFileSync(candidatePath, 'utf8'));
  verifyManifestAgainstPoint(pointPath, candidate, {...options, requireAccepted: true});
  fs.renameSync(candidatePath, path.join(pointPath, 'manifest.json'));
  const dir = fs.openSync(pointPath, 'r');
  try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
  return candidate;
}

function isInside(candidate, root) { return candidate === root || candidate.startsWith(`${root}${path.sep}`); }

function validateRestoreTarget(targetPath, protectedPaths = []) {
  if (!path.isAbsolute(targetPath)) fail('Bootstrap restore target must be absolute');
  const target = path.resolve(targetPath);
  if (target === path.parse(target).root) fail('Bootstrap restore target is unsafe');
  const prohibited = protectedPaths.filter(Boolean).map((candidate) => path.resolve(candidate));
  if (prohibited.some((candidate) => isInside(target, candidate))) fail('Bootstrap restore target overlaps a protected production path');
  if (fs.existsSync(target) && fs.readdirSync(target).length > 0) fail('Bootstrap restore target must be absent or empty');
  return target;
}

function extractArchive(archivePath, targetPath) {
  archiveEntries(archivePath);
  fs.mkdirSync(targetPath, {recursive: true});
  execFileSync('tar', ['-xzf', archivePath, '-C', targetPath, '--no-same-owner', '--no-same-permissions']);
}

export function restoreBootstrapPoint(pointPath, targetPath, options = {}) {
  const manifest = verifyBootstrapPoint(pointPath, {...options, requireAccepted: true});
  const target = validateRestoreTarget(targetPath, options.protectedPaths || []);
  const staging = `${target}.partial-${randomUUID()}`;
  fs.mkdirSync(staging, {recursive: true, mode: 0o750});
  try {
    const copies = [
      ['payload/panel/database.sqlite', 'panel/data/dsdst_panel.db'],
      ['payload/kit/database.sqlite', 'kit/data/dsdst-kit-studio.db'],
      ['payload/customer-hub/database.sqlite', 'customer-hub/data/customer-hub.db'],
    ];
    for (const [source, destination] of copies) {
      const output = path.join(staging, destination);
      fs.mkdirSync(path.dirname(output), {recursive: true});
      fs.copyFileSync(path.join(pointPath, source), output);
    }
    extractArchive(path.join(pointPath, 'payload/panel/uploads.tar.gz'), path.join(staging, 'panel/uploads'));
    extractArchive(path.join(pointPath, 'payload/kit/uploads.tar.gz'), path.join(staging, 'kit/uploads'));
    extractArchive(path.join(pointPath, 'payload/label/state.tar.gz'), path.join(staging, 'label/data'));
    extractArchive(path.join(pointPath, 'payload/customer-hub/attachments.tar.gz'), path.join(staging, 'customer-hub/data/attachments'));
    fs.mkdirSync(path.dirname(target), {recursive: true});
    if (fs.existsSync(target)) fs.rmdirSync(target);
    fs.renameSync(staging, target);
    return {state: 'VERIFIED_BOOTSTRAP_RESTORE', bootstrap_id: manifest.bootstrap_id, target};
  } catch (error) {
    fs.rmSync(staging, {recursive: true, force: true});
    throw error;
  }
}

export function verifyCandidateAgainstBootstrap(pointPath, runtime, sourceSet, options = {}) {
  const manifest = verifyBootstrapPoint(pointPath, {...options, requireAccepted: true});
  const expected = new Map(sourceSet.repositories.map((entry) => [entry.repository, entry.revision]));
  if (sourceSet.release !== 'V2-18') fail('Candidate verification requires exact V2-18 source set');
  if (!Array.isArray(runtime?.services) || runtime.services.length !== REQUIRED_SERVICES.length) fail('Candidate runtime provenance is incomplete');
  const legacy = JSON.parse(fs.readFileSync(path.join(pointPath, 'provenance/legacy-runtime.json'), 'utf8'));
  validateLegacyRuntimeEvidence(legacy);
  const legacySources = new Set(legacy.services.flatMap((service) => service.mounts.map((mount) => mount.source_id)));
  for (const service of runtime.services) {
    const revision = expected.get(service.source_repository);
    if (!revision || service.revision !== revision) fail(`Candidate source revision mismatch for ${service.service_id}`);
    if (!/^sha256:[a-f0-9]{64}$/.test(service.image_digest || '') || !/^sha256:[a-f0-9]{64}$/.test(service.image_id || '')) fail(`Candidate immutable image provenance missing for ${service.service_id}`);
    if (service.configuration?.status !== 'VERIFIED') fail(`Candidate configuration provenance missing for ${service.service_id}`);
    for (const volume of service.volumes || []) {
      if (legacySources.has(volume.source_id)) fail(`Candidate reuses a legacy production volume for ${service.service_id}`);
    }
    for (const port of service.ports || []) {
      if (port.exposure === 'published' && port.host_ip !== '127.0.0.1') fail(`Candidate port is not loopback-bound for ${service.service_id}`);
    }
  }
  const label = runtime.services.find((service) => service.service_id === 'label-printer');
  const renderer = runtime.services.find((service) => service.service_id === 'warehouse-label-renderer');
  const labelVolume = label?.volumes?.find((volume) => volume.target === '/app/data');
  const rendererVolume = renderer?.volumes?.find((volume) => volume.target === '/app/data');
  if (!labelVolume || !rendererVolume || labelVolume.source_id !== rendererVolume.source_id) fail('Candidate Label Printer and renderer do not share state source identity');
  return {bootstrap_id: manifest.bootstrap_id, candidate_status: 'VERIFIED_EXACT_V2_18'};
}
