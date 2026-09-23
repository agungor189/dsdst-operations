#!/usr/bin/env node

import crypto from "node:crypto";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const dbPath = process.argv[2];

if (!dbPath || !path.isAbsolute(dbPath)) {
  throw new Error("Usage: bootstrap-seed-service-keys.mjs <absolute-panel-db-path>");
}

const hashSecret = process.env.PANEL_API_HASH_SECRET || "";
if (Buffer.byteLength(hashSecret) < 32) {
  throw new Error("PANEL_API_HASH_SECRET is missing or too short");
}

const authScopes = [
  "auth:login",
  "auth:session:validate",
  "auth:session:revoke",
  "auth:password:change",
];

const principals = [
  {
    id: "bootstrap-v2-18-kit",
    name: "V2-18 Bootstrap Kit Studio",
    env: "KIT_STUDIO_API_KEY",
    permissions: [...authScopes, "kit-catalog:read", "catalog:read"],
  },
  {
    id: "bootstrap-v2-18-label",
    name: "V2-18 Bootstrap Label Printer",
    env: "LABEL_PRINTER_API_KEY",
    permissions: authScopes,
  },
  {
    id: "bootstrap-v2-18-customer-hub",
    name: "V2-18 Bootstrap Customer Hub",
    env: "CUSTOMER_HUB_API_KEY",
    permissions: authScopes,
  },
];

const clearKeys = principals.map((principal) => {
  const value = String(process.env[principal.env] || "").trim();
  if (!value) throw new Error(`${principal.env} is required`);
  return value;
});

const allKeys = [
  ...clearKeys,
  ...(process.env.WAREHOUSE_API_KEY ? [process.env.WAREHOUSE_API_KEY] : []),
];

if (new Set(allKeys).size !== allKeys.length) {
  throw new Error("Bootstrap service keys must be distinct");
}

const db = new DatabaseSync(dbPath);

try {
  const table = db.prepare(`
    SELECT 1 AS present
    FROM sqlite_master
    WHERE type='table' AND name='panel_api_keys'
  `).get();

  if (!table) throw new Error("panel_api_keys table is missing");

  const upsert = db.prepare(`
    INSERT INTO panel_api_keys
      (id, name, key_prefix, key_hash, last4, status, environment, permissions)
    VALUES
      (?, ?, ?, ?, ?, 'active', 'test', ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      key_prefix = excluded.key_prefix,
      key_hash = excluded.key_hash,
      last4 = excluded.last4,
      status = 'active',
      environment = 'test',
      permissions = excluded.permissions,
      updated_at = CURRENT_TIMESTAMP,
      deleted_at = NULL,
      revoked_at = NULL
  `);

  db.exec("BEGIN IMMEDIATE");

  try {
    principals.forEach((principal, index) => {
      const clearKey = clearKeys[index];
      const keyHash = crypto
        .createHmac("sha256", hashSecret)
        .update(clearKey)
        .digest("hex");

      upsert.run(
        principal.id,
        principal.name,
        clearKey.slice(0, 12),
        keyHash,
        clearKey.slice(-4),
        JSON.stringify(principal.permissions),
      );
    });

    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
} finally {
  db.close();
}

console.log("Candidate-only V2-18 service principals: SEEDED");
