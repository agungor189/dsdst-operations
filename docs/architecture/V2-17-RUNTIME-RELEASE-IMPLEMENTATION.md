# V2-17 — Runtime and release gate implementation

Status: release controller and isolated candidate contract implemented; production runtime remains **NOT VERIFIED**.

## Ownership and scope

O remains the Release domain authority. The implementation does not move business ownership, edit business rows, select a production venue, run a migration, restore a production database, deploy, restart a production service, or mutate a Cloudflare route.

The accepted base is the V2-16 closure `e64142f18eb6a2c3fe7c0f084a393c0871c76ee6` and content/source set recorded in `config/v2-16-source-set.json`. P, W, K, L, renderer, and Customer Hub revisions remain pinned. V2-17 changes O release orchestration only.

## State and evidence contract

The release journal is an external append-only NDJSON hash chain:

```text
PREPARED -> APPROVED -> PREFLIGHT_PASSED -> CANDIDATE_UP
         -> VERIFIED -> CUTOVER -> COMPLETED

Any active state -> FAILED
CUTOVER/COMPLETED/FAILED after a real cutover -> ROLLED_BACK
```

Each transition binds its prior event hash. Manual approval binds the exact canonical release-plan hash. Re-reading the journal revalidates the full chain and every state invariant; editing, deleting, reordering, or appending a fabricated event invalidates the evidence.

The generated report answers the exact source set and immutable images, approver, recovery point, migration preflight result/list, health/smoke/connectivity results, old/new runtime identities, cutover duration, seven-day rollback deadline, and rollback use/result. Secret-shaped fields are rejected before any journal write. Evidence stays outside application databases.

## Fail-closed release gates

- V2-16 recovery must be `SUCCESS` / `VERIFIED` / offsite `PERSISTED`, have a verified restore drill, match the accepted V2-16 source set, and be no older than the approved threshold; the threshold may never exceed the accepted 60-minute RPO.
- Every critical runtime image is an immutable registry digest and its OCI source revision matches the exact source set. L and renderer share the same image/source/config provenance.
- Migration preflight runs on an isolated V2-16 restore before the candidate DB exists or is touched. Candidate hydration then copies only that isolated set into separate candidate volumes and records the exact migrations actually executed.
- The candidate uses a distinct Compose project, network names, loopback ports, and persistent volume identities. Read-only collector evidence must prove it did not mount an old production volume.
- All six critical health checks, read-only smoke, connectivity, and collector provenance pass before cutover.
- Cloudflare route identity and current target are verified before mutation. Only the explicit `cutover` command can call the route adapter.
- Cutover makes the old runtime a stopped, read-only rollback target, retains its volume identities for seven days, records both runtime identities, and measures the five-minute target and ten-minute hard maximum from production write freeze rather than the later route call.
- Rollback is explicit, restores the exact prior runtime/route identity, and rejects any automatic database restore.

## Schema, data, and rollback impact

- Application schema/data impact: none.
- O evidence format: new append-only release journal/report.
- Compose: new isolated candidate overlay; production and candidate listeners are hard-bound to `127.0.0.1`.
- Legacy `scripts/deploy.sh`: fail-closed refusal; blind in-place deployment is no longer available.
- Code rollback: revert the O feature branch only. Do not delete release journals or retained volumes as part of code rollback.
- Data rollback: none performed by this implementation. A production restore remains a separately approved V2-16 recovery operation.

## Remaining runtime gates

- collect real registry digests, OCI labels, config fingerprints, container IDs, schemas, volumes, networks, and ports on the selected host;
- configure and independently review the runtime/migration/Cloudflare adapters;
- execute and sign a real V2-16 recovery point and isolated migration preflight;
- measure real candidate health, read-only smoke, connectivity, cutover, and rollback rehearsal;
- verify Cloudflare route provenance using authorized credentials without storing them in evidence;
- retain and independently inspect the prior runtime/volumes for the complete seven-day window.
