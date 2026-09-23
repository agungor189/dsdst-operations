import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.join(root, "config", "v2-15-source-set.json");
const previousManifestPath = path.join(root, "config", "v2-14-source-set.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const previous = JSON.parse(fs.readFileSync(previousManifestPath, "utf8"));

test("V2-15 source set closes the exact accepted O source pin and P/W/K/L revisions", () => {
  const byId = new Map(manifest.repositories.map((entry) => [entry.id, entry.revision]));
  assert.equal(manifest.release, "V2-15");
  assert.deepEqual(Object.fromEntries(byId), {
    O: "82f8826bee82cf60c1cecc8a8b3ec373bc3b5562",
    P: "a5bf029d559bf996ccb9ef905102c95da968a762",
    W: "525e18c508c1191c0c4e4b725bda00defd930d2f",
    K: "0e0717c3f8d3f3f0af186b4c165524bc2e81724c",
    L: "add3987e0eb15e8742ecac490b5eb4e78b620ce5",
  });
  assert.deepEqual(manifest.basedOn, { release: "V2-14", sourceSet: "config/v2-14-source-set.json", operationsClosureRevision: "e99668d6eb8a511014391b6a604d415dba12d061" });
  for (const revision of byId.values()) assert.match(revision, /^[a-f0-9]{40}$/);
  const old = new Map(previous.repositories.map((entry) => [entry.id, entry.revision]));
  for (const id of ["O", "K", "L"]) assert.equal(byId.get(id), old.get(id));
  for (const id of ["P", "W"]) assert.notEqual(byId.get(id), old.get(id));
});

test("source-set verifier accepts V2-15 and rejects the historical V2-14 manifest", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "dsdst-v2-15-source-set-"));
  const revision = spawnSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
  const entries = ["O", "P", "W", "K", "L"].map((id) => ({ id, repository: "agungor189/dsdst-operations", contextEnv: `${id}_TEST_CONTEXT`, revision }));
  const fixture = path.join(directory, "source-set.json");
  try {
    writeFileSync(fixture, JSON.stringify({ schemaVersion: "dsdst.test-source-set.v1", release: "V2-15", repositories: entries }));
    const accepted = spawnSync(process.execPath, [path.join(root, "scripts", "verify-source-set.mjs"), "--allow-dirty"], { encoding: "utf8", env: { ...process.env, EXPECTED_SOURCE_SET_RELEASE: "V2-15", SOURCE_SET_MANIFEST: fixture,
      O_TEST_CONTEXT: root, P_TEST_CONTEXT: root, W_TEST_CONTEXT: root, K_TEST_CONTEXT: root, L_TEST_CONTEXT: root } });
    assert.equal(accepted.status, 0, accepted.stderr);
    const rejected = spawnSync(process.execPath, [path.join(root, "scripts", "verify-source-set.mjs"), "--allow-dirty"], { encoding: "utf8", env: { ...process.env, EXPECTED_SOURCE_SET_RELEASE: "V2-15", SOURCE_SET_MANIFEST: previousManifestPath } });
    assert.notEqual(rejected.status, 0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
