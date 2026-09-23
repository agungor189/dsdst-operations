# Production deployment

## Release authority

Blind in-place deployment was retired by V2-17. `scripts/deploy.sh` now fails closed without changing runtime state. All published host ports are hard-bound to `127.0.0.1`; external access is through the explicitly controlled Cloudflare route.

Use `docs/runtime-release.md`. Production release requires an exact digest-pinned source/image set, manual approval, a fresh accepted V2-16 recovery point, isolated migration preflight, a separate candidate Compose project/volumes/networks/ports, health plus read-only smoke/connectivity checks, and an explicit Cloudflare cutover.

## Upgrades and rollback

The previous runtime becomes a stopped/read-only rollback target and its volume identities are retained for seven days. Rollback uses the explicit V2-17 command to restore the previous runtime and Cloudflare target identities. It never performs an automatic database restore. Restore remains a separate, approved V2-16 recovery operation.

The old per-repository compose files remain valid during the transition. Remove them only after at least one successful production deployment, backup verification, rollback rehearsal, and confirmation that no host automation still calls them.

After that acceptance window, the four per-repository `docker-compose.yml` files and any host-only `docker-compose.override.yml` can be retired. Keep every application `Dockerfile`, because Operations continues to build those independent images. Do not delete the old compose files during the first Operations v1 rollout.

## System test

`scripts/e2e.sh` builds an isolated Compose project with unique networks and volumes, runs the full receiving/template/picking workflow plus Customer Hub session/inbound/outbox/CRM workflow, then removes only that test project's containers and volumes. `scripts/e2e-local.sh` provides the same workflow with temporary SQLite files when Docker is unavailable; repository paths can be supplied through the five `*_CONTEXT` variables.
