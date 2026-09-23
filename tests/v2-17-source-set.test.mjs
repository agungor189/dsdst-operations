import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {fileURLToPath} from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.join(root, "config", "v2-17-source-set.json");
const previousPath = path.join(root, "config", "v2-16-source-set.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

test("V2-17 exact source set descends only O from the accepted V2-16 closure", () => {
  const revisions = Object.fromEntries(manifest.repositories.map(({id, revision}) => [id, revision]));
  assert.equal(manifest.release, "V2-17");
  assert.deepEqual(manifest.basedOn, {
    release: "V2-16",
    sourceSet: "config/v2-16-source-set.json",
    operationsClosureRevision: "e64142f18eb6a2c3fe7c0f084a393c0871c76ee6",
  });
  assert.deepEqual(revisions, {
    O: "35374d1f44f7d3f7b067682e73d8a5b527ecad02",
    P: "61ed1ad8fba25ed9d5c0b228308ff22da45febaf",
    W: "525e18c508c1191c0c4e4b725bda00defd930d2f",
    K: "0e0717c3f8d3f3f0af186b4c165524bc2e81724c",
    L: "add3987e0eb15e8742ecac490b5eb4e78b620ce5",
    HUB: "f030c29b6ee41765289993fda1e94d1e484b5cac",
  });
  const previous = Object.fromEntries(JSON.parse(fs.readFileSync(previousPath, "utf8")).repositories.map(({id, revision}) => [id, revision]));
  for (const id of ["P", "W", "K", "L", "HUB"]) assert.equal(revisions[id], previous[id]);
  assert.equal(spawnSync("git", ["-C", root, "merge-base", "--is-ancestor", manifest.basedOn.operationsClosureRevision, revisions.O]).status, 0);
});

test("V2-17 source-set verifier rejects V2-16 and permits only an O controller descendant", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dsdst-v2-17-source-set-"));
  const head = spawnSync("git", ["-C", root, "rev-parse", "HEAD"], {encoding: "utf8"}).stdout.trim();
  const entries = ["O", "P", "W", "K", "L", "HUB"].map((id) => ({
    id, repository: "agungor189/dsdst-operations", contextEnv: `${id}_V217_TEST_CONTEXT`, revision: id === "O" ? manifest.repositories[0].revision : head,
  }));
  const fixture = path.join(directory, "source-set.json");
  fs.writeFileSync(fixture, JSON.stringify({schemaVersion: "dsdst.test-source-set.v1", release: "V2-17", repositories: entries}));
  const environment = {...process.env, EXPECTED_SOURCE_SET_RELEASE: "V2-17", SOURCE_SET_MANIFEST: fixture};
  for (const id of ["O", "P", "W", "K", "L", "HUB"]) environment[`${id}_V217_TEST_CONTEXT`] = root;
  try {
    const accepted = spawnSync(process.execPath, [path.join(root, "scripts", "verify-source-set.mjs"), "--allow-dirty", "--allow-operations-descendant"], {encoding: "utf8", env: environment});
    assert.equal(accepted.status, 0, accepted.stderr);
    const rejected = spawnSync(process.execPath, [path.join(root, "scripts", "verify-source-set.mjs"), "--allow-dirty"], {encoding: "utf8", env: {...environment, SOURCE_SET_MANIFEST: previousPath}});
    assert.notEqual(rejected.status, 0);
  } finally {
    fs.rmSync(directory, {recursive: true, force: true});
  }
});
