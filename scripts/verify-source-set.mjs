#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.resolve(process.env.SOURCE_SET_MANIFEST || path.join(root, "config", "v2-02-source-set.json"));
const allowDirty = process.argv.includes("--allow-dirty");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const shaPattern = /^[a-f0-9]{40}$/;
const defaults = {
  OPERATIONS_CONTEXT: root,
  PANEL_CONTEXT: path.resolve(root, "../panel-kit-yonetimi"),
  WAREHOUSE_CONTEXT: path.resolve(root, "../Dsdst-Warehouse"),
  KIT_STUDIO_CONTEXT: path.resolve(root, "../dsdst-kit-studio"),
  LABEL_PRINTER_CONTEXT: path.resolve(root, "../Label-Printer"),
  CUSTOMER_HUB_CONTEXT: path.resolve(root, "../dsdst-customer-hub"),
};

const git = (repositoryPath, ...args) => execFileSync("git", ["-C", repositoryPath, ...args], { encoding: "utf8" }).trim();
const normalizeRemote = (value) => value
  .replace(/^git@github\.com:/, "")
  .replace(/^https:\/\/github\.com\//, "")
  .replace(/\.git$/, "")
  .toLowerCase();

if (manifest.schemaVersion !== "dsdst.test-source-set.v1") throw new Error("Unsupported source-set schema");
if (manifest.release !== "V2-02") throw new Error("Unsupported source-set release: expected V2-02");
if (!Array.isArray(manifest.repositories) || manifest.repositories.length === 0) throw new Error("Source set is empty");
const ids = new Set();
const verified = [];
for (const entry of manifest.repositories) {
  if (ids.has(entry.id)) throw new Error(`Duplicate source-set id: ${entry.id}`);
  ids.add(entry.id);
  if (!shaPattern.test(entry.revision)) throw new Error(`Invalid exact revision for ${entry.id}`);
  const repositoryPath = path.resolve(process.env[entry.contextEnv] || defaults[entry.contextEnv] || "");
  if (!fs.existsSync(path.join(repositoryPath, ".git"))) throw new Error(`Missing git repository for ${entry.id}: ${repositoryPath}`);
  const observedRevision = git(repositoryPath, "rev-parse", "HEAD");
  if (observedRevision !== entry.revision) {
    throw new Error(`${entry.id} revision mismatch: expected ${entry.revision}, observed ${observedRevision}`);
  }
  const remote = normalizeRemote(git(repositoryPath, "remote", "get-url", "origin"));
  if (remote !== entry.repository.toLowerCase()) {
    throw new Error(`${entry.id} remote mismatch: expected ${entry.repository}, observed ${remote}`);
  }
  if (!allowDirty) {
    const dirty = git(repositoryPath, "status", "--porcelain");
    if (dirty) throw new Error(`${entry.id} working tree is not clean`);
  }
  verified.push({ id: entry.id, repository: entry.repository, revision: observedRevision, role: entry.role || "release-source" });
}

for (const required of ["O", "P", "W", "K", "L"]) {
  if (!ids.has(required)) throw new Error(`Missing required V2 repository ${required}`);
}
process.stdout.write(`${JSON.stringify({ schemaVersion: manifest.schemaVersion, repositories: verified }, null, 2)}\n`);
