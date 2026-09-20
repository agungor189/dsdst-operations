#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

import { getRuntimeServicePolicies } from "./validate-release-evidence.mjs";

const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;

const fail = (message) => {
  throw new Error(message);
};

const docker = (args) => execFileSync("docker", args, {
  encoding: "utf8",
  maxBuffer: 4 * 1024 * 1024,
  stdio: ["ignore", "pipe", "pipe"],
}).trim();

const dockerJson = (args, description) => {
  const parsed = JSON.parse(docker(args));
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

export function collectRuntimeProvenance({composeFile, envFile}) {
  if (!composeFile || !envFile) fail("compose and environment file paths are required");
  const capturedAt = new Date().toISOString();
  const services = [];
  for (const policy of getRuntimeServicePolicies()) {
    const composeArgs = ["compose", "--env-file", envFile, "-f", composeFile, "ps", "--no-trunc", "-q", policy.service_id];
    const ids = docker(composeArgs).split(/\s+/).filter(Boolean);
    if (ids.length !== 1 || !/^[a-f0-9]{64}$/.test(ids[0])) fail(`service ${policy.service_id} does not have exactly one full running container identity`);
    const container = dockerJson(["inspect", ids[0]], `container inspection for ${policy.service_id}`);
    const composeService = container?.Config?.Labels?.["com.docker.compose.service"];
    if (composeService !== policy.service_id) fail(`container does not match expected service ${policy.service_id}`);
    const declaredReference = container?.Config?.Image;
    const imageId = container?.Image;
    if (typeof declaredReference !== "string" || declaredReference.length === 0 || !DIGEST.test(imageId)) {
      fail(`container image identity is incomplete for ${policy.service_id}`);
    }
    const image = dockerJson(["image", "inspect", imageId], `image inspection for ${policy.service_id}`);
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
    });
  }
  const duplicateContainer = services.some((service, index) => services.findIndex((candidate) => candidate.container_id === service.container_id) !== index);
  if (duplicateContainer) fail("a container identity cannot represent more than one service");
  const captureHash = createHash("sha256").update(JSON.stringify({capturedAt, services})).digest("hex");
  return {
    provenance_version: 1,
    capture_id: `runtime-${captureHash}`,
    captured_at: capturedAt,
    collector: "dsdst-read-only-runtime-collector-v1",
    services,
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
