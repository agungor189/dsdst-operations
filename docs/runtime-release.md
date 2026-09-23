# Runtime release and rollback

This runbook is the versioned runtime-release operator contract. The controller accepts
the exact historical V2-17 profile and the exact V2-18 profile; it rejects every other
release/source-set combination. The commands below show the current V2-18 profile. They
prepare controlled operations; repository tests do not deploy, restart, migrate, restore
production, or call Cloudflare.

## State model

```text
PREPARED -> APPROVED -> PREFLIGHT_PASSED -> CANDIDATE_UP
         -> VERIFIED --[FREEZE + FINAL_CONVERGENCE + ROUTE_INTENT]--> CUTOVER -> COMPLETED
                    \-> FAILED (old writer resumed; route unchanged)
                                                       \-> ROLLED_BACK (proof-gated)
                     COMPLETED -> ROLLED_BACK (inside the retention window)
```

The journal is append-only and external to protected databases. Store it in an access-controlled evidence directory. Never store the environment file, route ID, API token, secret, password, private key, credential, raw config, customer data, or database content beside it.

## 1. Prepare and approve

Create a release-plan JSON from runtime-derived evidence. It must contain:

- `release_id`, `release: V2-18`, `prepared_at`, and `recovery_max_age_seconds` at or below 3600;
- the exact `config/v2-18-source-set.json` revisions and `accepted_v2_17_source_set` content/closure revisions;
- six service records with repository, OCI revision, digest-pinned image reference, image ID, and redacted config fingerprint;
- an accepted, restore-tested exact V2-18 recovery point and source set;
- old runtime identity/route/volume IDs and distinct candidate project/route/volume IDs;
- only `127.0.0.1` candidate bindings;
- verified Cloudflare route hash/current target plus the fixed cutover/rollback command names;
- `rollback.retention_days: 7`.

Prepare:

```sh
node scripts/release/release-cli.mjs prepare \
  /approved/release-evidence/v2-18.ndjson \
  /approved/release-input/v2-18-plan.redacted.json
```

An authorized human reviews the plan hash, then supplies redacted approval JSON with `approved_by`, `approval_id`, the exact `plan_hash`, and `manual: true`:

```sh
node scripts/release/release-cli.mjs approve \
  /approved/release-evidence/v2-18.ndjson \
  /approved/release-input/v2-18-approval.redacted.json
```

No approval means the next transition is rejected.

## 2. Recovery and migration preflight

The migration adapter is repository/venue-specific and must emit the complete redacted preflight payload: `backup_id`, all four `PASS` checks, and `migration: {status: PASS, candidate_db_touched: false, migrations: [...]}`. The wrapper first verifies current recovery health, restores the release profile's approved recovery point into an isolated path, and only then invokes the adapter. For V2-18 that point must carry the exact V2-18 source set. It cannot start the candidate.

```sh
RECOVERY_MANIFEST_HMAC_KEY=<from-secret-store> \
./scripts/release/migration-preflight.sh \
  /approved/release-evidence/v2-18.ndjson \
  /opt/dsdst/backups/recovery-points/rp-... \
  /opt/dsdst/backups/restore-staging/v2-18-preflight \
  /approved/adapters/dsdst-migration-preflight \
  /approved/release-evidence/v2-18-preflight-result.json
```

Failure leaves the release before `PREFLIGHT_PASSED`; do not create or mount candidate DB volumes.

## 3. Start the isolated candidate

Create a protected candidate environment file. All six application/toolbox images must use `repository@sha256:<64 hex>`. Set `RELEASE_CANDIDATE_PROJECT` to the approved `dsdst-candidate-...` name and set the five explicit candidate ports. Production secret injection remains in this protected environment and is never copied into evidence.

Validate and pull without builds:

```sh
./scripts/release/candidate-stack.sh config /approved/release-evidence/v2-18.ndjson /approved/secrets/v2-18-candidate.env
./scripts/release/candidate-stack.sh pull   /approved/release-evidence/v2-18.ndjson /approved/secrets/v2-18-candidate.env
```

Hydrate only the separate candidate volumes from the already verified isolated restore for pre-verification. This recovery point remains mandatory protection evidence, but it is never the normal-cutover business-data source. The approved adapter runs candidate pre-verification migrations and is forbidden from mounting old production volumes:

```sh
./scripts/release/hydrate-candidate.sh \
  /approved/release-evidence/v2-18.ndjson \
  /approved/secrets/v2-18-candidate.env \
  /opt/dsdst/backups/restore-staging/v2-18-preflight \
  /approved/adapters/dsdst-candidate-hydration \
  /approved/release-evidence/v2-18-hydration.redacted.json

./scripts/release/candidate-stack.sh up \
  /approved/release-evidence/v2-18.ndjson \
  /approved/secrets/v2-18-candidate.env
```

The overlay assigns separate named volumes and networks and hard-binds published ports to loopback. Collect candidate provenance read-only. Record `CANDIDATE_UP` with the pre-verification hydration result, exact migrations, collector capture ID, all six exact source/image/config/container observations, actual volume source identities, and observed loopback bindings. Operator-supplied freeze timestamps are forbidden:

```sh
node scripts/release/release-cli.mjs candidate-up \
  /approved/release-evidence/v2-18.ndjson \
  /approved/release-evidence/v2-18-candidate-runtime.redacted.json
```

Any observed old volume identity, source/image mismatch, missing config fingerprint, wrong host binding, or L/renderer state-source mismatch is rejected.

## 4. Verify before cutover

Run critical health checks:

```sh
./scripts/release/candidate-stack.sh health /approved/release-evidence/v2-18.ndjson /approved/secrets/v2-18-candidate.env
```

Run the approved read-only smoke and connectivity adapter. The evidence payload must cover all six services, use `smoke.mode: READ_ONLY`, show `PASS` for smoke/connectivity/provenance, and enumerate cross-service checks. Then record:

```sh
node scripts/release/release-cli.mjs verify \
  /approved/release-evidence/v2-18.ndjson \
  /approved/release-evidence/v2-18-verification.redacted.json
```

A failed or missing check never reaches `VERIFIED` and therefore cannot begin convergence or cut over.

## 5. Freeze and converge current production data

After pre-verification, run the controller. It calls the runtime adapter directly to freeze old production writes and records the adapter's opaque audit token, timestamp, runtime identity, and canonical source watermark. That timestamp starts the ten-minute hard interruption clock. The operator cannot submit or override it.

The final-snapshot adapter must transactionally capture `P_DB`, `P_UPLOADS`, `K_DB`, `K_UPLOADS`, `L_STATE`, `HUB_DB`, and `HUB_ATTACHMENTS`. Live SQLite uses online backup; stopped databases may use a verified stopped-state copy. Raw copying a live writable SQLite file is rejected. Every component and the manifest are hashed. The hydration adapter then replaces candidate data only from this final snapshot, runs migrations, recollects runtime/schema provenance, verifies the source watermark, and reruns all critical health, read-only smoke, and connectivity checks.

```sh
CLOUDFLARE_ROUTE_ID=<from-protected-config> \
CLOUDFLARE_ROUTE_ADAPTER=/approved/adapters/dsdst-cloudflare-route \
DSDST_RUNTIME_SWITCH_ADAPTER=/approved/adapters/dsdst-runtime-switch \
DSDST_FINAL_SNAPSHOT_ADAPTER=/approved/adapters/dsdst-final-snapshot \
DSDST_FINAL_HYDRATION_ADAPTER=/approved/adapters/dsdst-final-hydration \
node scripts/release/final-convergence.mjs \
  /approved/release-evidence/v2-18.ndjson
```

If any pre-route step fails after freeze, the controller resumes the old writer, disables candidate writes, verifies the route is still the old target, and records `FAILED`. The candidate remains non-authoritative.

For an explicit operator abort after freeze:

```sh
DSDST_RELEASE_FAILURE_REASON='candidate health or smoke failure' \
CLOUDFLARE_ROUTE_ID=<from-protected-config> \
CLOUDFLARE_ROUTE_ADAPTER=/approved/adapters/dsdst-cloudflare-route \
DSDST_RUNTIME_SWITCH_ADAPTER=/approved/adapters/dsdst-runtime-switch \
node scripts/release/cloudflare-route.mjs abort \
  /approved/release-evidence/v2-18.ndjson
```

## 6. Explicit Cloudflare cutover

Review the commands without mutation:

```sh
node scripts/release/cloudflare-route.mjs plan /approved/release-evidence/v2-18.ndjson
```

The controller first fsyncs a `ROUTE_INTENT` containing a stable `operation_id`, action, expected/desired targets, old/new runtime identities, freeze/final-snapshot references, watermarks, and deadline. Only then may the Cloudflare adapter receive `apply --operation-id ...`; the adapter must make that operation idempotent and reconcilable. The controller never trusts a mutation return value as success: it calls `observe --operation-id ...` and records only the verified actual target. The runtime adapter must confirm exactly one authoritative writer for that observed target. Both adapter paths must be absolute. Cutover is the only route-mutating release command:

```sh
CLOUDFLARE_ROUTE_ID=<from-protected-config> \
CLOUDFLARE_ROUTE_ADAPTER=/approved/adapters/dsdst-cloudflare-route \
DSDST_RUNTIME_SWITCH_ADAPTER=/approved/adapters/dsdst-runtime-switch \
node scripts/release/cloudflare-route.mjs cutover \
  /approved/release-evidence/v2-18.ndjson
```

The controller measures from production write freeze, not from the later route command. It records the adapter's durable operation-applied timestamp separately from the later observation time, plus the approval ID, operation ID, and old/new runtime identities. On timeout, error, or restart it reconciles before any retry. A `PENDING` adapter operation remains unresolved and cannot be retried or classified until a later observation is terminal. Candidate target plus `APPLIED` means it records `CUTOVER` without a second mutation; old target plus `NOT_APPLIED`/`FAILED` means it resumes only the old writer and records `CUTOVER_ABORTED`; any third or contradictory target fences both writers and records `ROUTE_UNCERTAIN`. A target already changed before a newly persisted operation is also treated as uncertain, never fabricated as this operation's success.

Complete only after post-cutover checks pass. The controller verifies the route still targets the candidate and records a runtime-adapter-derived candidate write watermark observed after cutover:

```sh
DSDST_RUNTIME_SWITCH_ADAPTER=/approved/adapters/dsdst-runtime-switch \
CLOUDFLARE_ROUTE_ID=<from-protected-config> \
CLOUDFLARE_ROUTE_ADAPTER=/approved/adapters/dsdst-cloudflare-route \
node scripts/release/cloudflare-route.mjs complete \
  /approved/release-evidence/v2-18.ndjson
```

## 7. Deterministic, data-safe rollback

Rollback never restores a database automatically. The old stack and volumes are retained read-only for seven days, but retention alone does not make their data current or safe. Before any route mutation, the runtime adapter must prove either `ZERO_CANONICAL_WRITES` by showing the current candidate watermark equals the cutover watermark, or `CURRENT_STATE_SYNC` by verifying a synchronization/migration into the old runtime whose target watermark equals the newest candidate watermark and preserves every candidate-era write. That proof is included in the fsynced rollback `ROUTE_INTENT`. Retry reconciliation is the reverse of cutover: old target closes `ROLLBACK` without another mutation, candidate target records `ROLLBACK_ABORTED` with candidate-only authority, and a third target fences both writers. Without the safety proof rollback fails closed and the route stays on the candidate.

```sh
DSDST_ROLLBACK_REASON='operator-approved reason' \
CLOUDFLARE_ROUTE_ID=<from-protected-config> \
CLOUDFLARE_ROUTE_ADAPTER=/approved/adapters/dsdst-cloudflare-route \
DSDST_RUNTIME_SWITCH_ADAPTER=/approved/adapters/dsdst-runtime-switch \
node scripts/release/cloudflare-route.mjs rollback \
  /approved/release-evidence/v2-18.ndjson
```

Retain the previous volume identities and stopped/read-only runtime for seven full days after cutover. Do not describe them as a data-safe rollback state without one of the proofs above. Deletion is a separately approved retention operation and is not implemented by this release command.

## 8. Evidence report

```sh
node scripts/release/release-cli.mjs report \
  /approved/release-evidence/v2-18.ndjson \
  > /approved/release-evidence/v2-18-report.redacted.json
```

The report is a projection of the verified journal, not a new authority. It includes the actual freeze token/time/runtime, final snapshot ID and component hashes, source and candidate watermarks, final hydration snapshot, post-hydration migrations, final runtime/schema/data checks, every route intent/outcome operation ID and target observation, and rollback zero-write or synchronization proof. Preserve the NDJSON journal and adapter evidence. Re-running `report` detects journal tampering.
