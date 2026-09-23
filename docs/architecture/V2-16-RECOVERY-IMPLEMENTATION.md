# V2-16 — Recovery package implementation

Status: code and isolated verification contract implemented; production runtime evidence remains separate.

## Ownership and scope

O remains the Recovery domain owner and orchestrates existing service state through read-only mounts and online database snapshots. P, K, L, W, and Customer Hub retain their existing domain ownership. No business rows, source-of-truth boundary, deployment topology, or production data are changed.

The implementation extends:

- `scripts/backup.sh` into the coherent recovery-point coordinator;
- `scripts/restore-check.sh` into a fail-closed isolated restore gate;
- `compose.prod.yml`'s existing `operations-toolbox` with read-only state mounts and the existing rclone configuration;
- the existing R2/rclone route with client-side encrypted recovery payloads;
- monthly/quarterly drill evidence outside protected databases.

Panel's in-app backup configuration remains available. Its database archives already use SQLite online backup, and its rclone support is reused. In-app files are never relabelled as an accepted V2-16 full recovery point.

## Acceptance semantics

`SUCCESS` requires all of the following:

1. P, K, and Hub SQLite online snapshots complete and pass `PRAGMA integrity_check`;
2. P uploads, K uploads, L template/version state, and Hub attachments are present as full regular-file archives;
3. every component has a SHA-256 hash and byte size;
4. database and L state schemas match the runtime observations;
5. runtime OCI revisions match the exact O/P/W/K/L source-set closure;
6. runtime image/container/config provenance is complete and redacted;
7. the encrypted payload and HMAC-authenticated encrypted manifest persist offsite and round-trip SHA-256 checks pass;
8. a final local verification passes immediately before the signed `SUCCESS` manifest atomically replaces the canonical `INCOMPLETE` manifest.

Local verification with offsite disabled is `INCOMPLETE`. Missing/corrupt/incompatible state is `FAILED`. A failed offsite upload is `FAILED` while retaining the distinct local `VERIFIED` state in the manifest.

## Restore boundary

Restore accepts one authenticated `SUCCESS`/`VERIFIED`/`PERSISTED` recovery set only. It rejects manifest tampering, missing components, changed hashes, unsafe archive entries, SQLite corruption, schema mismatch, source/runtime mismatch, a non-empty target, a target outside the isolated restore root, and any target overlapping configured production paths. A named emergency local-only override still requires HMAC and complete local verification. Monthly drills boot the isolated digest-pinned stack, wait for health, run read-only smoke checks, and tear it down. There is no production overwrite, promotion, DNS, tunnel, or Cloudflare action.

## Schema, data, and rollback impact

- Application schema impact: none.
- Business-data migration or repair: none.
- Runtime volumes: read-only for the toolbox; the backup repository is the only writable recovery mount.
- Rollback: stop/disable the V2-16 timers and revert the O feature branch. Existing application data and Panel component backups are unchanged. Recovery points already written remain ordinary files and encrypted remote objects; delete them only through an explicitly approved retention operation.

## Remaining runtime gates

- install/enable the hourly and monthly timers on the selected production venue;
- configure and recovery-test the external encryption key;
- demonstrate offsite R2 persistence with real credentials;
- demonstrate RPO at or below 60 minutes and RTO at or below 60 minutes on the exact runtime set;
- conduct and sign the first quarterly full DR drill.
