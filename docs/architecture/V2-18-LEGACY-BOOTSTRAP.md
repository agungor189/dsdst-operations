# V2-18 legacy runtime bootstrap

Status: one-time fail-closed bridge for an existing runtime whose local images do not carry trustworthy OCI source/revision provenance.

## Why this exists

The existing production stack may be healthy while still being unsuitable as V2-18 release evidence. Local `operations-v1` / `preview` images can have stable Docker image IDs but no trustworthy `org.opencontainers.image.source` or `org.opencontainers.image.revision`. Such a runtime cannot be relabelled as V2-16, V2-17 or V2-18.

The normal contracts remain unchanged:

- an accepted V2-18 recovery point still requires exact V2-18 runtime/source provenance;
- the normal V2-18 release controller still requires an accepted V2-18 recovery point before its release candidate can start;
- Cloudflare cutover, final convergence and rollback safety are unchanged.

The bootstrap path resolves only the first-install deadlock. It is not a release profile and cannot cut over traffic.

## Ordered flow

1. **Legacy bootstrap snapshot.** Capture P/K/Hub SQLite with the SQLite online backup API and archive P/K uploads, Label state and Hub attachments. Record running container/image/mount identities but mark Git source provenance permanently `UNVERIFIED_LEGACY`.
2. **Encrypted offsite persistence.** HMAC-authenticate the local bootstrap manifest, encrypt the payload and manifest client-side, persist both to the configured R2/rclone destination, and verify round-trip hashes. The bootstrap manifest explicitly states `canonical_recovery_point: false` and `final_cutover_source: false`.
3. **Isolated bootstrap candidate.** Restore only into a new `dsdst-candidate-v2-18-bootstrap-*` Compose project with exact digest-pinned V2-18 images, separate volumes/networks and loopback-only published ports. Production volumes are never mounted into the candidate.
4. **Candidate verification.** Run health, read-only smoke/connectivity, exact source/image/schema/config/topology provenance and reject any candidate volume identity reused from the legacy runtime.
5. **First accepted V2-18 recovery point.** Snapshot only the verified bootstrap-candidate volumes, build the normal V2-18 recovery manifest, persist it encrypted offsite, verify it as accepted, and complete the normal isolated full restore drill.
6. **Return to the normal release controller.** Stop the bootstrap candidate and retain its isolated volumes/evidence. Start the ordinary V2-18 release workflow from the newly accepted V2-18 recovery point. Final convergence still captures current production data after the production write freeze; the bootstrap snapshot is never the final cutover data source.

## Safety invariants

- No legacy Git SHA is inferred from a local Docker image.
- A legacy bootstrap snapshot can never validate as a normal recovery point.
- Production containers, volumes, writers and Cloudflare routes are not mutated by bootstrap snapshot/candidate verification.
- Live SQLite files are never copied raw.
- Candidate volumes must be disjoint from every recorded legacy state volume.
- Only exact V2-18 OCI revisions/digests are accepted for the bootstrap candidate.
- The bootstrap candidate is stopped after the first accepted V2-18 recovery point and full restore drill succeed.
- Normal one-writer fencing, final convergence, route intent/reconciliation and rollback proofs remain mandatory for the later real cutover.
