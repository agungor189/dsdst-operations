#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

import { fingerprintEnvironment } from "./fingerprint-release-config.mjs";
import { createRuntimeCaptureId, getRuntimeServicePolicies } from "./validate-release-evidence.mjs";

const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const NOT_APPLICABLE = "NOT APPLICABLE";

const SCHEMA_PROBES = {
  "dsdst-panel": `const Database=require("better-sqlite3");const db=new Database("/data/dsdst_panel.db",{readonly:true,fileMustExist:true});try{const row=db.prepare("SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1").get();if(!row||row.version===undefined||row.version===null)process.exit(2);process.stdout.write(JSON.stringify({version:String(row.version)}));}finally{db.close();}`,
  "dsdst-kit-studio": `const Database=require("better-sqlite3");const db=new Database("/data/dsdst-kit-studio.db",{readonly:true,fileMustExist:true});try{const row=db.prepare("SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1").get();if(!row||row.version===undefined||row.version===null)process.exit(2);process.stdout.write(JSON.stringify({version:String(row.version)}));}finally{db.close();}`,
  "label-printer": `const fs=require("node:fs");const state=JSON.parse(fs.readFileSync("/app/data/app-state.json","utf8"));if(state.version===undefined||state.version===null||String(state.version).length===0)process.exit(2);process.stdout.write(JSON.stringify({version:String(state.version)}));`,
};

const fail = (message) => {
  throw new Error(message);
};

const docker = (args) => execFileSync("docker", args, {
  encoding: "utf8",
  maxBuffer: 4 * 1024 * 1024,
  stdio: ["ignore", "pipe", "pipe"],
}).trim();

const dockerJson = (args, description, runDocker = docker) => {
  const parsed = JSON.parse(runDocker(args));
  if (!Array.isArray(parsed) || parsed.length !== 1) fail(`${description} did not return exactly one object`);
  return parsed[0];
};

const repositoryFromReference = (reference) => {
  const withoutDigest = reference.split("@")[0];
  const slash = withoutDigest.lastIndexOf("/");
  const colon = withoutDigest.lastIndexOf(":");
  return colon > slash ? withoutDigest.slice(0, colon) : withoutDigest;
};

const normalizeSourceRepository = (source) => {
  if (typeof source !== "string") return "";
  return source.replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "").replace(/\/$/, "");
};

export const collectSchemaObservation = (policy, containerId, runDocker) => {
  if (policy.schema_kind === "none") {
    return {kind: "none", version: NOT_APPLICABLE, evidence_source: "runtime-collector"};
  }
  const probe = SCHEMA_PROBES[policy.service_id];
  if (!probe) fail(`no read-only schema probe exists for ${policy.service_id}`);
  let result;
  try {
    result = JSON.parse(runDocker(["exec", containerId, "node", "-e", probe]));
  } catch {
    fail(`read-only schema query failed for ${policy.service_id}`);
  }
  if (result === null || typeof result !== "object" || Array.isArray(result) || Object.keys(result).length !== 1 ||
      typeof result.version !== "string" || result.version.length === 0) {
    fail(`read-only schema query returned invalid evidence for ${policy.service_id}`);
  }
  return {kind: policy.schema_kind, version: result.version, evidence_source: "runtime-collector"};
};

const collectVolumes = (policy, container) => {
  if (!Array.isArray(container.Mounts)) fail(`runtime mounts are unavailable for ${policy.service_id}`);
  const mounts = container.Mounts.filter((mount) => mount?.Type !== "tmpfs");
  if (mounts.length !== policy.volumes.length) fail(`runtime volume count does not match ${policy.service_id}`);
  return policy.volumes.map((expected) => {
    const matches = mounts.filter((mount) => mount?.Destination === expected.target);
    if (matches.length !== 1) fail(`runtime volume target does not match ${policy.service_id}`);
    const mount = matches[0];
    const mode = mount.RW === true ? "rw" : mount.RW === false ? "ro" : null;
    if (mode !== expected.mode || typeof mount.Type !== "string" || typeof mount.Source !== "string" || mount.Source.length === 0) {
      fail(`runtime volume mapping does not match ${policy.service_id}`);
    }
    const sourceId = "sha256:" + createHash("sha256").update(JSON.stringify([mount.Type, mount.Source])).digest("hex");
    return {...expected, source_id: sourceId};
  });
};

const collectNetworks = (policy, container) => {
  const runtimeNetworks = container?.NetworkSettings?.Networks;
  if (runtimeNetworks === null || typeof runtimeNetworks !== "object" || Array.isArray(runtimeNetworks)) {
    fail(`runtime networks are unavailable for ${policy.service_id}`);
  }
  const actualNames = Object.keys(runtimeNetworks);
  if (actualNames.length !== policy.networks.length) fail(`runtime network count does not match ${policy.service_id}`);
  return policy.networks.map((network) => {
    const runtimeName = policy.network_names[network];
    if (!runtimeName || !Object.hasOwn(runtimeNetworks, runtimeName)) fail(`runtime network mapping does not match ${policy.service_id}`);
    return network;
  });
};

const collectPorts = (policy, container) => {
  const runtimePorts = container?.NetworkSettings?.Ports;
  if (runtimePorts === null || typeof runtimePorts !== "object" || Array.isArray(runtimePorts)) {
    fail(`runtime ports are unavailable for ${policy.service_id}`);
  }
  if (Object.keys(runtimePorts).length !== policy.ports.length) fail(`runtime port count does not match ${policy.service_id}`);
  return policy.ports.map((expected) => {
    const key = `${expected.container_port}/${expected.protocol}`;
    if (!Object.hasOwn(runtimePorts, key)) fail(`runtime port mapping does not match ${policy.service_id}`);
    const bindings = runtimePorts[key];
    if (expected.exposure === "internal") {
      if (!(bindings === null || (Array.isArray(bindings) && bindings.length === 0))) fail(`internal runtime port is unexpectedly published for ${policy.service_id}`);
      return {...expected, host_ip: NOT_APPLICABLE, host_port: NOT_APPLICABLE};
    }
    if (!Array.isArray(bindings) || bindings.length !== 1) fail(`published runtime port must have exactly one binding for ${policy.service_id}`);
    const binding = bindings[0];
    const hostPort = Number(binding?.HostPort);
    if (typeof binding?.HostIp !== "string" || binding.HostIp.length === 0 || !Number.isInteger(hostPort) || hostPort < 1 || hostPort > 65535) {
      fail(`published runtime port binding is invalid for ${policy.service_id}`);
    }
    return {...expected, host_ip: binding.HostIp, host_port: hostPort};
  });
};

export function collectContainerObservations(policy, container, schema) {
  const configuration = fingerprintEnvironment(policy.service_id, container?.Config?.Env);
  return {
    schema,
    configuration: {status: "VERIFIED", fingerprint: configuration.fingerprint, redacted: true, safe_keys: configuration.safe_keys},
    volumes: collectVolumes(policy, container),
    networks: collectNetworks(policy, container),
    ports: collectPorts(policy, container),
  };
}

export function collectRuntimeProvenance({composeFile, envFile, runDocker = docker}) {
  if (!composeFile || !envFile) fail("compose and environment file paths are required");
  const capturedAt = new Date().toISOString();
  const services = [];
  for (const policy of getRuntimeServicePolicies()) {
    const composeArgs = ["compose", "--env-file", envFile, "-f", composeFile, "ps", "--no-trunc", "-q", policy.service_id];
    const ids = runDocker(composeArgs).split(/\s+/).filter(Boolean);
    if (ids.length !== 1 || !/^[a-f0-9]{64}$/.test(ids[0])) fail(`service ${policy.service_id} does not have exactly one full running container identity`);
    const container = dockerJson(["inspect", ids[0]], `container inspection for ${policy.service_id}`, runDocker);
    if (container?.Id !== ids[0]) fail(`container identity changed during capture for ${policy.service_id}`);
    const composeService = container?.Config?.Labels?.["com.docker.compose.service"];
    if (composeService !== policy.service_id) fail(`container does not match expected service ${policy.service_id}`);
    const declaredReference = container?.Config?.Image;
    const imageId = container?.Image;
    if (typeof declaredReference !== "string" || declaredReference.length === 0 || !DIGEST.test(imageId)) {
      fail(`container image identity is incomplete for ${policy.service_id}`);
    }
    const image = dockerJson(["image", "inspect", imageId], `image inspection for ${policy.service_id}`, runDocker);
    if (image.Id !== imageId) fail(`inspected image ID does not match the running container for ${policy.service_id}`);
    const declaredByDigest = declaredReference.includes("@sha256:");
    const referencePresent = declaredByDigest
      ? Array.isArray(image.RepoDigests) && image.RepoDigests.includes(declaredReference)
      : Array.isArray(image.RepoTags) && image.RepoTags.includes(declaredReference);
    if (!referencePresent) {
      fail(`running image does not retain the declared reference for ${policy.service_id}`);
    }
    const declaredRepository = repositoryFromReference(declaredReference);
    const repoDigest = declaredByDigest ? declaredReference : Array.isArray(image.RepoDigests)
      ? image.RepoDigests.find((entry) => entry.startsWith(`${declaredRepository}@sha256:`))
      : undefined;
    const imageDigest = repoDigest?.slice(repoDigest.indexOf("@") + 1);
    if (!DIGEST.test(imageDigest)) fail(`registry digest is unavailable for ${policy.service_id}`);
    const labels = image?.Config?.Labels ?? {};
    const sourceRepository = normalizeSourceRepository(labels["org.opencontainers.image.source"]);
    const revision = labels["org.opencontainers.image.revision"];
    if (sourceRepository !== policy.source_repository) fail(`OCI source repository does not match ${policy.service_id}`);
    if (!SHA.test(revision)) fail(`OCI revision is unavailable for ${policy.service_id}`);
    const schema = collectSchemaObservation(policy, container.Id, runDocker);
    const observations = collectContainerObservations(policy, container, schema);
    services.push({
      service_id: policy.service_id,
      compose_service: composeService,
      container_id: container.Id,
      declared_image_reference: declaredReference,
      observed_image_reference: declaredReference,
      image_id: imageId,
      image_digest: imageDigest,
      source_repository: sourceRepository,
      revision,
      ...observations,
    });
  }
  const duplicateContainer = services.some((service, index) => services.findIndex((candidate) => candidate.container_id === service.container_id) !== index);
  if (duplicateContainer) fail("a container identity cannot represent more than one service");
  const captureId = createRuntimeCaptureId(capturedAt, services);
  return {
    provenance_version: 1,
    capture_id: captureId,
    captured_at: capturedAt,
    collector: "dsdst-read-only-runtime-collector-v1",
    services: services.map((service) => ({capture_id: captureId, ...service})),
  };
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (import.meta.url === invokedPath) {
  try {
    const [composeFile, envFile] = process.argv.slice(2);
    console.log(JSON.stringify(collectRuntimeProvenance({composeFile, envFile}), null, 2));
  } catch (error) {
    console.error(`Runtime provenance collection failed: ${error.message}`);
    process.exitCode = 1;
  }
}
