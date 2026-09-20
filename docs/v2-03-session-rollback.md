# V2-03 session rollback safety gate

Status: operational procedure only. It does not authorize a deploy, restart, migration, restore, secret change, or production access.

## Risk being contained

Pre-V2-03 Panel code validates a JWT signature but does not enforce `user_sessions`, `session_epoch`, service-principal binding, or revocation. A code rollback with the old signing secret would therefore make logged-out, revoked, disabled-user, and service-bound JWTs acceptable again.

**JWT secret rotation is mandatory** for every rollback to pre-V2-03 code. Revoking database sessions without rotating the signing secret is insufficient because the old code does not read the revocation state.

The exact pre-V2-03 Panel source also knows migrations only through v61. It must not be started against a v62 migration history. Exact rollback therefore requires the accepted, integrity-checked v61 recovery point captured immediately before the V2-03 migration and proof that no business writes were accepted after that point. If either condition is absent, rollback abort; use a forward security fix instead.

## Mandatory authorization and evidence

Before any execution, obtain a separately authorized change window and record:

1. exact current and rollback source/image provenance;
2. the checksummed pre-V2-03 v61 database recovery point and restore-test evidence;
3. proof that the system accepted no business mutations after that recovery point;
4. the named operator and approver;
5. a newly generated JWT signing secret held only in the approved secret manager;
6. rollback and forward-recovery stop criteria.

Do not expose pre-V2-03 code to any request until every mandatory step below has passed.

## Ordered procedure

1. Close ingress and keep all human and service traffic quiesced. Confirm there are no in-flight mutations.
2. Capture a fresh safety backup of the current v62 state for forward recovery. Do not treat this as the v61 rollback source.
3. While V2-03 code and schema are still active, revoke all current `user_sessions` and increment every user's `session_epoch` in one transaction:

   ```sql
   BEGIN IMMEDIATE;
   UPDATE user_sessions
      SET revoked_at = CURRENT_TIMESTAMP,
          revoked_reason = 'pre_v2_03_rollback'
    WHERE revoked_at IS NULL;
   UPDATE users SET session_epoch = session_epoch + 1;
   COMMIT;
   ```

4. Verify no active session row remains. If this verification fails, rollback abort.
5. Generate and stage a new JWT signing secret. Never reuse, log, commit, or place it in release evidence. Rotation must be atomic across the rollback deployment; mixed old/new signing secrets are forbidden.
6. Restore the accepted v61 recovery point only after proving there were no post-snapshot business writes. Do not edit `schema_migrations`, drop v62 tables/columns, or attempt an in-place down migration.
7. Start the exact pre-V2-03 application only with the new JWT secret and with ingress still closed.
8. Replay captured synthetic representatives of old direct and service-bound tokens. Old direct and service-bound tokens must both return `401`. Also prove that a newly authenticated human can access only the intended maintenance smoke route.
9. If an old token returns anything other than `401`, if the v61 restore differs from its checksum, or if a post-snapshot business write is discovered, rollback abort. Restore the v62 safety backup and follow the authorized forward-recovery plan.
10. Reopen ingress only after the operator and approver record the forced-login result. Every browser and W/K/L session must log in again.

## Post-rollback restriction

Pre-V2-03 code lacks durable revocation and service-bound session enforcement. The rollback state is therefore temporary containment, not V2-03 acceptance. Limit access to the approved incident window and return through a reviewed forward fix. Do not add a generic service-only finance bypass to make older clients work.
