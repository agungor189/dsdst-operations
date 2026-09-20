import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.join(root, "config", "v2-07-source-set.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

test("V2-07 source set declares exact immutable O/P/W/K/L revisions", () => {
  assert.equal(manifest.schemaVersion, "dsdst.test-source-set.v1");
  assert.equal(manifest.release, "V2-07");
  const byId = new Map(manifest.repositories.map((entry) => [entry.id, entry]));
  assert.deepEqual([...byId.keys()].filter((id) => ["O", "P", "W", "K", "L"].includes(id)).sort(), ["K", "L", "O", "P", "W"]);
  for (const id of ["O", "P", "W", "K", "L"]) assert.match(byId.get(id).revision, /^[a-f0-9]{40}$/);
  assert.equal(byId.get("HUB").role, "auxiliary-e2e-dependency");
  assert.deepEqual(Object.fromEntries(["O", "P", "W", "K", "L"].map((id) => [id, byId.get(id).revision])), {
    O: "b861f22ab370b76466d1e18e126c470a8958bad3",
    P: "eebc78823ca47d721d75c9beba502141d24d89ec",
    W: "398b7e17a6e7427e9a390503b4f9cf684f1b2918",
    K: "2337bd4d86c47e143d3cabaf830a869932bb0968",
    L: "c57d9df0f412dae2c022093f0d7ac8591754edec",
  });
});

test("source-set verifier accepts an explicitly selected V2-07 exact revision set", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "dsdst-v2-07-source-set-"));
  const revision = spawnSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
  const entries = ["O", "P", "W", "K", "L"].map((id) => ({
    id, repository: "agungor189/dsdst-operations", contextEnv: `${id}_TEST_CONTEXT`, revision,
  }));
  const fixture = path.join(directory, "source-set.json");
  try {
    writeFileSync(fixture, JSON.stringify({ schemaVersion: "dsdst.test-source-set.v1", release: "V2-07", repositories: entries }));
    const result = spawnSync(process.execPath, [path.join(root, "scripts", "verify-source-set.mjs"), "--allow-dirty"], {
      encoding: "utf8",
      env: {
        ...process.env,
        EXPECTED_SOURCE_SET_RELEASE: "V2-07",
        SOURCE_SET_MANIFEST: fixture,
        O_TEST_CONTEXT: root,
        P_TEST_CONTEXT: root,
        W_TEST_CONTEXT: root,
        K_TEST_CONTEXT: root,
        L_TEST_CONTEXT: root,
      },
    });
    assert.equal(result.status, 0, result.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("V2-07 verifier rejects a V2-06 manifest", () => {
  const result = spawnSync(process.execPath, [path.join(root, "scripts", "verify-source-set.mjs"), "--allow-dirty"], {
    encoding: "utf8",
    env: {
      ...process.env,
      EXPECTED_SOURCE_SET_RELEASE: "V2-07",
      SOURCE_SET_MANIFEST: path.join(root, "config", "v2-06-source-set.json"),
    },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unsupported source-set release: expected V2-07/);
});
