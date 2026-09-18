# Production deployment

## First deployment

1. Clone the five application repositories and this repository as sibling directories, or set the five `*_CONTEXT` variables explicitly.
2. Copy `.env.example` to `.env` and replace all placeholders. Obtain separate Panel API keys for Warehouse and Kit Studio with only their required permissions.
3. Keep `BIND_ADDRESS=127.0.0.1` unless a firewall and TLS reverse proxy explicitly require another listener.
4. Run `scripts/deploy.sh`.
5. Confirm `scripts/healthcheck.sh`, then exercise login and one dry-run label print before enabling a physical printer.

Deployment is additive: the script validates configuration, builds/pulls images, starts containers, and waits for health. It does not delete databases, volumes, backups, old compose files, or images.

## Upgrades and rollback

Run `scripts/backup.sh` before each upgrade. Pin immutable image tags in `.env`, deploy, and keep the previous tags. Roll back by restoring the previous tags and rerunning `scripts/deploy.sh`; only use a database restore after checking migration compatibility and validating the backup with `scripts/restore-check.sh`.

The old per-repository compose files remain valid during the transition. Remove them only after at least one successful production deployment, backup verification, rollback rehearsal, and confirmation that no host automation still calls them.

After that acceptance window, the four per-repository `docker-compose.yml` files and any host-only `docker-compose.override.yml` can be retired. Keep every application `Dockerfile`, because Operations continues to build those independent images. Do not delete the old compose files during the first Operations v1 rollout.

## System test

`scripts/e2e.sh` builds an isolated Compose project with unique networks and volumes, runs the full receiving/template/picking workflow plus Customer Hub session/inbound/outbox/CRM workflow, then removes only that test project's containers and volumes. `scripts/e2e-local.sh` provides the same workflow with temporary SQLite files when Docker is unavailable; repository paths can be supplied through the five `*_CONTEXT` variables.
