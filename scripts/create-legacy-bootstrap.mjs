#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import {createHash, randomBytes} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

import {buildBootstrapManifest, verifyBootstrapPoint} from './bootstrap-lib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REQUIRED = {
  'dsdst-panel': {container: 'dsdst-operations-dsdst-panel-1', mounts: {'/data': 'rw', '/app/uploads': 'rw'}},
  'dsdst-warehouse': {container: 'dsdst-operations-dsdst-warehouse-1', mounts: {}},
  'dsdst-kit-studio': {container: 'dsdst-operations-dsdst-kit-studio-1', mounts: {'/data': 'rw', '/app/uploads': 'rw'}},
  'dsdst-customer-hub': {container: 'dsdst-customer-hub-preview', mounts: {'/data': 'rw'}},
  'label-printer': {container: 'dsdst-operations-label-printer-1', mounts: {'/app/data': 'rw'}},
  'warehouse-label-renderer': {container: 'dsdst-operations-warehouse-label-renderer-1', mounts: {'/app/data': 'ro'}},
};

function fail(message) { throw new Error(message); }
function docker(args) { return execFileSync('docker', args, {encoding: 'utf8', maxBuffer: 8 * 1024 * 1024}).trim(); }
function inspectOne(args) {
  const parsed = JSON.parse(docker(args));
  if (!Array.isArray(parsed) || parsed.length !== 1) fail('Docker inspect did not return exactly one object');
  return parsed[0];
}
function sourceId(mount) {
  return `sha256:${createHash('sha256').update(JSON.stringify([mount.Type, mount.Source])).digest('hex')}`;
}
function parseEnv(filePath) {
  const result = {};
  for (const raw of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 1) continue;
    let value = line.slice(i + 1);
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    result[line.slice(0, i)] = value;
  }
  return result;
}
function stateMount(container, target, mode, serviceId) {
  const matches = (container.Mounts || []).filter((mount) => mount.Destination === target && mount.Type !== 'tmpfs');
  if (matches.length !== 1) fail(`${serviceId} must have exactly one ${target} state mount`);
  const mount = matches[0];
  const observedMode = mount.RW === true ? 'rw' : mount.RW === false ? 'ro' : null;
  if (observedMode !== mode) fail(`${serviceId} ${target} mount mode mismatch`);
  if (!['volume', 'bind'].includes(mount.Type)) fail(`${serviceId} ${target} uses unsupported mount type ${mount.Type}`);
  if (!mount.Source) fail(`${serviceId} ${target} mount source is unavailable`);
  if (mount.Type === 'volume' && !mount.Name) fail(`${serviceId} ${target} volume name is unavailable`);
  return mount;
}
function collectLegacyRuntime() {
  const capturedAt = new Date().toISOString();
  const services = [];
  for (const [serviceId, spec] of Object.entries(REQUIRED)) {
    const container = inspectOne(['inspect', spec.container]);
    if (container?.State?.Running !== true || !/^[a-f0-9]{64}$/.test(container.Id || '')) fail(`${serviceId} is not a stable running container`);
    if (!/^sha256:[a-f0-9]{64}$/.test(container.Image || '')) fail(`${serviceId} image ID is unavailable`);
    const mounts = Object.entries(spec.mounts).map(([target, mode]) => {
      const mount = stateMount(container, target, mode, serviceId);
      return {target, mode, type: mount.Type, source_id: sourceId(mount)};
    });
    services.push({
      service_id: serviceId,
      container_name: spec.container,
      container_id: container.Id,
      image_reference: container.Config?.Image || 'UNKNOWN_LOCAL_REFERENCE',
      image_id: container.Image,
      source_revision: null,
      source_revision_verified: false,
      mounts,
    });
  }
  const label = services.find((s) => s.service_id === 'label-printer').mounts[0];
  const renderer = services.find((s) => s.service_id === 'warehouse-label-renderer').mounts[0];
  if (label.source_id !== renderer.source_id) fail('Legacy Label Printer and renderer do not share the same state source');
  return {
    evidence_version: 'dsdst.legacy-runtime.v1',
    captured_at: capturedAt,
    source_provenance_state: 'UNVERIFIED_LEGACY',
    source_revision_claimed: false,
    services,
  };
}
function core(runtime) {
  return runtime.services.map((service) => ({
    service_id: service.service_id,
    container_id: service.container_id,
    image_id: service.image_id,
    mounts: service.mounts,
  }));
}
function dockerMount(mount, destination) {
  if (mount.Type === 'volume') return `type=volume,src=${mount.Name},dst=${destination},readonly`;
  return `type=bind,src=${mount.Source},dst=${destination},readonly`;
}
function sourceMount(containerName, sourceTarget, expectedMode, destination, serviceId) {
  const container = inspectOne(['inspect', containerName]);
  const mount = stateMount(container, sourceTarget, expectedMode, serviceId);
  return dockerMount(mount, destination);
}
function verifyToolbox(imageReference) {
  if (!/^[^\s@]+@sha256:[a-f0-9]{64}$/.test(imageReference || '')) fail('Toolbox image must be pinned by immutable digest');
  const image = inspectOne(['image', 'inspect', imageReference]);
  if (!(image.RepoDigests || []).includes(imageReference)) fail('Toolbox registry digest is not present locally');
  const sourceSet = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/v2-18-source-set.json'), 'utf8'));
  const expectedO = sourceSet.repositories.find((entry) => entry.id === 'O')?.revision;
  const labels = image.Config?.Labels || {};
  if (labels['org.opencontainers.image.source'] !== 'https://github.com/agungor189/dsdst-operations' || labels['org.opencontainers.image.revision'] !== expectedO) {
    fail('Toolbox OCI source/revision does not match the exact V2-18 Operations content');
  }
}

const [envFileArg, toolboxImageArg, backupRootArg] = process.argv.slice(2);
if (!envFileArg || !toolboxImageArg) {
  console.error('Usage: create-legacy-bootstrap.mjs <production-env-file> <v2-18-toolbox-image@sha256> [backup-root]');
  process.exit(2);
}

try {
  const envFile = path.resolve(envFileArg);
  const env = parseEnv(envFile);
  const backupRoot = path.resolve(backupRootArg || env.OPERATIONS_BACKUP_DIR || path.join(ROOT, 'backups'));
  const hmacKey = env.RECOVERY_MANIFEST_HMAC_KEY;
  const keyId = env.RECOVERY_MANIFEST_HMAC_KEY_ID || 'external-v1';
  if (!hmacKey || Buffer.byteLength(hmacKey) < 32) fail('RECOVERY_MANIFEST_HMAC_KEY is missing from the environment file');
  if (env.RECOVERY_OFFSITE_ENABLED !== 'true') fail('RECOVERY_OFFSITE_ENABLED=true is required before bootstrap snapshot creation');
  if (!env.RECOVERY_OFFSITE_RCLONE_REMOTE && !env.CLOUD_BACKUP_RCLONE_REMOTE) fail('Offsite rclone remote is required before bootstrap snapshot creation');
  if (!env.RECOVERY_ENCRYPTION_PASSPHRASE) fail('RECOVERY_ENCRYPTION_PASSPHRASE is required before bootstrap snapshot creation');
  verifyToolbox(toolboxImageArg);

  const id = `bootstrap-${new Date().toISOString().replace(/[-:.]/g, '').replace('Z', 'Z')}-${randomBytes(4).toString('hex')}`;
  const partial = path.join(backupRoot, 'bootstrap-points', `${id}.partial`);
  const final = path.join(backupRoot, 'bootstrap-points', id);
  fs.mkdirSync(path.dirname(partial), {recursive: true, mode: 0o750});
  if (fs.existsSync(partial) || fs.existsSync(final)) fail('Bootstrap point path already exists');
  const before = collectLegacyRuntime();
  const startedAt = new Date().toISOString();

  const mounts = [
    sourceMount(REQUIRED['dsdst-panel'].container, '/data', 'rw', '/sources/panel-data', 'dsdst-panel'),
    sourceMount(REQUIRED['dsdst-panel'].container, '/app/uploads', 'rw', '/sources/panel-uploads', 'dsdst-panel'),
    sourceMount(REQUIRED['dsdst-kit-studio'].container, '/data', 'rw', '/sources/kit-data', 'dsdst-kit-studio'),
    sourceMount(REQUIRED['dsdst-kit-studio'].container, '/app/uploads', 'rw', '/sources/kit-uploads', 'dsdst-kit-studio'),
    sourceMount(REQUIRED['label-printer'].container, '/app/data', 'rw', '/sources/labels', 'label-printer'),
    sourceMount(REQUIRED['dsdst-customer-hub'].container, '/data', 'rw', '/sources/customer-hub-data', 'dsdst-customer-hub'),
    `type=bind,src=${backupRoot},dst=/backups`,
    `type=bind,src=${path.join(ROOT, 'scripts')},dst=/operations/scripts,readonly`,
  ];
  const args = ['run', '--rm', '-e', `BOOTSTRAP_ID=${id}`];
  for (const mount of mounts) args.push('--mount', mount);
  args.push(toolboxImageArg, 'sh', '/operations/scripts/bootstrap-create-payload.sh');
  execFileSync('docker', args, {stdio: 'inherit'});

  const after = collectLegacyRuntime();
  if (JSON.stringify(core(before)) !== JSON.stringify(core(after))) {
    fs.rmSync(partial, {recursive: true, force: true});
    fail('Legacy runtime identity changed during bootstrap capture; snapshot rejected');
  }
  if (!fs.existsSync(partial)) fail('Bootstrap payload container did not create the expected partial point');
  before.capture_completed_at = after.captured_at;
  fs.writeFileSync(path.join(partial, 'provenance/legacy-runtime.json'), `${JSON.stringify(before, null, 2)}\n`, {mode: 0o640});

  process.env.RECOVERY_MANIFEST_HMAC_KEY = hmacKey;
  process.env.RECOVERY_MANIFEST_HMAC_KEY_ID = keyId;
  // The local payload is verified only after it is atomically moved out of the .partial namespace.
  fs.renameSync(partial, final);
  buildBootstrapManifest(final, {bootstrapId: id, createdAt: startedAt, completedAt: new Date().toISOString()});

  execFileSync('docker', [
    'run', '--rm', '--env-file', envFile,
    '-e', `BOOTSTRAP_ID=${id}`,
    '--mount', `type=bind,src=${backupRoot},dst=/backups`,
    '--mount', `type=bind,src=${path.join(ROOT, 'scripts')},dst=/operations/scripts,readonly`,
    toolboxImageArg, 'sh', '/operations/scripts/bootstrap-offsite-upload.sh',
  ], {stdio: 'inherit'});

  verifyBootstrapPoint(final, {manifestKey: hmacKey, requireAccepted: true});
  fs.chmodSync(final, 0o550);
  process.stdout.write(`Bootstrap snapshot SUCCESS: ${final}\n`);
} catch (error) {
  console.error(`Legacy bootstrap snapshot failed: ${error.message}`);
  process.exitCode = 1;
}
