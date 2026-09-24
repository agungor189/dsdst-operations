#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

import {
  validateLegacyRuntimeEvidence,
  verifyBootstrapPoint,
} from "../bootstrap-lib.mjs";
import { createEvidenceDigest } from "./release-lib.mjs";

const point = process.argv[2];

if (!point || !path.isAbsolute(point)) {
  throw new Error(
    "Usage: legacy-runtime-bridge.mjs <accepted-bootstrap-point>"
  );
}

verifyBootstrapPoint(point, { requireAccepted: true });

const legacyPath = path.join(
  point,
  "provenance",
  "legacy-runtime.json"
);

const legacy = JSON.parse(
  fs.readFileSync(legacyPath, "utf8")
);

validateLegacyRuntimeEvidence(legacy);

const services = legacy.services
  .map((service) => ({
    service_id: service.service_id,
    container_id: service.container_id,
    image_id: service.image_id,
    mounts: service.mounts
      .map((mount) => ({
        target: mount.target,
        mode: mount.mode,
        type: mount.type,
        source_id: mount.source_id,
      }))
      .sort((a, b) => a.target.localeCompare(b.target)),
  }))
  .sort((a, b) => a.service_id.localeCompare(b.service_id));

const body = {
  kind: "legacy-bootstrap-runtime",
  bootstrap_id: path.basename(point),
  captured_at: legacy.captured_at,
  source_provenance_state: "UNVERIFIED_LEGACY",
  source_revision_claimed: false,
  services,
};

const evidenceDigest = createEvidenceDigest(body);

const volumeIds = [
  ...new Set(
    services.flatMap((service) =>
      service.mounts.map((mount) => mount.source_id)
    )
  ),
].sort();

process.stdout.write(
  JSON.stringify(
    {
      runtime_identity:
        `legacy-runtime-${evidenceDigest.slice("sha256:".length)}`,
      volume_ids: volumeIds,
      identity_evidence: {
        ...body,
        evidence_digest: evidenceDigest,
      },
    },
    null,
    2
  ) + "\n"
);
