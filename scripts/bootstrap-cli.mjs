#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import {
  buildBootstrapManifest,
  finalizeBootstrapPoint,
  promoteBootstrapSuccess,
  restoreBootstrapPoint,
  stageBootstrapOffsite,
  verifyBootstrapPoint,
  verifyCandidateAgainstBootstrap,
} from './bootstrap-lib.mjs';

function json(value) { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); }

const [command, ...args] = process.argv.slice(2);

try {
  if (command === 'build') {
    const [pointPath, bootstrapId, createdAt, completedAt] = args;
    json(buildBootstrapManifest(path.resolve(pointPath), {bootstrapId, createdAt, completedAt}));
  } else if (command === 'verify') {
    const [pointPath, acceptedFlag] = args;
    json(verifyBootstrapPoint(path.resolve(pointPath), {requireAccepted: acceptedFlag === '--require-accepted'}));
  } else if (command === 'stage-offsite-final') {
    const [pointPath, candidatePath, remoteRoot, configFingerprint, payloadPath, payloadSha256, payloadSize, persistedAt, manifestPath] = args;
    json(stageBootstrapOffsite(path.resolve(pointPath), path.resolve(candidatePath), {
      remoteRoot,
      configFingerprint,
      payloadPath,
      payloadSha256,
      payloadSize,
      persistedAt,
      manifestPath,
    }));
  } else if (command === 'promote-offsite-final') {
    const [pointPath, candidatePath] = args;
    json(promoteBootstrapSuccess(path.resolve(pointPath), path.resolve(candidatePath)));
  } else if (command === 'finalize') {
    const [pointPath, candidatePath] = args;
    json(finalizeBootstrapPoint(path.resolve(pointPath), path.resolve(candidatePath)));
  } else if (command === 'restore') {
    const [pointPath, targetPath, ...protectedPaths] = args;
    json(restoreBootstrapPoint(path.resolve(pointPath), path.resolve(targetPath), {protectedPaths}));
  } else if (command === 'verify-candidate') {
    const [pointPath, runtimePath, sourceSetPath] = args;
    const runtime = JSON.parse(fs.readFileSync(path.resolve(runtimePath), 'utf8'));
    const sourceSet = JSON.parse(fs.readFileSync(path.resolve(sourceSetPath), 'utf8'));
    json(verifyCandidateAgainstBootstrap(path.resolve(pointPath), runtime, sourceSet));
  } else {
    throw new Error('Usage: bootstrap-cli.mjs <build|verify|stage-offsite-final|promote-offsite-final|finalize|restore|verify-candidate> ...');
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
