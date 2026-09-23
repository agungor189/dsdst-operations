#!/usr/bin/env node

import fs from "node:fs";
import {
  appendReleaseEvent,
  buildReleaseReport,
  prepareRelease,
  readReleaseJournal,
} from "./release-lib.mjs";

const [command, journalPath, inputPath, explicitTime] = process.argv.slice(2);

function readJson(filePath, label) {
  if (!filePath) throw new Error(`${label} path is required`);
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function output(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

const eventTypes = {
  approve: "APPROVE",
  "preflight-passed": "PREFLIGHT_PASS",
  "candidate-up": "CANDIDATE_UP",
  verify: "VERIFY",
  cutover: "CUTOVER",
  complete: "COMPLETE",
  fail: "FAIL",
  rollback: "ROLLBACK",
};

try {
  if (command === "prepare") {
    output(prepareRelease(journalPath, readJson(inputPath, "release plan")));
  } else if (eventTypes[command]) {
    output(appendReleaseEvent(journalPath, {
      type: eventTypes[command],
      occurred_at: explicitTime || new Date().toISOString(),
      payload: readJson(inputPath, `${command} evidence`),
    }));
  } else if (command === "state") {
    process.stdout.write(`${readReleaseJournal(journalPath).state}\n`);
  } else if (command === "assert-state") {
    const state = readReleaseJournal(journalPath).state;
    if (state !== inputPath) throw new Error(`release state is ${state}; expected ${inputPath}`);
    process.stdout.write(`${state}\n`);
  } else if (command === "candidate-project") {
    process.stdout.write(`${readReleaseJournal(journalPath).plan.candidate.project}\n`);
  } else if (command === "backup-id") {
    process.stdout.write(`${readReleaseJournal(journalPath).plan.recovery_point.recovery_point_id}\n`);
  } else if (command === "report") {
    output(buildReleaseReport(journalPath));
  } else {
    throw new Error("Usage: release-cli.mjs <prepare|approve|preflight-passed|candidate-up|verify|cutover|complete|fail|rollback|state|assert-state|candidate-project|backup-id|report> <journal> [input.json|expected-state] [occurred-at]");
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
