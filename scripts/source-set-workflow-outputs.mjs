#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const manifestPath = path.resolve(process.argv[2] || "config/v2-18-source-set.json");
const expectedRelease = process.argv[3] || "V2-18";
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
if (manifest.release !== expectedRelease) throw new Error(`Expected ${expectedRelease}, observed ${manifest.release}`);
const revisions = new Map(manifest.repositories.map((entry) => [entry.id, entry.revision]));
for (const id of ["O", "P", "W", "K", "L", "HUB"]) {
  const revision = revisions.get(id);
  if (typeof revision !== "string" || !/^[a-f0-9]{40}$/.test(revision)) throw new Error(`Missing exact ${id} revision`);
  process.stdout.write(`${id}=${revision}\n`);
}
