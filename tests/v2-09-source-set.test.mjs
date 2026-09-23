import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.join(root, "config", "v2-09-source-set.json");
const previousManifestPath = path.join(root, "config", "v2-08-source-set.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const previousManifest = JSON.parse(fs.readFileSync(previousManifestPath, "utf8"));

test("V2-09 source set declares exact immutable O/P/W/K/L revisions", () => {
  assert.equal(manifest.schemaVersion, "dsdst.test-source-set.v1");
  assert.equal(manifest.release, "V2-09");
  const byId = new Map(manifest.repositories.map((entry) => [entry.id, entry]));
  assert.deepEqual(Object.fromEntries(["O", "P", "W", "K", "L"].map((id) => [id, byId.get(id).revision])), {
    O: "6f4ec98d48c8ab5c20f60b6c356d6c8d04d2e012",
    P: "df8379d82b562a4aab0b9eace4e1d709cfea8932",
    W: "4d33c123441bfc4e571805849385a120c0fb1683",
    K: "2337bd4d86c47e143d3cabaf830a869932bb0968",
    L: "c57d9df0f412dae2c022093f0d7ac8591754edec",
  });
  for (const id of ["O", "P", "W", "K", "L"]) assert.match(byId.get(id).revision, /^[a-f0-9]{40}$/);
  assert.deepEqual([...byId.keys()].sort(), ["K", "L", "O", "P", "W"]);
});

test("V2-09 records V2-08 as its immutable predecessor closure", () => {
  assert.deepEqual(manifest.basedOn, {
    release: "V2-08",
    sourceSet: "config/v2-08-source-set.json",
    operationsClosureRevision: "8e0fda083dc9f92de70e74b1b2872b70f7e6af91",
  });
  assert.equal(previousManifest.release, "V2-08");
  const currentById = new Map(manifest.repositories.map((entry) => [entry.id, entry]));
  const previousById = new Map(previousManifest.repositories.map((entry) => [entry.id, entry]));
  for (const id of ["W", "K", "L"]) assert.equal(currentById.get(id).revision, previousById.get(id).revision);
  assert.equal(previousManifest.repositories.find((entry) => entry.id === "P").revision, "941abb1f5d958782a73c2b4731ab4a2f34a2edc7");
  assert.equal(currentById.get("P").revision, "df8379d82b562a4aab0b9eace4e1d709cfea8932");
  assert.notEqual(currentById.get("O").revision, manifest.basedOn.operationsClosureRevision);
});

test("source-set verifier accepts an explicitly selected V2-09 exact revision set", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "dsdst-v2-09-source-set-"));
  const revision = spawnSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
  const entries = ["O", "P", "W", "K", "L"].map((id) => ({ id, repository: "agungor189/dsdst-operations", contextEnv: `${id}_TEST_CONTEXT`, revision }));
  const fixture = path.join(directory, "source-set.json");
  try {
    writeFileSync(fixture, JSON.stringify({ schemaVersion: "dsdst.test-source-set.v1", release: "V2-09", repositories: entries }));
    const result = spawnSync(process.execPath, [path.join(root, "scripts", "verify-source-set.mjs"), "--allow-dirty"], {
      encoding: "utf8",
      env: { ...process.env, EXPECTED_SOURCE_SET_RELEASE: "V2-09", SOURCE_SET_MANIFEST: fixture,
        O_TEST_CONTEXT: root, P_TEST_CONTEXT: root, W_TEST_CONTEXT: root, K_TEST_CONTEXT: root, L_TEST_CONTEXT: root },
    });
    assert.equal(result.status, 0, result.stderr);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("V2-09 verifier rejects the historical V2-08 manifest", () => {
  const result = spawnSync(process.execPath, [path.join(root, "scripts", "verify-source-set.mjs"), "--allow-dirty"], {
    encoding: "utf8",
    env: { ...process.env, EXPECTED_SOURCE_SET_RELEASE: "V2-09", SOURCE_SET_MANIFEST: previousManifestPath },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unsupported source-set release: expected V2-09/);
});
