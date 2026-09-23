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

  const ciWorkflow = fs.readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf8");
  assert.match(ciWorkflow, /Checkout Operations with full history[\s\S]*?fetch-depth:\s*0/);
  assert.match(ciWorkflow, /node scripts\/source-set-workflow-outputs\.mjs config\/v2-18-source-set\.json V2-18/);
  for (const id of ["P", "W", "K", "L", "HUB"]) {
    assert.match(ciWorkflow, new RegExp(`steps\\.source-set\\.outputs\\.${id}`), `${id} CI checkout must come from the manifest reader`);
  }
  for (const context of ["PANEL_CONTEXT", "WAREHOUSE_CONTEXT", "KIT_STUDIO_CONTEXT", "LABEL_PRINTER_CONTEXT", "CUSTOMER_HUB_CONTEXT"]) {
    assert.match(ciWorkflow, new RegExp(`${context}: \\$\\{\\{ github\\.workspace \\}\\}/`), `${context} must be wired under the CI workspace`);
  }
  assert.match(ciWorkflow, /npm --prefix "\$PANEL_CONTEXT" ci/);
  assert.match(ciWorkflow, /npm --prefix "\$KIT_STUDIO_CONTEXT" ci/);
  assert.match(ciWorkflow, /node scripts\/verify-source-set\.mjs --allow-operations-descendant/);
  assert.doesNotMatch(ciWorkflow, /[a-f0-9]{40}/, "CI must not duplicate source-set revisions");

  for (const script of ["scripts/e2e.sh", "scripts/e2e-local.sh"]) {
    const source = fs.readFileSync(path.join(root, script), "utf8");
    assert.match(source, /EXPECTED_SOURCE_SET_RELEASE=\$\{EXPECTED_SOURCE_SET_RELEASE:-V2-18\}/);
    assert.match(source, /config\/v2-18-source-set\.json/);
  }
  const localE2e = fs.readFileSync(path.join(root, "scripts/e2e-local.sh"), "utf8");
  assert.doesNotMatch(localE2e, /npx -y node@24/, "local E2E must use the repository-native Node ABI");
  assert.match(localE2e, /NODE24_BIN=\$\{NODE24_BIN:-\$\(command -v node\)\}/);
  assert.match(localE2e, /TEMP_ROOT=.*cd -P/, "local E2E must resolve a physical temp path for Kit upload containment");

  const verifier = fs.readFileSync(path.join(root, "scripts/verify-source-set.mjs"), "utf8");
  assert.match(verifier, /EXPECTED_SOURCE_SET_RELEASE \|\| "V2-18"/);
});
