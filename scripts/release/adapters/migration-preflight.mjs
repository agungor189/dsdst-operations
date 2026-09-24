#!/usr/bin/env node

import {execFileSync} from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {DatabaseSync} from "node:sqlite";

import {verifyRecoveryPoint} from "../../recovery/recovery-lib.mjs";

function fail(message) {
  throw new Error(message);
}

function args() {
  const values = {};
  const input = process.argv.slice(2);

  for (let i = 0; i < input.length; i += 2) {
    const key = input[i];
    const value = input[i + 1];
    if (!key?.startsWith("--") || value === undefined) {
      fail("invalid migration-preflight adapter arguments");
    }
    values[key.slice(2)] = value;
  }

  return values;
}

function parseEnv(filePath) {
  const result = {};

  for (const raw of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;

    const i = line.indexOf("=");
    if (i < 1) fail("candidate environment contains an invalid line");

    const key = line.slice(0, i);
    let value = line.slice(i + 1);

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (Object.hasOwn(result, key)) {
      fail(`candidate environment repeats ${key}`);
    }

    result[key] = value;
  }

  return result;
}

function sqliteVersion(filePath) {
  if (!fs.existsSync(filePath)) {
    fail(`restored SQLite database is missing: ${filePath}`);
  }

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

    const table = db.prepare(`
      SELECT 1 AS present
      FROM sqlite_master
      WHERE type='table'
        AND name='schema_migrations'
    `).get();

    if (!table) {
      fail(`schema_migrations missing: ${filePath}`);
    }

    const row = db
      .prepare("SELECT MAX(version) AS version FROM schema_migrations")
      .get();

    if (row?.version === null || row?.version === undefined) {
      fail(`schema version missing: ${filePath}`);
    }

    return String(row.version);
  } finally {
    db.close();
  }
}

function labelVersion(filePath) {
  if (!fs.existsSync(filePath)) {
    fail(`restored label state is missing: ${filePath}`);
  }

  const state = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const version = Number(state?.version);

  if (![1, 2, 3].includes(version)) {
    fail("restored label state version is invalid");
  }

  return String(version);
}

function immutableReference(service) {
  const ref = service?.declared_image_reference;
  const digest = service?.image_digest;

  if (
    typeof ref !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(digest || "")
  ) {
    fail(`runtime image provenance missing for ${service?.service_id}`);
  }

  return `${ref.split("@")[0]}@${digest}`;
}

try {
  const input = args();

  if (input.mode !== "preflight") {
    fail("migration adapter supports only --mode preflight");
  }

  for (const key of [
    "restored-root",
    "recovery-point",
    "candidate-env",
    "candidate-project",
    "backup-id",
  ]) {
    if (!input[key]) fail(`--${key} is required`);
  }

  const restoredRoot = path.resolve(input["restored-root"]);
  const recoveryPoint = path.resolve(input["recovery-point"]);
  const candidateEnvPath = path.resolve(input["candidate-env"]);
  const candidateProject = input["candidate-project"];
  const backupId = input["backup-id"];

  if (path.basename(recoveryPoint) !== backupId) {
    fail("approved backup ID does not match recovery point");
  }

  const env = parseEnv(candidateEnvPath);

  if (!process.env.RECOVERY_MANIFEST_HMAC_KEY) {
    if (!env.RECOVERY_MANIFEST_HMAC_KEY) {
      fail("RECOVERY_MANIFEST_HMAC_KEY is unavailable");
    }

    process.env.RECOVERY_MANIFEST_HMAC_KEY =
      env.RECOVERY_MANIFEST_HMAC_KEY;
  }

  if (
    env.RECOVERY_MANIFEST_HMAC_KEY_ID &&
    !process.env.RECOVERY_MANIFEST_HMAC_KEY_ID
  ) {
    process.env.RECOVERY_MANIFEST_HMAC_KEY_ID =
      env.RECOVERY_MANIFEST_HMAC_KEY_ID;
  }

  const manifest = verifyRecoveryPoint(recoveryPoint, {
    requireAccepted: true,
  });

  if (manifest.recovery_point_id !== backupId) {
    fail("recovery manifest backup ID mismatch");
  }

  if (manifest.provenance?.source_set?.release !== "V2-18") {
    fail("migration preflight requires exact V2-18 recovery provenance");
  }

  execFileSync(
    process.execPath,
    [
      new URL("../verify-candidate-env.mjs", import.meta.url).pathname,
      candidateEnvPath,
      candidateProject,
    ],
    {stdio: ["ignore", "pipe", "pipe"]}
  );

  const requiredConfig = [
    "JWT_SECRET",
    "ENCRYPTION_SECRET",
    "PANEL_API_HASH_SECRET",
    "LABEL_RENDERER_API_KEY",
    "WAREHOUSE_API_KEY",
    "KIT_STUDIO_API_KEY",
    "CUSTOMER_HUB_API_KEY",
    "CUSTOMER_HUB_ENCRYPTION_KEY",
    "CUSTOMER_HUB_APP_ORIGIN",
    "LABEL_PRINTER_API_KEY",
  ];

  for (const key of requiredConfig) {
    if (typeof env[key] !== "string" || env[key].length === 0) {
      fail(`candidate protected configuration is missing ${key}`);
    }
  }

  const runtime = new Map(
    manifest.provenance.runtime.services.map((service) => [
      service.service_id,
      service,
    ])
  );

  const imageMapping = {
    PANEL_IMAGE: "dsdst-panel",
    WAREHOUSE_IMAGE: "dsdst-warehouse",
    KIT_STUDIO_IMAGE: "dsdst-kit-studio",
    CUSTOMER_HUB_IMAGE: "dsdst-customer-hub",
    LABEL_PRINTER_IMAGE: "label-printer",
  };

  for (const [envKey, serviceId] of Object.entries(imageMapping)) {
    const expected = immutableReference(runtime.get(serviceId));

    if (env[envKey] !== expected) {
      fail(`${envKey} differs from accepted V2-18 recovery provenance`);
    }
  }

  const observed = {
    panel: sqliteVersion(
      path.join(restoredRoot, "panel/data/dsdst_panel.db")
    ),
    kit: sqliteVersion(
      path.join(restoredRoot, "kit/data/dsdst-kit-studio.db")
    ),
    hub: sqliteVersion(
      path.join(restoredRoot, "customer-hub/data/customer-hub.db")
    ),
    label: labelVersion(
      path.join(restoredRoot, "label/data/app-state.json")
    ),
  };

  const expected = {
    panel: String(manifest.components.panel_database.schema_version),
    kit: String(manifest.components.kit_database.schema_version),
    hub: String(manifest.components.customer_hub_database.schema_version),
    label: String(manifest.components.label_state.schema_version),
  };

  for (const key of Object.keys(expected)) {
    if (observed[key] !== expected[key]) {
      fail(
        `${key} restored schema mismatch: ${observed[key]} != ${expected[key]}`
      );
    }
  }

  const migrations = [
    `panel:${observed.panel}->${expected.panel}`,
    `kit:${observed.kit}->${expected.kit}`,
    `hub:${observed.hub}->${expected.hub}`,
    `label:${observed.label}->${expected.label}`,
  ];

  process.stdout.write(
    JSON.stringify({
      backup_id: backupId,
      recovery_health: "PASS",
      source_set_check: "PASS",
      image_provenance_check: "PASS",
      secret_config_check: "PASS",
      migration: {
        status: "PASS",
        candidate_db_touched: false,
        migrations,
      },
    }) + "\n"
  );
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
