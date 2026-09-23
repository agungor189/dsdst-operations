#!/usr/bin/env node

import fs from "node:fs";

const filePath = process.argv[2];
const expectedProject = process.argv[3];
if (!filePath || !expectedProject) throw new Error("Usage: verify-candidate-env.mjs <env-file> <expected-project>");

const values = {};
for (const rawLine of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
  const line = rawLine.trim();
  if (!line || line.startsWith("#")) continue;
  const separator = line.indexOf("=");
  if (separator < 1) throw new Error("candidate environment contains an invalid line");
  const key = line.slice(0, separator);
  if (Object.hasOwn(values, key)) throw new Error(`candidate environment repeats ${key}`);
  values[key] = line.slice(separator + 1);
}

if (values.RELEASE_CANDIDATE_PROJECT !== expectedProject || !/^dsdst-candidate-[a-z0-9-]+$/.test(expectedProject)) {
  throw new Error("candidate project does not match the approved isolated project identity");
}

for (const key of ["PANEL_IMAGE", "WAREHOUSE_IMAGE", "KIT_STUDIO_IMAGE", "LABEL_PRINTER_IMAGE", "CUSTOMER_HUB_IMAGE", "OPERATIONS_TOOLBOX_IMAGE"]) {
  if (!/^[^\s@]+@sha256:[a-f0-9]{64}$/.test(values[key] || "")) throw new Error(`${key} must be pinned by immutable digest`);
}

for (const key of ["CANDIDATE_PANEL_PORT", "CANDIDATE_WAREHOUSE_PORT", "CANDIDATE_KIT_STUDIO_PORT", "CANDIDATE_LABEL_PRINTER_PORT", "CANDIDATE_CUSTOMER_HUB_PORT"]) {
  const port = Number(values[key]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`${key} must be an explicit valid port`);
}

process.stdout.write("candidate environment: VERIFIED\n");
