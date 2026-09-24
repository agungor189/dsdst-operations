#!/usr/bin/env node

import {execFileSync} from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {DatabaseSync} from "node:sqlite";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../.."
);

function fail(message) {
  throw new Error(message);
}

function parseArgs() {
  const result = {};
  const input = process.argv.slice(2);

  for (let i = 0; i < input.length; i++) {
    const key = input[i];

    if (!key.startsWith("--")) {
      fail("invalid candidate hydration argument");
    }

    if (key === "--forbid-production-volumes") {
      result["forbid-production-volumes"] = true;
      continue;
    }

    const value = input[++i];

    if (value === undefined) {
      fail(`missing value for ${key}`);
    }

    result[key.slice(2)] = value;
  }

  return result;
}

function parseEnv(filePath) {
  const result = {};

  for (const raw of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const line = raw.trim();

    if (!line || line.startsWith("#")) continue;

    const index = line.indexOf("=");

    if (index < 1) {
      fail("candidate env contains invalid line");
    }

    const key = line.slice(0, index);
    let value = line.slice(index + 1);

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    result[key] = value;
  }

  return result;
}

function run(command, args) {
  return execFileSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 16 * 1024 * 1024,
  }).trim();
}

function sqliteVersion(filePath) {
  const db = new DatabaseSync(filePath, {
    readOnly: true,
    open: true,
  });

  try {
    const integrity = db.prepare("PRAGMA integrity_check").all();

    if (
      integrity.length !== 1 ||
      integrity[0].integrity_check !== "ok"
    ) {
      fail(`SQLite integrity failed: ${filePath}`);
    }

    const row = db
      .prepare("SELECT MAX(version) AS version FROM schema_migrations")
      .get();

    if (row?.version === undefined || row?.version === null) {
      fail(`schema version missing: ${filePath}`);
    }

    return String(row.version);
  } finally {
    db.close();
  }
}

function restoredVersions(root) {
  const label = JSON.parse(
    fs.readFileSync(
      path.join(root, "label/data/app-state.json"),
      "utf8"
    )
  );

  return {
    panel: sqliteVersion(
      path.join(root, "panel/data/dsdst_panel.db")
    ),
    kit: sqliteVersion(
      path.join(root, "kit/data/dsdst-kit-studio.db")
    ),
    hub: sqliteVersion(
      path.join(root, "customer-hub/data/customer-hub.db")
    ),
    label: String(label.version),
  };
}

try {
  const input = parseArgs();

  for (const key of [
    "project",
    "isolated-restore",
    "backup-id",
    "candidate-env",
  ]) {
    if (!input[key]) fail(`--${key} is required`);
  }

  if (input["forbid-production-volumes"] !== true) {
    fail("--forbid-production-volumes is mandatory");
  }

  const project = input.project;
  const restoredRoot = path.resolve(input["isolated-restore"]);
  const envFile = path.resolve(input["candidate-env"]);
  const backupId = input["backup-id"];

  if (!/^dsdst-candidate-[a-z0-9-]+$/.test(project)) {
    fail("invalid candidate project identity");
  }

  if (!fs.statSync(restoredRoot).isDirectory()) {
    fail("isolated restore directory does not exist");
  }

  const env = parseEnv(envFile);

  if (env.RELEASE_CANDIDATE_PROJECT !== project) {
    fail("candidate environment project mismatch");
  }

  const toolbox = env.OPERATIONS_TOOLBOX_IMAGE;

  if (!/^[^\s@]+@sha256:[a-f0-9]{64}$/.test(toolbox || "")) {
    fail("immutable Operations toolbox image is required");
  }

  const uid = env.OPERATIONS_UID || "1000";
  const gid = env.OPERATIONS_GID || "1000";

  const composeBase = [
    "compose",
    "--project-name",
    project,
    "--env-file",
    envFile,
    "-f",
    path.join(ROOT, "compose.prod.yml"),
    "-f",
    path.join(ROOT, "compose.release-candidate.yml"),
  ];

  const expectedMounts = {
    "dsdst-panel": {
      "/data": [`${project}-panel-data`, true],
      "/app/uploads": [`${project}-panel-uploads`, true],
      "/backups": [`${project}-panel-backups`, true],
    },
    "dsdst-warehouse": {},
    "dsdst-kit-studio": {
      "/data": [`${project}-kit-data`, true],
      "/app/uploads": [`${project}-kit-uploads`, true],
    },
    "dsdst-customer-hub": {
      "/data": [`${project}-customer-hub-data`, true],
      "/backups": [`${project}-customer-hub-backups`, true],
    },
    "label-printer": {
      "/app/data": [`${project}-label-data`, true],
    },
    "warehouse-label-renderer": {
      "/app/data": [`${project}-label-data`, false],
    },
  };

  for (const [service, expected] of Object.entries(expectedMounts)) {
    const ids = run(
      "docker",
      [...composeBase, "ps", "-aq", service]
    ).split("\n").filter(Boolean);

    if (ids.length !== 1) {
      fail(`candidate service container is missing or ambiguous: ${service}`);
    }

    const inspected = JSON.parse(
      run("docker", ["inspect", ids[0]])
    );

    if (!Array.isArray(inspected) || inspected.length !== 1) {
      fail(`candidate inspect failed: ${service}`);
    }

    const mounts = inspected[0].Mounts || [];

    for (const mount of mounts) {
      if (!Object.hasOwn(expected, mount.Destination)) {
        fail(
          `unexpected candidate persistent mount on ${service}: ${mount.Destination}`
        );
      }

      const [expectedName, expectedRw] =
        expected[mount.Destination];

      if (
        mount.Type !== "volume" ||
        mount.Name !== expectedName ||
        mount.RW !== expectedRw
      ) {
        fail(`candidate mount identity mismatch: ${service}`);
      }
    }

    for (const destination of Object.keys(expected)) {
      if (!mounts.some((mount) => mount.Destination === destination)) {
        fail(`candidate mount missing: ${service} ${destination}`);
      }
    }
  }

  const before = restoredVersions(restoredRoot);

  run("docker", [
    "run",
    "--rm",
    "--user",
    "0:0",

    "-e",
    "RESTORED_ROOT=/restore",
    "-e",
    `TARGET_UID=${uid}`,
    "-e",
    `TARGET_GID=${gid}`,

    "--mount",
    `type=bind,src=${restoredRoot},dst=/restore,readonly`,

    "--mount",
    `type=volume,src=${project}-panel-data,dst=/target/panel-data`,
    "--mount",
    `type=volume,src=${project}-panel-uploads,dst=/target/panel-uploads`,
    "--mount",
    `type=volume,src=${project}-panel-backups,dst=/target/panel-backups`,
    "--mount",
    `type=volume,src=${project}-kit-data,dst=/target/kit-data`,
    "--mount",
    `type=volume,src=${project}-kit-uploads,dst=/target/kit-uploads`,
    "--mount",
    `type=volume,src=${project}-label-data,dst=/target/label-data`,
    "--mount",
    `type=volume,src=${project}-customer-hub-data,dst=/target/customer-hub-data`,
    "--mount",
    `type=volume,src=${project}-customer-hub-backups,dst=/target/customer-hub-backups`,

    "--mount",
    `type=bind,src=${path.join(ROOT, "scripts")},dst=/operations/scripts,readonly`,

    toolbox,
    "sh",
    "/operations/scripts/release/adapters/hydrate-candidate-volumes.sh",
  ]);

  const panelMigration = `
    import Database from "better-sqlite3";
    import { runMigrations } from "./server/migrations/runner.ts";
    const db = new Database(process.env.DB_PATH);
    db.pragma("foreign_keys = ON");
    db.pragma("busy_timeout = 5000");
    try { runMigrations(db); } finally { db.close(); }
  `;

  run("docker", [
    ...composeBase,
    "run",
    "--rm",
    "--no-deps",
    "--entrypoint",
    "node",
    "dsdst-panel",
    "node_modules/tsx/dist/cli.mjs",
    "-e",
    panelMigration,
  ]);

  run("docker", [
    ...composeBase,
    "run",
    "--rm",
    "--no-deps",
    "--entrypoint",
    "node",
    "dsdst-kit-studio",
    "dist-server/server/db/migrate-cli.js",
  ]);

  run("docker", [
    ...composeBase,
    "run",
    "--rm",
    "--no-deps",
    "--entrypoint",
    "node",
    "dsdst-customer-hub",
    "dist-server/server/db/migrate-cli.js",
  ]);

  const inspectedState = JSON.parse(
    run("docker", [
      "run",
      "--rm",

      "--mount",
      `type=volume,src=${project}-panel-data,dst=/sources/panel-data,readonly`,
      "--mount",
      `type=volume,src=${project}-kit-data,dst=/sources/kit-data,readonly`,
      "--mount",
      `type=volume,src=${project}-label-data,dst=/sources/labels,readonly`,
      "--mount",
      `type=volume,src=${project}-customer-hub-data,dst=/sources/customer-hub-data,readonly`,

      "--mount",
      `type=bind,src=${path.join(ROOT, "scripts")},dst=/operations/scripts,readonly`,

      toolbox,
      "node",
      "/operations/scripts/release/adapters/inspect-candidate-state.mjs",
    ])
  );

  for (const key of ["panel", "kit", "hub", "label"]) {
    if (inspectedState[key] !== before[key]) {
      fail(
        `candidate ${key} schema changed unexpectedly during V2-18 hydration`
      );
    }
  }

  process.stdout.write(
    JSON.stringify({
      status: "PASS",
      backup_id: backupId,
      source_isolated_restore: true,
      old_volume_mounted: false,
      migrations_ran: [
        `panel:${before.panel}->${inspectedState.panel}`,
        `kit:${before.kit}->${inspectedState.kit}`,
        `hub:${before.hub}->${inspectedState.hub}`,
      ],
    }) + "\n"
  );
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
