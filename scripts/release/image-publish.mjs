#!/usr/bin/env node

import {execFileSync} from "node:child_process";
import {createHash} from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";

const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const SCHEMA_VERSION = "dsdst.image-manifest.v1";

const BUILDS = Object.freeze([
  Object.freeze({id: "P", source_repository: "agungor189/panel-kit-yonetimi", image_repository: "ghcr.io/agungor189/dsdst-panel", dockerfile: "Dockerfile", services: Object.freeze(["dsdst-panel"])}),
  Object.freeze({id: "W", source_repository: "agungor189/Dsdst-Warehouse", image_repository: "ghcr.io/agungor189/dsdst-warehouse", dockerfile: "Dockerfile", services: Object.freeze(["dsdst-warehouse"])}),
  Object.freeze({id: "K", source_repository: "agungor189/dsdst-kit-studio", image_repository: "ghcr.io/agungor189/dsdst-kit-studio", dockerfile: "Dockerfile", services: Object.freeze(["dsdst-kit-studio"])}),
  Object.freeze({id: "L", source_repository: "agungor189/Label-Printer", image_repository: "ghcr.io/agungor189/label-printer", dockerfile: "Dockerfile", services: Object.freeze(["label-printer", "warehouse-label-renderer"])}),
  Object.freeze({id: "HUB", source_repository: "agungor189/dsdst-customer-hub", image_repository: "ghcr.io/agungor189/dsdst-customer-hub", dockerfile: "Dockerfile", services: Object.freeze(["dsdst-customer-hub"])}),
  Object.freeze({id: "O", source_repository: "agungor189/dsdst-operations", image_repository: "ghcr.io/agungor189/dsdst-operations-toolbox", dockerfile: "Dockerfile.operations-toolbox", services: Object.freeze(["operations-toolbox"])}),
]);

function fail(message) {
  throw new Error(message);
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  return value;
}

function exactKeys(value, expected, label) {
  object(value, label);
  const keys = Object.keys(value);
  const missing = expected.filter((key) => !keys.includes(key));
  const extra = keys.filter((key) => !expected.includes(key));
  if (missing.length || extra.length) fail(`${label} fields mismatch; missing=${missing.join(",") || "none"}, extra=${extra.join(",") || "none"}`);
}

function normalizeRepository(value) {
  return String(value || "")
    .replace(/^git@github\.com:/, "")
    .replace(/^https:\/\/github\.com\//, "")
    .replace(/\.git$/, "")
    .toLowerCase();
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function sourceSetDigest(sourceSet) {
  return `sha256:${createHash("sha256").update(JSON.stringify(canonical(sourceSet))).digest("hex")}`;
}

function validateSourceSet(sourceSet) {
  object(sourceSet, "source set");
  if (sourceSet.schemaVersion !== "dsdst.test-source-set.v1" || sourceSet.release !== "V2-18") {
    fail("image publication requires the canonical V2-18 source-set schema and release");
  }
  if (!Array.isArray(sourceSet.repositories) || sourceSet.repositories.length !== BUILDS.length) {
    fail("V2-18 source set must contain the exact O/P/W/K/L/HUB repositories");
  }
  const byId = new Map();
  for (const entry of sourceSet.repositories) {
    if (byId.has(entry.id)) fail(`duplicate source-set repository ${entry.id}`);
    byId.set(entry.id, entry);
  }
  for (const build of BUILDS) {
    const source = byId.get(build.id);
    if (!source) fail(`V2-18 source set is missing ${build.id}`);
    if (source.repository !== build.source_repository) fail(`${build.id} source repository mismatch`);
    if (!SHA.test(source.revision || "")) fail(`${build.id} source revision must be a full lowercase Git SHA`);
  }
  if (byId.size !== BUILDS.length) fail("V2-18 source set contains an unsupported repository");
  return byId;
}

export function createBuildMatrix(sourceSet) {
  const byId = validateSourceSet(sourceSet);
  return {
    include: BUILDS.map((build) => ({
      ...build,
      services: [...build.services],
      revision: byId.get(build.id).revision,
    })),
  };
}

export function verifyCheckoutObservation(entry, observation) {
  object(entry, "build plan entry");
  object(observation, "checkout observation");
  if (!SHA.test(entry.revision || "") || observation.revision !== entry.revision) fail(`${entry.id} checkout revision mismatch`);
  if (normalizeRepository(observation.repository) !== normalizeRepository(entry.source_repository)) fail(`${entry.id} checkout repository mismatch`);
  if (observation.dirty !== false) fail(`${entry.id} checkout is dirty`);
  return observation;
}

function imageLabels(inspection) {
  const config = inspection?.config ?? inspection?.Config;
  const labels = config?.Labels ?? config?.labels;
  return object(labels, "published image OCI labels");
}

export function createPublishedRecords(entry, digest, inspection) {
  if (!DIGEST.test(digest || "")) fail("published image digest must be an immutable SHA-256 digest");
  const labels = imageLabels(object(inspection, "published image inspection"));
  const expectedSource = `https://github.com/${entry.source_repository}`;
  if (labels["org.opencontainers.image.source"] !== expectedSource) fail(`${entry.id} OCI source label mismatch`);
  if (labels["org.opencontainers.image.revision"] !== entry.revision) fail(`${entry.id} OCI revision label mismatch`);
  const imageReference = `${entry.image_repository}@${digest}`;
  if (!/^ghcr\.io\/agungor189\/[a-z0-9-]+@sha256:[a-f0-9]{64}$/.test(imageReference)) {
    fail(`${entry.id} immutable GHCR image reference is invalid`);
  }
  return entry.services.map((service) => ({
    service,
    repository: entry.source_repository,
    revision: entry.revision,
    image_reference: imageReference,
    digest,
  }));
}

export function assembleImageManifest(sourceSet, partialGroups, generatedAt = new Date().toISOString()) {
  const matrix = createBuildMatrix(sourceSet).include;
  const parsedTime = new Date(generatedAt);
  if (Number.isNaN(parsedTime.getTime()) || parsedTime.toISOString() !== generatedAt) fail("generated_at must be an ISO-8601 UTC timestamp");
  if (!Array.isArray(partialGroups)) fail("published image records must be an array");
  const records = partialGroups.flat();
  const byService = new Map();
  for (const record of records) {
    exactKeys(record, ["service", "repository", "revision", "image_reference", "digest"], "published image record");
    if (byService.has(record.service)) fail(`duplicate published image service ${record.service}`);
    byService.set(record.service, record);
  }

  const ordered = [];
  for (const entry of matrix) {
    for (const service of entry.services) {
      const record = byService.get(service);
      if (!record) fail(`published image manifest is missing exact service ${service}`);
      if (record.repository !== entry.source_repository || record.revision !== entry.revision) fail(`${service} source provenance mismatch`);
      if (!DIGEST.test(record.digest || "") || record.image_reference !== `${entry.image_repository}@${record.digest}`) {
        fail(`${service} immutable registry reference mismatch`);
      }
      ordered.push(record);
    }
  }
  if (byService.size !== ordered.length) fail("published image manifest contains an unsupported service");
  const label = byService.get("label-printer");
  const renderer = byService.get("warehouse-label-renderer");
  if (label.image_reference !== renderer.image_reference || label.digest !== renderer.digest || label.revision !== renderer.revision) {
    fail("Label Printer and warehouse-label-renderer must use the same image, digest, and revision");
  }
  return {
    schema_version: SCHEMA_VERSION,
    release: "V2-18",
    generated_at: generatedAt,
    source_set: {
      path: "config/v2-18-source-set.json",
      digest: sourceSetDigest(sourceSet),
    },
    images: ordered,
  };
}

function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(path.resolve(filePath), "utf8"));
  } catch (error) {
    fail(`${label} is invalid: ${error.message}`);
  }
}

function writeJson(filePath, value) {
  const target = path.resolve(filePath);
  fs.mkdirSync(path.dirname(target), {recursive: true});
  fs.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`, {encoding: "utf8", mode: 0o640, flag: "wx"});
}

function planEntryFromEnvironment() {
  if (!process.env.IMAGE_BUILD_PLAN_ENTRY) fail("IMAGE_BUILD_PLAN_ENTRY is required");
  return JSON.parse(process.env.IMAGE_BUILD_PLAN_ENTRY);
}

function observeCheckout(repositoryPath) {
  const git = (...args) => execFileSync("git", ["-C", path.resolve(repositoryPath), ...args], {encoding: "utf8"}).trim();
  return {
    revision: git("rev-parse", "HEAD"),
    repository: git("remote", "get-url", "origin"),
    dirty: git("status", "--porcelain").length > 0,
  };
}

function runCli() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "plan") {
    process.stdout.write(`${JSON.stringify(createBuildMatrix(readJson(args[0], "source set")))}\n`);
  } else if (command === "verify-checkout") {
    verifyCheckoutObservation(planEntryFromEnvironment(), observeCheckout(args[0]));
    process.stdout.write("exact checkout: VERIFIED\n");
  } else if (command === "record") {
    const [digest, inspectionPath, outputPath] = args;
    writeJson(outputPath, createPublishedRecords(planEntryFromEnvironment(), digest, readJson(inspectionPath, "published image inspection")));
  } else if (command === "assemble") {
    const [sourceSetPath, partialDirectory, outputPath] = args;
    const partials = fs.readdirSync(path.resolve(partialDirectory), {withFileTypes: true})
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((entry) => readJson(path.join(partialDirectory, entry.name), `published image record ${entry.name}`));
    writeJson(outputPath, assembleImageManifest(readJson(sourceSetPath, "source set"), partials));
  } else {
    fail("Usage: image-publish.mjs <plan source-set|verify-checkout repository|record digest inspection output|assemble source-set partial-directory output>");
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    runCli();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
