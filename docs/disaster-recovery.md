# Disaster recovery

## Recovery contract

V2-16 extends the existing `scripts/backup.sh`, `scripts/restore-check.sh`, production Compose, and Panel rclone/R2 configuration. It does not create a second backup authority. O coordinates one recovery point; Panel's existing managed DB/uploads archives remain component-level operator conveniences and are not accepted recovery points by themselves.

The locked objectives are:

- RPO: at most 60 minutes;
- RTO target: at most 60 minutes;
- one complete recovery-point attempt each hour;
- hourly retention for 48 hours, daily for 30 days, weekly for 12 weeks, and monthly for 12 months;
- encrypted offsite persistence;
- the newest known-good recovery point is never retention-deleted.

A recovery point is `SUCCESS` only after every required component, SHA-256 hash, size, SQLite integrity check, schema version, exact source-set revision, runtime image/container provenance, redacted configuration fingerprint, and encrypted offsite object has verified. Offsite disabled is `INCOMPLETE`. An upload/persistence failure is `FAILED`, distinct from local verification. Missing components and corruption fail closed.

## Contents

Every recovery point contains full reconstructable state; these are complete snapshots, not incremental backups:

- Panel online SQLite snapshot and full uploads archive;
- Kit Studio online SQLite snapshot and full uploads archive;
- Label Printer complete template/version state archive;
- Customer Hub online SQLite snapshot and full attachments archive;
- exact O/P/W/K/L source-set contract and observed checkout closure;
- per-service runtime container ID, image ID/digest, OCI revision, schema version, and redacted configuration fingerprint.

SQLite files are created with the SQLite online backup API while the live WAL writer can remain active. Live database files are never copied raw. Archives contain regular files only and are hash checked before acceptance. Manifests contain no secret values or tokens.

## Required environment

Use the existing Panel rclone/R2 variables. V2-16 places recovery sets below a separate `recovery-points` prefix:

```dotenv
RECOVERY_OFFSITE_ENABLED=true
RECOVERY_OFFSITE_RCLONE_REMOTE=dsdstr2:dsdst-panel-backups
RECOVERY_OFFSITE_PREFIX=production/recovery-points
RECOVERY_ENCRYPTION_PASSPHRASE=<from-secret-store>
OPERATIONS_BACKUP_DIR=/opt/dsdst/backups
```

If `RECOVERY_OFFSITE_RCLONE_REMOTE` is omitted, the script uses `CLOUD_BACKUP_RCLONE_REMOTE`. Existing `RCLONE_CONFIG_DSDSTR2_*` settings remain supported. `RECOVERY_ENCRYPTION_PASSPHRASE` must be stored and recovered separately from the backup destination; it is never written to a manifest or evidence file.

## Backup and health commands

Create one full coherent recovery point:

```sh
./scripts/backup.sh
```

Check the 60-minute RPO health gate:

```sh
./scripts/recovery-health.sh
```

The reference systemd units in `deploy/systemd/` schedule `backup.sh` exactly hourly. Installation/enabling is a separate runtime operation and is not performed by this repository change.

## Isolated restore

Restore and verify a local point without changing production paths:

```sh
./scripts/restore-check.sh \
  /opt/dsdst/backups/recovery-points/rp-YYYYMMDDTHHMMSSZ-id \
  /opt/dsdst/backups/restore-staging/manual-check
```

The target must be beneath `RECOVERY_RESTORE_ROOT` (default: `<backup-root>/restore-staging`), absent or empty, and disjoint from configured production data/upload paths. The command verifies hashes, archive safety, SQLite integrity, schemas, exact source/runtime compatibility, then restores P/K/Hub databases, uploads/attachments, and L state into isolated directories. It never swaps a live database, mounts a production volume, restarts production, or changes Cloudflare routing.

Fetch, decrypt, verify, and restore an offsite point:

```sh
./scripts/fetch-offsite-recovery.sh \
  rp-YYYYMMDDTHHMMSSZ-id \
  /opt/dsdst/backups/restore-staging/offsite-check
```

## Drills

The monthly automated drill performs a complete isolated filesystem restore and readability/integrity verification using the newest successful point:

```sh
./scripts/restore-drill.sh
```

The reference `dsdst-recovery-drill.timer` runs it monthly. Evidence is written under `<backup-root>/evidence/drills/`, outside every protected database, and records start/completion timestamps, duration, recovery-point ID, exact restored source set, RPO freshness, drill type, and result.

The quarterly full drill additionally starts all restored services under a unique Compose project with no published ports, no production volumes, print dry-run, cloud backup disabled, mock Hub adapters, and internal-only networks:

```sh
./scripts/restore-drill.sh --full \
  /opt/dsdst/backups/recovery-points/rp-YYYYMMDDTHHMMSSZ-id
```

Use the approved isolated drill environment file. The script derives every restorable service image from the registry digest recorded in the recovery point, runs `--no-build`, waits for service health, records evidence, and tears down only the isolated Compose project. It performs no Cloudflare cutover.

## Retention and failure behavior

Retention is applied only after a new recovery point reaches `SUCCESS`. The GFS plan keeps all hourly buckets within 48 hours, one point per UTC day for 30 days, one per ISO week for 12 weeks, and one per UTC month for 12 months. The newest verified `SUCCESS` point is always protected. Offsite objects are removed by exact recovery-point prefix before the corresponding local point is removed; failure to remove the offsite prefix stops local deletion. A compact deletion receipt remains in `<backup-root>/evidence/recovery-points/`.

Failed and incomplete attempts are not called recovery points in good standing and are not silently treated as successful. They remain available for diagnosis until an explicit evidence-retention policy is approved.

## RTO and promotion

The target is recovery within 60 minutes. A drill measures this target; code or backup presence alone does not verify it. Promotion/cutover remains a separate, explicitly authorized operations action after isolated checks, owner review of the recorded RPO gap, and runtime provenance verification. V2-16 contains no promote command.
