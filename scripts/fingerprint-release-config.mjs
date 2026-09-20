#!/usr/bin/env node

import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

import { getSafeConfigKeys } from "./validate-release-evidence.mjs";

const fail = (message) => {
  throw new Error(message);
};

export function fingerprintConfigurationPairs(serviceId, pairs) {
  if (!Array.isArray(pairs)) fail("configuration pairs must be an array");
  const allowed = getSafeConfigKeys(serviceId);
  if (pairs.length !== allowed.length) fail("configuration input must contain the complete authoritative allowlist");
  const values = new Map();
  for (const [index, pair] of pairs.entries()) {
    if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== "string" || typeof pair[1] !== "string") {
      fail(`configuration pair ${index} is invalid`);
    }
    const [key, value] = pair;
    if (!allowed.includes(key)) fail(`configuration pair ${index} is outside the authoritative service allowlist`);
    if (values.has(key)) fail(`configuration pair ${index} duplicates an allowlisted key`);
    values.set(key, value);
  }
  if (allowed.some((key) => !values.has(key))) fail("configuration input is missing an authoritative allowlist key");
  const canonical = allowed.map((key) => [key, values.get(key)]);
  return "sha256:" + createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export function fingerprintEnvironment(serviceId, environment) {
  if (!Array.isArray(environment)) fail("runtime environment must be a JSON array");
  const allowed = getSafeConfigKeys(serviceId);
  const selected = new Map();
  for (const [index, entry] of environment.entries()) {
    if (typeof entry !== "string") fail(`runtime environment entry ${index} is invalid`);
    const separator = entry.indexOf("=");
    if (separator < 1) fail(`runtime environment entry ${index} is invalid`);
    const key = entry.slice(0, separator);
    if (allowed.includes(key)) selected.set(key, entry.slice(separator + 1));
  }
  const pairs = allowed.map((key) => {
    if (!selected.has(key)) fail("runtime environment is missing an authoritative allowlist key");
    return [key, selected.get(key)];
  });
  return { safe_keys: allowed, fingerprint: fingerprintConfigurationPairs(serviceId, pairs) };
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedPath === import.meta.url) {
  const serviceId = process.argv[2];
  if (!serviceId) {
    console.error("Usage: docker inspect ... | node scripts/fingerprint-release-config.mjs <service-id>");
    process.exitCode = 2;
  } else {
    try {
      let input = "";
      for await (const chunk of process.stdin) input += chunk;
      console.log(JSON.stringify(fingerprintEnvironment(serviceId, JSON.parse(input))));
    } catch (error) {
      console.error(`Configuration fingerprint failed: ${error.message}`);
      process.exitCode = 1;
    }
  }
}
