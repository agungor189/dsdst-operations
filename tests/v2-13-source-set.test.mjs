import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.join(root, "config", "v2-13-source-set.json");
const previousManifestPath = path.join(root, "config", "v2-12-source-set.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const previousManifest = JSON.parse(fs.readFileSync(previousManifestPath, "utf8"));

test("V2-13 source set declares exact immutable O/P/W/K/L revisions", () => {
  assert.equal(manifest.schemaVersion, "dsdst.test-source-set.v1");
  assert.equal(manifest.release, "V2-13");
  const byId = new Map(manifest.repositories.map((entry) => [entry.id, entry]));
  assert.deepEqual(Object.fromEntries(["O", "P", "W", "K", "L"].map((id) => [id, byId.get(id).revision])), {
    O: "e358c2d41940b26e396a0454ef53cb11ba19858f",
    P: "0f04354a856f2801692de5441f6e4b08a509e0b7",
    W: "2a290afb36cf06be926a15fc84485d922a1f3536",
    K: "0e0717c3f8d3f3f0af186b4c165524bc2e81724c",
    L: "c57d9df0f412dae2c022093f0d7ac8591754edec",
  });
  for (const id of ["O", "P", "W", "K", "L"]) assert.match(byId.get(id).revision, /^[a-f0-9]{40}$/);
  assert.deepEqual([...byId.keys()].sort(), ["K", "L", "O", "P", "W"]);
});

test("V2-13 records FINAL V2-12 and changes only O, P and W", () => {
  assert.deepEqual(manifest.basedOn, {
    release: "V2-12", sourceSet: "config/v2-12-source-set.json",
    operationsClosureRevision: "2e5f6524024ee9e126a47424d4e740a280db49db",
  });
  const current = new Map(manifest.repositories.map((entry) => [entry.id, entry.revision]));
  const previous = new Map(previousManifest.repositories.map((entry) => [entry.id, entry.revision]));
  for (const id of ["K", "L"]) assert.equal(current.get(id), previous.get(id));
  for (const id of ["O", "P", "W"]) assert.notEqual(current.get(id), previous.get(id));
  assert.notEqual(current.get("O"), manifest.basedOn.operationsClosureRevision);
});

test("source-set verifier accepts an explicitly selected V2-13 exact revision set", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "dsdst-v2-13-source-set-"));
  const revision = spawnSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
  const entries = ["O", "P", "W", "K", "L"].map((id) => ({ id, repository: "agungor189/dsdst-operations", contextEnv: `${id}_TEST_CONTEXT`, revision }));
  const fixture = path.join(directory, "source-set.json");
  try {
    writeFileSync(fixture, JSON.stringify({ schemaVersion: "dsdst.test-source-set.v1", release: "V2-13", repositories: entries }));
    const result = spawnSync(process.execPath, [path.join(root, "scripts", "verify-source-set.mjs"), "--allow-dirty"], {
      encoding: "utf8", env: { ...process.env, EXPECTED_SOURCE_SET_RELEASE: "V2-13", SOURCE_SET_MANIFEST: fixture,
        O_TEST_CONTEXT: root, P_TEST_CONTEXT: root, W_TEST_CONTEXT: root, K_TEST_CONTEXT: root, L_TEST_CONTEXT: root },
    });
    assert.equal(result.status, 0, result.stderr);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("V2-13 verifier rejects the historical V2-12 manifest", () => {
  const result = spawnSync(process.execPath, [path.join(root, "scripts", "verify-source-set.mjs"), "--allow-dirty"], {
    encoding: "utf8", env: { ...process.env, EXPECTED_SOURCE_SET_RELEASE: "V2-13", SOURCE_SET_MANIFEST: previousManifestPath },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unsupported source-set release: expected V2-13/);
});
