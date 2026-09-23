import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.join(root, "config", "v2-14-source-set.json");
const previousManifestPath = path.join(root, "config", "v2-13-source-set.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const previousManifest = JSON.parse(fs.readFileSync(previousManifestPath, "utf8"));

test("V2-14 source set declares exact immutable O/P/W/K/L revisions", () => {
  assert.equal(manifest.schemaVersion, "dsdst.test-source-set.v1");
  assert.equal(manifest.release, "V2-14");
  const byId = new Map(manifest.repositories.map((entry) => [entry.id, entry]));
  assert.deepEqual(Object.fromEntries(["O", "P", "W", "K", "L"].map((id) => [id, byId.get(id).revision])), {
    O: "b5ed2a30fa00ad0c11566aa66bad38583866ece0",
    P: "ca5e4ecf0f23620846ce7a86862bfbc46bb628db",
    W: "c786eb1f4f555b4df72324ccda92da06ca62c56d",
    K: "0e0717c3f8d3f3f0af186b4c165524bc2e81724c",
    L: "add3987e0eb15e8742ecac490b5eb4e78b620ce5",
  });
  for (const id of ["O", "P", "W", "K", "L"]) assert.match(byId.get(id).revision, /^[a-f0-9]{40}$/);
  assert.deepEqual([...byId.keys()].sort(), ["K", "L", "O", "P", "W"]);
});

test("V2-14 records accepted V2-13 and changes O, P, W and L only", () => {
  assert.deepEqual(manifest.basedOn, {
    release: "V2-13", sourceSet: "config/v2-13-source-set.json",
    operationsClosureRevision: "58eadecc541d8c6734ae5570564ba25d656a81c0",
  });
  const current = new Map(manifest.repositories.map((entry) => [entry.id, entry.revision]));
  const previous = new Map(previousManifest.repositories.map((entry) => [entry.id, entry.revision]));
  assert.equal(current.get("K"), previous.get("K"));
  for (const id of ["O", "P", "W", "L"]) assert.notEqual(current.get(id), previous.get(id));
});

test("source-set verifier accepts an explicitly selected V2-14 exact revision set", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "dsdst-v2-14-source-set-"));
  const revision = spawnSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
  const entries = ["O", "P", "W", "K", "L"].map((id) => ({ id, repository: "agungor189/dsdst-operations", contextEnv: `${id}_TEST_CONTEXT`, revision }));
  const fixture = path.join(directory, "source-set.json");
  try {
    writeFileSync(fixture, JSON.stringify({ schemaVersion: "dsdst.test-source-set.v1", release: "V2-14", repositories: entries }));
    const result = spawnSync(process.execPath, [path.join(root, "scripts", "verify-source-set.mjs"), "--allow-dirty"], {
      encoding: "utf8", env: { ...process.env, EXPECTED_SOURCE_SET_RELEASE: "V2-14", SOURCE_SET_MANIFEST: fixture,
        O_TEST_CONTEXT: root, P_TEST_CONTEXT: root, W_TEST_CONTEXT: root, K_TEST_CONTEXT: root, L_TEST_CONTEXT: root },
    });
    assert.equal(result.status, 0, result.stderr);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("V2-14 verifier rejects the historical V2-13 manifest", () => {
  const result = spawnSync(process.execPath, [path.join(root, "scripts", "verify-source-set.mjs"), "--allow-dirty"], {
    encoding: "utf8", env: { ...process.env, EXPECTED_SOURCE_SET_RELEASE: "V2-14", SOURCE_SET_MANIFEST: previousManifestPath },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unsupported source-set release: expected V2-14/);
});

