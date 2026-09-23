#!/usr/bin/env node

import fs from "node:fs";

const [filePath, expectedBackupId] = process.argv.slice(2);
if (!filePath || !expectedBackupId) throw new Error("Usage: verify-hydration-evidence.mjs <evidence.json> <expected-backup-id>");
const evidence = JSON.parse(fs.readFileSync(filePath, "utf8"));
if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) throw new Error("hydration evidence must be an object");
const allowed = ["status", "backup_id", "source_isolated_restore", "old_volume_mounted", "migrations_ran"];
const unsupported = Object.keys(evidence).filter((key) => !allowed.includes(key));
if (unsupported.length > 0) throw new Error(`hydration evidence contains unsupported fields: ${unsupported.join(", ")}`);
if (evidence.status !== "PASS" || evidence.backup_id !== expectedBackupId || evidence.source_isolated_restore !== true || evidence.old_volume_mounted !== false) {
  throw new Error("candidate hydration did not prove isolated recovery input and production-volume separation");
}
if (!Array.isArray(evidence.migrations_ran) || evidence.migrations_ran.some((value) => typeof value !== "string" || value.length === 0)) {
  throw new Error("hydration evidence must list the exact executed migrations");
}
process.stdout.write("candidate hydration evidence: VERIFIED\n");
