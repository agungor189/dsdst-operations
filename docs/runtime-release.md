# Runtime release and rollback

This runbook is the V2-17 operator contract. It prepares commands; repository tests do not deploy, restart, migrate, restore production, or call Cloudflare.

## State model

```text
PREPARED -> APPROVED -> PREFLIGHT_PASSED -> CANDIDATE_UP
         -> VERIFIED -> CUTOVER -> COMPLETED
                           \-> FAILED -> ROLLED_BACK (only if cutover occurred)
                     COMPLETED -> ROLLED_BACK (inside the retention window)
```

The journal is append-only and external to protected databases. Store it in an access-controlled evidence directory. Never store the environment file, route ID, API token, secret, password, private key, credential, raw config, customer data, or database content beside it.

## 1. Prepare and approve

Create a release-plan JSON from runtime-derived evidence. It must contain:

- `release_id`, `release: V2-17`, `prepared_at`, and `recovery_max_age_seconds` at or below 3600;
- the exact `config/v2-17-source-set.json` revisions and accepted V2-16 content/closure revisions;
- six service records with repository, OCI revision, digest-pinned image reference, image ID, and redacted config fingerprint;
- an accepted, restore-tested V2-16 recovery point and exact source set;
- old runtime identity/route/volume IDs and distinct candidate project/route/volume IDs;
- only `127.0.0.1` candidate bindings;
- verified Cloudflare route hash/current target plus the fixed cutover/rollback command names;
- `rollback.retention_days: 7`.

Prepare:

```sh
node scripts/release/release-cli.mjs prepare \
  /approved/release-evidence/v2-17.ndjson \
  /approved/release-input/v2-17-plan.redacted.json
```

An authorized human reviews the plan hash, then supplies redacted approval JSON with `approved_by`, `approval_id`, the exact `plan_hash`, and `manual: true`:

```sh
node scripts/release/release-cli.mjs approve \
  /approved/release-evidence/v2-17.ndjson \
  /approved/release-input/v2-17-approval.redacted.json
```

No approval means the next transition is rejected.

## 2. Recovery and migration preflight

The migration adapter is repository/venue-specific and must emit the complete redacted preflight payload: `backup_id`, all four `PASS` checks, and `migration: {status: PASS, candidate_db_touched: false, migrations: [...]}`. The wrapper first verifies current recovery health, restores V2-16 into an isolated path, and only then invokes the adapter. It cannot start the candidate.

```sh
RECOVERY_MANIFEST_HMAC_KEY=<from-secret-store> \
./scripts/release/migration-preflight.sh \
  /approved/release-evidence/v2-17.ndjson \
  /opt/dsdst/backups/recovery-points/rp-... \
  /opt/dsdst/backups/restore-staging/v2-17-preflight \
  /approved/adapters/dsdst-migration-preflight \
  /approved/release-evidence/v2-17-preflight-result.json
```

Failure leaves the release before `PREFLIGHT_PASSED`; do not create or mount candidate DB volumes.

## 3. Start the isolated candidate

Create a protected candidate environment file. All six application/toolbox images must use `repository@sha256:<64 hex>`. Set `RELEASE_CANDIDATE_PROJECT` to the approved `dsdst-candidate-...` name and set the five explicit candidate ports. Production secret injection remains in this protected environment and is never copied into evidence.

Validate and pull without builds:

```sh
./scripts/release/candidate-stack.sh config /approved/release-evidence/v2-17.ndjson /approved/secrets/v2-17-candidate.env
./scripts/release/candidate-stack.sh pull   /approved/release-evidence/v2-17.ndjson /approved/secrets/v2-17-candidate.env
```

Hydrate only the separate candidate volumes from the already verified isolated restore. The approved adapter runs the real candidate migrations and emits their exact identities; it is forbidden from mounting old production volumes:

```sh
./scripts/release/hydrate-candidate.sh \
  /approved/release-evidence/v2-17.ndjson \
  /approved/secrets/v2-17-candidate.env \
  /opt/dsdst/backups/restore-staging/v2-17-preflight \
  /approved/adapters/dsdst-candidate-hydration \
  /approved/release-evidence/v2-17-hydration.redacted.json

./scripts/release/candidate-stack.sh up \
  /approved/release-evidence/v2-17.ndjson \
  /approved/secrets/v2-17-candidate.env
```

Freeze production writes before final hydration and record that timestamp. It starts the interruption clock; route switching time alone is not the cutover duration. The overlay assigns separate named volumes and networks and hard-binds published ports to loopback. Collect candidate provenance read-only. Record `CANDIDATE_UP` only with the write-freeze timestamp, verified hydration result and exact migrations actually run, collector capture ID, all six exact source/image/config/container observations, actual volume source identities, and observed loopback bindings:

```sh
node scripts/release/release-cli.mjs candidate-up \
  /approved/release-evidence/v2-17.ndjson \
  /approved/release-evidence/v2-17-candidate-runtime.redacted.json
```

Any observed old volume identity, source/image mismatch, missing config fingerprint, wrong host binding, or L/renderer state-source mismatch is rejected.

## 4. Verify before cutover

Run critical health checks:

```sh
./scripts/release/candidate-stack.sh health /approved/release-evidence/v2-17.ndjson /approved/secrets/v2-17-candidate.env
```

Run the approved read-only smoke and connectivity adapter. The evidence payload must cover all six services, use `smoke.mode: READ_ONLY`, show `PASS` for smoke/connectivity/provenance, and enumerate cross-service checks. Then record:

```sh
node scripts/release/release-cli.mjs verify \
  /approved/release-evidence/v2-17.ndjson \
  /approved/release-evidence/v2-17-verification.redacted.json
```

A failed or missing check never reaches `VERIFIED` and therefore cannot cut over. If checks fail after write freeze, explicitly abort the candidate, restore the old writer, and verify that Cloudflare never moved:

```sh
DSDST_RELEASE_FAILURE_REASON='candidate health or smoke failure' \
CLOUDFLARE_ROUTE_ID=<from-protected-config> \
CLOUDFLARE_ROUTE_ADAPTER=/approved/adapters/dsdst-cloudflare-route \
DSDST_RUNTIME_SWITCH_ADAPTER=/approved/adapters/dsdst-runtime-switch \
node scripts/release/cloudflare-route.mjs abort \
  /approved/release-evidence/v2-17.ndjson
```

## 5. Explicit Cloudflare cutover

Review the commands without mutation:

```sh
node scripts/release/cloudflare-route.mjs plan /approved/release-evidence/v2-17.ndjson
```

The Cloudflare adapter must read the actual route ID from `DSDST_CLOUDFLARE_ROUTE_ID`, verify the expected target, perform one exact target change, and return redacted provenance JSON. The runtime-switch adapter must stop/fence old writers, report `READ_ONLY_STOPPED`, and recheck candidate health. Both adapter paths must be absolute. Cutover is the only route-mutating release command:

```sh
CLOUDFLARE_ROUTE_ID=<from-protected-config> \
CLOUDFLARE_ROUTE_ADAPTER=/approved/adapters/dsdst-cloudflare-route \
DSDST_RUNTIME_SWITCH_ADAPTER=/approved/adapters/dsdst-runtime-switch \
node scripts/release/cloudflare-route.mjs cutover \
  /approved/release-evidence/v2-17.ndjson
```

The controller measures from production write freeze, not from the later route command. It records start/end times, the approval ID, verified route result, and old/new runtime identities. More than ten minutes is rejected; more than five minutes is recorded as a target miss. If route mutation fails, do not assert completion—use the adapter's verified current-target result to decide whether the route is unchanged or explicit rollback is required.

Complete only after post-cutover read-only checks pass:

```sh
node scripts/release/release-cli.mjs complete \
  /approved/release-evidence/v2-17.ndjson \
  /approved/release-input/v2-17-complete.json
```

`v2-17-complete.json` contains only `{ "result": "SUCCESS" }`.

## 6. Deterministic rollback

Rollback never restores a database automatically. It reactivates and health-checks the retained previous runtime, verifies no DB restore was used, restores the exact previous Cloudflare target, and records the result. It is accepted only inside the seven-day window.

```sh
DSDST_ROLLBACK_REASON='operator-approved reason' \
CLOUDFLARE_ROUTE_ID=<from-protected-config> \
CLOUDFLARE_ROUTE_ADAPTER=/approved/adapters/dsdst-cloudflare-route \
DSDST_RUNTIME_SWITCH_ADAPTER=/approved/adapters/dsdst-runtime-switch \
node scripts/release/cloudflare-route.mjs rollback \
  /approved/release-evidence/v2-17.ndjson
```

Retain the previous volume identities and stopped/read-only runtime for seven full days after cutover. Deletion is a separately approved retention operation and is not implemented by this release command.

## 7. Evidence report

```sh
node scripts/release/release-cli.mjs report \
  /approved/release-evidence/v2-17.ndjson \
  > /approved/release-evidence/v2-17-report.redacted.json
```

The report is a projection of the verified journal, not a new authority. Preserve the NDJSON journal and adapter evidence. Re-running `report` detects journal tampering.
