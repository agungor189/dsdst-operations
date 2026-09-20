import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "config", "v2-06-source-set.json"), "utf8"));

test("V2-06 workflow cannot silently keep accepting the old V2-05 source set", () => {
  const workflow = fs.readFileSync(path.join(root, ".github", "workflows", "e2e.yml"), "utf8");
  assert.equal(fs.existsSync(path.join(root, "config", "v2-06-source-set.json")), true, "V2-06 needs its own immutable source-set manifest");
  assert.doesNotMatch(workflow, /9b02cf736316800e7d2b5341a4d7cd8e13bb6c88/);
  assert.doesNotMatch(workflow, /c49f2706e5f69b555ef526e7a4fe7d018656008a/);
  assert.doesNotMatch(workflow, /82aaaf5575e88bc347b4b2d28f81aa59490ccad0/);
  assert.match(workflow, /config\/v2-06-source-set\.json/);
});

test("V2-06 verifier rejects the immutable V2-05 manifest even when explicitly selected", () => {
  const result = spawnSync(process.execPath, [path.join(root, "scripts", "verify-source-set.mjs"), "--allow-dirty"], {
    encoding: "utf8",
    env: { ...process.env, SOURCE_SET_MANIFEST: path.join(root, "config", "v2-05-source-set.json") },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unsupported source-set release: expected V2-06/);
});

test("V2-06 source set declares exact immutable O/P/W/K/L revisions", () => {
  assert.equal(manifest.schemaVersion, "dsdst.test-source-set.v1");
  assert.equal(manifest.release, "V2-06");
  const byId = new Map(manifest.repositories.map((entry) => [entry.id, entry]));
  assert.deepEqual([...byId.keys()].filter((id) => ["O", "P", "W", "K", "L"].includes(id)).sort(), ["K", "L", "O", "P", "W"]);
  for (const id of ["O", "P", "W", "K", "L"]) assert.match(byId.get(id).revision, /^[a-f0-9]{40}$/);
  assert.equal(byId.get("HUB").role, "auxiliary-e2e-dependency");
  assert.match(byId.get("HUB").revision, /^[a-f0-9]{40}$/);
  assert.deepEqual(Object.fromEntries(["O", "P", "W", "K", "L"].map((id) => [id, byId.get(id).revision])), {
    O: "2fb0d75b2f035135f976a1c2f61253351904a79f",
    P: "8d58cbc27cfb5e0b878e8b4e072c021edc17a62a",
    W: "a00be0e89cd4871942b7a8eb51e90fe265e7e031",
    K: "2337bd4d86c47e143d3cabaf830a869932bb0968",
    L: "c57d9df0f412dae2c022093f0d7ac8591754edec",
  });
});

test("source-set verifier rejects self-resolved Operations revisions", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "dsdst-source-set-self-test-"));
  const actualRevision = spawnSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
  const entries = ["O", "P", "W", "K", "L"].map((id) => ({
    id,
    repository: "agungor189/dsdst-operations",
    contextEnv: `${id}_TEST_CONTEXT`,
    revision: id === "O" ? "SELF" : actualRevision,
  }));
  const manifestPath = path.join(directory, "source-set.json");
  try {
    writeFileSync(manifestPath, JSON.stringify({ schemaVersion: "dsdst.test-source-set.v1", release: "V2-06", repositories: entries }));
    const result = spawnSync(process.execPath, [path.join(root, "scripts", "verify-source-set.mjs"), "--allow-dirty"], {
      encoding: "utf8",
      env: {
        ...process.env,
        SOURCE_SET_MANIFEST: manifestPath,
        O_TEST_CONTEXT: root,
        P_TEST_CONTEXT: root,
        W_TEST_CONTEXT: root,
        K_TEST_CONTEXT: root,
        L_TEST_CONTEXT: root,
      },
    });
    assert.notEqual(result.status, 0, "SELF must not make an arbitrary Operations HEAD valid");
    assert.match(result.stderr, /Invalid exact revision for O/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("E2E workflow checkout refs exactly match the source-set lock", () => {
  const workflow = fs.readFileSync(path.join(root, ".github", "workflows", "e2e.yml"), "utf8");
  for (const entry of manifest.repositories) {
    assert.match(workflow, new RegExp(`repository: ${entry.repository.replace("/", "\\/")}\\n\\s+ref: ${entry.revision}`));
  }
});

test("source-set verifier fails closed on a wrong SHA and a missing repository", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "dsdst-source-set-test-"));
  const actualRevision = spawnSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
  const entries = ["O", "P", "W", "K", "L"].map((id) => ({
    id,
    repository: "agungor189/dsdst-operations",
    contextEnv: `${id}_TEST_CONTEXT`,
    revision: actualRevision,
  }));
  const manifestPath = path.join(directory, "source-set.json");
  try {
    writeFileSync(manifestPath, JSON.stringify({ schemaVersion: "dsdst.test-source-set.v1", release: "V2-06", repositories: entries }));
    const commonEnv = {
      ...process.env,
      SOURCE_SET_MANIFEST: manifestPath,
      O_TEST_CONTEXT: root,
      P_TEST_CONTEXT: root,
      W_TEST_CONTEXT: root,
      K_TEST_CONTEXT: root,
      L_TEST_CONTEXT: root,
    };
    const valid = spawnSync(process.execPath, [path.join(root, "scripts", "verify-source-set.mjs"), "--allow-dirty"], { encoding: "utf8", env: commonEnv });
    assert.equal(valid.status, 0, valid.stderr);

    entries[0].revision = "0".repeat(40);
    writeFileSync(manifestPath, JSON.stringify({ schemaVersion: "dsdst.test-source-set.v1", release: "V2-06", repositories: entries }));
    const wrongOperationsSha = spawnSync(process.execPath, [path.join(root, "scripts", "verify-source-set.mjs"), "--allow-dirty"], { encoding: "utf8", env: commonEnv });
    assert.notEqual(wrongOperationsSha.status, 0);
    assert.match(wrongOperationsSha.stderr, /O revision mismatch/);

    entries[0].revision = actualRevision;
    entries[1].revision = "0".repeat(40);
    writeFileSync(manifestPath, JSON.stringify({ schemaVersion: "dsdst.test-source-set.v1", release: "V2-06", repositories: entries }));
    const wrongSha = spawnSync(process.execPath, [path.join(root, "scripts", "verify-source-set.mjs"), "--allow-dirty"], { encoding: "utf8", env: commonEnv });
    assert.notEqual(wrongSha.status, 0);
    assert.match(wrongSha.stderr, /P revision mismatch/);

    entries[1].revision = actualRevision;
    writeFileSync(manifestPath, JSON.stringify({ schemaVersion: "dsdst.test-source-set.v1", release: "V2-06", repositories: entries }));
    const missing = spawnSync(process.execPath, [path.join(root, "scripts", "verify-source-set.mjs"), "--allow-dirty"], {
      encoding: "utf8",
      env: { ...commonEnv, P_TEST_CONTEXT: path.join(directory, "missing") },
    });
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /Missing git repository for P/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
