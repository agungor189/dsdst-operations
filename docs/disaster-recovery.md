# Disaster recovery

## Recovery objectives

Treat the Panel database and uploads as the authoritative operational dataset. Customer Hub conversation data/attachments, Kit Studio data, and Label-Printer template state are separate persistent assets. Define RPO/RTO with the business owner; the scripts provide the mechanism but do not choose the acceptable loss window.

## Backup procedure

`scripts/backup.sh` creates independent online SQLite backups for Panel and Customer Hub, then a compressed archive for Panel uploads, Customer Hub attachments, Kit Studio, and Label-Printer volumes. Panel's own scheduled/cloud backup remains enabled independently when configured. Copy completed backups off-host using the existing encrypted backup destination.

## Verification

Run `scripts/restore-check.sh <panel-db> <customer-hub-db> <archive>` after each backup cycle. It opens both copied databases read-only, runs `PRAGMA integrity_check`, and verifies both the archive and Customer Hub attachments entry without restoring over live data.

At least quarterly, restore into an isolated host or project name, start the stack on non-production ports, and execute the operations E2E suite. Never mount production volumes into the rehearsal stack.

## Recovery order

1. Provision a clean Docker host and secrets from the approved secret store.
2. Restore Panel DB/uploads, Customer Hub DB/attachments, Kit Studio data/uploads, and Label-Printer state into new volumes.
3. Start the renderer and Panel, then Label-Printer, Warehouse, Kit Studio, and Customer Hub.
4. Run health checks and the dry-run label path before routing users.
5. Record the restored backup timestamp and any data gap.
