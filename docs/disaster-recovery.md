# Disaster recovery

## Recovery objectives

Treat the Panel database and uploads as the authoritative operational dataset. Kit Studio data and Label-Printer template state are separate persistent assets. Define RPO/RTO with the business owner; the scripts provide the mechanism but do not choose the acceptable loss window.

## Backup procedure

`scripts/backup.sh` creates an online SQLite backup for Panel and a compressed archive for Kit Studio and Label-Printer volumes. Panel's own scheduled/cloud backup remains enabled independently when configured. Copy completed backups off-host using the existing encrypted backup destination.

## Verification

Run `scripts/restore-check.sh <db> <archive>` after each backup cycle. It opens the copied database read-only, runs `PRAGMA integrity_check`, and verifies the archive without restoring over live data.

At least quarterly, restore into an isolated host or project name, start the stack on non-production ports, and execute the operations E2E suite. Never mount production volumes into the rehearsal stack.

## Recovery order

1. Provision a clean Docker host and secrets from the approved secret store.
2. Restore Panel DB/uploads, Kit Studio data/uploads, and Label-Printer state into new volumes.
3. Start the renderer and Panel, then Label-Printer, Warehouse, and Kit Studio.
4. Run health checks and the dry-run label path before routing users.
5. Record the restored backup timestamp and any data gap.

