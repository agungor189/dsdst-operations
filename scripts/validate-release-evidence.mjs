#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
const ajv = new Ajv2020({strict: true});
addFormats(ajv);
const schemaCheck = ajv.compile(JSON.parse(readFileSync(new URL("../schemas/release-evidence.schema.json", import.meta.url), "utf8")));
export function validateSchema(manifest) {
  if (!schemaCheck(manifest)) throw new Error(`Schema validation failed at ${schemaCheck.errors[0].instancePath}`);
}

const UNKNOWN = "NOT VERIFIED";
const NOT_APPLICABLE = "NOT APPLICABLE";
const SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const RUNTIME_COLLECTOR = "dsdst-read-only-runtime-collector-v1";

const EXPECTED_SERVICES = {
  "dsdst-panel": {
    component: "P",
    repository: "agungor189/panel-kit-yonetimi",
    schemaKind: "sqlite",
    safeKeys: ["NODE_ENV", "PORT", "DB_PATH", "BACKUP_DIR", "APP_URL", "ALLOWED_ORIGINS", "LABEL_RENDERER_URL", "WAREHOUSE_PRINT_DRY_RUN", "CUPS_SERVER", "CLOUD_BACKUP_ENABLED"],
    networks: ["edge", "internal"],
    volumes: [
      { source_alias: "PANEL_DATA_DIR", target: "/data", mode: "rw" },
      { source_alias: "PANEL_UPLOADS_DIR", target: "/app/uploads", mode: "rw" },
      { source_alias: "PANEL_BACKUP_DIR", target: "/backups", mode: "rw" },
    ],
    ports: [{ exposure: "published", container_port: 3000, protocol: "tcp" }],
  },
  "dsdst-warehouse": {
    component: "W",
    repository: "agungor189/Dsdst-Warehouse",
    schemaKind: "none",
    safeKeys: ["NODE_ENV", "PORT", "PANEL_API_BASE_URL", "LABEL_RENDERER_URL", "COOKIE_SECURE", "TRUST_PROXY_HOPS"],
    networks: ["edge", "internal"],
    volumes: [],
    ports: [{ exposure: "published", container_port: 3006, protocol: "tcp" }],
  },
  "dsdst-kit-studio": {
    component: "K",
    repository: "agungor189/dsdst-kit-studio",
    schemaKind: "sqlite",
    safeKeys: ["NODE_ENV", "PORT", "DB_PATH", "UPLOAD_DIR", "PANEL_API_URL", "ALLOWED_ORIGINS", "TRUST_PROXY_HOPS"],
    networks: ["edge", "internal"],
    volumes: [
      { source_alias: "KIT_STUDIO_DATA_DIR", target: "/data", mode: "rw" },
      { source_alias: "KIT_STUDIO_UPLOADS_DIR", target: "/app/uploads", mode: "rw" },
    ],
    ports: [{ exposure: "published", container_port: 3012, protocol: "tcp" }],
  },
  "label-printer": {
    component: "L",
    repository: "agungor189/Label-Printer",
    schemaKind: "json-state",
    safeKeys: ["NODE_ENV", "PORT", "DATA_DIR", "STATE_FILE", "PANEL_API_URL", "COOKIE_SECURE", "TRUST_PROXY_HOPS"],
    networks: ["edge", "internal"],
    volumes: [{ source_alias: "LABEL_PRINTER_DATA_DIR", target: "/app/data", mode: "rw" }],
    ports: [{ exposure: "published", container_port: 3000, protocol: "tcp" }],
  },
  "warehouse-label-renderer": {
    component: "renderer",
    repository: "agungor189/Label-Printer",
    schemaKind: "none",
    safeKeys: ["NODE_ENV", "LABEL_RENDERER_PORT", "DATA_DIR", "STATE_FILE"],
    networks: ["internal"],
    volumes: [{ source_alias: "LABEL_PRINTER_DATA_DIR", target: "/app/data", mode: "ro" }],
    ports: [{ exposure: "internal", container_port: 3010, protocol: "tcp" }],
  },
};

const fail = (path, message) => {
  throw new Error(`${path}: ${message}`);
};

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

const requireObject = (value, path) => {
  if (!isObject(value)) fail(path, "must be an object");
  return value;
};

const requireArray = (value, path) => {
  if (!Array.isArray(value)) fail(path, "must be an array");
  return value;
};

const requireString = (value, path) => {
  if (typeof value !== "string" || value.length === 0) fail(path, "must be a non-empty string");
  return value;
};

const requireExactKeys = (value, expectedKeys, path) => {
  requireObject(value, path);
  for (const key of expectedKeys) {
    if (!Object.hasOwn(value, key)) fail(`${path}.${key}`, "is required");
  }
  const unexpected = Object.keys(value).filter((key) => !expectedKeys.includes(key));
  if (unexpected.length > 0) fail(path, `unexpected field(s): ${unexpected.join(", ")}`);
};

const sameJson = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const hostPorts = {"dsdst-panel": ["PANEL_PORT",3000], "dsdst-warehouse": ["WAREHOUSE_PORT",3006], "dsdst-kit-studio": ["KIT_STUDIO_PORT",3012], "label-printer": ["LABEL_PRINTER_PORT",3013]};
const mapping = ({source_id, ...rest}) => rest;

export function getSafeConfigKeys(serviceId) {
  const expected = EXPECTED_SERVICES[serviceId];
  if (!expected) fail("service_id", "is not a PR01 service");
  return [...expected.safeKeys];
}

export function getRuntimeServicePolicies() {
  return Object.entries(EXPECTED_SERVICES).map(([service_id, expected]) => ({
    service_id,
    source_repository: expected.repository,
  }));
}

const validateObserved = (value, path, itemValidator) => {
  if (value === UNKNOWN) return;
  requireArray(value, path).forEach((item, index) => itemValidator(item, `${path}[${index}]`));
};

const validateVolume = (volume, path) => {
  requireExactKeys(volume, ["source_alias", "target", "mode", "source_id"], path);
  if (volume.source_id !== UNKNOWN && !DIGEST_PATTERN.test(volume.source_id)) fail(path, "invalid volume source identity");
  if (!/^[A-Z][A-Z0-9_]*$/.test(requireString(volume.source_alias, `${path}.source_alias`))) {
    fail(`${path}.source_alias`, "must be a redacted configuration alias");
  }
  if (!requireString(volume.target, `${path}.target`).startsWith("/")) fail(`${path}.target`, "must be absolute");
  if (!new Set(["ro", "rw"]).has(volume.mode)) fail(`${path}.mode`, "must be ro or rw");
};

const validatePort = (port, path) => {
  requireExactKeys(port, ["exposure", "host_ip", "host_port", "container_port", "protocol"], path);
  if (!new Set(["published", "internal"]).has(port.exposure)) fail(`${path}.exposure`, "must be published or internal");
  requireString(port.host_ip, `${path}.host_ip`);
  if (!(typeof port.host_port === "string" || Number.isInteger(port.host_port))) fail(`${path}.host_port`, "must be a string or integer");
  if (!Number.isInteger(port.container_port) || port.container_port < 1 || port.container_port > 65535) {
    fail(`${path}.container_port`, "must be a valid port");
  }
  if (!new Set(["tcp", "udp"]).has(port.protocol)) fail(`${path}.protocol`, "must be tcp or udp");
  if (port.exposure === "internal" && (port.host_ip !== NOT_APPLICABLE || port.host_port !== NOT_APPLICABLE)) {
    fail(path, "internal ports cannot claim a host binding");
  }
};

const validateRuntime = (service, expected, path) => {
  const runtime = service.runtime;
  requireExactKeys(runtime, ["commit", "image", "schema", "configuration", "volumes", "networks", "ports"], `${path}.runtime`);

  requireExactKeys(runtime.image, ["declared_reference", "observed_reference", "image_id", "digest", "source_repository", "evidence_source"], `${path}.runtime.image`);
  const declaredReference = requireString(runtime.image.declared_reference, `${path}.runtime.image.declared_reference`);
  const observedReference = requireString(runtime.image.observed_reference, `${path}.runtime.image.observed_reference`);
  const imageId = requireString(runtime.image.image_id, `${path}.runtime.image.image_id`);
  const digest = requireString(runtime.image.digest, `${path}.runtime.image.digest`);
  const sourceRepository = requireString(runtime.image.source_repository, `${path}.runtime.image.source_repository`);
  requireString(runtime.image.evidence_source, `${path}.runtime.image.evidence_source`);
  const imageValues = [declaredReference, observedReference, imageId, digest, sourceRepository];
  const imageUnknown = imageValues.every((value) => value === UNKNOWN);
  const imageKnown = imageValues.every((value) => value !== UNKNOWN);
  if (!imageUnknown && !imageKnown) fail(`${path}.runtime.image`, "must be entirely NOT VERIFIED or contain complete runtime provenance");
  if (imageUnknown && runtime.image.evidence_source !== UNKNOWN) fail(`${path}.runtime.image.evidence_source`, "unverified image must have NOT VERIFIED evidence");
  if (imageKnown) {
    if (declaredReference !== observedReference) fail(`${path}.runtime.image.observed_reference`, "does not match the declared runtime image");
    if (!DIGEST_PATTERN.test(imageId)) fail(`${path}.runtime.image.image_id`, "must be an immutable sha256 image ID");
    if (!DIGEST_PATTERN.test(digest)) fail(`${path}.runtime.image.digest`, "must be an immutable registry digest");
    if (sourceRepository !== expected.repository) fail(`${path}.runtime.image.source_repository`, "does not match the service source repository");
    if (runtime.image.evidence_source !== "runtime-provenance") fail(`${path}.runtime.image.evidence_source`, "must be runtime-provenance");
  }

  requireExactKeys(runtime.commit, ["value", "evidence_source"], `${path}.runtime.commit`);
  const commit = requireString(runtime.commit.value, `${path}.runtime.commit.value`);
  const proof = runtime.commit.evidence_source;
  if (commit === UNKNOWN) {
    if (proof !== UNKNOWN) fail(`${path}.runtime.commit.evidence_source`, "unverified commit must have NOT VERIFIED evidence");
  } else {
    requireExactKeys(proof, ["kind", "capture_id", "service_id", "compose_service", "container_id", "image_reference", "image_id", "image_digest", "source_repository", "revision"], `${path}.runtime.commit.evidence_source`);
    requireString(proof.capture_id, `${path}.runtime.commit.evidence_source.capture_id`);
    if (proof.kind !== "runtime-oci-revision" || !/^[a-f0-9]{64}$/.test(proof.container_id) ||
        proof.service_id !== service.service_id || proof.compose_service !== service.service_id ||
        proof.image_reference !== observedReference || proof.image_id !== imageId ||
        proof.image_digest !== digest || proof.source_repository !== sourceRepository || proof.revision !== commit) {
      fail(`${path}.runtime.commit.evidence_source`, "runtime provenance must bind the service, container, image and OCI revision");
    }
  }
  if (commit !== UNKNOWN && !SHA_PATTERN.test(commit)) fail(`${path}.runtime.commit.value`, "must be NOT VERIFIED or a full Git SHA");
  if (commit !== UNKNOWN && runtime.commit.evidence_source === UNKNOWN) fail(`${path}.runtime.commit.evidence_source`, "must identify runtime evidence for a verified commit");

  requireExactKeys(runtime.schema, ["kind", "version", "evidence_source"], `${path}.runtime.schema`);
  if (runtime.schema.kind !== expected.schemaKind) fail(`${path}.runtime.schema.kind`, `must be ${expected.schemaKind}`);
  requireString(runtime.schema.version, `${path}.runtime.schema.version`);
  requireString(runtime.schema.evidence_source, `${path}.runtime.schema.evidence_source`);
  if (![UNKNOWN, "compose.prod.yml", "read-only schema query"].includes(runtime.schema.evidence_source)) fail(`${path}.runtime.schema.evidence_source`, "unsupported schema evidence source");
  if (runtime.schema.kind === "none" && runtime.schema.version !== NOT_APPLICABLE) fail(`${path}.runtime.schema.version`, "must be NOT APPLICABLE for a stateless service");
  if (runtime.schema.kind !== "none" && runtime.schema.version === NOT_APPLICABLE) fail(`${path}.runtime.schema.version`, "cannot be NOT APPLICABLE for a stateful service");

  requireExactKeys(runtime.configuration, ["status", "fingerprint", "redacted", "safe_keys"], `${path}.runtime.configuration`);
  if (!new Set([UNKNOWN, "VERIFIED"]).has(runtime.configuration.status)) fail(`${path}.runtime.configuration.status`, "must be NOT VERIFIED or VERIFIED");
  const fingerprint = requireString(runtime.configuration.fingerprint, `${path}.runtime.configuration.fingerprint`);
  if (fingerprint !== UNKNOWN && !DIGEST_PATTERN.test(fingerprint)) fail(`${path}.runtime.configuration.fingerprint`, "must be NOT VERIFIED or sha256:<64 lowercase hex>");
  if (runtime.configuration.status === "VERIFIED" && fingerprint === UNKNOWN) fail(`${path}.runtime.configuration.fingerprint`, "is required when configuration is VERIFIED");
  if (runtime.configuration.redacted !== true) fail(`${path}.runtime.configuration.redacted`, "must be true");
  const safeKeys = requireArray(runtime.configuration.safe_keys, `${path}.runtime.configuration.safe_keys`);
  if (new Set(safeKeys).size !== safeKeys.length) fail(`${path}.runtime.configuration.safe_keys`, "must be unique");
  for (const [index, key] of safeKeys.entries()) {
    requireString(key, `${path}.runtime.configuration.safe_keys[${index}]`);
  }
  if (!sameJson(safeKeys, expected.safeKeys)) fail(`${path}.runtime.configuration.safe_keys`, "must exactly match the authoritative service allowlist");

  requireExactKeys(runtime.volumes, ["declared", "observed"], `${path}.runtime.volumes`);
  const declaredVolumes = requireArray(runtime.volumes.declared, `${path}.runtime.volumes.declared`);
  declaredVolumes.forEach((volume, index) => validateVolume(volume, `${path}.runtime.volumes.declared[${index}]`));
  if (!sameJson(declaredVolumes.map(mapping), expected.volumes)) fail(`${path}.runtime.volumes.declared`, "does not match the service mapping contract");
  validateObserved(runtime.volumes.observed, `${path}.runtime.volumes.observed`, validateVolume);
  if (runtime.volumes.observed !== UNKNOWN && !sameJson(runtime.volumes.observed, declaredVolumes)) fail(`${path}.runtime.volumes.observed`, "does not match declared volume mappings");
  if (runtime.volumes.observed !== UNKNOWN && runtime.volumes.observed.some(v => v.source_id === UNKNOWN)) fail(`${path}.runtime.volumes.observed`, "observed volume requires actual source identity");

  requireExactKeys(runtime.networks, ["declared", "observed"], `${path}.runtime.networks`);
  const declaredNetworks = requireArray(runtime.networks.declared, `${path}.runtime.networks.declared`);
  if (!sameJson(declaredNetworks, expected.networks)) fail(`${path}.runtime.networks.declared`, "does not match the service mapping contract");
  validateObserved(runtime.networks.observed, `${path}.runtime.networks.observed`, (network, networkPath) => requireString(network, networkPath));
  if (runtime.networks.observed !== UNKNOWN && !sameJson(runtime.networks.observed, declaredNetworks)) fail(`${path}.runtime.networks.observed`, "does not match declared networks");

  requireExactKeys(runtime.ports, ["declared", "observed"], `${path}.runtime.ports`);
  const declaredPorts = requireArray(runtime.ports.declared, `${path}.runtime.ports.declared`);
  declaredPorts.forEach((port, index) => validatePort(port, `${path}.runtime.ports.declared[${index}]`));
  const portContract = declaredPorts.map(({ exposure, container_port, protocol }) => ({ exposure, container_port, protocol }));
  if (!sameJson(portContract, expected.ports)) fail(`${path}.runtime.ports.declared`, "does not match the service mapping contract");
  const binding = hostPorts[service.service_id];
  const declaredPort = declaredPorts[0];
  if (binding && (declaredPort.host_ip !== "${BIND_ADDRESS:-127.0.0.1}" || declaredPort.host_port !== `\${${binding[0]}:-${binding[1]}}`)) fail(`${path}.runtime.ports.declared`, "unexpected host binding declaration");
  validateObserved(runtime.ports.observed, `${path}.runtime.ports.observed`, validatePort);
  if (runtime.ports.observed !== UNKNOWN) {
    const observedContract = runtime.ports.observed.map(({ exposure, container_port, protocol }) => ({ exposure, container_port, protocol }));
    if (!sameJson(observedContract, expected.ports)) fail(`${path}.runtime.ports.observed`, "does not match the service mapping contract");
    if (binding && (runtime.ports.observed[0].host_ip !== "127.0.0.1" || runtime.ports.observed[0].host_port !== binding[1])) fail(`${path}.runtime.ports.observed`, "unexpected host port binding; overrides require reviewed contract changes");
  }
};

const validateRuntimeProvenance = (manifest, provenance) => {
  requireExactKeys(provenance, ["provenance_version", "capture_id", "captured_at", "collector", "services"], "runtime_provenance");
  if (provenance.provenance_version !== 1) fail("runtime_provenance.provenance_version", "must be 1");
  const captureId = requireString(provenance.capture_id, "runtime_provenance.capture_id");
  if (!/^runtime-[A-Za-z0-9._:-]+$/.test(captureId)) fail("runtime_provenance.capture_id", "has an invalid collector identity");
  if (provenance.captured_at !== manifest.captured_at) fail("runtime_provenance.captured_at", "must match the manifest capture timestamp");
  if (provenance.collector !== RUNTIME_COLLECTOR) fail("runtime_provenance.collector", "is not an authorized read-only collector");
  const records = requireArray(provenance.services, "runtime_provenance.services");
  if (records.length !== Object.keys(EXPECTED_SERVICES).length) fail("runtime_provenance.services", "must contain exactly one record for every PR01 service");
  const byService = new Map();
  const containerIds = new Set();
  for (const [index, record] of records.entries()) {
    const path = `runtime_provenance.services[${index}]`;
    requireExactKeys(record, ["service_id", "compose_service", "container_id", "declared_image_reference", "observed_image_reference", "image_id", "image_digest", "source_repository", "revision"], path);
    const serviceId = requireString(record.service_id, `${path}.service_id`);
    const expected = EXPECTED_SERVICES[serviceId];
    if (!expected) fail(`${path}.service_id`, "is not a PR01 service");
    if (byService.has(serviceId)) fail(`${path}.service_id`, "must be unique");
    if (record.compose_service !== serviceId) fail(`${path}.compose_service`, "does not match the expected service identity");
    if (!/^[a-f0-9]{64}$/.test(record.container_id)) fail(`${path}.container_id`, "must be a full runtime container ID");
    if (containerIds.has(record.container_id)) fail(`${path}.container_id`, "cannot be reused by another service");
    containerIds.add(record.container_id);
    requireString(record.declared_image_reference, `${path}.declared_image_reference`);
    requireString(record.observed_image_reference, `${path}.observed_image_reference`);
    if (record.declared_image_reference !== record.observed_image_reference) fail(`${path}.observed_image_reference`, "does not match the declared runtime image");
    if (!DIGEST_PATTERN.test(record.image_id)) fail(`${path}.image_id`, "must be an immutable sha256 image ID");
    if (!DIGEST_PATTERN.test(record.image_digest)) fail(`${path}.image_digest`, "must be an immutable registry digest");
    if (record.source_repository !== expected.repository) fail(`${path}.source_repository`, "does not match the expected service repository");
    if (!SHA_PATTERN.test(record.revision)) fail(`${path}.revision`, "must be an OCI source revision SHA");
    byService.set(serviceId, record);
  }
  for (const service of manifest.services) {
    const record = byService.get(service.service_id);
    if (!record) fail("runtime_provenance.services", `missing required service ${service.service_id}`);
    const runtime = service.runtime;
    const proof = runtime.commit.evidence_source;
    if (runtime.commit.value === UNKNOWN || proof === UNKNOWN) fail(`runtime_provenance.${service.service_id}`, "cannot verify a service with missing commit provenance");
    if (proof.capture_id !== captureId || proof.service_id !== record.service_id || proof.compose_service !== record.compose_service ||
        proof.container_id !== record.container_id || proof.image_reference !== record.observed_image_reference ||
        proof.image_id !== record.image_id || proof.image_digest !== record.image_digest ||
        proof.source_repository !== record.source_repository || proof.revision !== record.revision) {
      fail(`runtime_provenance.${service.service_id}`, "collector record does not match the manifest runtime provenance");
    }
    if (runtime.commit.value !== record.revision || runtime.image.declared_reference !== record.declared_image_reference ||
        runtime.image.observed_reference !== record.observed_image_reference || runtime.image.image_id !== record.image_id ||
        runtime.image.digest !== record.image_digest || runtime.image.source_repository !== record.source_repository) {
      fail(`runtime_provenance.${service.service_id}`, "collector record does not match the manifest runtime image");
    }
  }
  for (let left = 0; left < records.length; left += 1) {
    for (let right = left + 1; right < records.length; right += 1) {
      if (records[left].source_repository !== records[right].source_repository &&
          (records[left].image_id === records[right].image_id || records[left].image_digest === records[right].image_digest)) {
        fail("runtime_provenance.services", "independent service repositories cannot share the same runtime image identity");
      }
    }
  }
  const label = byService.get("label-printer");
  const renderer = byService.get("warehouse-label-renderer");
  if (label.source_repository !== renderer.source_repository || label.revision !== renderer.revision ||
      label.declared_image_reference !== renderer.declared_image_reference || label.observed_image_reference !== renderer.observed_image_reference ||
      label.image_id !== renderer.image_id || label.image_digest !== renderer.image_digest) {
    fail("runtime_provenance.services", "Label Printer and renderer must share source, revision and runtime image provenance");
  }
};

export function validateReleaseEvidence(manifest, {runtimeProvenance} = {}) {
  requireExactKeys(manifest, ["$schema", "manifest_version", "evidence_id", "environment", "captured_at", "runtime_access", "evidence_status", "source_checkout_notice", "redaction", "services"], "manifest");
  if (manifest.$schema !== "../schemas/release-evidence.schema.json") fail("manifest.$schema", "must reference the repository schema");
  if (manifest.manifest_version !== 1) fail("manifest.manifest_version", "must be 1");
  requireString(manifest.evidence_id, "manifest.evidence_id");
  requireString(manifest.environment, "manifest.environment");
  const capturedAt = requireString(manifest.captured_at, "manifest.captured_at");
  if (capturedAt !== UNKNOWN && Number.isNaN(Date.parse(capturedAt))) fail("manifest.captured_at", "must be NOT VERIFIED or an ISO date-time");
  if (!new Set(["NOT AUTHORIZED", "READ-ONLY AUTHORIZED"]).has(manifest.runtime_access)) fail("manifest.runtime_access", "has an unsupported value");
  if (!new Set([UNKNOWN, "VERIFIED"]).has(manifest.evidence_status)) fail("manifest.evidence_status", "has an unsupported value");
  requireString(manifest.source_checkout_notice, "manifest.source_checkout_notice");
  requireExactKeys(manifest.redaction, ["secret_values_included", "configuration_values_included"], "manifest.redaction");
  if (manifest.redaction.secret_values_included !== false) fail("manifest.redaction.secret_values_included", "must remain false");
  if (manifest.redaction.configuration_values_included !== false) fail("manifest.redaction.configuration_values_included", "must remain false");

  const services = requireArray(manifest.services, "manifest.services");
  if (services.length !== Object.keys(EXPECTED_SERVICES).length) fail("manifest.services", "must contain exactly P, W, K, L and renderer services");
  const seen = new Set();
  for (const [index, service] of services.entries()) {
    const path = `manifest.services[${index}]`;
    requireExactKeys(service, ["service_id", "component", "repository", "relationship", "declared_mapping_source", "runtime"], path);
    const serviceId = requireString(service.service_id, `${path}.service_id`);
    if (seen.has(serviceId)) fail(`${path}.service_id`, "must be unique");
    seen.add(serviceId);
    const expected = EXPECTED_SERVICES[serviceId];
    if (!expected) fail(`${path}.service_id`, "is not a PR01 service");
    if (service.component !== expected.component) fail(`${path}.component`, `must be ${expected.component}`);
    if (service.repository !== expected.repository) {
      const label = serviceId === "warehouse-label-renderer" ? "renderer repository" : "repository";
      fail(`${path}.repository`, `${label} must be ${expected.repository}`);
    }
    requireString(service.relationship, `${path}.relationship`);
    if (service.declared_mapping_source !== "compose.prod.yml") fail(`${path}.declared_mapping_source`, "must be compose.prod.yml");
    validateRuntime(service, expected, path);
  }
  for (const serviceId of Object.keys(EXPECTED_SERVICES)) {
    if (!seen.has(serviceId)) fail("manifest.services", `missing required service ${serviceId}`);
  }

  const label = services.find((service) => service.service_id === "label-printer");
  const renderer = services.find((service) => service.service_id === "warehouse-label-renderer");
  if (label.runtime.commit.value !== renderer.runtime.commit.value) fail("manifest.services", "Label Printer and renderer must have the same runtime commit");
  if (label.runtime.image.declared_reference !== renderer.runtime.image.declared_reference ||
      label.runtime.image.observed_reference !== renderer.runtime.image.observed_reference) fail("manifest.services", "Label Printer and renderer must have the same image reference");
  if (label.runtime.image.image_id !== renderer.runtime.image.image_id) fail("manifest.services", "Label Printer and renderer must have the same image ID");
  if (label.runtime.image.digest !== renderer.runtime.image.digest) fail("manifest.services", "Label Printer and renderer must have the same image digest");
  if (label.runtime.image.source_repository !== renderer.runtime.image.source_repository) fail("manifest.services", "Label Printer and renderer must have the same image source repository");
  if (label.runtime.volumes.declared[0].source_id !== renderer.runtime.volumes.declared[0].source_id) fail("manifest.services", "Label Printer and renderer must have the same volume source identity");
  if (services.some(s => s.runtime.commit.value !== UNKNOWN) &&
      (manifest.runtime_access !== "READ-ONLY AUTHORIZED" || manifest.captured_at === UNKNOWN)) fail("manifest.runtime", "runtime evidence requires authorized capture timestamp");

  if (manifest.evidence_status === "VERIFIED") {
    if (manifest.runtime_access !== "READ-ONLY AUTHORIZED") fail("manifest.runtime_access", "VERIFIED manifest requires read-only authorization");
    if (manifest.captured_at === UNKNOWN) fail("manifest.captured_at", "VERIFIED manifest requires a capture timestamp");
    const unknownPath = findUnknown(manifest);
    if (unknownPath) fail(unknownPath, "VERIFIED manifest cannot contain NOT VERIFIED");
  }

  const needsRuntimeProvenance = manifest.evidence_status === "VERIFIED" || services.some((service) =>
    service.runtime.commit.value !== UNKNOWN || service.runtime.image.digest !== UNKNOWN);
  if (needsRuntimeProvenance && !runtimeProvenance) fail("runtime_provenance", "collector provenance is required for runtime evidence");
  if (runtimeProvenance) validateRuntimeProvenance(manifest, runtimeProvenance);

  validateSchema(manifest);
  return manifest;
}

function findUnknown(value, path = "manifest") {
  if (value === UNKNOWN) return path;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = findUnknown(value[index], `${path}[${index}]`);
      if (found) return found;
    }
    return null;
  }
  if (isObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      const found = findUnknown(child, `${path}.${key}`);
      if (found) return found;
    }
  }
  return null;
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedPath === import.meta.url) {
  const manifestPath = process.argv[2];
  if (!manifestPath) {
    console.error("Usage: node scripts/validate-release-evidence.mjs <manifest.json> [runtime-provenance.json]");
    process.exitCode = 2;
  } else {
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      const provenancePath = process.argv[3];
      const runtimeProvenance = provenancePath ? JSON.parse(readFileSync(provenancePath, "utf8")) : undefined;
      validateReleaseEvidence(manifest, {runtimeProvenance});
      console.log(`${manifestPath}: VALID (${manifest.evidence_status})`);
    } catch (error) {
      console.error(`${manifestPath}: INVALID: ${error.message}`);
      process.exitCode = 1;
    }
  }
}
