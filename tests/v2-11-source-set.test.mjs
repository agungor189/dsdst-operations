import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.join(root, "config", "v2-11-source-set.json");
const previousManifestPath = path.join(root, "config", "v2-10-source-set.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const previousManifest = JSON.parse(fs.readFileSync(previousManifestPath, "utf8"));

test("V2-11 source set declares exact immutable O/P/W/K/L revisions", () => {
  assert.equal(manifest.schemaVersion, "dsdst.test-source-set.v1");
  assert.equal(manifest.release, "V2-11");
  const byId = new Map(manifest.repositories.map((entry) => [entry.id, entry]));
  assert.deepEqual(Object.fromEntries(["O", "P", "W", "K", "L"].map((id) => [id, byId.get(id).revision])), {
    O: "86752dda1068b340b03ea8e61767dfd83f52341a",
    P: "ebd78bb2ddc0cb97bbb3df72b51ac685dc13cbe6",
    W: "ec141480145bb8159570f8e6ed1c387de4fa08e3",
    K: "67325952cace8224b646c0a29d9464557a81c263",
    L: "c57d9df0f412dae2c022093f0d7ac8591754edec",
  });
  for (const id of ["O", "P", "W", "K", "L"]) assert.match(byId.get(id).revision, /^[a-f0-9]{40}$/);
  assert.deepEqual([...byId.keys()].sort(), ["K", "L", "O", "P", "W"]);
});

test("V2-11 records the accepted V2-10 Operations closure as its immutable predecessor", () => {
  assert.deepEqual(manifest.basedOn, {
    release: "V2-10",
    sourceSet: "config/v2-10-source-set.json",
    operationsClosureRevision: "eac443409cfe0790c78407a02ff6016684c44276",
  });
  assert.equal(previousManifest.release, "V2-10");
  const currentById = new Map(manifest.repositories.map((entry) => [entry.id, entry]));
  const previousById = new Map(previousManifest.repositories.map((entry) => [entry.id, entry]));
  for (const id of ["W", "L"]) assert.equal(currentById.get(id).revision, previousById.get(id).revision);
  for (const id of ["O", "P", "K"]) assert.notEqual(currentById.get(id).revision, previousById.get(id).revision);
  assert.notEqual(currentById.get("O").revision, manifest.basedOn.operationsClosureRevision);
});

test("source-set verifier accepts an explicitly selected V2-11 exact revision set", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "dsdst-v2-11-source-set-"));
  const revision = spawnSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
  const entries = ["O", "P", "W", "K", "L"].map((id) => ({ id, repository: "agungor189/dsdst-operations", contextEnv: `${id}_TEST_CONTEXT`, revision }));
  const fixture = path.join(directory, "source-set.json");
  try {
    writeFileSync(fixture, JSON.stringify({ schemaVersion: "dsdst.test-source-set.v1", release: "V2-11", repositories: entries }));
    const result = spawnSync(process.execPath, [path.join(root, "scripts", "verify-source-set.mjs"), "--allow-dirty"], {
      encoding: "utf8",
      env: { ...process.env, EXPECTED_SOURCE_SET_RELEASE: "V2-11", SOURCE_SET_MANIFEST: fixture,
        O_TEST_CONTEXT: root, P_TEST_CONTEXT: root, W_TEST_CONTEXT: root, K_TEST_CONTEXT: root, L_TEST_CONTEXT: root },
    });
    assert.equal(result.status, 0, result.stderr);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("V2-11 verifier rejects the historical V2-10 manifest", () => {
  const result = spawnSync(process.execPath, [path.join(root, "scripts", "verify-source-set.mjs"), "--allow-dirty"], {
    encoding: "utf8",
    env: { ...process.env, EXPECTED_SOURCE_SET_RELEASE: "V2-11", SOURCE_SET_MANIFEST: previousManifestPath },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unsupported source-set release: expected V2-11/);
});
