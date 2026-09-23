#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync, backup } from "node:sqlite";

export async function onlineBackup(sourcePath, destinationPath) {
  if (!path.isAbsolute(sourcePath) || !path.isAbsolute(destinationPath)) {
    throw new Error("SQLite source and destination paths must be absolute");
  }
  if (!fs.existsSync(sourcePath)) throw new Error(`SQLite source does not exist: ${sourcePath}`);
  fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
  const temporaryPath = `${destinationPath}.partial-${process.pid}`;
  fs.rmSync(temporaryPath, { force: true });
  const source = new DatabaseSync(sourcePath, { readOnly: true });
  try {
    await backup(source, temporaryPath);
  } finally {
    source.close();
  }
  const snapshot = new DatabaseSync(temporaryPath, { readOnly: true });
  try {
    const result = snapshot.prepare("PRAGMA integrity_check").all();
    if (result.length !== 1 || result[0].integrity_check !== "ok") {
      throw new Error(`SQLite integrity verification failed for ${sourcePath}`);
    }
  } finally {
    snapshot.close();
  }
  fs.renameSync(temporaryPath, destinationPath);
  return destinationPath;
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (import.meta.url === invokedPath) {
  const [sourcePath, destinationPath] = process.argv.slice(2);
  if (!sourcePath || !destinationPath) {
    console.error("Usage: sqlite-online-backup.mjs <absolute-source.db> <absolute-destination.db>");
    process.exitCode = 2;
  } else {
    onlineBackup(sourcePath, destinationPath)
      .then(() => process.stdout.write(`${destinationPath}\n`))
      .catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
      });
  }
}
