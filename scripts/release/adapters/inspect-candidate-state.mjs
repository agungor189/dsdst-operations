#!/usr/bin/env node

import fs from "node:fs";
import {DatabaseSync} from "node:sqlite";

function inspectSqlite(filePath) {
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
      throw new Error(`SQLite integrity failed: ${filePath}`);
    }

    const row = db
      .prepare("SELECT MAX(version) AS version FROM schema_migrations")
      .get();

    if (row?.version === undefined || row?.version === null) {
      throw new Error(`schema version missing: ${filePath}`);
    }

    return String(row.version);
  } finally {
    db.close();
  }
}

const label = JSON.parse(
  fs.readFileSync("/sources/labels/app-state.json", "utf8")
);

if (![1, 2, 3].includes(Number(label.version))) {
  throw new Error("label state schema version is invalid");
}

process.stdout.write(
  JSON.stringify({
    panel: inspectSqlite(
      "/sources/panel-data/dsdst_panel.db"
    ),
    kit: inspectSqlite(
      "/sources/kit-data/dsdst-kit-studio.db"
    ),
    hub: inspectSqlite(
      "/sources/customer-hub-data/customer-hub.db"
    ),
    label: String(label.version),
  }) + "\n"
);
