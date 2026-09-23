import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {fileURLToPath} from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import {
  assembleImageManifest,
  createBuildMatrix,
  createPublishedRecords,
  verifyCheckoutObservation,
} from "../scripts/release/image-publish.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceSet = JSON.parse(fs.readFileSync(path.join(root, "config/v2-18-source-set.json"), "utf8"));
const revisions = Object.fromEntries(sourceSet.repositories.map(({id, revision}) => [id, revision]));

function inspection(entry) {
  return {
    architecture: "amd64",
    config: {
      Labels: {
        "org.opencontainers.image.source": `https://github.com/${entry.source_repository}`,
        "org.opencontainers.image.revision": entry.revision,
      },
    },
  };
}

test("manual GHCR workflow derives all six builds from the canonical V2-18 manifest", () => {
  const workflow = fs.readFileSync(path.join(root, ".github/workflows/publish-v2-18-images.yml"), "utf8");
  assert.match(workflow, /^on:\n  workflow_dispatch:\s*$/m);
  const triggers = workflow.match(/^on:\n([\s\S]*?)\npermissions:/m)?.[1] || "";
  assert.doesNotMatch(triggers, /(?:push|pull_request|release|schedule):/);
  assert.match(workflow, /permissions:\n  contents: read\n  packages: write/);
  assert.match(workflow, /config\/v2-18-source-set\.json/);
  assert.match(workflow, /fromJSON\(needs\.plan\.outputs\.matrix\)/);
  assert.match(workflow, /org\.opencontainers\.image\.source=https:\/\/github\.com\/\$\{\{ matrix\.source_repository \}\}/);
  assert.match(workflow, /org\.opencontainers\.image\.revision=\$\{\{ matrix\.revision \}\}/);
  assert.match(workflow, /\$\{\{ matrix\.image_repository \}\}@\$\{\{ steps\.push\.outputs\.digest \}\}/);
  assert.match(workflow, /provenance: mode=max/);
  assert.doesNotMatch(workflow, /:latest|github\.sha[^\n]*image\.revision/);
  assert.doesNotMatch(workflow, /[a-f0-9]{40}/, "source revisions must not be copied into the workflow");
});

test("build matrix pins repositories and revisions from V2-18, including pinned O content", () => {
  const matrix = createBuildMatrix(sourceSet).include;
  assert.equal(matrix.length, 6);
  assert.deepEqual(matrix.map(({id}) => id), ["P", "W", "K", "L", "HUB", "O"]);
  assert.deepEqual(matrix.map(({image_repository}) => image_repository), [
    "ghcr.io/agungor189/dsdst-panel",
    "ghcr.io/agungor189/dsdst-warehouse",
    "ghcr.io/agungor189/dsdst-kit-studio",
    "ghcr.io/agungor189/label-printer",
    "ghcr.io/agungor189/dsdst-customer-hub",
    "ghcr.io/agungor189/dsdst-operations-toolbox",
  ]);
  for (const entry of matrix) assert.equal(entry.revision, revisions[entry.id]);
  assert.equal(matrix.find(({id}) => id === "O").revision, revisions.O);
  assert.equal(matrix.find(({id}) => id === "O").dockerfile, "Dockerfile.operations-toolbox");
  assert.deepEqual(matrix.find(({id}) => id === "L").services, ["label-printer", "warehouse-label-renderer"]);
  assert.equal(new Set(matrix.map(({image_repository}) => image_repository)).size, 6);
});

test("checkout and published OCI evidence fail closed on source, revision, or dirty-state mismatch", () => {
  const entry = createBuildMatrix(sourceSet).include[0];
  assert.doesNotThrow(() => verifyCheckoutObservation(entry, {
    revision: entry.revision,
    repository: entry.source_repository,
    dirty: false,
  }));
  assert.throws(() => verifyCheckoutObservation(entry, {
    revision: "f".repeat(40), repository: entry.source_repository, dirty: false,
  }), /revision/i);
  assert.throws(() => verifyCheckoutObservation(entry, {
    revision: entry.revision, repository: "attacker/example", dirty: false,
  }), /repository/i);
  assert.throws(() => verifyCheckoutObservation(entry, {
    revision: entry.revision, repository: entry.source_repository, dirty: true,
  }), /dirty/i);

  const digest = `sha256:${"a".repeat(64)}`;
  assert.equal(createPublishedRecords(entry, digest, inspection(entry))[0].image_reference, `${entry.image_repository}@${digest}`);
  const wrongRevision = inspection(entry);
  wrongRevision.config.Labels["org.opencontainers.image.revision"] = "f".repeat(40);
  assert.throws(() => createPublishedRecords(entry, digest, wrongRevision), /OCI revision/i);
  const wrongSource = inspection(entry);
  wrongSource.config.Labels["org.opencontainers.image.source"] = "https://github.com/attacker/example";
  assert.throws(() => createPublishedRecords(entry, digest, wrongSource), /OCI source/i);
  assert.throws(() => createPublishedRecords(entry, "local-image:latest", inspection(entry)), /digest/i);
});

test("redacted manifest contains seven service bindings over six immutable registry images", () => {
  const matrix = createBuildMatrix(sourceSet).include;
  const partials = matrix.map((entry, index) => createPublishedRecords(
    entry,
    `sha256:${String(index + 1).repeat(64)}`,
    inspection(entry),
  ));
  const manifest = assembleImageManifest(sourceSet, partials, "2026-09-24T12:00:00.000Z");
  const ajv = new Ajv2020({strict: true});
  addFormats(ajv);
  const validate = ajv.compile(JSON.parse(fs.readFileSync(path.join(root, "schemas/image-manifest.schema.json"), "utf8")));
  assert.equal(validate(manifest), true, JSON.stringify(validate.errors));
  assert.equal(manifest.schema_version, "dsdst.image-manifest.v1");
  assert.equal(manifest.release, "V2-18");
  assert.equal(manifest.images.length, 7);
  assert.equal(new Set(manifest.images.map(({image_reference}) => image_reference)).size, 6);
  for (const image of manifest.images) {
    assert.deepEqual(Object.keys(image), ["service", "repository", "revision", "image_reference", "digest"]);
    assert.equal(image.revision, sourceSet.repositories.find(({repository}) => repository === image.repository).revision);
    assert.match(image.image_reference, /^ghcr\.io\/agungor189\/[a-z0-9-]+@sha256:[a-f0-9]{64}$/);
  }
  const label = manifest.images.find(({service}) => service === "label-printer");
  const renderer = manifest.images.find(({service}) => service === "warehouse-label-renderer");
  assert.equal(label.image_reference, renderer.image_reference);
  assert.equal(label.digest, renderer.digest);

  const missing = partials.slice(1);
  assert.throws(() => assembleImageManifest(sourceSet, missing, "2026-09-24T12:00:00.000Z"), /missing|exact/i);
});
