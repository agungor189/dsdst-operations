import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const baseEnv = {
  ...process.env,
  COMPOSE_PROJECT_NAME: "dsdst-v218-compose-test",
  E2E_WAREHOUSE_API_KEY: "test-warehouse",
  E2E_KIT_STUDIO_API_KEY: "test-kit",
  E2E_LABEL_PRINTER_API_KEY: "test-label",
  E2E_CUSTOMER_HUB_API_KEY: "test-hub",
  RESTORE_ROOT: "/tmp/dsdst-v218-compose-restore",
  RELEASE_CANDIDATE_PROJECT: "dsdst-candidate-v218-compose",
  CANDIDATE_PANEL_PORT: "41000",
  CANDIDATE_WAREHOUSE_PORT: "41001",
  CANDIDATE_KIT_STUDIO_PORT: "41002",
  CANDIDATE_CUSTOMER_HUB_PORT: "41003",
  CANDIDATE_LABEL_PRINTER_PORT: "41004",
  PANEL_IMAGE: `ghcr.io/test/p@sha256:${"a".repeat(64)}`,
  WAREHOUSE_IMAGE: `ghcr.io/test/w@sha256:${"b".repeat(64)}`,
  KIT_STUDIO_IMAGE: `ghcr.io/test/k@sha256:${"c".repeat(64)}`,
  CUSTOMER_HUB_IMAGE: `ghcr.io/test/h@sha256:${"d".repeat(64)}`,
  LABEL_PRINTER_IMAGE: `ghcr.io/test/l@sha256:${"e".repeat(64)}`,
  OPERATIONS_TOOLBOX_IMAGE: `ghcr.io/test/o@sha256:${"f".repeat(64)}`,
};

const render = (overlay) => {
  const result = spawnSync("docker", ["compose", "--env-file", ".env.example", "-f", "compose.prod.yml", "-f", overlay,
    "config", "--format", "json"], { cwd: root, env: baseEnv, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
};

const published = (config) => Object.entries(config.services)
  .flatMap(([service, value]) => (value.ports || []).map((port) => ({ service, ...port })));

test("merged E2E, recovery, and candidate Compose topology cannot inherit unintended production ports", () => {
  const e2e = render("compose.e2e.yml");
  const recovery = render("compose.recovery.yml");
  assert.deepEqual(published(e2e), []);
  assert.deepEqual(published(recovery), []);
  assert.equal(e2e.networks.internal.internal, true);
  assert.equal(recovery.networks.internal.internal, true);

  const candidate = render("compose.release-candidate.yml");
  const candidatePorts = published(candidate);
  assert.equal(candidatePorts.length, 5, `candidate must publish only five isolated ports: ${JSON.stringify(candidatePorts)}`);
  assert.ok(candidatePorts.every(({ host_ip }) => host_ip === "127.0.0.1"));
  assert.deepEqual(candidatePorts.map(({ published: port }) => Number(port)).sort((a, b) => a - b), [41000, 41001, 41002, 41003, 41004]);
  assert.equal(candidate.networks.internal.internal, true);
});

