import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("V2-18 CI and E2E are locked to the V2-18 exact source set", () => {
  const manifestPath = path.join(root, "config/v2-18-source-set.json");
  assert.equal(fs.existsSync(manifestPath), true, "V2-18 requires its own immutable source-set manifest");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  assert.equal(manifest.release, "V2-18");
  assert.deepEqual(manifest.basedOn, {
    release: "V2-17",
    sourceSet: "config/v2-17-source-set.json",
    operationsClosureRevision: "b62cc89d586ddde15c9a0fe9e5ee71a66d2b43d1",
  });
  assert.deepEqual(manifest.repositories.map(({ id }) => id), ["O", "P", "W", "K", "L", "HUB"]);

  const workflow = fs.readFileSync(path.join(root, ".github/workflows/e2e.yml"), "utf8");
  assert.match(workflow, /config\/v2-18-source-set\.json/);
  assert.match(workflow, /EXPECTED_SOURCE_SET_RELEASE:\s*V2-18/);
  for (const id of ["O", "P", "W", "K", "L", "HUB"]) {
    assert.match(workflow, new RegExp(`steps\\.source-set\\.outputs\\.${id}`), `${id} checkout must come from the manifest reader`);
  }
  assert.doesNotMatch(workflow, /config\/v2-06-source-set\.json|2fb0d75b2f035135f976a1c2f61253351904a79f/);

  for (const script of ["scripts/e2e.sh", "scripts/e2e-local.sh"]) {
    const source = fs.readFileSync(path.join(root, script), "utf8");
    assert.match(source, /EXPECTED_SOURCE_SET_RELEASE=V2-18/);
    assert.match(source, /config\/v2-18-source-set\.json/);
  }

  const verifier = fs.readFileSync(path.join(root, "scripts/verify-source-set.mjs"), "utf8");
  assert.match(verifier, /EXPECTED_SOURCE_SET_RELEASE \|\| "V2-18"/);
});
