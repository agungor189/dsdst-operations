# DSDST V2 invariants

These rules are binding acceptance conditions. An implementation that cannot prove them must fail closed. `DECISION REQUIRED` values must be resolved before their dependent mutation becomes authoritative.

## Global command invariants

1. Every mutation has one owning domain and one transaction boundary.
2. Every mutation has a stable `operation_id`/idempotency key unique within actor and command scope.
3. Same key + same canonical payload returns the original committed result without a second effect.
4. Same key + different payload returns conflict and creates no effect.
5. A response is not success until the local transaction commits. External work is an outbox job, never an in-transaction assumption.
6. Actor identity, service identity, authorization decision and correlation ID are recorded without secrets.
7. State transitions are explicit and compare the prior state/version; blind last-write-wins is forbidden for business aggregates.
8. Retries, restarts and webhook replays cannot duplicate physical, financial or approval effects.

## Inventory invariants

1. A physical event posts exactly once to the inventory ledger.
2. `on_hand = opening + accepted_receipts + accepted_returns + positive_adjustments - dispatched - scrap - negative_adjustments`, in base units and for a declared scope.
3. `reserved >= 0`, `on_hand >= 0` unless a separately approved backorder policy says otherwise, and `available = on_hand - reserved`.
4. Active reservations cannot exceed eligible on-hand stock under product/lot/location/status constraints.
5. Planned, expected, quarantined and rejected quantities are not sellable on-hand.
6. Internal placement, move, pick and pack do not change company-wide on-hand; they change container/location/status.
7. One approved dispatch boundary creates the physical OUT. `DECISION REQUIRED`: carrier staging or carrier handoff.
8. Cancellation releases reservations but does not create stock. Return creates stock only after physical receipt and disposition.
9. Container remaining quantities, location balances, ledger aggregates and product projections reconcile exactly.
10. Count never clamps or overwrites silently; it records observed quantity, expected quantity, difference, approval and an explicit adjustment event.
11. Ledger rows are immutable. Corrections are compensating events referencing the original.
12. Historical pick and return use the sale-time BOM/quantity snapshot, not current product composition.

## Receipt, lot and cost invariants

1. A receipt intent or CSV inbound plan is not physical inventory.
2. Every accepted receipt has supplier/document provenance, base-unit quantity and a unique receipt event.
3. Every inventory-bearing lot has an immutable acquisition-cost snapshot before authoritative valuation.
4. Native amount/currency, FX rate/source/time/direction, allocations, rounding and accounting-currency result are retained.
5. Allocated component totals plus recorded rounding residue equal the approved landed total.
6. A master price, current FX rate or later invoice edit cannot rewrite an approved lot cost.
7. Cost correction is a new approved version/event, never an in-place historical rewrite.
8. Consumption method is deterministic and approved. `DECISION REQUIRED`: FIFO, weighted average or specific lot.

## Money and finance invariants

1. Every monetary value carries currency; unlike currencies are never added.
2. Authoritative amounts use integer minor units and declared rounding; binary floating point is forbidden.
3. Every conversion retains both amounts and complete FX provenance.
4. Current/display FX never recalculates a historical posting.
5. Cash account currency matches the posted native currency, or an explicit exchange transaction posts both legs and FX difference.
6. Debit/credit or IN/OUT legs balance under one operation identity.
7. Sales, refunds, expenses, fees and settlements post once and can be reconciled to their source document.
8. Header, line, cash and report totals share the same formula version and snapshot scope.
9. Missing required cost/FX/tax inputs produce `INCOMPLETE`/blocked state, never zero or implicit rate 1.
10. Profit is not authoritative until tax, commission, marketplace fee, shipping, packaging, labor, refund and cost policy are owner-approved.

## Sales, returns and shipment invariants

1. An accepted sale/order stores immutable product, quantity, unit, price, tax, discount, BOM, cost and currency snapshots.
2. External marketplace identity plus version is unique and replay-safe.
3. Unmatched SKU, changed totals, invalid currency or incomplete policy is quarantined before sale creation.
4. Order, payment, fulfillment, shipment, refund and physical-return states are independent and linked explicitly.
5. Cancelling/refunding money does not imply a physical return; receiving a return does not imply a refund.
6. Partial fulfillment and partial refund preserve line-level quantities and never exceed the original snapshot.
7. Carrier acceptance is not dispatch unless the owner-approved physical boundary says so.
8. A shipment contains immutable parcel/content snapshots and carrier request/response identities.

## Catalog and UOM invariants

1. SKU/product identity has one core owner and stable ID; aliases map explicitly.
2. Every stockable or priced product has one base unit from a controlled vocabulary.
3. Quantities are fixed-precision base-unit integers; conversions are rational, versioned and snapshotted.
4. Unit/category/attribute validation is schema-driven; free text cannot participate in calculation.
5. A unit semantic change after history exists creates a new version/product or approved migration.
6. Dimensions/mass use declared canonical units and non-negative validated values.

## Kit and pricing invariants

1. K drafts are editable; approved/published versions are immutable.
2. Approval covers the complete BOM, cuts, quantities, UOM conversions, waste, component cost, FX, tax, fees, labor, packaging, shipping policy and formula version.
3. The approved content hash and authorized actor are recorded in K and the core publication.
4. K cannot publish canonical SKU, stock, cost or price by direct DB write.
5. Current catalog/cost simulation is visibly non-authoritative and cannot alter an approved snapshot.
6. One accepted published-kit ID maps to one exact authored version/content hash.
7. Legacy P kit data cannot compete with K/core publication; it becomes read-only during migration and is retired after reconciliation.

## Identity and authorization invariants

1. P is the sole human identity authority for the scoped system.
2. Every protected user action validates current account status, session epoch and capability in the backend.
3. Logout, password change, account disablement and material role change revoke existing sessions.
4. Service credentials identify a service and scopes; they never impersonate or replace a human actor.
5. User-initiated cross-service commands carry both validated human and service identities.
6. Secrets are write-only after creation, encrypted where persisted, rotatable, revocable and absent from logs/evidence.
7. High-impact capabilities are least-privilege and auditable.

## Template and printing invariants

1. L is the only editable template source of truth; every template version has immutable ID/content hash.
2. Concurrent template updates use revision/CAS or a transactional equivalent; no successful update is lost.
3. A print job snapshots data and template version; later edits do not alter queued output.
4. A print attempt has a stable idempotency identity and lease/recovery semantics.
5. Renderer success, spool submission and physical delivery are distinct.
6. An uncertain final attempt becomes `DELIVERY_UNKNOWN`; it is not automatically retried or marked printed.

## Migration, import and repair invariants

1. Fresh DB and every supported upgrade path converge on one declared schema.
2. Migrations are ordered, transactional where supported, checksum/version tracked and fail closed.
3. Schema migration does not silently repair production business data.
4. Imports have dry run, immutable source hash, row errors, normalized preview, reviewer and idempotent apply.
5. Repair begins with read-only reconciliation, requires backup and explicit approval, is bounded/replay-safe/audited, and produces before/after evidence plus rollback.
6. No blanket stock, price, cost or cash rewrite is permitted.

## Release and recovery invariants

1. A release set identifies every service by repository, expected service, unique container identity, immutable image digest/image ID and image-derived OCI/source revision.
2. Git HEAD, tags, free text or user-filled manifest fields are not runtime provenance.
3. Service, host/internal port, network, volume/source, image and renderer/source relationships must match the contract.
4. Missing or contradictory provenance remains `NOT VERIFIED`; it cannot become `VERIFIED` by assertion.
5. Config evidence is allowlisted per service and fingerprinted; no secret-like or unknown key/value enters evidence.
6. Backup set checksums, schema/release identity and required assets are complete before a recovery point is accepted.
7. Restore is proven only in isolation with integrity, invariant and smoke checks on the restored exact release.
8. Main branch, a successful build or an existing backup file is not proof of deploy or recoverability.
